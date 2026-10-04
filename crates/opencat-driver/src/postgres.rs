//! PostgreSQL driver.
//!
//! PostgreSQL differs from the other engines OpenCat speaks to in three ways that
//! shape every function in this file:
//!
//! * **A connection is bound to one database.** `database.schema.table` — the
//!   three part name [`crate::common::relation`] builds for MySQL — is a syntax
//!   error in PostgreSQL, so a [`Scope`] is narrowed to its schema and its
//!   database component is only used to *check* that the caller is asking about
//!   the database this pool was opened against. Anything else is reported as
//!   [`CoreError::Invalid`] instead of silently querying the wrong database.
//! * **Nothing stores `CREATE TABLE` text.** [`PostgresDriver::table_ddl`]
//!   regenerates the script from the catalogs through [`crate::ddl::create_table`]
//!   — the same renderer the visual designer uses — so the two can never drift
//!   apart. Only the parts a column list cannot express (partial and expression
//!   indexes, views, sequences) are taken verbatim from the server.
//! * **Introspection is a join over the system catalogs.** `pg_class`,
//!   `pg_attribute`, `pg_index`, `pg_constraint` and `pg_trigger` are read
//!   directly, and a relation is resolved through `to_regclass()` so the server —
//!   not this code — decides what a name means.
//!
//! # Values
//!
//! Queries are issued as raw SQL through sqlx's *simple query protocol*
//! ([`sqlx::raw_sql`]), which returns every value in PostgreSQL's text
//! representation. That is deliberate:
//!
//! * text is the representation from which *every* type — including the ones the
//!   binary protocol gives sqlx no decoder for (`inet`, `cidr`, `macaddr`,
//!   `tsvector`, `interval`, `money`, `xml`) — can be rendered, which is exactly
//!   what `decode_cell` needs;
//! * it needs no bound parameters, matching the house rule that statements are
//!   assembled from correctly escaped literals ([`crate::edit`]);
//! * `DateStyle` and `IntervalStyle` are pinned at connect time so the output
//!   format cannot depend on how `postgresql.conf` happens to be configured.
//!
//! The cost is that a user defined type (an enum, a domain, `citext`) arrives
//! without a resolvable name and is therefore rendered as text.
//!
//! Requires PostgreSQL 11 or newer (`pg_proc.prokind`, identity columns).

use std::collections::{BTreeMap, BTreeSet};
use std::time::{Duration, Instant};

use async_trait::async_trait;
use bigdecimal::BigDecimal;
use chrono::{DateTime, NaiveDate, NaiveDateTime, NaiveTime, Utc};
use sqlx::postgres::types::Oid;
use sqlx::postgres::{PgConnectOptions, PgPool, PgPoolOptions, PgRow, PgSslMode};
use sqlx::{Column, ColumnIndex, Decode, Row, TypeInfo, ValueRef};

use opencat_core::model::{
    ColumnMeta, ColumnPlan, ColumnSchema, DatabaseInfo, DbKind, ForeignKeyPlan, ForeignKeySchema,
    IndexPlan, IndexSchema, LogicalType, ObjectKind, ObjectRef, QueryResult, RowEdit, RowInsert,
    ServerInfo, StatementKind, TablePage, TablePlan, TableSchema, TriggerSchema,
};
use opencat_core::sql::{
    classify_statement, escape_literal, quote_ident, split_statements, summarise,
};
use opencat_core::value::Value;
use opencat_core::{CoreError, Result};

use crate::common;
use crate::traits::{
    CountRequest, Driver, DriverConfig, FindRequest, PageRequest, QueryOptions, Scope,
};

/// The schema used when a [`Scope`] does not name one.
const DEFAULT_SCHEMA: &str = "public";

/// PostgreSQL connection.
pub struct PostgresDriver {
    pool: PgPool,
    /// The database this pool is connected to.
    database: String,
    read_only: bool,
    timeout: Duration,
    max_rows: u32,
}

impl PostgresDriver {
    /// Open a connection pool.
    pub async fn connect(cfg: &DriverConfig) -> Result<Self> {
        let profile = &cfg.profile;
        let (host, port) = cfg.endpoint();
        let mut opts = PgConnectOptions::new()
            .host(&host)
            .port(port)
            .username(&profile.username)
            .password(&profile.password)
            .application_name("OpenCat")
            .ssl_mode(match profile.ssl_mode {
                opencat_core::model::SslMode::Disable => PgSslMode::Disable,
                opencat_core::model::SslMode::Prefer => PgSslMode::Prefer,
                opencat_core::model::SslMode::Require => PgSslMode::Require,
                opencat_core::model::SslMode::VerifyCa => PgSslMode::VerifyCa,
                opencat_core::model::SslMode::VerifyFull => PgSslMode::VerifyFull,
            });
        let database = profile
            .database
            .as_deref()
            .filter(|d| !d.is_empty())
            .unwrap_or("postgres")
            .to_string();
        opts = opts.database(&database);
        if let Some(search_path) = profile.params.get("search_path") {
            opts = opts.options([("search_path", search_path.as_str())]);
        }
        // Values travel as text (see the module docs), so pin the formats the
        // decoders understand rather than trusting the server's configuration.
        opts = opts.options([("DateStyle", "ISO"), ("IntervalStyle", "postgres")]);

        let pool = PgPoolOptions::new()
            .max_connections(cfg.max_connections.max(1))
            .acquire_timeout(Duration::from_secs(profile.connect_timeout_secs.max(1)))
            .connect_with(opts)
            .await
            .map_err(crate::traits::classify_error)?;

        Ok(PostgresDriver {
            pool,
            database,
            read_only: profile.read_only,
            timeout: Duration::from_secs(profile.connect_timeout_secs.max(1) * 8),
            max_rows: profile.max_rows,
        })
    }

    /// Run a query, enforcing the client-side deadline.
    ///
    /// Statements go through the simple query protocol: no prepared statements,
    /// every value in text form. See the module documentation for why.
    async fn fetch_all(&self, sql: &str) -> Result<Vec<PgRow>> {
        let fut = sqlx::raw_sql(sql).fetch_all(&self.pool);
        tokio::time::timeout(self.timeout, fut)
            .await
            .map_err(|_| CoreError::Query(format!("query timed out: {}", summarise(sql, 80))))?
            .map_err(crate::traits::classify_error)
    }

    /// Run a statement that does not return rows. Returns the affected row count.
    async fn execute_raw(&self, sql: &str) -> Result<u64> {
        let fut = sqlx::raw_sql(sql).execute(&self.pool);
        let res = tokio::time::timeout(self.timeout, fut)
            .await
            .map_err(|_| CoreError::Query(format!("statement timed out: {}", summarise(sql, 80))))?
            .map_err(crate::traits::classify_error)?;
        Ok(res.rows_affected())
    }

    fn guard_write(&self) -> Result<()> {
        if self.read_only {
            return Err(CoreError::Invalid(
                "connection was opened read-only; writes are disabled".into(),
            ));
        }
        Ok(())
    }

    /// Reject a scope that names a database this connection cannot reach.
    fn check_database(&self, requested: Option<&str>) -> Result<()> {
        if let Some(wanted) = requested.map(str::trim).filter(|d| !d.is_empty()) {
            if wanted != self.database {
                return Err(CoreError::Invalid(format!(
                    "this connection is bound to database `{}`; open a connection to `{wanted}` \
                     to browse it",
                    self.database
                )));
            }
        }
        Ok(())
    }

    /// Validate the scope's database and reduce it to the two part scope
    /// PostgreSQL actually uses (`schema.table`).
    fn resolve_scope(&self, scope: &Scope) -> Result<Scope> {
        self.check_database(scope.database.as_deref())?;
        Ok(Scope {
            database: None,
            schema: scope.schema.clone().filter(|s| !s.trim().is_empty()),
        })
    }

    /// The catalog facts about one relation, resolved with `to_regclass` so the
    /// server applies its own name resolution (quoting, `search_path`).
    async fn relation_info(&self, scope: &Scope, name: &str) -> Result<RelationInfo> {
        let target = qualified_name(scope.schema.as_deref(), name);
        let sql = format!(
            "SELECT c.oid AS oid, \
                    n.nspname AS schema, \
                    c.relname AS name, \
                    c.relkind::text AS relkind, \
                    t.spcname AS tablespace, \
                    pg_catalog.obj_description(c.oid, 'pg_class') AS comment, \
                    CASE WHEN c.relkind IN ('r','p','m') THEN c.reltuples::int8 END AS row_count \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             LEFT JOIN pg_catalog.pg_tablespace t ON t.oid = c.reltablespace \
             WHERE c.oid = pg_catalog.to_regclass({})",
            escape_literal(&target, DbKind::Postgres)
        );
        let rows = self.fetch_all(&sql).await?;
        let row = rows
            .first()
            .ok_or_else(|| CoreError::NotFound(format!("relation `{target}` does not exist")))?;

        let relkind = cell::<String, _>(row, "relkind").unwrap_or_default();
        let row_count = cell::<i64, _>(row, "row_count").filter(|n| *n >= 0);
        Ok(RelationInfo {
            oid: cell::<Oid, _>(row, "oid").map(|oid| oid.0).unwrap_or(0),
            schema: cell::<String, _>(row, "schema").unwrap_or_else(|| DEFAULT_SCHEMA.to_string()),
            name: cell::<String, _>(row, "name").unwrap_or_else(|| name.to_string()),
            kind: object_kind(&relkind),
            comment: cell::<String, _>(row, "comment"),
            tablespace: cell::<String, _>(row, "tablespace"),
            row_count,
        })
    }

    /// Columns of one relation, including their defaults, comments and enums.
    async fn columns(&self, oid: u32) -> Result<Vec<ColumnSchema>> {
        let sql = format!(
            "SELECT a.attname AS name, \
                    pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type, \
                    a.attnotnull AS not_null, \
                    pg_catalog.pg_get_expr(ad.adbin, ad.adrelid) AS default_expr, \
                    pg_catalog.col_description(a.attrelid, a.attnum) AS comment, \
                    a.attidentity::text AS identity, \
                    a.attnum::int4 AS ordinal, \
                    t.typtype::text AS typtype, \
                    CASE WHEN a.atttypmod > 4 AND a.atttypid IN ('pg_catalog.varchar'::regtype, \
                                                                  'pg_catalog.bpchar'::regtype) \
                         THEN (a.atttypmod - 4)::int8 END AS char_max_length, \
                    CASE WHEN a.atttypmod > 4 AND a.atttypid = 'pg_catalog.numeric'::regtype \
                         THEN (((a.atttypmod - 4) >> 16) & 65535)::int8 END AS numeric_precision, \
                    CASE WHEN a.atttypmod > 4 AND a.atttypid = 'pg_catalog.numeric'::regtype \
                         THEN ((a.atttypmod - 4) & 65535)::int8 END AS numeric_scale, \
                    (SELECT pg_catalog.array_agg(e.enumlabel::text ORDER BY e.enumsortorder) \
                       FROM pg_catalog.pg_enum e \
                      WHERE e.enumtypid = a.atttypid) AS enum_labels \
             FROM pg_catalog.pg_attribute a \
             LEFT JOIN pg_catalog.pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum \
             LEFT JOIN pg_catalog.pg_type t ON t.oid = a.atttypid \
             WHERE a.attrelid = {oid}::oid AND a.attnum > 0 AND NOT a.attisdropped \
             ORDER BY a.attnum"
        );
        let rows = self.fetch_all(&sql).await?;
        let mut out = Vec::with_capacity(rows.len());
        for row in &rows {
            let data_type = cell::<String, _>(row, "data_type").unwrap_or_default();
            let default_value = cell::<String, _>(row, "default_expr");
            let identity = cell::<String, _>(row, "identity").unwrap_or_default();
            let is_serial = default_value
                .as_deref()
                .map(|d| d.starts_with("nextval("))
                .unwrap_or(false);
            let is_auto_increment = matches!(identity.as_str(), "a" | "d") || is_serial;
            let typtype = cell::<String, _>(row, "typtype").unwrap_or_default();
            let enum_values = cell::<Vec<String>, _>(row, "enum_labels").unwrap_or_default();

            // Enum columns get the discriminating family the editor needs, even
            // though their formatted type name says nothing about it.
            let logical_type = if typtype == "e" {
                LogicalType::Enum
            } else {
                common::logical_type(DbKind::Postgres, &data_type)
            };
            let extra = match identity.as_str() {
                "a" => Some("GENERATED ALWAYS AS IDENTITY".to_string()),
                "d" => Some("GENERATED BY DEFAULT AS IDENTITY".to_string()),
                _ if is_serial => Some("serial".to_string()),
                _ => None,
            };

            out.push(ColumnSchema {
                name: cell::<String, _>(row, "name").unwrap_or_default(),
                data_type,
                logical_type,
                nullable: !cell::<bool, _>(row, "not_null").unwrap_or(false),
                default_value,
                is_primary_key: false,
                is_auto_increment,
                is_unique: false,
                comment: cell::<String, _>(row, "comment"),
                ordinal: cell::<i32, _>(row, "ordinal").unwrap_or(0),
                char_max_length: cell::<i64, _>(row, "char_max_length"),
                numeric_precision: cell::<i64, _>(row, "numeric_precision"),
                numeric_scale: cell::<i64, _>(row, "numeric_scale"),
                extra,
                enum_values,
            });
        }
        Ok(out)
    }

    /// Indexes of one relation, in key column order.
    async fn indexes(&self, oid: u32) -> Result<Vec<IndexSchema>> {
        let sql = format!(
            "SELECT ci.relname AS name, \
                    i.indisunique AS is_unique, \
                    i.indisprimary AS is_primary, \
                    (i.indexprs IS NOT NULL OR i.indpred IS NOT NULL) AS is_special, \
                    am.amname AS method, \
                    pg_catalog.pg_get_indexdef(i.indexrelid) AS definition, \
                    pg_catalog.obj_description(i.indexrelid, 'pg_class') AS comment, \
                    (SELECT pg_catalog.array_agg(a.attname::text ORDER BY k.ord) \
                       FROM pg_catalog.unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord) \
                       JOIN pg_catalog.pg_attribute a \
                         ON a.attrelid = i.indrelid AND a.attnum = k.attnum \
                      WHERE k.attnum <> 0) AS columns \
             FROM pg_catalog.pg_index i \
             JOIN pg_catalog.pg_class ci ON ci.oid = i.indexrelid \
             JOIN pg_catalog.pg_am am ON am.oid = ci.relam \
             WHERE i.indrelid = {oid}::oid \
             ORDER BY i.indisprimary DESC, ci.relname"
        );
        let rows = self.fetch_all(&sql).await?;
        Ok(rows
            .iter()
            .map(|row| {
                let method = cell::<String, _>(row, "method").unwrap_or_default();
                let definition = cell::<String, _>(row, "definition").unwrap_or_default();
                let is_special = cell::<bool, _>(row, "is_special").unwrap_or(false);
                IndexSchema {
                    name: cell::<String, _>(row, "name").unwrap_or_default(),
                    columns: cell::<Vec<String>, _>(row, "columns").unwrap_or_default(),
                    is_unique: cell::<bool, _>(row, "is_unique").unwrap_or(false),
                    is_primary: cell::<bool, _>(row, "is_primary").unwrap_or(false),
                    // The access method describes a plain index. A partial or
                    // expression index cannot be rebuilt from a column list, so
                    // the definition itself is what we carry across (and what
                    // `render_relation_ddl` re-emits verbatim).
                    index_type: Some(if is_special && !definition.is_empty() {
                        definition
                    } else {
                        method
                    }),
                    comment: cell::<String, _>(row, "comment"),
                }
            })
            .collect())
    }

    /// Outgoing foreign keys of one relation.
    async fn foreign_keys(&self, oid: u32) -> Result<Vec<ForeignKeySchema>> {
        let sql = format!(
            "SELECT c.conname AS name, \
                    pg_catalog.pg_get_constraintdef(c.oid) AS definition, \
                    rt.relname AS ref_table, \
                    rn.nspname AS ref_schema, \
                    (SELECT pg_catalog.array_agg(a.attname::text ORDER BY k.ord) \
                       FROM pg_catalog.unnest(c.conkey) WITH ORDINALITY AS k(attnum, ord) \
                       JOIN pg_catalog.pg_attribute a \
                         ON a.attrelid = c.conrelid AND a.attnum = k.attnum \
                      WHERE k.attnum <> 0) AS columns, \
                    (SELECT pg_catalog.array_agg(a.attname::text ORDER BY k.ord) \
                       FROM pg_catalog.unnest(c.confkey) WITH ORDINALITY AS k(attnum, ord) \
                       JOIN pg_catalog.pg_attribute a \
                         ON a.attrelid = c.confrelid AND a.attnum = k.attnum \
                      WHERE k.attnum <> 0) AS ref_columns \
             FROM pg_catalog.pg_constraint c \
             JOIN pg_catalog.pg_class rt ON rt.oid = c.confrelid \
             JOIN pg_catalog.pg_namespace rn ON rn.oid = rt.relnamespace \
             WHERE c.conrelid = {oid}::oid AND c.contype = 'f' \
             ORDER BY c.conname"
        );
        let rows = self.fetch_all(&sql).await?;
        Ok(rows
            .iter()
            .map(|row| {
                let definition = cell::<String, _>(row, "definition").unwrap_or_default();
                ForeignKeySchema {
                    name: cell::<String, _>(row, "name").unwrap_or_default(),
                    columns: cell::<Vec<String>, _>(row, "columns").unwrap_or_default(),
                    ref_table: cell::<String, _>(row, "ref_table").unwrap_or_default(),
                    ref_columns: cell::<Vec<String>, _>(row, "ref_columns").unwrap_or_default(),
                    ref_schema: cell::<String, _>(row, "ref_schema"),
                    on_update: constraint_action(&definition, "UPDATE")
                        .or_else(|| Some("NO ACTION".into())),
                    on_delete: constraint_action(&definition, "DELETE")
                        .or_else(|| Some("NO ACTION".into())),
                }
            })
            .collect())
    }

    /// User triggers of one relation (internal constraint triggers excluded).
    async fn triggers(&self, oid: u32) -> Result<Vec<TriggerSchema>> {
        let sql = format!(
            "SELECT t.tgname AS name, \
                    t.tgtype AS type_bits, \
                    pg_catalog.pg_get_triggerdef(t.oid) AS definition \
             FROM pg_catalog.pg_trigger t \
             WHERE t.tgrelid = {oid}::oid AND NOT t.tgisinternal \
             ORDER BY t.tgname"
        );
        let rows = self.fetch_all(&sql).await?;
        Ok(rows
            .iter()
            .map(|row| {
                let bits = cell::<i32, _>(row, "type_bits").unwrap_or(0);
                TriggerSchema {
                    name: cell::<String, _>(row, "name").unwrap_or_default(),
                    timing: trigger_timing(bits),
                    event: trigger_event(bits),
                    statement: cell::<String, _>(row, "definition"),
                }
            })
            .collect())
    }

    /// Column set that identifies a row: the primary key when there is one,
    /// otherwise the first unique index whose columns are all `NOT NULL`.
    async fn key_columns(&self, scope: &Scope, table: &str) -> Result<Vec<String>> {
        let rel = self.relation_info(scope, table).await?;
        let columns = self.columns(rel.oid).await?;
        let indexes = self.indexes(rel.oid).await?;
        Ok(choose_key_columns(&columns, &indexes))
    }

    /// Order key columns so composite keys are applied deterministically.
    async fn order_keys(
        &self,
        scope: &Scope,
        table: &str,
        keys: &BTreeMap<String, Value>,
    ) -> Result<Vec<String>> {
        let declared = self.key_columns(scope, table).await.unwrap_or_default();
        let ordered: Vec<String> = declared
            .into_iter()
            .filter(|c| keys.contains_key(c))
            .collect();
        if ordered.is_empty() {
            // Nothing declared matched: trust the keys the grid sent, in map order.
            return Ok(keys.keys().cloned().collect());
        }
        Ok(ordered)
    }

    /// `CREATE` script for one already introspected relation.
    async fn schema_ddl(&self, oid: u32, schema: &TableSchema) -> Result<String> {
        match schema.kind {
            ObjectKind::View | ObjectKind::MaterializedView => {
                let keyword = if schema.kind == ObjectKind::View {
                    "CREATE VIEW"
                } else {
                    "CREATE MATERIALIZED VIEW"
                };
                let definition = self.view_definition(oid).await?;
                Ok(format!(
                    "{keyword} {} AS\n{}",
                    qualified_name(schema.schema.as_deref(), &schema.name),
                    definition.trim_end().trim_end_matches(';')
                ))
            },
            ObjectKind::Sequence => self.sequence_ddl(oid, schema).await,
            ObjectKind::Table => Ok(render_relation_ddl(schema)),
            ObjectKind::Folder => Err(CoreError::Unsupported(
                "a folder has no definition to show".into(),
            )),
            _ => Err(CoreError::Unsupported(format!(
                "PostgreSQL has no `CREATE` script for a {}",
                kind_label(schema.kind)
            ))),
        }
    }

    /// The `SELECT` a view or materialized view is defined by.
    async fn view_definition(&self, oid: u32) -> Result<String> {
        let sql = format!("SELECT pg_catalog.pg_get_viewdef({oid}::oid, true) AS definition");
        let rows = self.fetch_all(&sql).await?;
        rows.first()
            .and_then(|row| cell::<String, _>(row, "definition"))
            .ok_or_else(|| CoreError::NotFound("the view has no stored definition".into()))
    }

    /// `CREATE SEQUENCE` rebuilt from `pg_sequence`.
    async fn sequence_ddl(&self, oid: u32, schema: &TableSchema) -> Result<String> {
        let sql = format!(
            "SELECT pg_catalog.format_type(s.seqtypid, NULL) AS data_type, \
                    s.seqstart AS start_value, \
                    s.seqincrement AS increment_by, \
                    s.seqmin AS min_value, \
                    s.seqmax AS max_value, \
                    s.seqcache AS cache_size, \
                    s.seqcycle AS cycle \
             FROM pg_catalog.pg_sequence s \
             WHERE s.seqrelid = {oid}::oid"
        );
        let rows = self.fetch_all(&sql).await?;
        let row = rows.first().ok_or_else(|| {
            CoreError::NotFound(format!("sequence `{}` does not exist", schema.name))
        })?;

        let mut out = format!(
            "CREATE SEQUENCE {}",
            qualified_name(schema.schema.as_deref(), &schema.name)
        );
        if let Some(data_type) = cell::<String, _>(row, "data_type") {
            out.push_str(&format!("\n    AS {data_type}"));
        }
        for (label, column) in [
            ("START WITH", "start_value"),
            ("INCREMENT BY", "increment_by"),
            ("MINVALUE", "min_value"),
            ("MAXVALUE", "max_value"),
            ("CACHE", "cache_size"),
        ] {
            if let Some(value) = cell::<i64, _>(row, column) {
                out.push_str(&format!("\n    {label} {value}"));
            }
        }
        let cycle = cell::<bool, _>(row, "cycle").unwrap_or(false);
        out.push_str(if cycle {
            "\n    CYCLE"
        } else {
            "\n    NO CYCLE"
        });
        Ok(out)
    }
}

/// Catalog facts about a resolved relation.
struct RelationInfo {
    oid: u32,
    schema: String,
    name: String,
    kind: ObjectKind,
    comment: Option<String>,
    tablespace: Option<String>,
    /// `pg_class.reltuples`, `None` when the relation has no meaningful count.
    row_count: Option<i64>,
}

/// Human readable object kind, used in error messages.
fn kind_label(kind: ObjectKind) -> &'static str {
    match kind {
        ObjectKind::MaterializedView => "materialized view",
        ObjectKind::Sequence => "sequence",
        ObjectKind::View => "view",
        ObjectKind::Index => "index",
        _ => "relation",
    }
}

/// Read one cell, treating "not this type" as absent rather than as an error.
///
/// Decoding goes through [`Row::try_get_unchecked`] on purpose: sqlx's checked
/// accessor only accepts the handful of types each Rust decoder advertises, while
/// the text representation of *any* PostgreSQL type can be read as that type's
/// natural Rust shape (and, as a last resort, as a `String`).
fn cell<T, I>(row: &PgRow, index: I) -> Option<T>
where
    T: for<'r> Decode<'r, sqlx::Postgres>,
    I: ColumnIndex<PgRow>,
{
    row.try_get_unchecked::<T, I>(index).ok()
}

/// `"schema"."name"`, or just `"name"` when no schema is pinned (the server then
/// resolves it through `search_path`). The result is a *string*, so it can be
/// handed to `to_regclass` — the server parses and resolves it for us.
fn qualified_name(schema: Option<&str>, name: &str) -> String {
    match schema.map(str::trim).filter(|s| !s.is_empty()) {
        Some(schema) => format!(
            "{}.{}",
            quote_ident(schema, DbKind::Postgres),
            quote_ident(name, DbKind::Postgres)
        ),
        None => quote_ident(name, DbKind::Postgres),
    }
}

/// Map `pg_class.relkind` onto the object tree's vocabulary.
fn object_kind(relkind: &str) -> ObjectKind {
    match relkind {
        "v" => ObjectKind::View,
        "m" => ObjectKind::MaterializedView,
        "S" => ObjectKind::Sequence,
        "i" | "I" => ObjectKind::Index,
        // `r` (table), `p` (partitioned table), `f` (foreign table).
        _ => ObjectKind::Table,
    }
}

/// True for the maintenance and template databases.
fn is_system_database(name: &str) -> bool {
    matches!(name, "postgres" | "template0" | "template1")
}

/// `"PostgreSQL 16.1 on x86_64-pc-linux-gnu, ..."` → `"PostgreSQL 16.1"`.
fn version_banner(version: &str) -> Option<String> {
    let head = version.split(" on ").next().unwrap_or(version).trim();
    if head.is_empty() {
        None
    } else {
        Some(head.to_string())
    }
}

/// Pull `ON <keyword> <action>` out of `pg_get_constraintdef` output.
///
/// `"FOREIGN KEY (a) REFERENCES t(b) ON UPDATE CASCADE ON DELETE SET NULL"`.
fn constraint_action(definition: &str, keyword: &str) -> Option<String> {
    let upper = definition.to_ascii_uppercase();
    let marker = format!("ON {} ", keyword.to_ascii_uppercase());
    let start = upper.find(&marker)? + marker.len();
    let rest = upper[start..].trim_start();
    [
        "NO ACTION",
        "SET NULL",
        "SET DEFAULT",
        "CASCADE",
        "RESTRICT",
    ]
    .iter()
    .find(|action| rest.starts_with(**action))
    .map(|action| action.to_string())
}

/// Decode `pg_trigger.tgtype` (bit 2 = BEFORE, bit 64 = INSTEAD OF).
fn trigger_timing(type_bits: i32) -> Option<String> {
    if type_bits & 64 != 0 {
        Some("INSTEAD OF".into())
    } else if type_bits & 2 != 0 {
        Some("BEFORE".into())
    } else {
        Some("AFTER".into())
    }
}

/// Decode the event bits of `pg_trigger.tgtype`.
fn trigger_event(type_bits: i32) -> Option<String> {
    let mut events: Vec<&str> = Vec::new();
    if type_bits & 4 != 0 {
        events.push("INSERT");
    }
    if type_bits & 8 != 0 {
        events.push("DELETE");
    }
    if type_bits & 16 != 0 {
        events.push("UPDATE");
    }
    if type_bits & 32 != 0 {
        events.push("TRUNCATE");
    }
    if events.is_empty() {
        None
    } else {
        Some(events.join(" OR "))
    }
}

/// Row identity for the data grid.
fn choose_key_columns(columns: &[ColumnSchema], indexes: &[IndexSchema]) -> Vec<String> {
    let declared: Vec<String> = columns
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| c.name.clone())
        .collect();
    if !declared.is_empty() {
        return declared;
    }
    if let Some(pk) = indexes
        .iter()
        .find(|i| i.is_primary && !i.columns.is_empty())
    {
        return pk.columns.clone();
    }

    let nullable: BTreeSet<&str> = columns
        .iter()
        .filter(|c| c.nullable)
        .map(|c| c.name.as_str())
        .collect();
    indexes
        .iter()
        .filter(|i| {
            i.is_unique
                && !i.is_primary
                && !i.columns.is_empty()
                // A partial index only guarantees uniqueness where its predicate
                // holds, so it cannot identify a row.
                && index_definition(i).is_none()
        })
        .find(|i| i.columns.iter().all(|c| !nullable.contains(c.as_str())))
        .map(|i| i.columns.clone())
        .unwrap_or_default()
}

/// `Some` when `index_type` carries a ready made `CREATE INDEX` statement rather
/// than an access method name.
fn index_definition(index: &IndexSchema) -> Option<&str> {
    index
        .index_type
        .as_deref()
        .map(str::trim)
        .filter(|definition| definition.to_ascii_uppercase().starts_with("CREATE"))
}

/// Statements that produce a result set rather than an affected-row count.
fn returns_rows(sql: &str) -> bool {
    match classify_statement(sql) {
        StatementKind::Select => true,
        StatementKind::Insert | StatementKind::Update | StatementKind::Delete => {
            sql.to_ascii_lowercase().contains("returning")
        },
        _ => false,
    }
}

// ---------------------------------------------------------------------------
// DDL generation
// ---------------------------------------------------------------------------

/// Build the `CREATE TABLE`/`CREATE INDEX`/`COMMENT` script for `schema`.
///
/// PostgreSQL stores no `CREATE TABLE` text, so the script is regenerated from
/// the introspected schema. The table itself is rendered by
/// [`crate::ddl::create_table`] — the same function behind the designer's
/// preview — so the two can never disagree. Only what a column list cannot
/// express is taken from the server verbatim.
fn render_relation_ddl(schema: &TableSchema) -> String {
    let plan = plan_from_schema(schema);
    let mut statements = crate::ddl::create_table(&plan, DbKind::Postgres).statements;

    // Partial and expression indexes, and index comments, cannot be rebuilt from
    // a column list: re-emit the server's own definition instead.
    let verbatim: Vec<String> = schema
        .indexes
        .iter()
        .filter(|i| !i.is_primary)
        .filter_map(|i| index_definition(i).map(str::to_string))
        .collect();

    let mut trailing: Vec<String> = Vec::new();
    if let Some(comment) = schema.comment.as_deref().filter(|c| !c.is_empty()) {
        trailing.push(format!(
            "COMMENT ON TABLE {} IS {}",
            qualified_name(schema.schema.as_deref(), &schema.name),
            escape_literal(comment, DbKind::Postgres)
        ));
    }

    // `ddl::create_table` already emitted the column comments; keep them after
    // the indexes so the script reads in dependency order.
    let at = statements
        .iter()
        .position(|s| s.starts_with("COMMENT "))
        .unwrap_or(statements.len());
    for (offset, definition) in verbatim.into_iter().enumerate() {
        statements.insert(at + offset, definition);
    }
    statements.extend(trailing);
    statements.join(";\n\n")
}

/// Translate an introspected [`TableSchema`] into the designer's [`TablePlan`].
fn plan_from_schema(schema: &TableSchema) -> TablePlan {
    TablePlan {
        // PostgreSQL relations are addressed as `schema.table`; the connection is
        // already bound to one database.
        database: None,
        schema: schema.schema.clone(),
        name: schema.name.clone(),
        original_name: None,
        kind: schema.kind,
        columns: schema
            .columns
            .iter()
            .map(|c| ColumnPlan {
                name: c.name.clone(),
                data_type: c.data_type.clone(),
                nullable: c.nullable,
                // An identity column carries its default in the type definition;
                // emitting `GENERATED ... AS IDENTITY` *and* the `nextval(...)`
                // default that a serial column has is a syntax error.
                default_value: if c.is_auto_increment {
                    None
                } else {
                    c.default_value.clone()
                },
                is_primary_key: c.is_primary_key,
                is_auto_increment: c.is_auto_increment,
                // Uniqueness is rebuilt from the indexes below so the constraint
                // keeps its name instead of becoming an anonymous column clause.
                is_unique: false,
                comment: c.comment.clone(),
                original_name: None,
                dropped: false,
                enum_values: c.enum_values.clone(),
            })
            .collect(),
        indexes: schema
            .indexes
            .iter()
            .filter(|i| index_definition(i).is_none())
            .map(|i| IndexPlan {
                name: i.name.clone(),
                columns: i.columns.clone(),
                is_unique: i.is_unique,
                is_primary: i.is_primary,
                is_new: true,
                dropped: false,
            })
            .collect(),
        foreign_keys: schema
            .foreign_keys
            .iter()
            .map(|f| ForeignKeyPlan {
                name: f.name.clone(),
                columns: f.columns.clone(),
                ref_table: f.ref_table.clone(),
                ref_columns: f.ref_columns.clone(),
                ref_schema: f.ref_schema.clone(),
                on_update: f.on_update.clone(),
                on_delete: f.on_delete.clone(),
                dropped: false,
            })
            .collect(),
        options: schema.options.clone(),
        is_new: false,
    }
}

// ---------------------------------------------------------------------------
// Cell decoding
// ---------------------------------------------------------------------------

/// Where a PostgreSQL type name routes in [`decode_cell`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum CellFamily {
    Bool,
    Int,
    /// Unsigned integers such as `oid`.
    Uint,
    Float,
    Decimal,
    /// `money`: a decimal when the server renders one, text otherwise.
    Money,
    Text,
    Bytes,
    Date,
    Time,
    /// `timestamp without time zone`.
    Timestamp,
    /// `timestamp with time zone`.
    DateTime,
    Uuid,
    Json,
    Array(ArrayElement),
    Unknown,
}

/// Element family of the array types the grid renders as JSON.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ArrayElement {
    Int4,
    Int8,
    Text,
    Bool,
    Float4,
    Float8,
    Other,
}

/// Classify a type name as reported by the server.
///
/// Built-in types arrive with their catalog names (`int4`, `timestamptz`, ...);
/// arrays are named `_int4` by the catalog and `int4[]` by hand written SQL, and
/// both spellings are accepted here. A user defined type has no resolvable name
/// over the simple query protocol and shows up as `?`, which falls through to
/// [`CellFamily::Unknown`] and is rendered as text.
fn cell_family(type_name: &str) -> CellFamily {
    let name = type_name.to_ascii_uppercase();
    if let Some(element) = array_element(&name) {
        return CellFamily::Array(match element.as_str() {
            "INT2" | "INT4" => ArrayElement::Int4,
            "INT8" | "OID" => ArrayElement::Int8,
            "TEXT" | "VARCHAR" | "BPCHAR" | "CHAR" | "NAME" | "CITEXT" | "UUID" => {
                ArrayElement::Text
            },
            "BOOL" => ArrayElement::Bool,
            "FLOAT4" => ArrayElement::Float4,
            "FLOAT8" => ArrayElement::Float8,
            _ => ArrayElement::Other,
        });
    }

    match name.as_str() {
        "BOOL" => CellFamily::Bool,
        "INT2" | "INT4" | "INT8" => CellFamily::Int,
        "OID" => CellFamily::Uint,
        "FLOAT4" | "FLOAT8" => CellFamily::Float,
        "NUMERIC" => CellFamily::Decimal,
        "MONEY" => CellFamily::Money,
        "TEXT" | "VARCHAR" | "BPCHAR" | "CHAR" | "NAME" | "CITEXT" | "XML" | "INET" | "CIDR"
        | "MACADDR" | "MACADDR8" | "TSVECTOR" | "TSQUERY" | "INTERVAL" | "REFCURSOR"
        | "UNKNOWN" | "VOID" => CellFamily::Text,
        "BYTEA" => CellFamily::Bytes,
        "DATE" => CellFamily::Date,
        "TIME" | "TIMETZ" => CellFamily::Time,
        "TIMESTAMP" => CellFamily::Timestamp,
        "TIMESTAMPTZ" => CellFamily::DateTime,
        "UUID" => CellFamily::Uuid,
        "JSON" | "JSONB" => CellFamily::Json,
        _ => CellFamily::Unknown,
    }
}

/// `_int4` and `int4[]` both name the array of `int4`.
fn array_element(type_name: &str) -> Option<String> {
    if let Some(element) = type_name.strip_suffix("[]") {
        if !element.is_empty() {
            return Some(element.to_string());
        }
    }
    if let Some(element) = type_name.strip_prefix('_') {
        if !element.is_empty() {
            return Some(element.to_string());
        }
    }
    None
}

/// Decode one cell, dispatching on the value's own type.
fn decode_cell(row: &PgRow, idx: usize) -> Value {
    let raw = match row.try_get_raw(idx) {
        Ok(raw) => raw,
        Err(_) => return Value::Null,
    };
    if raw.is_null() {
        return Value::Null;
    }

    let type_name = raw.type_info().name().to_ascii_uppercase();
    decode_family(row, idx, cell_family(&type_name))
        .unwrap_or_else(|| decode_fallback(row, idx, &type_name))
}

/// The typed decode for one family, or `None` when the value does not fit it.
fn decode_family(row: &PgRow, idx: usize, family: CellFamily) -> Option<Value> {
    Some(match family {
        CellFamily::Bool => Value::Bool(cell::<bool, _>(row, idx)?),
        CellFamily::Int => Value::Int(cell::<i64, _>(row, idx)?),
        CellFamily::Uint => Value::Uint(u64::from(cell::<Oid, _>(row, idx)?.0)),
        CellFamily::Float => match cell::<f64, _>(row, idx) {
            Some(v) => Value::Float(v),
            None => Value::Float(f64::from(cell::<f32, _>(row, idx)?)),
        },
        CellFamily::Decimal => Value::Decimal(cell::<BigDecimal, _>(row, idx)?.to_string()),
        CellFamily::Money => match cell::<BigDecimal, _>(row, idx) {
            Some(amount) => Value::Decimal(amount.to_string()),
            // `money` is locale formatted ("$1,234.56"), which is not a decimal.
            None => Value::Text(cell::<String, _>(row, idx)?),
        },
        CellFamily::Text => Value::Text(cell::<String, _>(row, idx)?),
        CellFamily::Bytes => Value::Bytes(cell::<Vec<u8>, _>(row, idx)?),
        CellFamily::Date => Value::Date(
            cell::<NaiveDate, _>(row, idx)?
                .format("%Y-%m-%d")
                .to_string(),
        ),
        CellFamily::Time => match cell::<NaiveTime, _>(row, idx) {
            Some(time) => Value::Time(format_time(time)),
            // `timetz` keeps its offset, which a naive time cannot carry.
            None => Value::Time(cell::<String, _>(row, idx)?),
        },
        CellFamily::Timestamp => {
            Value::DateTime(format_timestamp(cell::<NaiveDateTime, _>(row, idx)?))
        },
        CellFamily::DateTime => {
            Value::DateTime(format_timestamptz(cell::<DateTime<Utc>, _>(row, idx)?))
        },
        CellFamily::Uuid => Value::Text(cell::<uuid::Uuid, _>(row, idx)?.to_string()),
        CellFamily::Json => match cell::<sqlx::types::Json<serde_json::Value>, _>(row, idx) {
            Some(sqlx::types::Json(json)) => Value::Json(json.to_string()),
            None => Value::Json(cell::<String, _>(row, idx)?),
        },
        CellFamily::Array(element) => Value::Json(decode_array(row, idx, element)?),
        CellFamily::Unknown => return None,
    })
}

/// Render an array as a JSON array so the grid can show and edit it.
///
/// Elements are decoded as `Option<T>`: `NULL` inside an array is a normal value
/// that must not fail the whole cell.
fn decode_array(row: &PgRow, idx: usize, element: ArrayElement) -> Option<String> {
    let json = match element {
        ArrayElement::Int4 => serde_json::json!(cell::<Vec<Option<i32>>, _>(row, idx)?),
        ArrayElement::Int8 => serde_json::json!(cell::<Vec<Option<i64>>, _>(row, idx)?),
        ArrayElement::Text => serde_json::json!(cell::<Vec<Option<String>>, _>(row, idx)?),
        ArrayElement::Bool => serde_json::json!(cell::<Vec<Option<bool>>, _>(row, idx)?),
        ArrayElement::Float4 => serde_json::json!(cell::<Vec<Option<f32>>, _>(row, idx)?),
        ArrayElement::Float8 => serde_json::json!(cell::<Vec<Option<f64>>, _>(row, idx)?),
        ArrayElement::Other => return None,
    };
    Some(json.to_string())
}

/// Last resort: the value as the server rendered it, or at least its type.
fn decode_fallback(row: &PgRow, idx: usize, type_name: &str) -> Value {
    if let Some(text) = cell::<String, _>(row, idx) {
        return Value::Text(text);
    }
    let label = if type_name.is_empty() || type_name == "?" {
        "unknown".to_string()
    } else {
        type_name.to_ascii_lowercase()
    };
    Value::Text(format!("<{label}>"))
}

/// `HH:MM:SS[.ffffff]`, trailing zeros trimmed the way PostgreSQL trims them.
fn format_time(time: NaiveTime) -> String {
    let mut out = time.format("%H:%M:%S").to_string();
    // Call through the trait: chrono 0.4.45 added a private inherent
    // `nanosecond` that otherwise shadows `Timelike::nanosecond`.
    let nanos = chrono::Timelike::nanosecond(&time);
    if nanos > 0 {
        out.push_str(&fraction(nanos));
    }
    out
}

/// `YYYY-MM-DD HH:MM:SS[.ffffff]`.
fn format_timestamp(timestamp: NaiveDateTime) -> String {
    let mut out = timestamp.format("%Y-%m-%d %H:%M:%S").to_string();
    if timestamp.and_utc().timestamp_subsec_nanos() > 0 {
        out.push_str(&fraction(timestamp.and_utc().timestamp_subsec_nanos()));
    }
    out
}

/// `YYYY-MM-DD HH:MM:SS[.ffffff]+00`.
///
/// The offset is kept explicit so a value written back by the grid is interpreted
/// as the instant it was read, whatever the session's `TimeZone` happens to be.
fn format_timestamptz(timestamp: DateTime<Utc>) -> String {
    format!("{}+00", format_timestamp(timestamp.naive_utc()))
}

/// `.ffffff` with trailing zeros (but never the leading digit) removed.
fn fraction(nanoseconds: u32) -> String {
    let mut digits = format!("{:06}", nanoseconds / 1_000);
    while digits.len() > 1 && digits.ends_with('0') {
        digits.pop();
    }
    format!(".{digits}")
}

fn decode_row(row: &PgRow) -> Vec<Value> {
    (0..row.len()).map(|i| decode_cell(row, i)).collect()
}

fn build_columns(row: &PgRow) -> Vec<ColumnMeta> {
    row.columns()
        .iter()
        .map(|c| {
            let reported = c.type_info().name().to_string();
            // The simple query protocol cannot resolve user defined type names,
            // which sqlx reports as `?`.
            let type_name = if reported.is_empty() || reported == "?" {
                "unknown".to_string()
            } else {
                reported
            };
            ColumnMeta {
                name: c.name().to_string(),
                logical_type: common::logical_type(DbKind::Postgres, &type_name),
                type_name,
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

// ---------------------------------------------------------------------------
// Driver
// ---------------------------------------------------------------------------

#[async_trait]
impl Driver for PostgresDriver {
    fn kind(&self) -> DbKind {
        DbKind::Postgres
    }

    async fn server_info(&self) -> Result<ServerInfo> {
        let sql = "SELECT pg_catalog.version() AS version, \
                          current_user AS username, \
                          current_database() AS database_name, \
                          pg_catalog.current_setting('server_encoding') AS server_encoding, \
                          pg_catalog.current_setting('TimeZone') AS timezone, \
                          pg_catalog.current_setting('max_connections') AS max_connections, \
                          EXTRACT(EPOCH FROM (pg_catalog.now() \
                              - pg_catalog.pg_postmaster_start_time()))::int8 AS uptime_secs";
        let rows = self.fetch_all(sql).await?;
        let row = rows
            .first()
            .ok_or_else(|| CoreError::Query("the server returned no session information".into()))?;

        let version = cell::<String, _>(row, "version").unwrap_or_else(|| "unknown".into());
        Ok(ServerInfo {
            edition: version_banner(&version),
            version,
            current_user: cell::<String, _>(row, "username"),
            current_database: cell::<String, _>(row, "database_name"),
            server_encoding: cell::<String, _>(row, "server_encoding"),
            timezone: cell::<String, _>(row, "timezone"),
            max_connections: cell::<String, _>(row, "max_connections")
                .and_then(|value| value.trim().parse::<i64>().ok()),
            uptime_secs: cell::<i64, _>(row, "uptime_secs"),
        })
    }

    async fn list_databases(&self) -> Result<Vec<DatabaseInfo>> {
        // `pg_database_size` is only readable for databases the role may connect
        // to, so it is guarded rather than failing the whole listing.
        let sql = "SELECT d.datname AS name, \
                          pg_catalog.pg_encoding_to_char(d.encoding) AS encoding, \
                          pg_catalog.obj_description(d.oid, 'pg_database') AS comment, \
                          CASE WHEN pg_catalog.has_database_privilege(d.datname, 'CONNECT') \
                               THEN pg_catalog.pg_database_size(d.datname) END AS size_bytes \
                   FROM pg_catalog.pg_database d \
                   WHERE NOT d.datistemplate \
                   ORDER BY d.datname";
        let rows = self.fetch_all(sql).await?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                let name = cell::<String, _>(row, "name")?;
                Some(DatabaseInfo {
                    is_system: is_system_database(&name),
                    name,
                    size_bytes: cell::<i64, _>(row, "size_bytes"),
                    comment: cell::<String, _>(row, "comment"),
                    charset: cell::<String, _>(row, "encoding"),
                })
            })
            .collect())
    }

    async fn list_schemas(&self, database: Option<&str>) -> Result<Vec<String>> {
        // Schemas only exist within the connected database, so a request for
        // another one is a mistake worth reporting rather than guessing at.
        self.check_database(database)?;
        let sql = "SELECT n.nspname AS name \
                   FROM pg_catalog.pg_namespace n \
                   WHERE n.nspname NOT LIKE 'pg\\_%' \
                     AND n.nspname <> 'information_schema' \
                   ORDER BY n.nspname";
        let rows = self.fetch_all(sql).await?;
        Ok(rows
            .iter()
            .filter_map(|row| cell::<String, _>(row, "name"))
            .collect())
    }

    async fn list_objects(&self, scope: &Scope) -> Result<Vec<ObjectRef>> {
        let scope = self.resolve_scope(scope)?;
        let schema = scope.schema.as_deref().unwrap_or(DEFAULT_SCHEMA);
        let sql = format!(
            "SELECT c.relname AS name, \
                    c.relkind::text AS relkind, \
                    pg_catalog.obj_description(c.oid, 'pg_class') AS comment, \
                    CASE WHEN c.relkind IN ('r','p','m') THEN c.reltuples::int8 END AS row_count \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind IN ('r','p','v','m','f') AND n.nspname = {} \
             ORDER BY c.relname",
            escape_literal(schema, DbKind::Postgres)
        );
        let rows = self.fetch_all(&sql).await?;
        Ok(rows
            .iter()
            .filter_map(|row| {
                let name = cell::<String, _>(row, "name")?;
                let relkind = cell::<String, _>(row, "relkind").unwrap_or_default();
                let mut object = ObjectRef::new(object_kind(&relkind), name);
                object.schema = Some(schema.to_string());
                object.database = None;
                object.comment = cell::<String, _>(row, "comment");
                object.row_count = cell::<i64, _>(row, "row_count").filter(|n| *n >= 0);
                if relkind == "f" {
                    // Foreign tables behave like tables but are served by an
                    // extension; the tree labels them separately.
                    object
                        .extra
                        .insert("relkind".into(), "foreign table".into());
                }
                Some(object)
            })
            .collect())
    }

    async fn list_routines(&self, scope: &Scope) -> Result<Vec<ObjectRef>> {
        let scope = self.resolve_scope(scope)?;
        let schema = scope.schema.as_deref().unwrap_or(DEFAULT_SCHEMA);
        let literal = escape_literal(schema, DbKind::Postgres);
        let routines = format!(
            "SELECT p.proname AS name, \
                    p.prokind::text AS prokind, \
                    pg_catalog.obj_description(p.oid, 'pg_proc') AS comment \
             FROM pg_catalog.pg_proc p \
             JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace \
             WHERE n.nspname = {literal} AND p.prokind IN ('f','p') \
             ORDER BY p.proname"
        );
        let sequences = format!(
            "SELECT c.relname AS name, \
                    pg_catalog.obj_description(c.oid, 'pg_class') AS comment \
             FROM pg_catalog.pg_class c \
             JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace \
             WHERE c.relkind = 'S' AND n.nspname = {literal} \
             ORDER BY c.relname"
        );

        let mut out: Vec<ObjectRef> = Vec::new();
        for row in self.fetch_all(&routines).await? {
            let Some(name) = cell::<String, _>(&row, "name") else {
                continue;
            };
            // Overloads share a name; the tree shows one node per routine.
            let kind = if cell::<String, _>(&row, "prokind").as_deref() == Some("p") {
                ObjectKind::Procedure
            } else {
                ObjectKind::Function
            };
            if out.iter().any(|o| o.name == name && o.kind == kind) {
                continue;
            }
            let mut object = ObjectRef::new(kind, name);
            object.schema = Some(schema.to_string());
            object.comment = cell::<String, _>(&row, "comment");
            out.push(object);
        }

        for row in self.fetch_all(&sequences).await? {
            let Some(name) = cell::<String, _>(&row, "name") else {
                continue;
            };
            let mut object = ObjectRef::new(ObjectKind::Sequence, name);
            object.schema = Some(schema.to_string());
            object.comment = cell::<String, _>(&row, "comment");
            out.push(object);
        }
        Ok(out)
    }

    async fn table_schema(
        &self,
        scope: &Scope,
        name: &str,
        kind: ObjectKind,
    ) -> Result<TableSchema> {
        let scope = self.resolve_scope(scope)?;
        let relation = self.relation_info(&scope, name).await?;

        let mut columns = self.columns(relation.oid).await?;
        let indexes = self.indexes(relation.oid).await?;
        let foreign_keys = self.foreign_keys(relation.oid).await?;
        let triggers = self.triggers(relation.oid).await.unwrap_or_default();

        // The primary key and column uniqueness both live in `pg_index`.
        let primary: Vec<String> = indexes
            .iter()
            .filter(|i| i.is_primary)
            .flat_map(|i| i.columns.clone())
            .collect();
        for column in columns.iter_mut() {
            column.is_primary_key = primary.contains(&column.name);
            let name = column.name.clone();
            column.is_unique = indexes.iter().any(|i| {
                i.is_unique && !i.is_primary && i.columns.len() == 1 && i.columns[0] == name
            });
        }

        let mut options = BTreeMap::new();
        if let Some(tablespace) = relation.tablespace.as_deref() {
            options.insert("tablespace".into(), tablespace.to_string());
        }

        let mut schema = TableSchema {
            name: relation.name.clone(),
            // Trust the catalog over the caller: a view that was opened as a
            // table still needs a view-shaped description.
            kind: match relation.kind {
                ObjectKind::Table if kind != ObjectKind::Table => kind,
                resolved => resolved,
            },
            database: None,
            schema: Some(relation.schema.clone()),
            columns,
            indexes,
            foreign_keys,
            triggers,
            comment: relation.comment.clone(),
            row_count: relation.row_count,
            ddl: None,
            options,
        };

        // Introspecting a plain table is pure string work; views and sequences
        // need one more catalog read. A kind we cannot render is not fatal.
        schema.ddl = match self.schema_ddl(relation.oid, &schema).await {
            Ok(ddl) => Some(ddl),
            Err(CoreError::Unsupported(_)) => None,
            Err(err) => return Err(err),
        };
        Ok(schema)
    }

    async fn table_ddl(&self, scope: &Scope, name: &str, kind: ObjectKind) -> Result<String> {
        let schema = self.table_schema(scope, name, kind).await?;
        schema
            .ddl
            .ok_or_else(|| CoreError::NotFound(format!("`{name}` has no describable definition")))
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
            let statement_kind = classify_statement(&statement);

            if returns_rows(&statement) {
                // PostgreSQL rejects several statements inside one prepared
                // statement; the split above already hands us one at a time.
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
                    statement_kind,
                    statement: statement.clone(),
                    truncated,
                });
            } else {
                let affected = self.execute_raw(&statement).await?;
                results.push(common::affected_result(
                    &statement,
                    affected,
                    // PostgreSQL has no last-insert-id: use `RETURNING` instead.
                    None,
                    started.elapsed().as_secs_f64() * 1000.0,
                ));
            }
        }
        Ok(results)
    }

    async fn fetch_page(&self, req: &PageRequest) -> Result<TablePage> {
        let started = Instant::now();
        let scope = self.resolve_scope(&req.scope)?;
        let schema = self
            .table_schema(&req.scope, &req.table, ObjectKind::Table)
            .await?;

        let columns = common::columns_from_schema(&schema);
        let names: Vec<String> = columns.iter().map(|c| c.name.clone()).collect();
        let key_columns = choose_key_columns(&schema.columns, &schema.indexes);

        // Select through the catalog's spelling of the name so a table that was
        // created quoted (`"Users"`) is found even when the caller typed it lower
        // case.
        let sql = common::paged_select(&common::PageQuery {
            kind: DbKind::Postgres,
            scope: &scope,
            table: &schema.name,
            columns: &names,
            order_by: &req.order_by,
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
        let scope = self.resolve_scope(&req.scope)?;
        let filtered = req
            .filter
            .as_deref()
            .map(str::trim)
            .filter(|f| !f.is_empty())
            .is_some();

        let sql = if req.approximate && !filtered {
            // `reltuples` is kept up to date by ANALYZE and autovacuum: good
            // enough for a tree label, and free compared to a real count.
            let target = qualified_name(scope.schema.as_deref(), &req.table);
            format!(
                "SELECT GREATEST(c.reltuples, 0)::int8 FROM pg_catalog.pg_class c \
                 WHERE c.oid = pg_catalog.to_regclass({})",
                escape_literal(&target, DbKind::Postgres)
            )
        } else {
            common::count_select(DbKind::Postgres, &scope, &req.table, req.filter.as_deref())
        };

        let rows = self.fetch_all(&sql).await?;
        Ok(rows
            .first()
            .and_then(|row| cell::<i64, _>(row, 0))
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
        let filter = common::search_predicate(DbKind::Postgres, &targets, &req.needle);
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
        let scope = self.resolve_scope(&edit_scope(edit))?;
        let changes: Vec<(String, Value, Value)> = edit
            .changes
            .iter()
            .map(|c| (c.column.clone(), c.old_value.clone(), c.new_value.clone()))
            .collect();
        let order = self.order_keys(&scope, &edit.table, &edit.keys).await?;
        let sql = crate::edit::build_update(
            DbKind::Postgres,
            &scope,
            &edit.table,
            &edit.keys,
            &order,
            &changes,
        )?;
        self.execute_raw(&sql).await
    }

    async fn insert_row(&self, insert: &RowInsert) -> Result<u64> {
        self.guard_write()?;
        let scope = self.resolve_scope(&Scope {
            database: insert.database.clone(),
            schema: insert.schema.clone(),
        })?;
        // NULL means "leave it out" so the server fills in defaults, identity
        // values included.
        let sql = crate::edit::build_insert(
            DbKind::Postgres,
            &scope,
            &insert.table,
            &insert.values,
            true,
        );
        self.execute_raw(&sql).await
    }

    async fn delete_row(&self, edit: &RowEdit) -> Result<u64> {
        self.guard_write()?;
        let scope = self.resolve_scope(&edit_scope(edit))?;
        let order = self.order_keys(&scope, &edit.table, &edit.keys).await?;
        let sql =
            crate::edit::build_delete(DbKind::Postgres, &scope, &edit.table, &edit.keys, &order)?;
        self.execute_raw(&sql).await
    }

    async fn rename_object(
        &self,
        scope: &Scope,
        from: &str,
        to: &str,
        kind: ObjectKind,
    ) -> Result<()> {
        self.guard_write()?;
        let scope = self.resolve_scope(scope)?;
        let sql = format!(
            "ALTER {} {} RENAME TO {}",
            alter_keyword(kind),
            common::relation(&scope, from, DbKind::Postgres),
            quote_ident(to, DbKind::Postgres)
        );
        self.execute_raw(&sql).await?;
        Ok(())
    }

    async fn drop_object(&self, scope: &Scope, name: &str, kind: ObjectKind) -> Result<()> {
        self.guard_write()?;
        let scope = self.resolve_scope(scope)?;
        let sql = format!(
            "DROP {} {}",
            alter_keyword(kind),
            common::relation(&scope, name, DbKind::Postgres)
        );
        self.execute_raw(&sql).await?;
        Ok(())
    }

    async fn truncate_table(&self, scope: &Scope, name: &str) -> Result<()> {
        self.guard_write()?;
        let scope = self.resolve_scope(scope)?;
        let sql = format!(
            "TRUNCATE TABLE {}",
            common::relation(&scope, name, DbKind::Postgres)
        );
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

/// The scope an edit refers to.
fn edit_scope(edit: &RowEdit) -> Scope {
    Scope {
        database: edit.database.clone(),
        schema: edit.schema.clone(),
    }
}

/// The object keyword shared by `ALTER <kind>` and `DROP <kind>`.
fn alter_keyword(kind: ObjectKind) -> &'static str {
    match kind {
        ObjectKind::View => "VIEW",
        ObjectKind::MaterializedView => "MATERIALIZED VIEW",
        ObjectKind::Sequence => "SEQUENCE",
        _ => "TABLE",
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn column(name: &str, data_type: &str, nullable: bool, primary: bool) -> ColumnSchema {
        ColumnSchema {
            name: name.into(),
            data_type: data_type.into(),
            logical_type: common::logical_type(DbKind::Postgres, data_type),
            nullable,
            default_value: None,
            is_primary_key: primary,
            is_auto_increment: false,
            is_unique: false,
            comment: None,
            ordinal: 1,
            char_max_length: None,
            numeric_precision: None,
            numeric_scale: None,
            extra: None,
            enum_values: Vec::new(),
        }
    }

    fn index(name: &str, columns: &[&str], unique: bool, primary: bool) -> IndexSchema {
        IndexSchema {
            name: name.into(),
            columns: columns.iter().map(|c| (*c).to_string()).collect(),
            is_unique: unique,
            is_primary: primary,
            index_type: Some("btree".into()),
            comment: None,
        }
    }

    fn users_schema() -> TableSchema {
        let mut id = column("id", "integer", false, true);
        id.is_auto_increment = true;
        id.extra = Some("GENERATED BY DEFAULT AS IDENTITY".into());

        let mut email = column("email", "character varying(255)", false, false);
        email.is_unique = true;
        email.char_max_length = Some(255);

        let mut note = column("note", "text", true, false);
        note.comment = Some("free text".to_string());
        note.default_value = Some("'n/a'::text".into());

        let mut amount = column("amount", "numeric(10,2)", true, false);
        amount.numeric_precision = Some(10);
        amount.numeric_scale = Some(2);

        TableSchema {
            name: "users".into(),
            kind: ObjectKind::Table,
            database: None,
            schema: Some("public".into()),
            columns: vec![id, email, note, amount],
            indexes: vec![
                index("users_pkey", &["id"], true, true),
                index("users_email_key", &["email"], true, false),
                index("users_note_idx", &["note"], false, false),
                IndexSchema {
                    name: "users_lower_email_idx".into(),
                    columns: Vec::new(),
                    is_unique: false,
                    is_primary: false,
                    index_type: Some(
                        "CREATE INDEX users_lower_email_idx ON public.users USING btree (lower(email))"
                            .into(),
                    ),
                    comment: None,
                },
            ],
            foreign_keys: vec![ForeignKeySchema {
                name: "users_role_fkey".into(),
                columns: vec!["role_id".into()],
                ref_table: "roles".into(),
                ref_columns: vec!["id".into()],
                ref_schema: Some("public".into()),
                on_update: Some("CASCADE".into()),
                on_delete: Some("SET NULL".into()),
            }],
            triggers: vec![TriggerSchema {
                name: "users_touch".into(),
                timing: trigger_timing(2 | 1 | 16),
                event: trigger_event(2 | 1 | 16),
                statement: Some("CREATE TRIGGER users_touch ...".into()),
            }],
            comment: Some("people".into()),
            row_count: Some(0),
            ddl: None,
            options: Default::default(),
        }
    }

    #[test]
    fn maps_type_names_to_cell_families() {
        assert_eq!(cell_family("bool"), CellFamily::Bool);
        assert_eq!(cell_family("INT2"), CellFamily::Int);
        assert_eq!(cell_family("int8"), CellFamily::Int);
        assert_eq!(cell_family("oid"), CellFamily::Uint);
        assert_eq!(cell_family("float4"), CellFamily::Float);
        assert_eq!(cell_family("numeric"), CellFamily::Decimal);
        assert_eq!(cell_family("money"), CellFamily::Money);
        assert_eq!(cell_family("text"), CellFamily::Text);
        assert_eq!(cell_family("citext"), CellFamily::Text);
        assert_eq!(cell_family("inet"), CellFamily::Text);
        assert_eq!(cell_family("tsvector"), CellFamily::Text);
        assert_eq!(cell_family("interval"), CellFamily::Text);
        assert_eq!(cell_family("bytea"), CellFamily::Bytes);
        assert_eq!(cell_family("date"), CellFamily::Date);
        assert_eq!(cell_family("timetz"), CellFamily::Time);
        assert_eq!(cell_family("timestamp"), CellFamily::Timestamp);
        assert_eq!(cell_family("timestamptz"), CellFamily::DateTime);
        assert_eq!(cell_family("uuid"), CellFamily::Uuid);
        assert_eq!(cell_family("jsonb"), CellFamily::Json);
        // An unresolvable user defined type falls back to text.
        assert_eq!(cell_family("?"), CellFamily::Unknown);

        assert_eq!(cell_family("_int4"), CellFamily::Array(ArrayElement::Int4));
        assert_eq!(cell_family("int4[]"), CellFamily::Array(ArrayElement::Int4));
        assert_eq!(cell_family("_int8"), CellFamily::Array(ArrayElement::Int8));
        assert_eq!(cell_family("_text"), CellFamily::Array(ArrayElement::Text));
        assert_eq!(
            cell_family("varchar[]"),
            CellFamily::Array(ArrayElement::Text)
        );
        assert_eq!(cell_family("_bool"), CellFamily::Array(ArrayElement::Bool));
        assert_eq!(
            cell_family("_float8"),
            CellFamily::Array(ArrayElement::Float8)
        );
        assert_eq!(
            cell_family("_numeric"),
            CellFamily::Array(ArrayElement::Other)
        );
    }

    #[test]
    fn generates_a_readable_create_table() {
        let ddl = render_relation_ddl(&users_schema());

        assert!(
            ddl.starts_with("CREATE TABLE \"public\".\"users\" (\n"),
            "{ddl}"
        );
        // Identity columns are spelled out, never as `integer DEFAULT nextval(..)`.
        assert!(
            ddl.contains("\"id\" integer GENERATED BY DEFAULT AS IDENTITY NOT NULL"),
            "{ddl}"
        );
        assert!(
            ddl.contains("\"email\" character varying(255) NOT NULL"),
            "{ddl}"
        );
        assert!(ddl.contains("\"amount\" numeric(10,2)"), "{ddl}");
        assert!(ddl.contains("\"note\" text DEFAULT 'n/a'::text"), "{ddl}");
        assert!(ddl.contains("PRIMARY KEY (\"id\")"), "{ddl}");
        // Uniqueness keeps its constraint name instead of an inline UNIQUE.
        assert!(
            ddl.contains("CONSTRAINT \"users_email_key\" UNIQUE (\"email\")"),
            "{ddl}"
        );
        assert!(
            ddl.contains("CONSTRAINT \"users_role_fkey\" FOREIGN KEY (\"role_id\")"),
            "{ddl}"
        );
        assert!(ddl.contains("ON DELETE SET NULL"), "{ddl}");
        assert!(
            ddl.contains("CREATE INDEX \"users_note_idx\" ON \"public\".\"users\" (\"note\")"),
            "{ddl}"
        );
        // An expression index cannot be rebuilt from columns: it is re-emitted.
        assert!(
            ddl.contains(
                "CREATE INDEX users_lower_email_idx ON public.users USING btree (lower(email))"
            ),
            "{ddl}"
        );
        assert!(
            ddl.contains("COMMENT ON COLUMN \"public\".\"users\".\"note\" IS 'free text'"),
            "{ddl}"
        );
        assert!(
            ddl.contains("COMMENT ON TABLE \"public\".\"users\" IS 'people'"),
            "{ddl}"
        );
        // Comments come last so the script reads in dependency order.
        let create_at = ddl.find("CREATE INDEX users_lower_email_idx").unwrap();
        let comment_at = ddl.find("COMMENT ON COLUMN").unwrap();
        assert!(create_at < comment_at, "{ddl}");
    }

    #[test]
    fn ddl_never_emits_both_identity_and_default() {
        let mut schema = users_schema();
        schema.columns[0].default_value = Some("nextval('users_id_seq'::regclass)".into());
        let ddl = render_relation_ddl(&schema);
        assert!(ddl.contains("GENERATED BY DEFAULT AS IDENTITY"), "{ddl}");
        assert!(!ddl.contains("nextval"), "{ddl}");
    }

    #[test]
    fn picks_a_row_identity() {
        let schema = users_schema();
        assert_eq!(
            choose_key_columns(&schema.columns, &schema.indexes),
            vec!["id".to_string()]
        );

        // Without a primary key, a fully NOT NULL unique index is used.
        let mut columns = vec![
            column("code", "text", false, false),
            column("region", "text", false, false),
        ];
        let indexes = vec![index("t_code_region_key", &["code", "region"], true, false)];
        assert_eq!(
            choose_key_columns(&columns, &indexes),
            vec!["code".to_string(), "region".to_string()]
        );

        // A nullable column makes the index unusable as a row identity.
        columns[1].nullable = true;
        assert!(choose_key_columns(&columns, &indexes).is_empty());

        // ... and so does a partial unique index, which only holds where its
        // predicate is true.
        let partial = vec![IndexSchema {
            index_type: Some("CREATE UNIQUE INDEX t_code_key ON t (code) WHERE deleted".into()),
            ..index("t_code_key", &["code"], true, false)
        }];
        assert!(choose_key_columns(&columns, &partial).is_empty());
    }

    #[test]
    fn reads_foreign_key_actions() {
        let definition = "FOREIGN KEY (role_id) REFERENCES roles(id) ON UPDATE CASCADE \
                          ON DELETE SET NULL DEFERRABLE INITIALLY DEFERRED";
        assert_eq!(
            constraint_action(definition, "UPDATE").as_deref(),
            Some("CASCADE")
        );
        assert_eq!(
            constraint_action(definition, "DELETE").as_deref(),
            Some("SET NULL")
        );
        assert_eq!(
            constraint_action("FOREIGN KEY (a) REFERENCES t(b)", "DELETE"),
            None
        );
        assert_eq!(
            constraint_action(
                "FOREIGN KEY (a) REFERENCES t(b) ON DELETE NO ACTION",
                "DELETE"
            )
            .as_deref(),
            Some("NO ACTION")
        );
    }

    #[test]
    fn decodes_trigger_bits() {
        // BEFORE INSERT OR UPDATE, FOR EACH ROW.
        let bits = 2 | 1 | 4 | 16;
        assert_eq!(trigger_timing(bits).as_deref(), Some("BEFORE"));
        assert_eq!(trigger_event(bits).as_deref(), Some("INSERT OR UPDATE"));
        // AFTER DELETE, statement level.
        assert_eq!(trigger_timing(8).as_deref(), Some("AFTER"));
        assert_eq!(trigger_event(8).as_deref(), Some("DELETE"));
        // INSTEAD OF UPDATE, on a view.
        assert_eq!(trigger_timing(64 | 16).as_deref(), Some("INSTEAD OF"));
    }

    #[test]
    fn formats_temporal_values() {
        let timestamp = NaiveDate::from_ymd_opt(2024, 5, 1)
            .unwrap()
            .and_hms_micro_opt(10, 30, 15, 123_400)
            .unwrap();
        assert_eq!(format_timestamp(timestamp), "2024-05-01 10:30:15.1234");
        assert_eq!(
            format_timestamp(
                NaiveDate::from_ymd_opt(2024, 5, 1)
                    .unwrap()
                    .and_hms_opt(10, 30, 15)
                    .unwrap()
            ),
            "2024-05-01 10:30:15"
        );
        assert_eq!(
            format_timestamptz(timestamp.and_utc()),
            "2024-05-01 10:30:15.1234+00"
        );
        assert_eq!(
            format_time(NaiveTime::from_hms_micro_opt(9, 5, 0, 500_000).unwrap()),
            "09:05:00.5"
        );
        assert_eq!(
            format_time(NaiveTime::from_hms_opt(9, 5, 0).unwrap()),
            "09:05:00"
        );
    }

    #[test]
    fn builds_and_reads_qualified_names() {
        assert_eq!(
            qualified_name(Some("public"), "users"),
            "\"public\".\"users\""
        );
        assert_eq!(qualified_name(None, "users"), "\"users\"");
        // A quoted identifier survives, quotes doubled.
        assert_eq!(
            qualified_name(Some("my schema"), "we\"ird"),
            "\"my schema\".\"we\"\"ird\""
        );
        assert_eq!(qualified_name(Some("  "), "users"), "\"users\"");
    }

    #[test]
    fn classifies_relations_and_versions() {
        assert_eq!(object_kind("r"), ObjectKind::Table);
        assert_eq!(object_kind("p"), ObjectKind::Table);
        assert_eq!(object_kind("f"), ObjectKind::Table);
        assert_eq!(object_kind("v"), ObjectKind::View);
        assert_eq!(object_kind("m"), ObjectKind::MaterializedView);
        assert_eq!(object_kind("S"), ObjectKind::Sequence);

        assert_eq!(
            version_banner("PostgreSQL 16.1 on x86_64-pc-linux-gnu, compiled by gcc").as_deref(),
            Some("PostgreSQL 16.1")
        );
        assert_eq!(version_banner(""), None);
        assert!(is_system_database("postgres"));
        assert!(!is_system_database("shop"));
    }

    #[test]
    fn recognises_row_returning_statements() {
        assert!(returns_rows("SELECT 1"));
        assert!(returns_rows("WITH x AS (SELECT 1) SELECT * FROM x"));
        assert!(!returns_rows("UPDATE t SET a = 1"));
        assert!(returns_rows("UPDATE t SET a = 1 RETURNING a"));
        assert!(!returns_rows("CREATE TABLE t (a int)"));
    }
}
