//! The driver abstraction every engine implements.
//!
//! Drivers are deliberately *stateless with respect to the UI*: they own a
//! connection pool and know how to introspect and mutate their engine, but never
//! hold view state. That keeps them cheap to share behind an `Arc<dyn Driver>`
//! and makes the command layer in `src-tauri` a thin translation shim.

use std::sync::Arc;

use async_trait::async_trait;

use opencat_core::model::{
    DatabaseInfo, DbKind, ObjectKind, ObjectRef, QueryResult, RowEdit, RowInsert, ServerInfo,
    TablePage, TableSchema,
};
use opencat_core::{CoreError, Result};

/// A fully resolved connection (secrets already decrypted).
#[derive(Debug, Clone)]
pub struct DriverConfig {
    pub profile: opencat_core::model::ConnectionProfile,
    /// Pool size. Browsing and the editor share it.
    pub max_connections: u32,
    /// `(host, port)` override used when traffic goes through an SSH tunnel.
    pub endpoint_override: Option<(String, u16)>,
}

impl DriverConfig {
    pub fn new(profile: opencat_core::model::ConnectionProfile) -> Self {
        DriverConfig {
            profile,
            max_connections: 4,
            endpoint_override: None,
        }
    }

    /// The host/port actually dialled.
    pub fn endpoint(&self) -> (String, u16) {
        match &self.endpoint_override {
            Some((h, p)) => (h.clone(), *p),
            None => (self.profile.host.clone(), self.profile.port),
        }
    }
}

/// Which database/schema a request targets.
#[derive(Debug, Clone, Default, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
}

impl Scope {
    pub fn database(db: impl Into<String>) -> Self {
        Scope {
            database: Some(db.into()),
            schema: None,
        }
    }

    pub fn schema(db: Option<String>, schema: impl Into<String>) -> Self {
        Scope {
            database: db,
            schema: Some(schema.into()),
        }
    }

    pub fn is_empty(&self) -> bool {
        self.database.is_none() && self.schema.is_none()
    }
}

/// How a statement should be executed.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryOptions {
    /// Stop after this many rows for `SELECT`-like statements.
    pub max_rows: u32,
    /// Client-side deadline; the UI unblocks even if the server keeps working.
    pub timeout_secs: u64,
    /// Reject anything that is not a read-only statement.
    pub read_only: bool,
    /// Record the statement in the history store.
    pub record_history: bool,
}

impl Default for QueryOptions {
    fn default() -> Self {
        QueryOptions {
            max_rows: 50_000,
            timeout_secs: 120,
            read_only: false,
            record_history: true,
        }
    }
}

/// Sort direction for a paged data read.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OrderBy {
    pub column: String,
    pub desc: bool,
}

/// A request for one page of table data.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PageRequest {
    #[serde(default)]
    pub scope: Scope,
    pub table: String,
    pub offset: u64,
    pub limit: u32,
    #[serde(default)]
    pub order_by: Vec<OrderBy>,
    /// Raw SQL predicate appended to the `WHERE` clause.
    #[serde(default)]
    pub filter: Option<String>,
    /// Count the full result set (expensive on large tables).
    #[serde(default)]
    pub include_total: bool,
}

/// A filter used to build a row count.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountRequest {
    #[serde(default)]
    pub scope: Scope,
    pub table: String,
    #[serde(default)]
    pub filter: Option<String>,
    #[serde(default)]
    pub approximate: bool,
}

/// Optional free-form string search applied by the data grid.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FindRequest {
    #[serde(default)]
    pub scope: Scope,
    pub table: String,
    /// Column -> needle. An empty map means "all text columns".
    #[serde(default)]
    pub columns: Vec<String>,
    pub needle: String,
    #[serde(default)]
    pub limit: u32,
}

/// Everything a driver must be able to do.
#[async_trait]
pub trait Driver: Send + Sync + 'static {
    /// Which engine this driver speaks.
    fn kind(&self) -> DbKind;

    /// Server version, current user, encoding and similar session facts.
    async fn server_info(&self) -> Result<ServerInfo>;

    /// Databases (MySQL/SQLite) or catalogs (PostgreSQL) visible to the user.
    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>>;

    /// Schemas inside `database` (PostgreSQL) — other engines return `["main"]`
    /// style synthetic names or an empty list.
    async fn list_schemas(&self, database: Option<&str>) -> Result<Vec<String>>;

    /// Tables, views and other relation-like objects in `scope`.
    async fn list_objects(&self, scope: &Scope) -> Result<Vec<ObjectRef>>;

    /// Routine objects (functions, procedures, sequences, triggers).
    async fn list_routines(&self, scope: &Scope) -> Result<Vec<ObjectRef>>;

    /// Full column/index/foreign-key description of one relation.
    async fn table_schema(
        &self,
        scope: &Scope,
        name: &str,
        kind: ObjectKind,
    ) -> Result<TableSchema>;

    /// `CREATE` statement that would rebuild the object, when the engine stores one.
    async fn table_ddl(&self, scope: &Scope, name: &str, kind: ObjectKind) -> Result<String>;

    /// Execute a script, splitting it into statements and returning one result
    /// per statement.
    async fn execute(&self, sql: &str, opts: &QueryOptions) -> Result<Vec<QueryResult>>;

    /// A page of rows for the data grid, plus the information needed to edit it.
    async fn fetch_page(&self, req: &PageRequest) -> Result<TablePage>;

    /// Row count for a table, optionally filtered.
    async fn count_rows(&self, req: &CountRequest) -> Result<i64>;

    /// Server-side search across the given columns.
    async fn find_rows(&self, req: &FindRequest) -> Result<TablePage>;

    /// Apply a set of cell edits to one row. Returns the affected row count.
    async fn update_row(&self, edit: &RowEdit) -> Result<u64>;

    /// Insert one row. Returns the affected row count.
    async fn insert_row(&self, insert: &RowInsert) -> Result<u64>;

    /// Delete one row identified by its key columns.
    async fn delete_row(&self, edit: &RowEdit) -> Result<u64>;

    /// Rename a relation.
    async fn rename_object(
        &self,
        scope: &Scope,
        from: &str,
        to: &str,
        kind: ObjectKind,
    ) -> Result<()>;

    /// Drop a relation.
    async fn drop_object(&self, scope: &Scope, name: &str, kind: ObjectKind) -> Result<()>;

    /// Truncate all rows from a table.
    async fn truncate_table(&self, scope: &Scope, name: &str) -> Result<()>;

    /// Cheap round trip used by the connection monitor.
    async fn ping(&self) -> Result<()>;

    /// Close the pool and release server resources.
    async fn close(&self);
}

/// Helper: a driver that is trivially shared.
pub type SharedDriver = Arc<dyn Driver>;

/// Map an engine error into a [`CoreError`] with the right variant.
pub fn classify_error(err: impl std::fmt::Display) -> CoreError {
    let text = err.to_string();
    let lowered = text.to_ascii_lowercase();
    if lowered.contains("access denied")
        || lowered.contains("authentication")
        || lowered.contains("password")
        || lowered.contains("role \"")
    {
        CoreError::Auth(text)
    } else if lowered.contains("connection")
        || lowered.contains("refused")
        || lowered.contains("timed out")
        || lowered.contains("unreachable")
        || lowered.contains("no such host")
    {
        CoreError::Connection(text)
    } else {
        CoreError::Query(text)
    }
}

/// Build a [`CoreError::Unsupported`] naming the engine.
pub fn unsupported(kind: DbKind, what: &str) -> CoreError {
    CoreError::Unsupported(format!("{} does not support {}", kind.display_name(), what))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classifies_driver_errors() {
        assert!(matches!(
            classify_error("Access denied for user 'root'@'localhost'"),
            CoreError::Auth(_)
        ));
        assert!(matches!(
            classify_error("connection refused"),
            CoreError::Connection(_)
        ));
        assert!(matches!(
            classify_error("syntax error at or near"),
            CoreError::Query(_)
        ));
    }

    #[test]
    fn endpoint_override_wins() {
        let profile = opencat_core::model::ConnectionProfile::new("x", DbKind::Mysql);
        let mut cfg = DriverConfig::new(profile);
        assert_eq!(cfg.endpoint().1, 3306);
        cfg.endpoint_override = Some(("127.0.0.1".into(), 40001));
        assert_eq!(cfg.endpoint(), ("127.0.0.1".to_string(), 40001));
    }
}
