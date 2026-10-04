//! Connection management: CRUD over saved profiles, connectivity tests and
//! opening/closing live sessions.

use tauri::State;

use opencat_core::model::{ConnectionProfile, DbKind, ServerInfo, SessionInfo};
use opencat_driver::{DriverConfig, QueryOptions};

use crate::error::CmdResult;
use crate::state::{apply_session_guards, session_info, AppState, Session};

/// Saved profiles, with secrets replaced by a mask.
#[tauri::command]
pub async fn list_connections(state: State<'_, AppState>) -> CmdResult<Vec<ConnectionProfile>> {
    Ok(state.with_workspace(|ws| ws.connections_masked()))
}

/// Insert or update a profile. Masked secrets are restored from the stored copy.
#[tauri::command]
pub async fn save_connection(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> CmdResult<ConnectionProfile> {
    state
        .with_workspace_mut(|ws| ws.upsert_connection(profile))?
        .pipe(Ok)
}

/// Remove a profile and close any session using it.
#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> CmdResult<bool> {
    let open: Vec<_> = state
        .sessions()
        .into_iter()
        .filter(|s| s.info.profile_id == id)
        .map(|s| s.id.clone())
        .collect();
    for session_id in open {
        if let Some(session) = state.take_session(&session_id) {
            session.driver.close().await;
        }
    }
    Ok(state.with_workspace_mut(|ws| ws.delete_connection(&id))?)
}

/// Copy a profile under a new id.
#[tauri::command]
pub async fn duplicate_connection(
    state: State<'_, AppState>,
    id: String,
    name: Option<String>,
) -> CmdResult<ConnectionProfile> {
    Ok(state.with_workspace_mut(|ws| ws.duplicate_connection(&id, name))?)
}

/// Probe a profile without keeping the connection.
///
/// Accepts an unsaved draft so "Test Connection" works before the first save.
#[tauri::command]
pub async fn test_connection(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> CmdResult<ServerInfo> {
    let resolved = resolve_draft(&state, &profile)?;
    Ok(opencat_driver::test_connection(&resolved).await?)
}

/// Open a session and return its descriptor.
#[tauri::command]
pub async fn open_connection(
    state: State<'_, AppState>,
    profile_id: String,
    database: Option<String>,
) -> CmdResult<SessionInfo> {
    // Reuse an already-open session for the same profile and database.
    if let Some(existing) = state.sessions().into_iter().find(|s| {
        s.info.profile_id == profile_id
            && database.as_deref().unwrap_or_default()
                == s.profile.database.as_deref().unwrap_or_default()
    }) {
        return Ok(existing.info.clone());
    }

    let mut resolved = state.with_workspace(|ws| {
        ws.connection(&profile_id)
            .cloned()
            .ok_or_else(|| opencat_core::CoreError::NotFound(format!("connection `{profile_id}`")))
            .and_then(|p| ws.resolve(&p))
    })?;

    if let Some(db) = database.filter(|d| !d.trim().is_empty()) {
        resolved.database = Some(db);
    }
    if resolved.kind == DbKind::Mysql && resolved.database.is_none() {
        // Leave it unset: the user can pick a database from the tree.
    }

    let mut config = DriverConfig::new(resolved.clone());
    // A desktop client talks to one server with one logical session. A single
    // pooled connection keeps `USE` / `SET search_path` semantics predictable
    // when the user switches database from the toolbar.
    config.max_connections = 1;

    let driver = opencat_driver::connect_with(config).await?;
    apply_session_guards(&driver, resolved.kind, resolved.connect_timeout_secs).await;

    let server = match driver.server_info().await {
        Ok(info) => info,
        Err(err) => {
            driver.close().await;
            return Err(err.into());
        },
    };

    let mut info = session_info(&resolved, server, resolved.ssh.enabled);
    let session_id = info.session_id.clone();
    info.profile_name = resolved.name.clone();

    let session = Session {
        id: session_id,
        profile: resolved,
        driver,
        info: info.clone(),
    };
    state.add_session(session);
    Ok(info)
}

/// Close a session and release its connections.
#[tauri::command]
pub async fn close_connection(state: State<'_, AppState>, session_id: String) -> CmdResult<bool> {
    match state.take_session(&session_id) {
        Some(session) => {
            session.driver.close().await;
            Ok(true)
        },
        None => Ok(false),
    }
}

/// Every live session, for the connection monitor.
#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> CmdResult<Vec<SessionInfo>> {
    Ok(state
        .sessions()
        .into_iter()
        .map(|s| s.info.clone())
        .collect())
}

/// Round trip used by the "keep alive" indicator.
#[tauri::command]
pub async fn ping_session(state: State<'_, AppState>, session_id: String) -> CmdResult<f64> {
    let session = state.session(&session_id)?;
    let started = std::time::Instant::now();
    session.driver.ping().await?;
    Ok(started.elapsed().as_secs_f64() * 1000.0)
}

/// Open a throwaway connection to verify a draft profile, then drop it.
///
/// Performs a trivial query so we are testing execution, not just the handshake.
#[tauri::command]
pub async fn validate_connection(
    state: State<'_, AppState>,
    profile: ConnectionProfile,
) -> CmdResult<ServerInfo> {
    let resolved = resolve_draft(&state, &profile)?;
    let driver = opencat_driver::connect_with(DriverConfig::new(resolved)).await?;
    let info = driver.server_info().await;
    let _ = driver
        .execute(
            "SELECT 1",
            &QueryOptions {
                max_rows: 1,
                timeout_secs: 15,
                read_only: true,
                record_history: false,
            },
        )
        .await;
    driver.close().await;
    Ok(info?)
}

/// Merge a masked draft with its stored secrets and decrypt it.
fn resolve_draft(
    state: &State<'_, AppState>,
    draft: &ConnectionProfile,
) -> CmdResult<ConnectionProfile> {
    Ok(state.with_workspace(|ws| {
        let mut profile = draft.clone();
        profile.normalise();
        if let Some(stored) = ws.connection(&profile.id) {
            profile.merge_secrets(stored);
        }
        ws.resolve(&profile)
    })?)
}

/// Tiny helper so `save_connection` can stay an expression.
trait Pipe: Sized {
    fn pipe<T>(self, f: impl FnOnce(Self) -> T) -> T {
        f(self)
    }
}
impl<T> Pipe for T {}
