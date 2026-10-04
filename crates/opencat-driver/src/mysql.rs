//! MySQL / MariaDB driver.
//!
//! MySQL has no schema layer below the database: `database` is the only
//! qualifier an object ever carries, so [`Driver::list_schemas`] returns
//! nothing and every relation is addressed as `` `db`.`table` ``.
//!
//! Introspection therefore reads `information_schema` — the data dictionary
//! MySQL 8 builds on top of the InnoDB catalog — with two deliberate
//! exceptions: `SHOW CREATE TABLE`/`SHOW CREATE VIEW` for DDL (no view in
//! `information_schema` reproduces a statement faithfully) and `SHOW GLOBAL
//! STATUS` for the server uptime.
//!
//! Row identity for the data grid comes from the primary key or, failing that,
//! from the first unique index whose columns are all `NOT NULL`. MySQL has no
//! analogue of SQLite's implicit `rowid`, so a keyless table is browsable but
//! read-only — editing it would risk rewriting the wrong row.
//!
//! All statements are sent through the *text* protocol (`sqlx::query` without
//! bound arguments). That is what lets `decode_cell` parse dates, decimals
//! and JSON straight out of the text MySQL sends: the binary protocol would
//! collapse `DECIMAL` into a float and lose the exact digits the grid needs to
//! write a value back unchanged.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bigdecimal::BigDecimal;
use chrono::{NaiveDate, NaiveDateTime, NaiveTime, Timelike};
use sqlx::mysql::{MySqlConnectOptions, MySqlPool, MySqlPoolOptions, MySqlRow, MySqlSslMode};
use sqlx::{Column, Row, TypeInfo, ValueRef};

use opencat_core::model::{
    ColumnMeta, ColumnSchema, DatabaseInfo, DbKind, ForeignKeySchema, IndexSchema, LogicalType,
    ObjectKind, ObjectRef, QueryResult, RowEdit, RowInsert, ServerInfo, TablePage, TableSchema,
    TriggerSchema,
};
use opencat_core::sql::{
    classify_statement, escape_literal, is_read_only, split_statements, summarise,
};
use opencat_core::value::Value;
use opencat_core::{is_system_schema, CoreError, Result};

use crate::common;
use crate::traits::{
    CountRequest, Driver, DriverConfig, FindRequest, OrderBy, PageRequest, QueryOptions, Scope,
};

/// A foreign key mid-assembly.
///
/// `information_schema` reports one row per column of a composite key, so the
/// key is accumulated as the schema under construction plus its column pairs,
/// each tagged with `ORDINAL_POSITION` so the local and referenced lists can be
/// sorted back into alignment.
type ForeignKeyUnderConstruction = (ForeignKeySchema, Vec<(i64, String, String)>);

/// MySQL / MariaDB connection.
pub struct MySqlDriver {
    pool: MySqlPool,
    read_only: bool,
    timeout: Duration,
    max_rows: u32,
}

impl MySqlDriver {
    /// Open a connection pool.
    pub async fn connect(cfg: &DriverConfig) -> Result<Self> {
        let profile = &cfg.profile;
        let (host, port) = cfg.endpoint();
        let mut opts = MySqlConnectOptions::new()
            .host(&host)
            .port(port)
            .username(&profile.username)
            .password(&profile.password)
            .ssl_mode(match profile.ssl_mode {
                opencat_core::model::SslMode::Disable => MySqlSslMode::Disabled,
                opencat_core::model::SslMode::Prefer => MySqlSslMode::Preferred,
                opencat_core::model::SslMode::Require => MySqlSslMode::Required,
                opencat_core::model::SslMode::VerifyCa => MySqlSslMode::VerifyCa,
                opencat_core::model::SslMode::VerifyFull => MySqlSslMode::VerifyIdentity,
            });
        if let Some(db) = profile.database.as_deref().filter(|d| !d.is_empty()) {
            opts = opts.database(db);
        }

        let pool = MySqlPoolOptions::new()
            .max_connections(cfg.max_connections.max(1))
            .acquire_timeout(Duration::from_secs(profile.connect_timeout_secs.max(1)))
            .connect_with(opts)
            .await
            .map_err(crate::traits::classify_error)?;

        Ok(MySqlDriver {
            pool,
            read_only: profile.read_only,
            timeout: Duration::from_secs(profile.connect_timeout_secs.max(1) * 8),
            max_rows: profile.max_rows,
        })
    }

    /// Run a query, enforcing the client-side deadline.
    async fn fetch_all(&self, sql: &str) -> Result<Vec<MySqlRow>> {
        let fut = sqlx::query(sql).fetch_all(&self.pool);
        tokio::time::timeout(self.timeout, fut)
            .await
            .map_err(|_| CoreError::Query(format!("query timed out: {}", summarise(sql, 80))))?
            .map_err(crate::traits::classify_error)
    }

    async fn execute_raw(&self, sql: &str) -> Result<(u64, Option<i64>)> {
        let fut = sqlx::query(sql).execute(&self.pool);
        let result = tokio::time::timeout(self.timeout, fut)
            .await
            .map_err(|_| CoreError::Query(format!("statement timed out: {}", summarise(sql, 80))))?
            .map_err(crate::traits::classify_error)?;

        // MySQL reports `0` when a statement generated no value at all (no
        // auto-increment column involved), which means "no id", not "id 0".
        let last_id = i64::try_from(result.last_insert_id())
            .ok()
            .filter(|id| *id != 0);
        Ok((result.rows_affected(), last_id))
    }

    fn guard_write(&self) -> Result<()> {
        if self.read_only {
            return Err(CoreError::Invalid(
                "connection was opened read-only; writes are disabled".into(),
            ));
        }
        Ok(())
    }

    /// How many rows a result set may keep before it is flagged as truncated.
    /// `0` in the profile means "unlimited" rather than "return nothing".
    fn row_cap(&self) -> usize {
        row_cap(self.max_rows)
    }

    async fn current_database(&self) -> Result<Option<String>> {
        let rows = self
            .fetch_all("SELECT DATABASE() AS current_database")
            .await?;
        Ok(rows
            .first()
            .and_then(|row| opt_string(row, "current_database"))
            .filter(|db| !db.is_empty()))
    }

    /// The database `scope` refers to, falling back to the session's current
    /// database. `None` when neither is set.
    async fn optional_database(&self, scope: &Scope) -> Result<Option<String>> {
        if let Some(db) = scope
            .database
            .as_deref()
            .map(str::trim)
            .filter(|db| !db.is_empty())
        {
            return Ok(Some(db.to_string()));
        }
        self.current_database().await
    }

    /// Same as [`Self::optional_database`] but fails loudly: every
    /// introspection path needs a database to filter `information_schema` by.
    async fn database_name(&self, scope: &Scope) -> Result<String> {
        self.optional_database(scope).await?.ok_or_else(|| {
            CoreError::Config("no MySQL database is selected for this session".into())
        })
    }

    /// `SHOW CREATE TABLE` on a view returns the view definition, so ask for the
    /// object that was actually opened and fall back for older servers.
    async fn ddl_of(&self, scope: &Scope, name: &str, kind: ObjectKind) -> Result<String> {
        let object = relation(scope, name);
        let statement = match kind {
            ObjectKind::View | ObjectKind::MaterializedView => {
                format!("SHOW CREATE VIEW {object}")
            },
            _ => format!("SHOW CREATE TABLE {object}"),
        };
        let rows = self.fetch_all(&statement).await?;
        let row = rows
            .first()
            .ok_or_else(|| CoreError::NotFound(format!("`{name}` has no stored DDL")))?;

        // The DDL column is named `Create Table` / `Create View` (MySQL appends
        // `character_set_client` and `collation_connection` for views), so read
        // it positionally instead of by name.
        row.try_get_unchecked::<String, _>(1usize)
            .map_err(|_| CoreError::NotFound(format!("`{name}` has no stored DDL")))
    }

    async fn columns_of(&self, db: &str, table: &str) -> Result<Vec<ColumnSchema>> {
        let sql = format!(
            "SELECT COLUMN_NAME AS name, COLUMN_TYPE AS column_type, IS_NULLABLE AS is_nullable, \
                    COLUMN_DEFAULT AS column_default, COLUMN_KEY AS column_key, EXTRA AS extra, \
                    COLUMN_COMMENT AS column_comment, ORDINAL_POSITION AS ordinal, \
                    CHARACTER_MAXIMUM_LENGTH AS char_length, \
                    NUMERIC_PRECISION AS numeric_precision, NUMERIC_SCALE AS numeric_scale \
             FROM information_schema.COLUMNS \
             WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} \
             ORDER BY ORDINAL_POSITION",
            quote_literal(db),
            quote_literal(table)
        );
        let rows = self.fetch_all(&sql).await?;

        Ok(rows
            .iter()
            .filter_map(|row| {
                let name = opt_string(row, "name")?;
                let column_type = opt_string(row, "column_type").unwrap_or_default();
                let extra = opt_string(row, "extra").unwrap_or_default();
                let column_key = opt_string(row, "column_key").unwrap_or_default();

                // `COLUMN_TYPE` is the only place the enum/set members, the
                // display width of `tinyint(1)` and the `unsigned` suffix
                // survive, so both the logical family and the members come from
                // it rather than from the bare `DATA_TYPE`.
                let logical_type = common::logical_type(DbKind::Mysql, &column_type);
                let enum_values = parse_enum_values(&column_type);

                Some(ColumnSchema {
                    name,
                    data_type: if column_type.is_empty() {
                        "text".into()
                    } else {
                        column_type
                    },
                    logical_type,
                    nullable: opt_string(row, "is_nullable")
                        .map(|v| v.eq_ignore_ascii_case("YES"))
                        .unwrap_or(true),
                    default_value: opt_string(row, "column_default"),
                    is_primary_key: column_key.eq_ignore_ascii_case("PRI"),
                    is_auto_increment: extra.to_ascii_lowercase().contains("auto_increment"),
                    is_unique: column_key.eq_ignore_ascii_case("UNI"),
                    comment: opt_string(row, "column_comment").filter(|c| !c.is_empty()),
                    ordinal: opt_i64(row, "ordinal").unwrap_or(0) as i32,
                    char_max_length: opt_i64(row, "char_length"),
                    numeric_precision: opt_i64(row, "numeric_precision"),
                    numeric_scale: opt_i64(row, "numeric_scale"),
                    extra: (!extra.is_empty()).then_some(extra),
                    enum_values,
                })
            })
            .collect())
    }

    /// Indexes, one entry per `INDEX_NAME`, with the member columns in
    /// `SEQ_IN_INDEX` order.
    async fn indexes_of(&self, db: &str, table: &str) -> Result<Vec<IndexSchema>> {
        let sql = format!(
            "SELECT INDEX_NAME AS name, NON_UNIQUE AS non_unique, SEQ_IN_INDEX AS seq, \
                    COLUMN_NAME AS column_name, INDEX_TYPE AS index_type, \
                    INDEX_COMMENT AS index_comment \
             FROM information_schema.STATISTICS \
             WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {} \
             ORDER BY INDEX_NAME, SEQ_IN_INDEX",
            quote_literal(db),
            quote_literal(table)
        );
        let rows = self.fetch_all(&sql).await?;

        let mut grouped: BTreeMap<String, (IndexSchema, Vec<(i64, String)>)> = BTreeMap::new();
        for row in &rows {
            let Some(name) = opt_string(row, "name") else {
                continue;
            };
            // Functional indexes report no `COLUMN_NAME`; skip the member so the
            // index is not silently advertised as single-column.
            let Some(column) = opt_string(row, "column_name").filter(|c| !c.is_empty()) else {
                continue;
            };
            let seq = opt_i64(row, "seq").unwrap_or(0);
            let (_, members) = grouped.entry(name.clone()).or_insert_with(|| {
                (
                    IndexSchema {
                        is_primary: name.eq_ignore_ascii_case("PRIMARY"),
                        is_unique: opt_i64(row, "non_unique").unwrap_or(1) == 0,
                        index_type: opt_string(row, "index_type").filter(|t| !t.is_empty()),
                        comment: opt_string(row, "index_comment").filter(|c| !c.is_empty()),
                        columns: Vec::new(),
                        name: name.clone(),
                    },
                    Vec::new(),
                )
            });
            members.push((seq, column));
        }

        Ok(grouped
            .into_values()
            .map(|(mut index, mut members)| {
                members.sort_by_key(|(seq, _)| *seq);
                index.columns = members.into_iter().map(|(_, column)| column).collect();
                index
            })
            .collect())
    }

    async fn foreign_keys_of(&self, db: &str, table: &str) -> Result<Vec<ForeignKeySchema>> {
        let sql = format!(
            "SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS column_name, \
                    k.ORDINAL_POSITION AS ordinal, k.REFERENCED_TABLE_SCHEMA AS ref_schema, \
                    k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_column, \
                    r.UPDATE_RULE AS on_update, r.DELETE_RULE AS on_delete \
             FROM information_schema.KEY_COLUMN_USAGE k \
             JOIN information_schema.REFERENTIAL_CONSTRAINTS r \
               ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA \
              AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME \
              AND r.TABLE_NAME = k.TABLE_NAME \
             WHERE k.TABLE_SCHEMA = {} AND k.TABLE_NAME = {} \
               AND k.REFERENCED_TABLE_NAME IS NOT NULL \
             ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION",
            quote_literal(db),
            quote_literal(table)
        );
        let rows = self.fetch_all(&sql).await?;

        // A composite foreign key spans several rows; `ORDINAL_POSITION` keeps
        // the local and referenced column lists aligned.
        let mut grouped: BTreeMap<String, ForeignKeyUnderConstruction> = BTreeMap::new();
        for row in &rows {
            let Some(name) = opt_string(row, "name") else {
                continue;
            };
            let column = opt_string(row, "column_name").unwrap_or_default();
            let ref_column = opt_string(row, "ref_column").unwrap_or_default();
            let ordinal = opt_i64(row, "ordinal").unwrap_or(0);
            let (_, members) = grouped.entry(name.clone()).or_insert_with(|| {
                (
                    ForeignKeySchema {
                        name: name.clone(),
                        columns: Vec::new(),
                        ref_table: opt_string(row, "ref_table").unwrap_or_default(),
                        ref_columns: Vec::new(),
                        ref_schema: opt_string(row, "ref_schema"),
                        on_update: opt_string(row, "on_update"),
                        on_delete: opt_string(row, "on_delete"),
                    },
                    Vec::new(),
                )
            });
            members.push((ordinal, column, ref_column));
        }

        Ok(grouped
            .into_values()
            .map(|(mut fk, mut members)| {
                members.sort_by_key(|(ordinal, _, _)| *ordinal);
                fk.columns = members.iter().map(|(_, c, _)| c.clone()).collect();
                fk.ref_columns = members.into_iter().map(|(_, _, rc)| rc).collect();
                fk
            })
            .collect())
    }

    async fn triggers_of(&self, db: &str, table: &str) -> Result<Vec<TriggerSchema>> {
        let sql = format!(
            "SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, \
                    EVENT_MANIPULATION AS event, ACTION_STATEMENT AS statement \
             FROM information_schema.TRIGGERS \
             WHERE TRIGGER_SCHEMA = {} AND EVENT_OBJECT_TABLE = {} \
             ORDER BY TRIGGER_NAME",
            quote_literal(db),
            quote_literal(table)
        );
        let rows = self.fetch_all(&sql).await?;
        Ok(rows
            .iter()
            .map(|row| TriggerSchema {
                name: opt_string(row, "name").unwrap_or_default(),
                timing: opt_string(row, "timing"),
                event: opt_string(row, "event"),
                statement: opt_string(row, "statement"),
            })
            .collect())
    }

    /// Table comment, engine/charset options and the row-count estimate kept in
    /// the data dictionary (exact for MyISAM, approximate for InnoDB).
    async fn table_options_of(
        &self,
        db: &str,
        table: &str,
    ) -> Result<(Option<String>, BTreeMap<String, String>, Option<i64>)> {
        let sql = format!(
            "SELECT ENGINE AS engine, TABLE_COLLATION AS collation, TABLE_COMMENT AS comment, \
                    CREATE_OPTIONS AS create_options, TABLE_ROWS AS row_count \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}",
            quote_literal(db),
            quote_literal(table)
        );
        let rows = self.fetch_all(&sql).await?;
        let Some(row) = rows.first() else {
            return Ok((None, BTreeMap::new(), None));
        };

        let mut options = BTreeMap::new();
        for (key, column) in [
            ("engine", "engine"),
            ("collation", "collation"),
            ("createOptions", "create_options"),
        ] {
            if let Some(value) = opt_string(row, column).filter(|v| !v.is_empty()) {
                options.insert(key.to_string(), value);
            }
        }

        // MySQL stores the literal string `VIEW` in `TABLE_COMMENT` for views.
        let comment = opt_string(row, "comment").filter(|c| !c.is_empty() && c != "VIEW");
        Ok((comment, options, opt_i64(row, "row_count")))
    }

    /// Primary key columns present in `keys`, so composite keys are applied in
    /// index order. Falls back to the caller's own key order.
    async fn key_order(
        &self,
        scope: &Scope,
        table: &str,
        keys: &BTreeMap<String, Value>,
    ) -> Vec<String> {
        let mut ordered: Vec<String> = Vec::new();

        if let Some(db) = self.optional_database(scope).await.ok().flatten() {
            let sql = format!(
                "SELECT COLUMN_NAME AS name FROM information_schema.KEY_COLUMN_USAGE \
                 WHERE CONSTRAINT_NAME = 'PRIMARY' AND TABLE_SCHEMA = {} AND TABLE_NAME = {} \
                 ORDER BY ORDINAL_POSITION",
                quote_literal(&db),
                quote_literal(table)
            );
            if let Ok(rows) = self.fetch_all(&sql).await {
                for row in &rows {
                    if let Some(name) = opt_string(row, "name") {
                        if keys.contains_key(&name) && !ordered.contains(&name) {
                            ordered.push(name);
                        }
                    }
                }
            }
        }

        for key in keys.keys() {
            if !ordered.contains(key) {
                ordered.push(key.clone());
            }
        }
        ordered
    }

    /// `SHOW GLOBAL STATUS LIKE 'Uptime'`; absent when the account lacks the
    /// privilege, which is not worth failing `server_info` over.
    async fn uptime_seconds(&self) -> Option<i64> {
        let rows = self
            .fetch_all("SHOW GLOBAL STATUS LIKE 'Uptime'")
            .await
            .ok()?;
        rows.first()
            .and_then(|row| opt_string(row, "Value"))
            .and_then(|value| value.trim().parse().ok())
    }
}

// ---------------------------------------------------------------------------
// Dialect helpers
// ---------------------------------------------------------------------------

/// `` `db`.`table` ``, dropping an empty or absent database qualifier so the
/// session's current database applies.
fn relation(scope: &Scope, table: &str) -> String {
    let database = scope
        .database
        .as_deref()
        .map(str::trim)
        .filter(|db| !db.is_empty())
        .map(str::to_string);
    common::relation(
        &Scope {
            database,
            schema: None,
        },
        table,
        DbKind::Mysql,
    )
}

/// Quote a value for the `information_schema` filters built below.
fn quote_literal(value: &str) -> String {
    escape_literal(value, DbKind::Mysql)
}

/// Build a [`Scope`] from the loose `database`/`schema` pair carried by
/// [`RowEdit`] and [`RowInsert`] — MySQL never uses a schema, and callers
/// occasionally put the database there.
fn scope_of(database: Option<&str>, schema: Option<&str>) -> Scope {
    let database = database
        .into_iter()
        .chain(schema)
        .map(str::trim)
        .find(|db| !db.is_empty())
        .map(str::to_string);
    Scope {
        database,
        schema: None,
    }
}

/// Rows a result set may keep; a profile cap of `0` means "no cap".
fn row_cap(max_rows: u32) -> usize {
    if max_rows == 0 {
        usize::MAX
    } else {
        max_rows as usize
    }
}

/// Statements that produce a result set rather than an affected-row count.
fn returns_rows(sql: &str) -> bool {
    match classify_statement(sql) {
        opencat_core::model::StatementKind::Select => true,
        opencat_core::model::StatementKind::Insert
        | opencat_core::model::StatementKind::Update
        | opencat_core::model::StatementKind::Delete => {
            sql.to_ascii_lowercase().contains("returning")
        },
        _ => false,
    }
}

/// Row identity for the data grid: the primary key, else the first unique index
/// whose columns are all `NOT NULL` (a unique index over nullable columns cannot
/// address a row unambiguously, because `NULL`s never compare equal).
fn choose_keys(schema: &TableSchema) -> Vec<String> {
    let primary = schema.primary_key_columns();
    if !primary.is_empty() {
        return primary;
    }

    let nullable: Vec<&str> = schema
        .columns
        .iter()
        .filter(|c| c.nullable)
        .map(|c| c.name.as_str())
        .collect();

    schema
        .indexes
        .iter()
        .filter(|index| index.is_unique && !index.is_primary)
        .find(|index| {
            !index.columns.is_empty()
                && index
                    .columns
                    .iter()
                    .all(|column| !nullable.contains(&column.as_str()))
        })
        .map(|index| index.columns.clone())
        .unwrap_or_default()
}

/// Split the members out of a MySQL `enum(...)`/`set(...)` column type.
///
/// The data dictionary escapes the members the same way an SQL string literal
/// is escaped, so both `\'` and `''` have to be understood.
fn parse_enum_values(column_type: &str) -> Vec<String> {
    let trimmed = column_type.trim();
    // `to_ascii_lowercase` only rewrites ASCII bytes, so byte offsets stay valid
    // for slicing the original.
    let lowered = trimmed.to_ascii_lowercase();
    let Some(open) = lowered.find('(') else {
        return Vec::new();
    };
    let base = lowered[..open].trim();
    if base != "enum" && base != "set" {
        return Vec::new();
    }
    let Some(close) = trimmed.rfind(')') else {
        return Vec::new();
    };
    if close <= open {
        return Vec::new();
    }
    split_members(&trimmed[open + 1..close])
}

fn split_members(inner: &str) -> Vec<String> {
    let chars: Vec<char> = inner.chars().collect();
    let mut members: Vec<String> = Vec::new();
    let mut current = String::new();
    let mut quoted = false;
    // Whether the member being built produced anything at all, so `enum('')`
    // yields one empty member while `enum()` yields none.
    let mut touched = false;
    let mut i = 0usize;

    while i < chars.len() {
        let c = chars[i];
        if quoted {
            match c {
                '\\' if i + 1 < chars.len() => {
                    current.push(unescape_member(chars[i + 1]));
                    touched = true;
                    i += 2;
                },
                '\'' if i + 1 < chars.len() && chars[i + 1] == '\'' => {
                    current.push('\'');
                    touched = true;
                    i += 2;
                },
                '\'' => {
                    quoted = false;
                    i += 1;
                },
                _ => {
                    current.push(c);
                    touched = true;
                    i += 1;
                },
            }
            continue;
        }
        match c {
            '\'' => {
                quoted = true;
                touched = true;
                i += 1;
            },
            ',' => {
                members.push(std::mem::take(&mut current));
                touched = false;
                i += 1;
            },
            // Whitespace outside the quotes is the server's formatting, never
            // part of a member; inside them it is significant.
            c if c.is_whitespace() => i += 1,
            _ => {
                current.push(c);
                touched = true;
                i += 1;
            },
        }
    }

    if touched {
        members.push(current);
    }
    members
}

/// Unescape one `\x` pair from a MySQL string literal.
fn unescape_member(escaped: char) -> char {
    match escaped {
        '0' => '\0',
        'b' => '\u{8}',
        'n' => '\n',
        'r' => '\r',
        't' => '\t',
        'Z' => '\u{1a}',
        other => other,
    }
}

fn format_naive_time(value: NaiveTime) -> String {
    // `Timelike::nanosecond` must be called through the trait: chrono 0.4.45
    // added a private inherent method with the same name that otherwise wins
    // method resolution.
    if Timelike::nanosecond(&value) == 0 {
        value.format("%H:%M:%S").to_string()
    } else {
        value.format("%H:%M:%S%.6f").to_string()
    }
}

fn format_naive_datetime(value: NaiveDateTime) -> String {
    if Timelike::nanosecond(&value) == 0 {
        value.format("%Y-%m-%d %H:%M:%S").to_string()
    } else {
        value.format("%Y-%m-%d %H:%M:%S%.6f").to_string()
    }
}

// ---------------------------------------------------------------------------
// Cell decoding
// ---------------------------------------------------------------------------

/// Which Rust type a MySQL type name is read as.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum DecodeAs {
    Bool,
    Int,
    Uint,
    Float,
    Decimal,
    Date,
    Time,
    DateTime,
    Text,
    Json,
    Bytes,
    Fallback,
}

/// Map the type name the MySQL server reported to the family used to decode it.
///
/// `name()` is the server's own spelling, normalised by `sqlx`: `TINYINT(1)`
/// arrives as `BOOLEAN`, the `BINARY` flag turns `CHAR`/`VARCHAR` into
/// `BINARY`/`VARBINARY` and `TEXT` into `BLOB`, and unsigned integers carry an
/// ` UNSIGNED` suffix.
fn decode_as(type_name: &str) -> DecodeAs {
    match type_name.trim().to_ascii_uppercase().as_str() {
        // `BOOLEAN` is what the server reports for `TINYINT(1)`; `BIT` is the
        // one-bit integer type. Both surface as booleans.
        "BOOLEAN" | "BOOL" | "BIT" => DecodeAs::Bool,
        "TINYINT" | "SMALLINT" | "MEDIUMINT" | "INT" | "INTEGER" | "BIGINT" | "YEAR" | "SERIAL" => {
            DecodeAs::Int
        },
        "TINYINT UNSIGNED" | "SMALLINT UNSIGNED" | "MEDIUMINT UNSIGNED" | "INT UNSIGNED"
        | "INTEGER UNSIGNED" | "BIGINT UNSIGNED" | "YEAR UNSIGNED" => DecodeAs::Uint,
        "FLOAT" | "DOUBLE" | "REAL" | "DOUBLE PRECISION" => DecodeAs::Float,
        "DECIMAL" | "NUMERIC" | "NEWDECIMAL" | "DEC" | "FIXED" => DecodeAs::Decimal,
        "DATE" => DecodeAs::Date,
        "TIME" => DecodeAs::Time,
        "DATETIME" | "TIMESTAMP" => DecodeAs::DateTime,
        "CHAR" | "VARCHAR" | "STRING" | "VARSTRING" | "TEXT" | "TINYTEXT" | "MEDIUMTEXT"
        | "LONGTEXT" | "ENUM" | "SET" => DecodeAs::Text,
        "JSON" => DecodeAs::Json,
        "BINARY" | "VARBINARY" | "TINYBLOB" | "BLOB" | "MEDIUMBLOB" | "LONGBLOB" | "GEOMETRY"
        | "LONG VARBINARY" => DecodeAs::Bytes,
        _ => DecodeAs::Fallback,
    }
}

/// Decode one cell from the text MySQL sent, using the server's declared type.
fn decode_cell(row: &MySqlRow, idx: usize) -> Value {
    let raw = match row.try_get_raw(idx) {
        Ok(raw) => raw,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }

    let declared = row.column(idx).type_info().name().to_string();
    let name = declared.to_ascii_uppercase();

    // `BIT(M)` is a bit *string*, not an integer: only the one-bit form is a
    // boolean, and every wider form keeps its bits as an unsigned integer.
    // `u64` is also the only decoder that understands the raw byte form BIT
    // arrives in.
    if name == "BIT" {
        if let Ok(bits) = row.try_get_unchecked::<u64, _>(idx) {
            return if bits <= 1 {
                Value::Bool(bits == 1)
            } else {
                Value::Uint(bits)
            };
        }
    }

    match decode_as(&declared) {
        DecodeAs::Bool => {
            if let Ok(v) = row.try_get_unchecked::<bool, _>(idx) {
                return Value::Bool(v);
            }
            if let Ok(v) = row.try_get_unchecked::<u64, _>(idx) {
                return Value::Bool(v != 0);
            }
            if let Ok(v) = row.try_get_unchecked::<i64, _>(idx) {
                return Value::Bool(v != 0);
            }
        },
        DecodeAs::Int => {
            if let Ok(v) = row.try_get_unchecked::<i64, _>(idx) {
                return Value::Int(v);
            }
            if let Ok(v) = row.try_get_unchecked::<u64, _>(idx) {
                return Value::Uint(v);
            }
            if let Ok(v) = row.try_get_unchecked::<f64, _>(idx) {
                return Value::Float(v);
            }
            if let Ok(v) = row.try_get_unchecked::<String, _>(idx) {
                return Value::Text(v);
            }
        },
        DecodeAs::Uint => {
            if let Ok(v) = row.try_get_unchecked::<u64, _>(idx) {
                return Value::Uint(v);
            }
            if let Ok(v) = row.try_get_unchecked::<i64, _>(idx) {
                return Value::Int(v);
            }
            if let Ok(v) = row.try_get_unchecked::<f64, _>(idx) {
                return Value::Float(v);
            }
            if let Ok(v) = row.try_get_unchecked::<String, _>(idx) {
                return Value::Text(v);
            }
        },
        DecodeAs::Float => {
            if let Ok(v) = row.try_get_unchecked::<f64, _>(idx) {
                return Value::Float(v);
            }
            if let Ok(v) = row.try_get_unchecked::<String, _>(idx) {
                if let Ok(parsed) = v.trim().parse::<f64>() {
                    return Value::Float(parsed);
                }
                return Value::Text(v);
            }
        },
        DecodeAs::Decimal => {
            if let Ok(v) = row.try_get_unchecked::<BigDecimal, _>(idx) {
                return Value::Decimal(v.to_string());
            }
            // Keep the exact text the server sent rather than rounding it
            // through a float.
            if let Ok(v) = row.try_get_unchecked::<String, _>(idx) {
                return Value::Decimal(v);
            }
        },
        DecodeAs::Date => {
            if let Ok(v) = row.try_get_unchecked::<NaiveDate, _>(idx) {
                return Value::Date(v.format("%Y-%m-%d").to_string());
            }
            // `0000-00-00` is not a valid date but MySQL stores it happily.
            if let Ok(v) = row.try_get_unchecked::<String, _>(idx) {
                return Value::Date(v);
            }
        },
        DecodeAs::Time => {
            if let Ok(v) = row.try_get_unchecked::<NaiveTime, _>(idx) {
                return Value::Time(format_naive_time(v));
            }
            // Negative and multi-day `TIME` values do not fit `NaiveTime`.
            if let Ok(v) = row.try_get_unchecked::<String, _>(idx) {
                return Value::Time(v);
            }
        },
        DecodeAs::DateTime => {
            if let Ok(v) = row.try_get_unchecked::<NaiveDateTime, _>(idx) {
                return Value::DateTime(format_naive_datetime(v));
            }
            if let Ok(v) = row.try_get_unchecked::<String, _>(idx) {
                return Value::DateTime(v);
            }
        },
        DecodeAs::Text => {
            if let Ok(v) = row.try_get_unchecked::<String, _>(idx) {
                return Value::Text(v);
            }
            if let Ok(v) = row.try_get_unchecked::<Vec<u8>, _>(idx) {
                return Value::Bytes(v);
            }
        },
        DecodeAs::Json => {
            if let Ok(text) = row.try_get_unchecked::<String, _>(idx) {
                // Store compact JSON so the grid, exports and the editor all
                // see one canonical spelling.
                return match serde_json::from_str::<serde_json::Value>(&text) {
                    Ok(parsed) => Value::Json(parsed.to_string()),
                    // MariaDB lets a `JSON` column hold arbitrary text.
                    Err(_) => Value::Text(text),
                };
            }
        },
        DecodeAs::Bytes => {
            if let Ok(v) = row.try_get_unchecked::<Vec<u8>, _>(idx) {
                return Value::Bytes(v);
            }
            if let Ok(v) = row.try_get_unchecked::<String, _>(idx) {
                return Value::Text(v);
            }
        },
        DecodeAs::Fallback => {},
    }

    decode_fallback(row, idx)
}

/// Last-resort chain for exotic types (MariaDB `INET6`, user UDTs, expressions
/// with an unexpected type).
fn decode_fallback(row: &MySqlRow, idx: usize) -> Value {
    if let Ok(v) = row.try_get_unchecked::<i64, _>(idx) {
        return Value::Int(v);
    }
    if let Ok(v) = row.try_get_unchecked::<u64, _>(idx) {
        return Value::Uint(v);
    }
    if let Ok(v) = row.try_get_unchecked::<f64, _>(idx) {
        return Value::Float(v);
    }
    if let Ok(v) = row.try_get_unchecked::<String, _>(idx) {
        return Value::Text(v);
    }
    if let Ok(v) = row.try_get_unchecked::<Vec<u8>, _>(idx) {
        return Value::Bytes(v);
    }
    Value::Null
}

fn decode_row(row: &MySqlRow) -> Vec<Value> {
    (0..row.len()).map(|i| decode_cell(row, i)).collect()
}

fn build_columns(row: &MySqlRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|c| {
            let declared = c.type_info().name().to_string();
            ColumnMeta {
                name: c.name().to_string(),
                logical_type: common::logical_type(DbKind::Mysql, &declared),
                type_name: declared,
                // Result-set metadata does not carry nullability; the grid asks
                // the table schema when it needs to be precise.
                nullable: true,
                table: None,
                is_primary_key: false,
                hidden: false,
                is_auto_increment: false,
                default_value: None,
                char_max_length: None,
                comment: None,
            }
        })
        .collect()
}

/// Read a nullable integer from a column regardless of how MySQL typed it:
/// `BIGINT UNSIGNED`, `DECIMAL` (what `SUM()` produces) or the plain signed
/// integer types all end up here.
fn opt_i64(row: &MySqlRow, column: &str) -> Option<i64> {
    if let Ok(v) = row.try_get::<Option<i64>, _>(column) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get::<Option<u64>, _>(column) {
        return i64::try_from(v).ok();
    }
    if let Ok(Some(v)) = row.try_get::<Option<BigDecimal>, _>(column) {
        return v.to_string().parse().ok();
    }
    if let Ok(Some(v)) = row.try_get_unchecked::<Option<String>, _>(column) {
        return v.trim().parse().ok();
    }
    None
}

/// Read a nullable text column, tolerating the `BINARY` flag MySQL puts on
/// some dictionary columns.
fn opt_string(row: &MySqlRow, column: &str) -> Option<String> {
    if let Ok(v) = row.try_get::<Option<String>, _>(column) {
        return v;
    }
    if let Ok(Some(v)) = row.try_get_unchecked::<Option<Vec<u8>>, _>(column) {
        return String::from_utf8(v).ok();
    }
    None
}

#[async_trait]
impl Driver for MySqlDriver {
    fn kind(&self) -> DbKind {
        DbKind::Mysql
    }

    async fn server_info(&self) -> Result<ServerInfo> {
        let rows = self
            .fetch_all(
                "SELECT VERSION() AS version, \
                        CURRENT_USER() AS current_user, \
                        DATABASE() AS current_database, \
                        @@version_comment AS version_comment, \
                        @@character_set_server AS charset, \
                        @@collation_server AS collation, \
                        @@time_zone AS time_zone, \
                        @@system_time_zone AS system_time_zone, \
                        @@max_connections AS max_connections",
            )
            .await?;
        let row = rows
            .first()
            .ok_or_else(|| CoreError::Connection("the server returned no version row".into()))?;

        let version = opt_string(row, "version").unwrap_or_else(|| "unknown".into());
        let version_comment = opt_string(row, "version_comment").filter(|c| !c.trim().is_empty());
        let edition = match version_comment {
            Some(comment) => comment,
            None if version.to_ascii_lowercase().contains("mariadb") => "MariaDB".into(),
            None => "MySQL".into(),
        };

        // `@@time_zone` is `SYSTEM` on a default install; the real zone is then
        // `@@system_time_zone`.
        let timezone = match opt_string(row, "time_zone") {
            Some(zone) if !zone.eq_ignore_ascii_case("SYSTEM") => Some(zone),
            _ => opt_string(row, "system_time_zone"),
        };

        let encoding = match (opt_string(row, "charset"), opt_string(row, "collation")) {
            (Some(charset), Some(collation)) => Some(format!("{charset} ({collation})")),
            (Some(charset), None) => Some(charset),
            (None, collation) => collation,
        };

        Ok(ServerInfo {
            version,
            edition: Some(edition),
            current_user: opt_string(row, "current_user"),
            current_database: opt_string(row, "current_database").filter(|db| !db.is_empty()),
            server_encoding: encoding,
            timezone,
            max_connections: opt_i64(row, "max_connections"),
            uptime_secs: self.uptime_seconds().await,
        })
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        // `TABLES` is joined rather than aggregated per schema so the whole
        // catalog is read with one pass.
        let rows = self
            .fetch_all(
                "SELECT s.SCHEMA_NAME AS name, \
                        s.DEFAULT_CHARACTER_SET_NAME AS charset, \
                        t.size_bytes AS size_bytes \
                 FROM information_schema.SCHEMATA s \
                 LEFT JOIN ( \
                     SELECT TABLE_SCHEMA AS database_name, \
                            SUM(COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0)) AS size_bytes \
                     FROM information_schema.TABLES \
                     GROUP BY TABLE_SCHEMA \
                 ) t ON t.database_name = s.SCHEMA_NAME \
                 ORDER BY s.SCHEMA_NAME",
            )
            .await?;

        Ok(rows
            .iter()
            .filter_map(|row| {
                let name = opt_string(row, "name")?;
                Some(DatabaseInfo {
                    is_system: is_system_schema(DbKind::Mysql, &name),
                    name,
                    size_bytes: opt_i64(row, "size_bytes"),
                    comment: None,
                    charset: opt_string(row, "charset"),
                })
            })
            .collect())
    }

    async fn list_schemas(&self, _database: Option<&str>) -> Result<Vec<String>> {
        // MySQL has no schema layer below the database.
        Ok(Vec::new())
    }

    async fn list_objects(&self, scope: &Scope) -> Result<Vec<ObjectRef>> {
        let db = self.database_name(scope).await?;
        let sql = format!(
            "SELECT TABLE_NAME AS name, TABLE_TYPE AS object_type, TABLE_COMMENT AS comment, \
                    TABLE_ROWS AS row_count, \
                    COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS size_bytes \
             FROM information_schema.TABLES \
             WHERE TABLE_SCHEMA = {} \
             ORDER BY TABLE_TYPE, TABLE_NAME",
            quote_literal(&db)
        );
        let rows = self.fetch_all(&sql).await?;

        Ok(rows
            .iter()
            .filter_map(|row| {
                let name = opt_string(row, "name")?;
                let object_type = opt_string(row, "object_type")
                    .unwrap_or_default()
                    .to_ascii_uppercase();
                let kind = if object_type.contains("VIEW") {
                    ObjectKind::View
                } else {
                    ObjectKind::Table
                };

                let mut object = ObjectRef::new(kind, name);
                object.database = Some(db.clone());
                object.comment =
                    opt_string(row, "comment").filter(|c| !c.is_empty() && c != "VIEW");
                object.row_count = opt_i64(row, "row_count");
                object.size_bytes = opt_i64(row, "size_bytes");
                Some(object)
            })
            .collect())
    }

    async fn list_routines(&self, scope: &Scope) -> Result<Vec<ObjectRef>> {
        let db = self.database_name(scope).await?;

        let routines = self
            .fetch_all(&format!(
                "SELECT ROUTINE_NAME AS name, ROUTINE_TYPE AS routine_type, \
                        DTD_IDENTIFIER AS returns, ROUTINE_COMMENT AS comment \
                 FROM information_schema.ROUTINES \
                 WHERE ROUTINE_SCHEMA = {} \
                 ORDER BY ROUTINE_TYPE, ROUTINE_NAME",
                quote_literal(&db)
            ))
            .await?;

        let mut objects: Vec<ObjectRef> = routines
            .iter()
            .map(|row| {
                let routine_type = opt_string(row, "routine_type").unwrap_or_default();
                let kind = if routine_type.eq_ignore_ascii_case("PROCEDURE") {
                    ObjectKind::Procedure
                } else {
                    ObjectKind::Function
                };

                let mut object = ObjectRef::new(kind, opt_string(row, "name").unwrap_or_default());
                object.database = Some(db.clone());
                object.comment = opt_string(row, "comment").filter(|c| !c.is_empty());
                if let Some(returns) = opt_string(row, "returns").filter(|r| !r.is_empty()) {
                    object.extra.insert("returns".into(), returns);
                }
                object
            })
            .collect();

        // Triggers belong to a table, but the tree groups them with the routines
        // so they can be listed without opening every table.
        let triggers = self
            .fetch_all(&format!(
                "SELECT TRIGGER_NAME AS name, EVENT_OBJECT_TABLE AS table_name, \
                        ACTION_TIMING AS timing, EVENT_MANIPULATION AS event \
                 FROM information_schema.TRIGGERS \
                 WHERE TRIGGER_SCHEMA = {} \
                 ORDER BY TRIGGER_NAME",
                quote_literal(&db)
            ))
            .await
            .unwrap_or_default();

        objects.extend(triggers.iter().filter_map(|row| {
            let name = opt_string(row, "name")?;
            let mut object = ObjectRef::new(ObjectKind::Trigger, name);
            object.database = Some(db.clone());
            for (key, column) in [
                ("table", "table_name"),
                ("timing", "timing"),
                ("event", "event"),
            ] {
                if let Some(value) = opt_string(row, column).filter(|v| !v.is_empty()) {
                    object.extra.insert(key.to_string(), value);
                }
            }
            Some(object)
        }));

        Ok(objects)
    }

    async fn table_schema(
        &self,
        scope: &Scope,
        name: &str,
        kind: ObjectKind,
    ) -> Result<TableSchema> {
        let db = self.database_name(scope).await?;
        let mut columns = self.columns_of(&db, name).await?;
        let indexes = self.indexes_of(&db, name).await.unwrap_or_default();
        let foreign_keys = self.foreign_keys_of(&db, name).await.unwrap_or_default();
        let triggers = self.triggers_of(&db, name).await.unwrap_or_default();
        let (comment, options, row_count) =
            self.table_options_of(&db, name).await.unwrap_or_default();
        let ddl = self.ddl_of(scope, name, kind).await.ok();

        // `COLUMN_KEY` only marks the leading column of a unique index; promote
        // every column that is the sole member of one.
        for column in columns.iter_mut() {
            if !column.is_unique {
                column.is_unique = indexes.iter().any(|index| {
                    index.is_unique && index.columns.len() == 1 && index.columns[0] == column.name
                });
            }
        }

        Ok(TableSchema {
            name: name.to_string(),
            kind,
            database: Some(db),
            schema: None,
            columns,
            indexes,
            foreign_keys,
            triggers,
            comment,
            row_count,
            ddl,
            options,
        })
    }

    async fn table_ddl(&self, scope: &Scope, name: &str, kind: ObjectKind) -> Result<String> {
        self.ddl_of(scope, name, kind).await
    }

    async fn execute(&self, sql: &str, opts: &QueryOptions) -> Result<Vec<QueryResult>> {
        let statements = split_statements(sql);
        if statements.is_empty() {
            return Ok(Vec::new());
        }

        let mut results = Vec::with_capacity(statements.len());
        for statement in statements {
            // The profile's guard rail applies even when the caller did not ask
            // for it: a read-only connection must not run DML.
            if (opts.read_only || self.read_only) && !is_read_only(&statement) {
                return Err(CoreError::Invalid(format!(
                    "connection is read-only; refused: {}",
                    summarise(&statement, 60)
                )));
            }

            let started = Instant::now();
            let statement_kind = classify_statement(&statement);

            if returns_rows(&statement) {
                let rows = self.fetch_all(&statement).await?;
                let columns = rows.first().map(build_columns).unwrap_or_default();
                let mut values: Vec<Vec<Value>> = rows.iter().map(decode_row).collect();
                let cap = self.row_cap();
                let truncated = values.len() > cap;
                if truncated {
                    values.truncate(cap);
                }
                results.push(QueryResult {
                    columns,
                    rows: values,
                    rows_affected: 0,
                    last_insert_id: None,
                    elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
                    notices: Vec::new(),
                    statement_kind,
                    statement: statement.clone(),
                    truncated,
                });
            } else {
                let (affected, last_id) = self.execute_raw(&statement).await?;
                results.push(common::affected_result(
                    &statement,
                    affected,
                    last_id,
                    started.elapsed().as_secs_f64() * 1000.0,
                ));
            }
        }
        Ok(results)
    }

    async fn fetch_page(&self, req: &PageRequest) -> Result<TablePage> {
        let started = Instant::now();
        let schema = self
            .table_schema(&req.scope, &req.table, ObjectKind::Table)
            .await?;
        let columns = common::columns_from_schema(&schema);
        let key_columns = choose_keys(&schema);
        let column_names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();

        // Offset pagination without an `ORDER BY` lets MySQL return a row twice
        // (or not at all) between pages, so fall back to the key columns.
        let order_by = if req.order_by.is_empty() {
            key_columns
                .iter()
                .map(|column| OrderBy {
                    column: column.clone(),
                    desc: false,
                })
                .collect()
        } else {
            req.order_by.clone()
        };

        let sql = common::paged_select(&common::PageQuery {
            kind: DbKind::Mysql,
            scope: &req.scope,
            table: &req.table,
            columns: &column_names,
            order_by: &order_by,
            filter: req.filter.as_deref(),
            limit: req.limit,
            offset: req.offset,
        });
        let rows = self.fetch_all(&sql).await?;
        let decoded: Vec<Vec<Value>> = rows.iter().map(decode_row).collect();

        let total_rows = if req.include_total {
            self.count_rows(&CountRequest {
                scope: req.scope.clone(),
                table: req.table.clone(),
                filter: req.filter.clone(),
                approximate: false,
            })
            .await
            .ok()
        } else {
            None
        };

        let editable = !key_columns.is_empty() && !self.read_only;
        Ok(TablePage {
            columns,
            rows: decoded,
            offset: req.offset,
            limit: req.limit,
            total_rows,
            key_columns,
            editable,
            reason: if editable {
                None
            } else if self.read_only {
                Some("connection is read-only".into())
            } else {
                Some("table has no primary key or non-null unique index".into())
            },
            sql,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    }

    async fn count_rows(&self, req: &CountRequest) -> Result<i64> {
        // The data dictionary keeps a row estimate that costs nothing to read;
        // a filtered count has to touch the table either way.
        if req.approximate && req.filter.is_none() {
            if let Ok(Some(estimate)) = self.table_options_of_estimate(&req.scope, &req.table).await
            {
                return Ok(estimate);
            }
        }

        let sql =
            common::count_select(DbKind::Mysql, &req.scope, &req.table, req.filter.as_deref());
        let rows = self.fetch_all(&sql).await?;
        Ok(rows
            .first()
            .and_then(|row| opt_i64(row, "COUNT(*)"))
            .unwrap_or(0))
    }

    async fn find_rows(&self, req: &FindRequest) -> Result<TablePage> {
        let schema = self
            .table_schema(&req.scope, &req.table, ObjectKind::Table)
            .await?;
        let targets: Vec<String> = if req.columns.is_empty() {
            schema
                .columns
                .iter()
                .filter(|c| {
                    matches!(
                        c.logical_type,
                        LogicalType::String
                            | LogicalType::Text
                            | LogicalType::Json
                            | LogicalType::Enum
                    )
                })
                .map(|c| c.name.clone())
                .collect()
        } else {
            req.columns.clone()
        };
        if targets.is_empty() {
            return Err(CoreError::Invalid(format!(
                "`{}` has no text columns to search",
                req.table
            )));
        }

        let filter = common::search_predicate(DbKind::Mysql, &targets, &req.needle);
        self.fetch_page(&PageRequest {
            scope: req.scope.clone(),
            table: req.table.clone(),
            offset: 0,
            limit: if req.limit == 0 { 500 } else { req.limit },
            order_by: Vec::new(),
            filter: Some(filter),
            include_total: true,
        })
        .await
    }

    async fn update_row(&self, edit: &RowEdit) -> Result<u64> {
        if edit.changes.is_empty() {
            return Ok(0);
        }
        self.guard_write()?;

        let scope = scope_of(edit.database.as_deref(), edit.schema.as_deref());
        let key_order = self.key_order(&scope, &edit.table, &edit.keys).await;
        let changes: Vec<(String, Value, Value)> = edit
            .changes
            .iter()
            .map(|change| {
                (
                    change.column.clone(),
                    change.old_value.clone(),
                    change.new_value.clone(),
                )
            })
            .collect();

        // `skip_nulls = false`: an explicit NULL is a value the user typed.
        let sql = crate::edit::build_update(
            DbKind::Mysql,
            &scope,
            &edit.table,
            &edit.keys,
            &key_order,
            &changes,
        )?;
        let (affected, _) = self.execute_raw(&sql).await?;
        Ok(affected)
    }

    async fn insert_row(&self, insert: &RowInsert) -> Result<u64> {
        self.guard_write()?;

        let scope = scope_of(insert.database.as_deref(), insert.schema.as_deref());
        // `skip_nulls = false`: a column the user left empty is written as NULL
        // so the row matches what the grid showed.
        let sql =
            crate::edit::build_insert(DbKind::Mysql, &scope, &insert.table, &insert.values, false);
        let (affected, _) = self.execute_raw(&sql).await?;
        Ok(affected)
    }

    async fn delete_row(&self, edit: &RowEdit) -> Result<u64> {
        self.guard_write()?;

        let scope = scope_of(edit.database.as_deref(), edit.schema.as_deref());
        let key_order = self.key_order(&scope, &edit.table, &edit.keys).await;
        let sql =
            crate::edit::build_delete(DbKind::Mysql, &scope, &edit.table, &edit.keys, &key_order)?;
        let (affected, _) = self.execute_raw(&sql).await?;
        Ok(affected)
    }

    async fn rename_object(
        &self,
        scope: &Scope,
        from: &str,
        to: &str,
        _kind: ObjectKind,
    ) -> Result<()> {
        self.guard_write()?;
        // `RENAME TABLE` moves both tables and views; the target lives in the
        // same database as the source.
        let sql = format!(
            "RENAME TABLE {} TO {}",
            relation(scope, from),
            relation(scope, to)
        );
        self.execute_raw(&sql).await?;
        Ok(())
    }

    async fn drop_object(&self, scope: &Scope, name: &str, kind: ObjectKind) -> Result<()> {
        self.guard_write()?;
        let sql = match kind {
            ObjectKind::View | ObjectKind::MaterializedView => {
                format!("DROP VIEW {}", relation(scope, name))
            },
            _ => format!("DROP TABLE {}", relation(scope, name)),
        };
        self.execute_raw(&sql).await?;
        Ok(())
    }

    async fn truncate_table(&self, scope: &Scope, name: &str) -> Result<()> {
        self.guard_write()?;
        let sql = format!("TRUNCATE TABLE {}", relation(scope, name));
        self.execute_raw(&sql).await?;
        Ok(())
    }

    async fn ping(&self) -> Result<()> {
        self.fetch_all("SELECT 1").await.map(|_| ())
    }

    async fn close(&self) {
        self.pool.close().await;
    }
}

impl MySqlDriver {
    /// Row estimate from `information_schema.TABLES`, used by
    /// [`Driver::count_rows`] when an approximate answer will do.
    async fn table_options_of_estimate(&self, scope: &Scope, table: &str) -> Result<Option<i64>> {
        let db = self.database_name(scope).await?;
        let rows = self
            .fetch_all(&format!(
                "SELECT TABLE_ROWS AS row_count FROM information_schema.TABLES \
                 WHERE TABLE_SCHEMA = {} AND TABLE_NAME = {}",
                quote_literal(&db),
                quote_literal(table)
            ))
            .await?;
        Ok(rows.first().and_then(|row| opt_i64(row, "row_count")))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(name: &str, nullable: bool, primary_key: bool) -> ColumnSchema {
        ColumnSchema {
            name: name.into(),
            data_type: "int".into(),
            logical_type: LogicalType::Integer,
            nullable,
            default_value: None,
            is_primary_key: primary_key,
            is_auto_increment: false,
            is_unique: false,
            comment: None,
            ordinal: 0,
            char_max_length: None,
            numeric_precision: None,
            numeric_scale: None,
            extra: None,
            enum_values: Vec::new(),
        }
    }

    fn index(name: &str, columns: &[&str], unique: bool) -> IndexSchema {
        IndexSchema {
            name: name.into(),
            columns: columns.iter().map(|c| (*c).to_string()).collect(),
            is_unique: unique,
            is_primary: name.eq_ignore_ascii_case("PRIMARY"),
            index_type: None,
            comment: None,
        }
    }

    fn table(columns: Vec<ColumnSchema>, indexes: Vec<IndexSchema>) -> TableSchema {
        TableSchema {
            name: "t".into(),
            kind: ObjectKind::Table,
            database: Some("shop".into()),
            schema: None,
            columns,
            indexes,
            foreign_keys: Vec::new(),
            triggers: Vec::new(),
            comment: None,
            row_count: None,
            ddl: None,
            options: Default::default(),
        }
    }

    #[test]
    fn maps_type_names_to_decode_families() {
        // `BOOLEAN` is the server's own spelling for `TINYINT(1)`.
        assert_eq!(decode_as("BOOLEAN"), DecodeAs::Bool);
        assert_eq!(decode_as("bit"), DecodeAs::Bool);
        assert_eq!(decode_as("TINYINT"), DecodeAs::Int);
        assert_eq!(decode_as("year"), DecodeAs::Int);
        assert_eq!(decode_as("BIGINT UNSIGNED"), DecodeAs::Uint);
        assert_eq!(decode_as("int unsigned"), DecodeAs::Uint);
        assert_eq!(decode_as("DOUBLE"), DecodeAs::Float);
        assert_eq!(decode_as("NEWDECIMAL"), DecodeAs::Decimal);
        assert_eq!(decode_as("numeric"), DecodeAs::Decimal);
        assert_eq!(decode_as("DATE"), DecodeAs::Date);
        assert_eq!(decode_as("TIME"), DecodeAs::Time);
        assert_eq!(decode_as("DATETIME"), DecodeAs::DateTime);
        assert_eq!(decode_as(" timestamp "), DecodeAs::DateTime);
        assert_eq!(decode_as("VARCHAR"), DecodeAs::Text);
        assert_eq!(decode_as("LONGTEXT"), DecodeAs::Text);
        assert_eq!(decode_as("ENUM"), DecodeAs::Text);
        assert_eq!(decode_as("SET"), DecodeAs::Text);
        assert_eq!(decode_as("JSON"), DecodeAs::Json);
        assert_eq!(decode_as("VARBINARY"), DecodeAs::Bytes);
        assert_eq!(decode_as("MEDIUMBLOB"), DecodeAs::Bytes);
        assert_eq!(decode_as("GEOMETRY"), DecodeAs::Bytes);
        assert_eq!(decode_as("INET6"), DecodeAs::Fallback);
        assert_eq!(decode_as(""), DecodeAs::Fallback);
    }

    #[test]
    fn boolean_types_agree_with_the_shared_type_mapper() {
        // `decode_as` and `common::logical_type` must not disagree about which
        // MySQL types are booleans, or the grid would pick the wrong editor.
        for name in ["BOOLEAN", "BIT", "bool", "boolean"] {
            assert_eq!(
                common::logical_type(DbKind::Mysql, name),
                LogicalType::Boolean
            );
            assert_eq!(decode_as(name), DecodeAs::Bool, "{name}");
        }
        assert_eq!(
            common::logical_type(DbKind::Mysql, "tinyint(1)"),
            LogicalType::Boolean
        );
        assert_eq!(
            common::logical_type(DbKind::Mysql, "tinyint"),
            LogicalType::Integer
        );
    }

    #[test]
    fn parses_enum_and_set_members() {
        assert_eq!(
            parse_enum_values("enum('small','medium','large')"),
            vec!["small", "medium", "large"]
        );
        assert_eq!(parse_enum_values("SET('a','b')"), vec!["a", "b"]);
        assert_eq!(parse_enum_values("ENUM('A')"), vec!["A"]);
        assert_eq!(parse_enum_values("enum('a,b','c')"), vec!["a,b", "c"]);
        assert_eq!(parse_enum_values("enum(' spaced ')"), vec![" spaced "]);
        assert_eq!(parse_enum_values("varchar(255)"), Vec::<String>::new());
        assert_eq!(parse_enum_values("int"), Vec::<String>::new());
        assert_eq!(parse_enum_values(""), Vec::<String>::new());
    }

    #[test]
    fn parser_round_trips_escaped_members() {
        // MySQL escapes a quote inside an enum member as `\'` and doubles it
        // when the value is re-read through `SHOW CREATE TABLE`.
        assert_eq!(parse_enum_values(r"enum('it\'s','b')"), vec!["it's", "b"]);
        assert_eq!(parse_enum_values("enum('it''s','b')"), vec!["it's", "b"]);
        assert_eq!(parse_enum_values(r"enum('a\\b','c')"), vec![r"a\b", "c"]);
        assert_eq!(parse_enum_values(r"enum('line\n')"), vec!["line\n"]);
        assert_eq!(parse_enum_values("enum('ہاں','no')"), vec!["ہاں", "no"]);
    }

    #[test]
    fn recognises_row_returning_statements() {
        assert!(returns_rows("SELECT 1"));
        assert!(returns_rows("  -- comment\nSHOW TABLES"));
        assert!(returns_rows("INSERT INTO t (a) VALUES (1) RETURNING id"));
        assert!(returns_rows("DELETE FROM t RETURNING *"));
        assert!(!returns_rows("INSERT INTO t (a) VALUES (1)"));
        assert!(!returns_rows("UPDATE t SET a = 1"));
        assert!(!returns_rows("CREATE TABLE t (a int)"));
    }

    #[test]
    fn prefers_primary_key_then_not_null_unique_index() {
        let schema = table(
            vec![
                column("id", false, true),
                column("email", false, false),
                column("nick", true, false),
            ],
            vec![
                index("PRIMARY", &["id"], true),
                index("uq_email", &["email"], true),
            ],
        );
        assert_eq!(choose_keys(&schema), vec!["id".to_string()]);

        // No primary key: the unique index over `NOT NULL` columns is usable.
        let schema = table(
            vec![column("email", false, false), column("nick", true, false)],
            vec![index("uq_email", &["email"], true)],
        );
        assert_eq!(choose_keys(&schema), vec!["email".to_string()]);

        // A unique index over a nullable column cannot address a row.
        let schema = table(
            vec![column("email", true, false), column("nick", false, false)],
            vec![
                index("uq_email", &["email"], true),
                index("uq_nick", &["nick"], true),
                index("ix_plain", &["email", "nick"], false),
            ],
        );
        assert_eq!(choose_keys(&schema), vec!["nick".to_string()]);

        let keyless = table(vec![column("a", false, false)], Vec::new());
        assert!(choose_keys(&keyless).is_empty());
    }

    #[test]
    fn normalises_scopes_and_relations() {
        assert_eq!(scope_of(Some("shop"), None), Scope::database("shop"));
        // Callers occasionally carry the database in `schema`; accept either.
        assert_eq!(scope_of(None, Some("shop")), Scope::database("shop"));
        assert_eq!(scope_of(Some(" "), None), Scope::default());
        assert_eq!(scope_of(None, None), Scope::default());
        assert_eq!(
            scope_of(Some("shop"), Some("public")),
            Scope::database("shop")
        );

        assert_eq!(
            relation(&Scope::database("shop"), "orders"),
            "`shop`.`orders`"
        );
        assert_eq!(
            relation(
                &Scope {
                    database: Some("  ".into()),
                    schema: None
                },
                "orders"
            ),
            "`orders`"
        );
        assert_eq!(relation(&Scope::default(), "orders"), "`orders`");
    }

    #[test]
    fn quotes_information_schema_filters() {
        assert_eq!(quote_literal("shop"), "'shop'");

        // How the embedded quote is escaped is `escape_literal`'s business
        // (MySQL doubles it); what matters here is that the result stays a
        // single literal token.
        let quoted = quote_literal("it's");
        assert!(quoted.starts_with('\'') && quoted.ends_with('\''));
        assert!(quoted.contains("''") || quoted.contains("\\'"), "{quoted}");
    }

    #[test]
    fn row_cap_treats_zero_as_unlimited() {
        assert_eq!(row_cap(0), usize::MAX);
        assert_eq!(row_cap(500), 500);
    }

    #[test]
    fn formats_temporal_values_without_trailing_zeros() {
        let plain =
            NaiveDateTime::parse_from_str("2024-05-01 10:00:00", "%Y-%m-%d %H:%M:%S").unwrap();
        assert_eq!(format_naive_datetime(plain), "2024-05-01 10:00:00");

        let fractional =
            NaiveDateTime::parse_from_str("2024-05-01 10:00:00.123456", "%Y-%m-%d %H:%M:%S%.f")
                .unwrap();
        assert_eq!(
            format_naive_datetime(fractional),
            "2024-05-01 10:00:00.123456"
        );

        assert_eq!(
            format_naive_time(NaiveTime::parse_from_str("09:30:00", "%H:%M:%S").unwrap()),
            "09:30:00"
        );
        assert_eq!(
            format_naive_time(NaiveTime::parse_from_str("09:30:00.5", "%H:%M:%S%.f").unwrap()),
            "09:30:00.500000"
        );
    }

    #[test]
    fn system_databases_are_flagged_by_the_shared_helper() {
        assert!(is_system_schema(DbKind::Mysql, "information_schema"));
        assert!(is_system_schema(DbKind::Mysql, "performance_schema"));
        assert!(is_system_schema(DbKind::Mysql, "MYSQL"));
        assert!(is_system_schema(DbKind::Mysql, "sys"));
        assert!(!is_system_schema(DbKind::Mysql, "shop"));
    }
}
