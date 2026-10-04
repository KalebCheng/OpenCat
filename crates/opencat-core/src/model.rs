//! The OpenCat domain model: connection profiles, database objects, table
//! schemas and query results. Everything here is `Serialize`/`Deserialize`
//! because it doubles as the IPC contract with the frontend.

use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;

use crate::value::Value;

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

/// Which database engine a profile talks to.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum DbKind {
    Sqlite,
    Mysql,
    Postgres,
}

impl DbKind {
    pub const ALL: [DbKind; 3] = [DbKind::Sqlite, DbKind::Mysql, DbKind::Postgres];

    pub fn as_str(&self) -> &'static str {
        match self {
            DbKind::Sqlite => "sqlite",
            DbKind::Mysql => "mysql",
            DbKind::Postgres => "postgres",
        }
    }

    pub fn display_name(&self) -> &'static str {
        match self {
            DbKind::Sqlite => "SQLite",
            DbKind::Mysql => "MySQL / MariaDB",
            DbKind::Postgres => "PostgreSQL",
        }
    }

    /// Default TCP port, `None` for file based engines.
    pub fn default_port(&self) -> Option<u16> {
        match self {
            DbKind::Sqlite => None,
            DbKind::Mysql => Some(3306),
            DbKind::Postgres => Some(5432),
        }
    }

    /// The placeholder used when quoting identifiers.
    pub fn quote_char(&self) -> char {
        match self {
            DbKind::Mysql => '`',
            _ => '"',
        }
    }

    /// The parameter placeholder used when building statements.
    pub fn placeholder(&self, index: usize) -> String {
        match self {
            DbKind::Postgres => format!("${index}"),
            _ => "?".to_string(),
        }
    }

    pub fn is_file_based(&self) -> bool {
        matches!(self, DbKind::Sqlite)
    }
}

impl std::fmt::Display for DbKind {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(self.as_str())
    }
}

/// An SSH jump-host tunnel definition.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SshTunnel {
    pub enabled: bool,
    pub host: String,
    #[serde(default = "default_ssh_port")]
    pub port: u16,
    pub username: String,
    #[serde(default)]
    pub password: String,
    #[serde(default)]
    pub private_key_path: Option<String>,
    #[serde(default)]
    pub passphrase: Option<String>,
}

fn default_ssh_port() -> u16 {
    22
}

/// SSL/TLS negotiation mode, mapped onto each engine's own vocabulary.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SslMode {
    Disable,
    /// Negotiate TLS when the server offers it, but do not require it.
    #[default]
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

impl SslMode {
    pub fn as_str(&self) -> &'static str {
        match self {
            SslMode::Disable => "disable",
            SslMode::Prefer => "prefer",
            SslMode::Require => "require",
            SslMode::VerifyCa => "verify-ca",
            SslMode::VerifyFull => "verify-full",
        }
    }
}

/// Everything needed to open a connection.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionProfile {
    pub id: String,
    pub name: String,
    pub kind: DbKind,

    #[serde(default)]
    pub group: Option<String>,
    /// Hex accent colour shown in the sidebar.
    #[serde(default)]
    pub color: Option<String>,

    #[serde(default = "default_host")]
    pub host: String,
    #[serde(default)]
    pub port: u16,
    #[serde(default)]
    pub username: String,
    #[serde(default)]
    pub password: String,

    /// Default database/schema to open, `None` means "browse everything".
    #[serde(default)]
    pub database: Option<String>,
    /// SQLite file path.
    #[serde(default)]
    pub file: Option<String>,

    #[serde(default)]
    pub ssl_mode: SslMode,
    /// Extra engine specific URL parameters (`charset`, `connect_timeout`, ...).
    #[serde(default)]
    pub params: BTreeMap<String, String>,

    #[serde(default)]
    pub ssh: SshTunnel,

    /// Guard rail: refuse to run anything but read-only statements.
    #[serde(default)]
    pub read_only: bool,
    /// Rows fetched per page in the data grid.
    #[serde(default = "default_page_size")]
    pub page_size: u32,
    /// Hard cap on rows returned by an ad-hoc query.
    #[serde(default = "default_max_rows")]
    pub max_rows: u32,
    #[serde(default = "default_timeout")]
    pub connect_timeout_secs: u64,

    #[serde(default)]
    pub created_at: Option<String>,
    #[serde(default)]
    pub updated_at: Option<String>,
}

fn default_host() -> String {
    "127.0.0.1".into()
}
fn default_page_size() -> u32 {
    500
}
fn default_max_rows() -> u32 {
    50_000
}
fn default_timeout() -> u64 {
    15
}

impl ConnectionProfile {
    /// Create a profile with sensible defaults for the given engine.
    pub fn new(name: impl Into<String>, kind: DbKind) -> Self {
        ConnectionProfile {
            id: uuid::Uuid::new_v4().to_string(),
            name: name.into(),
            kind,
            group: None,
            color: None,
            host: default_host(),
            port: kind.default_port().unwrap_or(0),
            username: String::new(),
            password: String::new(),
            database: None,
            file: None,
            ssl_mode: SslMode::default(),
            params: BTreeMap::new(),
            ssh: SshTunnel::default(),
            read_only: false,
            page_size: default_page_size(),
            max_rows: default_max_rows(),
            connect_timeout_secs: default_timeout(),
            created_at: Some(chrono::Utc::now().to_rfc3339()),
            updated_at: None,
        }
    }

    /// Fill in defaults that may be missing after a hand-edit of the JSON store.
    pub fn normalise(&mut self) {
        if self.port == 0 {
            self.port = self.kind.default_port().unwrap_or(0);
        }
        if self.page_size == 0 {
            self.page_size = default_page_size();
        }
        if self.max_rows == 0 {
            self.max_rows = default_max_rows();
        }
        if self.connect_timeout_secs == 0 {
            self.connect_timeout_secs = default_timeout();
        }
        if self.ssh.port == 0 {
            self.ssh.port = 22;
        }
    }

    /// Never send the raw password to the UI; the frontend only needs to know
    /// whether one is stored.
    pub fn redacted(&self) -> Self {
        let mut clone = self.clone();
        if !clone.password.is_empty() {
            clone.password = MASK.to_string();
        }
        if !clone.ssh.password.is_empty() {
            clone.ssh.password = MASK.to_string();
        }
        if clone.ssh.passphrase.is_some() {
            clone.ssh.passphrase = Some(MASK.to_string());
        }
        clone
    }

    /// Restore masked secrets from the previously stored profile.
    pub fn merge_secrets(&mut self, previous: &ConnectionProfile) {
        if self.password == MASK {
            self.password = previous.password.clone();
        }
        if self.ssh.password == MASK {
            self.ssh.password = previous.ssh.password.clone();
        }
        if self.ssh.passphrase.as_deref() == Some(MASK) {
            self.ssh.passphrase = previous.ssh.passphrase.clone();
        }
    }
}

/// Sentinel returned in place of a stored secret.
pub const MASK: &str = "\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}\u{2022}";

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

/// The kind of node in the object tree.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ObjectKind {
    Server,
    Database,
    Schema,
    Table,
    View,
    MaterializedView,
    Column,
    Index,
    ForeignKey,
    Trigger,
    Function,
    Procedure,
    Sequence,
    Folder,
}

/// A lightweight reference to a database object.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ObjectRef {
    pub kind: ObjectKind,
    pub name: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub row_count: Option<i64>,
    #[serde(default)]
    pub size_bytes: Option<i64>,
    #[serde(default)]
    pub extra: BTreeMap<String, String>,
}

impl ObjectRef {
    pub fn new(kind: ObjectKind, name: impl Into<String>) -> Self {
        ObjectRef {
            kind,
            name: name.into(),
            database: None,
            schema: None,
            comment: None,
            row_count: None,
            size_bytes: None,
            extra: BTreeMap::new(),
        }
    }

    pub fn with_schema(mut self, schema: impl Into<String>) -> Self {
        self.schema = Some(schema.into());
        self
    }

    pub fn with_database(mut self, database: impl Into<String>) -> Self {
        self.database = Some(database.into());
        self
    }

    /// Fully qualified name, quoted for the dialect.
    pub fn qualified(&self, kind: DbKind) -> String {
        let q = kind.quote_char();
        let mut parts = Vec::new();
        if matches!(kind, DbKind::Mysql) {
            if let Some(db) = &self.database {
                parts.push(format!("{q}{db}{q}"));
            }
        } else if let Some(schema) = &self.schema {
            parts.push(format!("{q}{schema}{q}"));
        }
        parts.push(format!("{q}{}{q}", self.name));
        parts.join(".")
    }
}

/// A column definition as reported by the server.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnSchema {
    pub name: String,
    /// The declared type, exactly as the engine spells it.
    pub data_type: String,
    /// Coarse family used to choose an editor widget.
    pub logical_type: LogicalType,
    pub nullable: bool,
    #[serde(default)]
    pub default_value: Option<String>,
    #[serde(default)]
    pub is_primary_key: bool,
    #[serde(default)]
    pub is_auto_increment: bool,
    #[serde(default)]
    pub is_unique: bool,
    #[serde(default)]
    pub comment: Option<String>,
    pub ordinal: i32,
    #[serde(default)]
    pub char_max_length: Option<i64>,
    #[serde(default)]
    pub numeric_precision: Option<i64>,
    #[serde(default)]
    pub numeric_scale: Option<i64>,
    /// Engine specific extras (`on update CURRENT_TIMESTAMP`, `GENERATED`, ...).
    #[serde(default)]
    pub extra: Option<String>,
    /// Enum/set members, when the engine exposes them.
    #[serde(default)]
    pub enum_values: Vec<String>,
}

/// Coarse type family, decoupled from dialect specific type names.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum LogicalType {
    Boolean,
    Integer,
    Float,
    Decimal,
    String,
    Text,
    Binary,
    Date,
    Time,
    DateTime,
    Timestamp,
    Json,
    Uuid,
    Enum,
    Array,
    Geometry,
    #[default]
    Unknown,
}

impl LogicalType {
    pub fn align_right(&self) -> bool {
        matches!(
            self,
            LogicalType::Integer | LogicalType::Float | LogicalType::Decimal
        )
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexSchema {
    pub name: String,
    pub columns: Vec<String>,
    pub is_unique: bool,
    pub is_primary: bool,
    #[serde(default)]
    pub index_type: Option<String>,
    #[serde(default)]
    pub comment: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeySchema {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    #[serde(default)]
    pub ref_schema: Option<String>,
    #[serde(default)]
    pub on_update: Option<String>,
    #[serde(default)]
    pub on_delete: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TriggerSchema {
    pub name: String,
    #[serde(default)]
    pub timing: Option<String>,
    #[serde(default)]
    pub event: Option<String>,
    #[serde(default)]
    pub statement: Option<String>,
}

/// A complete table/view description.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TableSchema {
    pub name: String,
    pub kind: ObjectKind,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    pub columns: Vec<ColumnSchema>,
    #[serde(default)]
    pub indexes: Vec<IndexSchema>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeySchema>,
    #[serde(default)]
    pub triggers: Vec<TriggerSchema>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub row_count: Option<i64>,
    #[serde(default)]
    pub ddl: Option<String>,
    /// Engine specific extras (engine, charset, collation, tablespace, ...).
    #[serde(default)]
    pub options: BTreeMap<String, String>,
}

impl TableSchema {
    pub fn primary_key_columns(&self) -> Vec<String> {
        let mut pk: Vec<_> = self
            .columns
            .iter()
            .filter(|c| c.is_primary_key)
            .map(|c| c.name.clone())
            .collect();
        if pk.is_empty() {
            if let Some(idx) = self.indexes.iter().find(|i| i.is_primary) {
                pk = idx.columns.clone();
            }
        }
        pk
    }
}

// ---------------------------------------------------------------------------
// Query results
// ---------------------------------------------------------------------------

/// Metadata for one result set column.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnMeta {
    pub name: String,
    /// Engine type name, e.g. `VARCHAR(255)`, `int8`.
    pub type_name: String,
    #[serde(default)]
    pub logical_type: LogicalType,
    pub nullable: bool,
    #[serde(default)]
    pub table: Option<String>,
    /// True when this column is part of the table's primary key, which enables
    /// safe in-grid editing.
    #[serde(default)]
    pub is_primary_key: bool,
    /// Synthetic column (SQLite `rowid` and friends). Carried through the result
    /// so row identity survives, but never rendered by the grid.
    #[serde(default)]
    pub hidden: bool,
    /// Mirrors the underlying schema when the column came from a known table.
    /// The data grid uses these to build a sensible "insert row" form without a
    /// second round trip.
    #[serde(default)]
    pub is_auto_increment: bool,
    #[serde(default)]
    pub default_value: Option<String>,
    #[serde(default)]
    pub char_max_length: Option<i64>,
    #[serde(default)]
    pub comment: Option<String>,
}

/// The class of statement that was executed.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum StatementKind {
    Select,
    Insert,
    Update,
    Delete,
    Ddl,
    Other,
}

/// One result set produced by a statement.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryResult {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    /// Rows changed by DML/DDL.
    #[serde(default)]
    pub rows_affected: u64,
    #[serde(default)]
    pub last_insert_id: Option<i64>,
    pub elapsed_ms: f64,
    #[serde(default)]
    pub notices: Vec<String>,
    pub statement_kind: StatementKind,
    /// The statement text this result came from (useful for multi-statement runs).
    #[serde(default)]
    pub statement: String,
    /// True when the server reported more rows than the configured cap.
    #[serde(default)]
    pub truncated: bool,
}

impl QueryResult {
    pub fn empty(kind: StatementKind) -> Self {
        QueryResult {
            columns: Vec::new(),
            rows: Vec::new(),
            rows_affected: 0,
            last_insert_id: None,
            elapsed_ms: 0.0,
            notices: Vec::new(),
            statement_kind: kind,
            statement: String::new(),
            truncated: false,
        }
    }
}

/// A page of table data plus the information needed to edit it.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePage {
    pub columns: Vec<ColumnMeta>,
    pub rows: Vec<Vec<Value>>,
    pub offset: u64,
    pub limit: u32,
    #[serde(default)]
    pub total_rows: Option<i64>,
    /// Column names forming the row identity used for UPDATE/DELETE.
    pub key_columns: Vec<String>,
    #[serde(default)]
    pub editable: bool,
    #[serde(default)]
    pub reason: Option<String>,
    /// The exact SQL that produced this page, shown in the UI for transparency.
    pub sql: String,
    pub elapsed_ms: f64,
}

/// A single-cell mutation.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CellChange {
    pub column: String,
    /// Old value, used inside the WHERE clause to guard against lost updates.
    pub old_value: Value,
    pub new_value: Value,
}

/// A row-level edit request coming from the data grid.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowEdit {
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: String,
    /// Primary-key column -> value identifying the row.
    pub keys: BTreeMap<String, Value>,
    /// Column changes; empty for a delete.
    pub changes: Vec<CellChange>,
}

/// A brand new row to insert.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RowInsert {
    pub database: Option<String>,
    pub schema: Option<String>,
    pub table: String,
    pub values: BTreeMap<String, Value>,
}

// ---------------------------------------------------------------------------
// Server / session info
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServerInfo {
    pub version: String,
    #[serde(default)]
    pub edition: Option<String>,
    #[serde(default)]
    pub current_user: Option<String>,
    #[serde(default)]
    pub current_database: Option<String>,
    #[serde(default)]
    pub server_encoding: Option<String>,
    #[serde(default)]
    pub timezone: Option<String>,
    #[serde(default)]
    pub max_connections: Option<i64>,
    #[serde(default)]
    pub uptime_secs: Option<i64>,
}

/// A live connection as seen by the UI.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionInfo {
    pub session_id: String,
    pub profile_id: String,
    pub profile_name: String,
    pub kind: DbKind,
    pub server: ServerInfo,
    pub opened_at: String,
    /// `true` when the connection is carried over an SSH tunnel.
    pub tunnelled: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DatabaseInfo {
    pub name: String,
    #[serde(default)]
    pub is_system: bool,
    #[serde(default)]
    pub size_bytes: Option<i64>,
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub charset: Option<String>,
}

// ---------------------------------------------------------------------------
// Table designer plans
// ---------------------------------------------------------------------------

/// One column in the table designer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ColumnPlan {
    pub name: String,
    /// Engine-specific type as typed by the user, e.g. `varchar(255)`.
    pub data_type: String,
    #[serde(default = "default_true")]
    pub nullable: bool,
    #[serde(default)]
    pub default_value: Option<String>,
    #[serde(default)]
    pub is_primary_key: bool,
    #[serde(default)]
    pub is_auto_increment: bool,
    #[serde(default)]
    pub is_unique: bool,
    #[serde(default)]
    pub comment: Option<String>,
    /// Set when the column already exists; used to detect renames during a diff.
    #[serde(default)]
    pub original_name: Option<String>,
    /// Marked for removal by the designer.
    #[serde(default)]
    pub dropped: bool,
    #[serde(default)]
    pub enum_values: Vec<String>,
}

fn default_true() -> bool {
    true
}

/// One index in the table designer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IndexPlan {
    pub name: String,
    pub columns: Vec<String>,
    #[serde(default)]
    pub is_unique: bool,
    #[serde(default)]
    pub is_primary: bool,
    #[serde(default)]
    pub is_new: bool,
    #[serde(default)]
    pub dropped: bool,
}

/// One foreign key in the table designer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ForeignKeyPlan {
    pub name: String,
    pub columns: Vec<String>,
    pub ref_table: String,
    pub ref_columns: Vec<String>,
    #[serde(default)]
    pub ref_schema: Option<String>,
    #[serde(default)]
    pub on_update: Option<String>,
    #[serde(default)]
    pub on_delete: Option<String>,
    #[serde(default)]
    pub dropped: bool,
}

/// A complete create/alter request produced by the table designer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TablePlan {
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    /// Target name (after any rename).
    pub name: String,
    /// Previous name when the object is being renamed.
    #[serde(default)]
    pub original_name: Option<String>,
    pub kind: ObjectKind,
    pub columns: Vec<ColumnPlan>,
    #[serde(default)]
    pub indexes: Vec<IndexPlan>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyPlan>,
    /// Engine-specific table options (engine, charset, collation, tablespace).
    #[serde(default)]
    pub options: BTreeMap<String, String>,
    /// `true` for a brand new object, `false` when altering an existing one.
    #[serde(default)]
    pub is_new: bool,
}

impl TablePlan {
    pub fn column(&self, name: &str) -> Option<&ColumnPlan> {
        self.columns.iter().find(|c| c.name == name)
    }
}

/// The SQL a plan expands to, ready to be reviewed and executed.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DdlPlan {
    /// One entry per statement, in execution order.
    pub statements: Vec<String>,
    /// Human-readable warnings (e.g. "SQLite rebuilds the table for this change").
    #[serde(default)]
    pub warnings: Vec<String>,
    /// `true` when applying the plan destroys and recreates the object.
    #[serde(default)]
    pub destructive: bool,
}

impl DdlPlan {
    pub fn new(statements: Vec<String>) -> Self {
        DdlPlan {
            statements,
            warnings: Vec::new(),
            destructive: false,
        }
    }

    pub fn with_warning(mut self, warning: impl Into<String>) -> Self {
        self.warnings.push(warning.into());
        self
    }

    pub fn script(&self) -> String {
        self.statements.join(";\n\n")
    }
}
