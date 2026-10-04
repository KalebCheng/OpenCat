//! SQLite driver.
//!
//! SQLite has no server and no schema layer, so the object model is flat: the
//! "databases" are the attached databases (`main`, `temp`, ...) and every object
//! lives in one of them. Row identity comes from the declared primary key, or
//! from the implicit `rowid` on ordinary tables — which is what makes the data
//! grid editable even for schemas that forgot to declare a key.

use std::path::Path;
use std::time::{Duration, Instant};

use async_trait::async_trait;
use sqlx::sqlite::{
    SqliteConnectOptions, SqliteJournalMode, SqlitePool, SqlitePoolOptions, SqliteRow,
    SqliteSynchronous,
};
use sqlx::{Column, Row, TypeInfo, ValueRef};

use opencat_core::model::{
    ColumnMeta, ColumnSchema, DatabaseInfo, DbKind, ForeignKeySchema, IndexSchema, LogicalType,
    ObjectKind, ObjectRef, QueryResult, RowEdit, RowInsert, ServerInfo, TablePage, TableSchema,
    TriggerSchema,
};
use opencat_core::sql::{classify_statement, quote_ident, split_statements, summarise};
use opencat_core::value::Value;
use opencat_core::{is_system_schema, CoreError, Result};

use crate::common;
use crate::traits::{
    CountRequest, Driver, DriverConfig, FindRequest, PageRequest, QueryOptions, Scope,
};

/// SQLite connection.
pub struct SqliteDriver {
    pool: SqlitePool,
    file: String,
    read_only: bool,
    timeout: Duration,
    max_rows: u32,
}

impl SqliteDriver {
    /// Open (or create) a database file.
    pub async fn connect(cfg: &DriverConfig) -> Result<Self> {
        let profile = &cfg.profile;
        let file = profile
            .file
            .clone()
            .filter(|f| !f.trim().is_empty())
            .ok_or_else(|| CoreError::Config("no SQLite database file was specified".into()))?;

        let create = profile
            .params
            .get("create")
            .map(|v| v == "true" || v == "1")
            .unwrap_or(false);
        let want_read_only = profile
            .params
            .get("mode")
            .map(|v| v.eq_ignore_ascii_case("ro") || v.eq_ignore_ascii_case("readonly"))
            .unwrap_or(false);

        if !create && !Path::new(&file).exists() {
            return Err(CoreError::Connection(format!(
                "SQLite database `{file}` does not exist"
            )));
        }

        let mut opts = SqliteConnectOptions::new()
            .filename(&file)
            .read_only(want_read_only)
            .foreign_keys(true)
            .busy_timeout(Duration::from_secs(profile.connect_timeout_secs.max(1) * 2))
            .create_if_missing(create);

        if !want_read_only {
            opts = opts
                .journal_mode(SqliteJournalMode::Wal)
                .synchronous(SqliteSynchronous::Normal);
        }

        let pool = SqlitePoolOptions::new()
            .max_connections(if want_read_only { 4 } else { 1 })
            .acquire_timeout(Duration::from_secs(profile.connect_timeout_secs.max(1)))
            .connect_with(opts)
            .await
            .map_err(crate::traits::classify_error)?;

        Ok(SqliteDriver {
            pool,
            file,
            read_only: want_read_only,
            timeout: Duration::from_secs(profile.connect_timeout_secs.max(1) * 4),
            max_rows: profile.max_rows,
        })
    }

    /// In-memory pool used by tests.
    #[cfg(test)]
    pub async fn memory() -> Result<Self> {
        let pool = SqlitePoolOptions::new()
            .max_connections(1)
            .connect_with(SqliteConnectOptions::new().filename(":memory:"))
            .await
            .map_err(crate::traits::classify_error)?;
        Ok(SqliteDriver {
            pool,
            file: ":memory:".into(),
            read_only: false,
            timeout: Duration::from_secs(30),
            max_rows: 10_000,
        })
    }

    fn schema_prefix(scope: &Scope, kind: DbKind) -> String {
        // SQLite resolves `db.name` for attached databases.
        match &scope.database {
            Some(db) if !db.is_empty() && db != "main" => {
                format!("{}.", quote_ident(db, kind))
            },
            _ => String::new(),
        }
    }

    fn table_ref(&self, scope: &Scope, table: &str) -> String {
        format!(
            "{}{}",
            Self::schema_prefix(scope, DbKind::Sqlite),
            quote_ident(table, DbKind::Sqlite)
        )
    }

    async fn pragma_table_info(&self, scope: &Scope, table: &str) -> Result<Vec<ColumnSchema>> {
        let sql = format!(
            "PRAGMA {}.table_info({})",
            Self::schema_name(scope)?,
            quote_ident_sql(table)
        );
        let rows = self.fetch_all(&sql).await?;
        let mut out = Vec::new();
        let mut pk_count = rows
            .iter()
            .filter_map(|r| r.try_get::<i64, _>("pk").ok())
            .filter(|v| *v > 0)
            .count();

        for row in &rows {
            let name: String = row.try_get("name").unwrap_or_default();
            let declared: String = row.try_get("type").unwrap_or_default();
            let notnull: i64 = row.try_get("notnull").unwrap_or(0);
            let default_value: Option<String> = row.try_get("dflt_value").ok();
            let pk: i64 = row.try_get("pk").unwrap_or(0);
            let cid: i64 = row.try_get("cid").unwrap_or(0);
            let logical = common::logical_type(DbKind::Sqlite, &declared);
            let is_auto_increment =
                pk == 1 && pk_count == 1 && declared.eq_ignore_ascii_case("integer");
            if pk > 0 {
                pk_count = pk_count.max(pk as usize);
            }
            out.push(ColumnSchema {
                name,
                data_type: if declared.is_empty() {
                    "BLOB".into()
                } else {
                    declared.clone()
                },
                logical_type: logical,
                // SQLite reports `notnull = 0` for `INTEGER PRIMARY KEY` even
                // though such a column can never be NULL: it *is* the rowid.
                nullable: notnull == 0 && pk == 0,
                default_value,
                is_primary_key: pk > 0,
                is_auto_increment,
                is_unique: false,
                comment: None,
                ordinal: cid as i32,
                char_max_length: parse_length(&declared),
                numeric_precision: None,
                numeric_scale: None,
                extra: None,
                enum_values: Vec::new(),
            });
        }
        Ok(out)
    }

    fn schema_name(scope: &Scope) -> Result<String> {
        let db = scope
            .database
            .clone()
            .filter(|d| !d.is_empty())
            .unwrap_or_else(|| "main".to_string());
        Ok(quote_ident(&db, DbKind::Sqlite))
    }

    async fn index_list(&self, scope: &Scope, table: &str) -> Result<Vec<IndexSchema>> {
        let sql = format!(
            "PRAGMA {}.index_list({})",
            Self::schema_name(scope)?,
            quote_ident_sql(table)
        );
        let rows = self.fetch_all(&sql).await?;
        let mut out = Vec::new();
        for row in &rows {
            let name: String = row.try_get("name").unwrap_or_default();
            let unique: i64 = row.try_get("unique").unwrap_or(0);
            let origin: String = row.try_get("origin").unwrap_or_default();
            let cols = self.index_columns(scope, &name).await?;
            out.push(IndexSchema {
                name,
                columns: cols,
                is_unique: unique != 0,
                is_primary: origin == "pk",
                index_type: Some(if origin == "pk" {
                    "PRIMARY".into()
                } else if origin == "u" {
                    "UNIQUE".into()
                } else {
                    "INDEX".into()
                }),
                comment: None,
            });
        }
        Ok(out)
    }

    async fn index_columns(&self, scope: &Scope, index: &str) -> Result<Vec<String>> {
        let sql = format!(
            "PRAGMA {}.index_info({})",
            Self::schema_name(scope)?,
            quote_ident_sql(index)
        );
        let rows = self.fetch_all(&sql).await.unwrap_or_default();
        Ok(rows
            .iter()
            .filter_map(|r| r.try_get::<String, _>("name").ok())
            .collect())
    }

    async fn foreign_keys(&self, scope: &Scope, table: &str) -> Result<Vec<ForeignKeySchema>> {
        let sql = format!(
            "PRAGMA {}.foreign_key_list({})",
            Self::schema_name(scope)?,
            quote_ident_sql(table)
        );
        let rows = self.fetch_all(&sql).await.unwrap_or_default();
        // Group by `id`: one logical FK spans several rows, ordered by `seq`.
        let mut grouped: std::collections::BTreeMap<i64, ForeignKeySchema> = Default::default();
        for row in &rows {
            let id: i64 = row.try_get("id").unwrap_or(0);
            let from: String = row.try_get("from").unwrap_or_default();
            let to: String = row.try_get("to").ok().flatten().unwrap_or_default();
            let ref_table: String = row.try_get("table").unwrap_or_default();
            let on_update: String = row.try_get("on_update").unwrap_or_default();
            let on_delete: String = row.try_get("on_delete").unwrap_or_default();
            let entry = grouped.entry(id).or_insert_with(|| ForeignKeySchema {
                name: format!("fk_{table}_{id}"),
                columns: Vec::new(),
                ref_table: ref_table.clone(),
                ref_columns: Vec::new(),
                ref_schema: scope.database.clone(),
                on_update: Some(on_update),
                on_delete: Some(on_delete),
            });
            entry.columns.push(from);
            entry.ref_columns.push(to);
        }
        Ok(grouped.into_values().collect())
    }

    async fn triggers(&self, scope: &Scope, table: &str) -> Result<Vec<TriggerSchema>> {
        let prefix = Self::schema_prefix(scope, DbKind::Sqlite);
        let sql = format!(
            "SELECT name, sql FROM {prefix}sqlite_master WHERE type = 'trigger' AND tbl_name = {}",
            opencat_core::sql::escape_literal(table, DbKind::Sqlite)
        );
        let rows = self.fetch_all(&sql).await.unwrap_or_default();
        Ok(rows
            .iter()
            .map(|r| {
                let name: String = r.try_get("name").unwrap_or_default();
                let statement: Option<String> = r.try_get("sql").ok();
                TriggerSchema {
                    name,
                    timing: None,
                    event: None,
                    statement,
                }
            })
            .collect())
    }

    /// True when the table has no `rowid` (i.e. declared `WITHOUT ROWID`).
    async fn is_without_rowid(&self, scope: &Scope, table: &str) -> bool {
        let prefix = Self::schema_prefix(scope, DbKind::Sqlite);
        let sql = format!(
            "SELECT sql FROM {prefix}sqlite_master WHERE type='table' AND name={}",
            opencat_core::sql::escape_literal(table, DbKind::Sqlite)
        );
        match self.fetch_all(&sql).await {
            Ok(rows) => rows
                .first()
                .and_then(|r| r.try_get::<Option<String>, _>("sql").ok().flatten())
                .map(|s| s.to_ascii_uppercase().contains("WITHOUT ROWID"))
                .unwrap_or(false),
            Err(_) => false,
        }
    }

    /// Run a query, enforcing the client-side deadline.
    async fn fetch_all(&self, sql: &str) -> Result<Vec<SqliteRow>> {
        let fut = sqlx::query(sql).fetch_all(&self.pool);
        tokio::time::timeout(self.timeout, fut)
            .await
            .map_err(|_| CoreError::Query(format!("query timed out: {}", summarise(sql, 80))))?
            .map_err(crate::traits::classify_error)
    }

    async fn execute_raw(&self, sql: &str) -> Result<(u64, Option<i64>)> {
        let fut = sqlx::query(sql).execute(&self.pool);
        let res = tokio::time::timeout(self.timeout, fut)
            .await
            .map_err(|_| CoreError::Query(format!("statement timed out: {}", summarise(sql, 80))))?
            .map_err(crate::traits::classify_error)?;
        Ok((res.rows_affected(), Some(res.last_insert_rowid())))
    }
}

fn quote_ident_sql(name: &str) -> String {
    format!("'{}'", name.replace('\'', "''"))
}

fn parse_length(declared: &str) -> Option<i64> {
    let start = declared.find('(')?;
    let end = declared[start..].find(')')? + start;
    declared[start + 1..end]
        .split(',')
        .next()?
        .trim()
        .parse()
        .ok()
}

/// Decode one cell using the runtime storage class, refined by the declared type.
fn decode_cell(row: &SqliteRow, idx: usize) -> Value {
    let raw = match row.try_get_raw(idx) {
        Ok(r) => r,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }

    let declared = row.column(idx).type_info().name().to_string();
    let logical = common::logical_type(DbKind::Sqlite, &declared);
    let storage = raw.type_info().name().to_ascii_uppercase();

    match storage.as_str() {
        "INTEGER" | "INT" | "BIGINT" => {
            if let Ok(v) = row.try_get::<i64, _>(idx) {
                return match logical {
                    LogicalType::Boolean => Value::Bool(v != 0),
                    // SQLite has no date type: integers may be unix seconds.
                    LogicalType::DateTime | LogicalType::Timestamp => Value::DateTime(
                        chrono::DateTime::from_timestamp(v, 0)
                            .map(|d| d.naive_utc().format("%Y-%m-%d %H:%M:%S").to_string())
                            .unwrap_or_else(|| v.to_string()),
                    ),
                    LogicalType::Date => Value::Date(
                        chrono::DateTime::from_timestamp(v, 0)
                            .map(|d| d.naive_utc().format("%Y-%m-%d").to_string())
                            .unwrap_or_else(|| v.to_string()),
                    ),
                    LogicalType::Decimal => Value::Decimal(v.to_string()),
                    _ => Value::Int(v),
                };
            }
        },
        "REAL" | "FLOAT" | "DOUBLE" | "NUMERIC" | "DECIMAL" => {
            if let Ok(v) = row.try_get::<f64, _>(idx) {
                return Value::Float(v);
            }
        },
        "TEXT" | "VARCHAR" | "CHAR" | "CLOB" | "NULL" => {
            if let Ok(v) = row.try_get::<String, _>(idx) {
                return match logical {
                    LogicalType::Date => Value::Date(v),
                    LogicalType::Time => Value::Time(v),
                    LogicalType::DateTime | LogicalType::Timestamp => Value::DateTime(v),
                    LogicalType::Json => Value::Json(v),
                    LogicalType::Boolean => Value::Bool(v != "0" && !v.is_empty()),
                    _ => Value::Text(v),
                };
            }
        },
        "BLOB" => {
            if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
                return Value::Bytes(v);
            }
            if let Ok(v) = row.try_get::<String, _>(idx) {
                return Value::Text(v);
            }
        },
        _ => {},
    }

    // Fallback chain for exotic storage classes and virtual tables.
    if let Ok(v) = row.try_get::<i64, _>(idx) {
        return Value::Int(v);
    }
    if let Ok(v) = row.try_get::<f64, _>(idx) {
        return Value::Float(v);
    }
    if let Ok(v) = row.try_get::<String, _>(idx) {
        return Value::Text(v);
    }
    if let Ok(v) = row.try_get::<Vec<u8>, _>(idx) {
        return Value::Bytes(v);
    }
    Value::Null
}

fn decode_row(row: &SqliteRow) -> Vec<Value> {
    (0..row.len()).map(|i| decode_cell(row, i)).collect()
}

fn build_columns(row: &SqliteRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|c| {
            let declared = c.type_info().name().to_string();
            ColumnMeta {
                name: c.name().to_string(),
                logical_type: common::logical_type(DbKind::Sqlite, &declared),
                type_name: declared,
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

#[async_trait]
impl Driver for SqliteDriver {
    fn kind(&self) -> DbKind {
        DbKind::Sqlite
    }

    async fn server_info(&self) -> Result<ServerInfo> {
        let version: String = self
            .fetch_all("SELECT sqlite_version() AS v")
            .await?
            .first()
            .and_then(|r| r.try_get("v").ok())
            .unwrap_or_else(|| "unknown".into());

        let encoding: Option<String> = self
            .fetch_all("PRAGMA encoding")
            .await
            .ok()
            .and_then(|rows| rows.first().and_then(|r| r.try_get(0).ok()));

        Ok(ServerInfo {
            version,
            edition: Some("SQLite".into()),
            current_user: Some(whoami()),
            current_database: Some(self.file.clone()),
            server_encoding: encoding,
            timezone: Some("UTC".into()),
            max_connections: None,
            uptime_secs: None,
        })
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        let rows = self.fetch_all("PRAGMA database_list").await?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name: String = r.try_get("name").ok()?;
                let file: String = r.try_get("file").ok().unwrap_or_default();
                Some(DatabaseInfo {
                    is_system: matches!(name.as_str(), "temp" | "main"),
                    name,
                    size_bytes: std::fs::metadata(&file).ok().map(|m| m.len() as i64),
                    comment: if file.is_empty() { None } else { Some(file) },
                    charset: Some("UTF-8".into()),
                })
            })
            .collect())
    }

    async fn list_schemas(&self, _database: Option<&str>) -> Result<Vec<String>> {
        // SQLite has no schema layer; attached databases play that role.
        Ok(Vec::new())
    }

    async fn list_objects(&self, scope: &Scope) -> Result<Vec<ObjectRef>> {
        let prefix = Self::schema_prefix(scope, DbKind::Sqlite);
        let sql = format!(
            "SELECT name, type FROM {prefix}sqlite_master \
             WHERE type IN ('table','view') AND name NOT LIKE 'sqlite_%' ORDER BY type, name"
        );
        let rows = self.fetch_all(&sql).await?;
        Ok(rows
            .iter()
            .filter_map(|r| {
                let name: String = r.try_get("name").ok()?;
                let ty: String = r.try_get("type").ok()?;
                let kind = if ty == "view" {
                    ObjectKind::View
                } else {
                    ObjectKind::Table
                };
                let mut obj = ObjectRef::new(kind, name);
                obj.database = scope.database.clone();
                Some(obj)
            })
            .collect())
    }

    async fn list_routines(&self, _scope: &Scope) -> Result<Vec<ObjectRef>> {
        // SQLite ships no stored routines; triggers are surfaced with the table.
        Ok(Vec::new())
    }

    async fn table_schema(
        &self,
        scope: &Scope,
        name: &str,
        kind: ObjectKind,
    ) -> Result<TableSchema> {
        let columns = self.pragma_table_info(scope, name).await?;
        let indexes = self.index_list(scope, name).await.unwrap_or_default();
        let foreign_keys = self.foreign_keys(scope, name).await.unwrap_or_default();
        let triggers = self.triggers(scope, name).await.unwrap_or_default();
        let ddl = self.table_ddl(scope, name, kind).await.ok();

        let row_count = self
            .count_rows(&CountRequest {
                scope: scope.clone(),
                table: name.to_string(),
                filter: None,
                approximate: true,
            })
            .await
            .ok();

        Ok(TableSchema {
            name: name.to_string(),
            kind,
            database: scope.database.clone(),
            schema: None,
            columns,
            indexes,
            foreign_keys,
            triggers,
            comment: None,
            row_count,
            ddl,
            options: Default::default(),
        })
    }

    async fn table_ddl(&self, scope: &Scope, name: &str, kind: ObjectKind) -> Result<String> {
        let prefix = Self::schema_prefix(scope, DbKind::Sqlite);
        let ty = if matches!(kind, ObjectKind::View) {
            "view"
        } else {
            "table"
        };
        let sql = format!(
            "SELECT sql FROM {prefix}sqlite_master WHERE type='{ty}' AND name={}",
            opencat_core::sql::escape_literal(name, DbKind::Sqlite)
        );
        let rows = self.fetch_all(&sql).await?;
        let ddl: Option<String> = rows
            .first()
            .and_then(|r| r.try_get::<Option<String>, _>("sql").ok().flatten());
        ddl.ok_or_else(|| CoreError::NotFound(format!("{ty} `{name}` has no stored DDL")))
    }

    async fn execute(&self, sql: &str, opts: &QueryOptions) -> Result<Vec<QueryResult>> {
        let statements = split_statements(sql);
        if statements.is_empty() {
            return Ok(Vec::new());
        }

        let mut results = Vec::new();
        for statement in statements {
            if opts.read_only && !opencat_core::sql::is_read_only(&statement) {
                return Err(CoreError::Invalid(format!(
                    "connection is read-only; refused: {}",
                    summarise(&statement, 60)
                )));
            }
            let started = Instant::now();
            let stmt_kind = classify_statement(&statement);

            if returns_rows(&statement) {
                let rows = self.fetch_all(&statement).await?;
                let columns = rows.first().map(build_columns).unwrap_or_default();
                let mut values: Vec<Vec<Value>> = rows.iter().map(decode_row).collect();
                let truncated = values.len() > self.max_rows as usize;
                if truncated {
                    values.truncate(self.max_rows as usize);
                }
                results.push(QueryResult {
                    columns,
                    rows: values,
                    rows_affected: 0,
                    last_insert_id: None,
                    elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
                    notices: Vec::new(),
                    statement_kind: stmt_kind,
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
        let mut columns = common::columns_from_schema(&schema);

        // Row identity: declared primary key, else the implicit rowid.
        let mut key_columns: Vec<String> = schema.primary_key_columns();
        let mut use_rowid = false;
        if key_columns.is_empty() && !self.is_without_rowid(&req.scope, &req.table).await {
            use_rowid = true;
            key_columns = vec!["rowid".to_string()];
            columns.push(ColumnMeta {
                name: "rowid".into(),
                type_name: "INTEGER".into(),
                logical_type: LogicalType::Integer,
                nullable: false,
                table: Some(req.table.clone()),
                is_primary_key: true,
                hidden: true,
                is_auto_increment: true,
                default_value: None,
                char_max_length: None,
                comment: None,
            });
        }

        let select_list = columns
            .iter()
            .map(|c| {
                let q = quote_ident(&c.name, DbKind::Sqlite);
                if c.hidden {
                    format!("{q} AS {q}")
                } else {
                    q
                }
            })
            .collect::<Vec<_>>()
            .join(", ");

        let mut sql = format!(
            "SELECT {select_list} FROM {}",
            self.table_ref(&req.scope, &req.table)
        );
        if let Some(f) = req
            .filter
            .as_deref()
            .map(str::trim)
            .filter(|f| !f.is_empty())
        {
            sql.push_str(" WHERE ");
            sql.push_str(f);
        }
        if !req.order_by.is_empty() {
            let order = req
                .order_by
                .iter()
                .map(|o| {
                    format!(
                        "{} {}",
                        quote_ident(&o.column, DbKind::Sqlite),
                        if o.desc { "DESC" } else { "ASC" }
                    )
                })
                .collect::<Vec<_>>()
                .join(", ");
            sql.push_str(" ORDER BY ");
            sql.push_str(&order);
        }
        sql.push_str(&format!(" LIMIT {} OFFSET {}", req.limit, req.offset));

        let rows = self.fetch_all(&sql).await?;
        let decoded: Vec<Vec<Value>> = rows.iter().map(decode_row).collect();
        if use_rowid {
            for col in columns.iter_mut().filter(|c| c.hidden) {
                col.is_primary_key = true;
            }
        }

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
                Some("table has no primary key and no rowid".into())
            },
            sql,
            elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        })
    }

    async fn count_rows(&self, req: &CountRequest) -> Result<i64> {
        let sql = common::count_select(
            DbKind::Sqlite,
            &req.scope,
            &req.table,
            req.filter.as_deref(),
        );
        let rows = self.fetch_all(&sql).await?;
        Ok(rows
            .first()
            .and_then(|r| r.try_get::<i64, _>(0).ok())
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
        let filter = common::search_predicate(DbKind::Sqlite, &targets, &req.needle);
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
        let scope = row_scope(edit.database.clone(), edit.schema.clone());
        let key_order = self.order_keys(&scope, &edit.table, &edit.keys).await?;
        let changes: Vec<(String, Value, Value)> = edit
            .changes
            .iter()
            .map(|c| (c.column.clone(), c.old_value.clone(), c.new_value.clone()))
            .collect();

        let sql = crate::edit::build_update(
            DbKind::Sqlite,
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
        let scope = row_scope(insert.database.clone(), insert.schema.clone());
        // Skipping NULLs lets SQLite assign its own rowid / autoincrement value.
        let sql =
            crate::edit::build_insert(DbKind::Sqlite, &scope, &insert.table, &insert.values, true);
        let (affected, _) = self.execute_raw(&sql).await?;
        Ok(affected)
    }

    async fn delete_row(&self, edit: &RowEdit) -> Result<u64> {
        self.guard_write()?;
        let scope = row_scope(edit.database.clone(), edit.schema.clone());
        let key_order = self.order_keys(&scope, &edit.table, &edit.keys).await?;
        let sql =
            crate::edit::build_delete(DbKind::Sqlite, &scope, &edit.table, &edit.keys, &key_order)?;
        let (affected, _) = self.execute_raw(&sql).await?;
        Ok(affected)
    }

    async fn rename_object(
        &self,
        scope: &Scope,
        from: &str,
        to: &str,
        kind: ObjectKind,
    ) -> Result<()> {
        let sql = match kind {
            ObjectKind::View => format!(
                "ALTER VIEW {} RENAME TO {}",
                self.table_ref(scope, from),
                quote_ident(to, DbKind::Sqlite)
            ),
            _ => format!(
                "ALTER TABLE {} RENAME TO {}",
                self.table_ref(scope, from),
                quote_ident(to, DbKind::Sqlite)
            ),
        };
        self.execute_raw(&sql).await?;
        Ok(())
    }

    async fn drop_object(&self, scope: &Scope, name: &str, kind: ObjectKind) -> Result<()> {
        let sql = match kind {
            ObjectKind::View => format!("DROP VIEW {}", self.table_ref(scope, name)),
            _ => format!("DROP TABLE {}", self.table_ref(scope, name)),
        };
        self.execute_raw(&sql).await?;
        Ok(())
    }

    async fn truncate_table(&self, scope: &Scope, name: &str) -> Result<()> {
        let sql = format!("DELETE FROM {}", self.table_ref(scope, name));
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

impl SqliteDriver {
    fn guard_write(&self) -> Result<()> {
        if self.read_only {
            return Err(CoreError::Invalid(
                "connection was opened read-only; writes are disabled".into(),
            ));
        }
        Ok(())
    }

    /// Order key columns so composite keys are applied deterministically.
    async fn order_keys(
        &self,
        scope: &Scope,
        table: &str,
        keys: &std::collections::BTreeMap<String, Value>,
    ) -> Result<Vec<String>> {
        let cols = self.pragma_table_info(scope, table).await?;
        let declared: Vec<String> = cols
            .iter()
            .filter(|c| c.is_primary_key && keys.contains_key(&c.name))
            .map(|c| c.name.clone())
            .collect();
        if !declared.is_empty() {
            return Ok(declared);
        }
        // rowid or explicit keys supplied by the caller.
        Ok(keys.keys().cloned().collect())
    }
}

/// Build the scope a row edit targets from the wire representation.
fn row_scope(database: Option<String>, schema: Option<String>) -> Scope {
    Scope { database, schema }
}

fn whoami() -> String {
    std::env::var("USERNAME")
        .or_else(|_| std::env::var("USER"))
        .unwrap_or_else(|_| "sqlite".into())
}

/// Names of the built-in SQLite databases.
pub fn default_databases() -> Vec<&'static str> {
    vec!["main", "temp"]
}

/// SQLite keeps its system catalog in `sqlite_master`.
pub fn is_system_table(name: &str) -> bool {
    is_system_schema(DbKind::Sqlite, name)
}
