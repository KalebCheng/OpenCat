//! Shared application state: the persisted workspace plus every live database
//! session.
//!
//! Sessions are keyed by an opaque id handed to the frontend. The workspace is
//! guarded by a plain `RwLock`; commands deliberately copy what they need and
//! drop the guard before awaiting, so a slow query can never block a settings
//! read.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::{Arc, RwLock};

use opencat_core::model::{ConnectionProfile, DbKind, ServerInfo, SessionInfo};
use opencat_core::{Result, Workspace};
use opencat_driver::{QueryOptions, SharedDriver};

use crate::error::{coded, other, CmdError};

/// A live connection.
pub struct Session {
    pub id: String,
    /// The profile with secrets decrypted.
    pub profile: ConnectionProfile,
    pub driver: SharedDriver,
    pub info: SessionInfo,
}

impl Session {
    pub fn kind(&self) -> DbKind {
        self.profile.kind
    }
}

/// Global application state registered with Tauri.
pub struct AppState {
    workspace: RwLock<Workspace>,
    sessions: RwLock<HashMap<String, Arc<Session>>>,
}

impl AppState {
    /// Open the workspace under `dir`.
    pub fn new(dir: &Path) -> Result<Self> {
        let workspace = Workspace::open(dir)?;
        Ok(AppState {
            workspace: RwLock::new(workspace),
            sessions: RwLock::new(HashMap::new()),
        })
    }

    // -- workspace -----------------------------------------------------------

    /// Run `f` with read access to the workspace, then release the lock.
    pub fn with_workspace<T>(&self, f: impl FnOnce(&Workspace) -> T) -> T {
        let guard = self.workspace.read().unwrap_or_else(|e| e.into_inner());
        f(&guard)
    }

    /// Run `f` with write access to the workspace, then release the lock.
    pub fn with_workspace_mut<T>(&self, f: impl FnOnce(&mut Workspace) -> T) -> T {
        let mut guard = self.workspace.write().unwrap_or_else(|e| e.into_inner());
        f(&mut guard)
    }

    // -- sessions ------------------------------------------------------------

    /// Register a freshly opened session.
    pub fn add_session(&self, session: Session) -> Arc<Session> {
        let session = Arc::new(session);
        let mut guard = self.sessions.write().unwrap_or_else(|e| e.into_inner());
        guard.insert(session.id.clone(), Arc::clone(&session));
        session
    }

    /// Look a session up by id.
    pub fn session(&self, id: &str) -> std::result::Result<Arc<Session>, CmdError> {
        let guard = self.sessions.read().unwrap_or_else(|e| e.into_inner());
        guard
            .get(id)
            .cloned()
            .ok_or_else(|| coded("not_found", format!("connection `{id}` is no longer open")))
    }

    /// Remove a session and return it so the caller can close the pool.
    pub fn take_session(&self, id: &str) -> Option<Arc<Session>> {
        let mut guard = self.sessions.write().unwrap_or_else(|e| e.into_inner());
        guard.remove(id)
    }

    /// All live sessions, ordered by open time.
    pub fn sessions(&self) -> Vec<Arc<Session>> {
        let guard = self.sessions.read().unwrap_or_else(|e| e.into_inner());
        let mut list: Vec<_> = guard.values().cloned().collect();
        list.sort_by(|a, b| a.info.opened_at.cmp(&b.info.opened_at));
        list
    }

    /// Close every session; used on shutdown.
    pub async fn close_all(&self) {
        let sessions = {
            let mut guard = self.sessions.write().unwrap_or_else(|e| e.into_inner());
            std::mem::take(&mut *guard)
        };
        for session in sessions.values() {
            session.driver.close().await;
        }
    }
}

/// Build a [`SessionInfo`] for a freshly opened connection.
pub fn session_info(
    profile: &ConnectionProfile,
    server: ServerInfo,
    tunnelled: bool,
) -> SessionInfo {
    SessionInfo {
        session_id: uuid::Uuid::new_v4().to_string(),
        profile_id: profile.id.clone(),
        profile_name: profile.name.clone(),
        kind: profile.kind,
        server,
        opened_at: chrono::Utc::now().to_rfc3339(),
        tunnelled,
    }
}

/// Convenience for turning an unexpected internal failure into a payload.
pub fn internal(context: &str, err: impl std::fmt::Display) -> CmdError {
    other(format!("{context}: {err}"))
}

/// Ensure a driver exists for the requested engine, with a helpful message.
pub fn driver_or_error(
    driver: Option<SharedDriver>,
) -> std::result::Result<SharedDriver, CmdError> {
    driver.ok_or_else(|| {
        other(
            "that database engine is not available in this build — \
             OpenCat currently ships SQLite, MySQL/MariaDB and PostgreSQL",
        )
    })
}

/// Apply engine-specific session guards right after connecting.
///
/// Setting a server-side statement timeout means a runaway query is stopped by
/// the database even if the client is killed. Failures are ignored: not every
/// engine (or server version) supports every setting.
pub async fn apply_session_guards(driver: &SharedDriver, kind: DbKind, timeout_secs: u64) {
    let millis = timeout_secs.saturating_mul(1000).max(1_000);
    let statements: Vec<String> = match kind {
        DbKind::Postgres => vec![
            format!("SET statement_timeout = {millis}"),
            "SET idle_in_transaction_session_timeout = 600000".to_string(),
        ],
        DbKind::Mysql => vec![
            // MySQL 5.7.8+; MariaDB does not understand it and will error out.
            format!("SET SESSION max_execution_time = {millis}"),
        ],
        DbKind::Sqlite => Vec::new(),
    };

    for statement in statements {
        let options = QueryOptions {
            max_rows: 1,
            timeout_secs: 10,
            read_only: false,
            record_history: false,
        };
        if let Err(err) = driver.execute(&statement, &options).await {
            tracing::debug!("session guard `{statement}` was rejected: {err}");
        }
    }
}

/// Fallback workspace location when the platform app-data directory is missing.
pub fn portable_workspace_dir() -> PathBuf {
    std::env::current_dir()
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".opencat-data")
        .join("workspace")
}
