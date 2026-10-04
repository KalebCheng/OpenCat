//! Dialect helpers shared by all drivers: type mapping, value literals and
//! pagination SQL generation.

use opencat_core::model::{
    ColumnMeta, ColumnSchema, DbKind, LogicalType, QueryResult, StatementKind,
};
use opencat_core::sql::{classify_statement, quote_ident, quote_path};
use opencat_core::value::Value;

use crate::traits::{OrderBy, Scope};

/// Infer the coarse [`LogicalType`] family from an engine type name.
pub fn logical_type(kind: DbKind, type_name: &str) -> LogicalType {
    let t = type_name.trim().to_ascii_lowercase();
    // Strip modifiers: `varchar(255)`, `numeric(10,2)`, `timestamp(6) with time zone`
    let base: String = t.split(['(', ' ']).next().unwrap_or(&t).trim().to_string();

    match kind {
        DbKind::Sqlite => match base.as_str() {
            "integer" | "int" | "bigint" | "smallint" | "tinyint" | "mediumint" | "int2"
            | "int4" | "int8" | "unsigned big int" => LogicalType::Integer,
            "boolean" | "bool" => LogicalType::Boolean,
            "real" | "double" | "double precision" | "float" => LogicalType::Float,
            "numeric" | "decimal" => LogicalType::Decimal,
            "blob" | "binary" | "varbinary" => LogicalType::Binary,
            "date" => LogicalType::Date,
            "datetime" | "timestamp" => LogicalType::DateTime,
            "time" => LogicalType::Time,
            "json" | "jsonb" => LogicalType::Json,
            "text" | "clob" => LogicalType::Text,
            "char" | "varchar" | "varying character" | "nvarchar" | "nchar" => LogicalType::String,
            _ if base.is_empty() => LogicalType::Unknown,
            _ => LogicalType::Text,
        },
        DbKind::Mysql => {
            let unsigned = t.contains("unsigned");
            match base.as_str() {
                "tinyint" if t.contains("(1)") => LogicalType::Boolean,
                "bool" | "boolean" | "bit" => LogicalType::Boolean,
                "tinyint" | "smallint" | "mediumint" | "int" | "integer" | "bigint" | "year" => {
                    LogicalType::Integer
                },
                "float" | "double" | "real" => LogicalType::Float,
                "decimal" | "numeric" | "dec" | "fixed" => LogicalType::Decimal,
                "char" | "varchar" => LogicalType::String,
                "tinytext" | "text" | "mediumtext" | "longtext" => LogicalType::Text,
                "binary" | "varbinary" | "tinyblob" | "blob" | "mediumblob" | "longblob"
                | "geometry" => {
                    if base.contains("blob") || base == "binary" || base == "varbinary" {
                        LogicalType::Binary
                    } else {
                        LogicalType::Geometry
                    }
                },
                "date" => LogicalType::Date,
                "time" => LogicalType::Time,
                "datetime" => LogicalType::DateTime,
                "timestamp" => LogicalType::Timestamp,
                "json" => LogicalType::Json,
                "enum" | "set" => LogicalType::Enum,
                _ if unsigned => LogicalType::Integer,
                _ => LogicalType::Unknown,
            }
        },
        DbKind::Postgres => match base.as_str() {
            "bool" | "boolean" => LogicalType::Boolean,
            "int2" | "int4" | "int8" | "smallint" | "integer" | "bigint" | "serial"
            | "bigserial" | "smallserial" | "oid" => LogicalType::Integer,
            "float4" | "float8" | "real" | "double precision" => LogicalType::Float,
            "numeric" | "decimal" | "money" => LogicalType::Decimal,
            "varchar" | "character varying" | "char" | "character" | "bpchar" | "name"
            | "citext" => LogicalType::String,
            "text" => LogicalType::Text,
            "bytea" => LogicalType::Binary,
            "date" => LogicalType::Date,
            "time" | "timetz" => LogicalType::Time,
            "timestamp" => LogicalType::Timestamp,
            "timestamptz" => LogicalType::DateTime,
            "interval" => LogicalType::Text,
            "json" | "jsonb" => LogicalType::Json,
            "uuid" => LogicalType::Uuid,
            "xml" | "inet" | "cidr" | "macaddr" | "macaddr8" | "tsvector" | "tsquery" => {
                LogicalType::Text
            },
            "point" | "line" | "lseg" | "box" | "path" | "polygon" | "circle" | "geometry"
            | "geography" => LogicalType::Geometry,
            _ => {
                if base.starts_with('_') || base.ends_with("[]") {
                    LogicalType::Array
                } else {
                    LogicalType::Unknown
                }
            },
        },
    }
}

/// Render a [`Value`] as a SQL literal for the given dialect.
///
/// Data-grid edits and DDL are generated with inline literals rather than bound
/// parameters: parameter type inference differs wildly across engines (notably
/// PostgreSQL's extended protocol) whereas a correctly escaped literal is
/// unambiguous everywhere. [`opencat_core::sql::escape_literal`] handles the
/// quoting rules.
pub fn literal(value: &Value, kind: DbKind) -> String {
    match value {
        Value::Null => "NULL".to_string(),
        Value::Bool(b) => {
            if matches!(kind, DbKind::Postgres) {
                if *b {
                    "TRUE".into()
                } else {
                    "FALSE".into()
                }
            } else {
                if *b {
                    "1".into()
                } else {
                    "0".into()
                }
            }
        },
        Value::Int(i) => i.to_string(),
        Value::Uint(u) => u.to_string(),
        Value::Float(f) => {
            if f.is_nan() || f.is_infinite() {
                "NULL".to_string()
            } else {
                opencat_core::value::format_float(*f)
            }
        },
        Value::Decimal(d) => {
            if is_numeric(d) {
                d.clone()
            } else {
                opencat_core::sql::escape_literal(d, kind)
            }
        },
        Value::Text(t) => opencat_core::sql::escape_literal(t, kind),
        Value::Date(d) | Value::Time(d) | Value::DateTime(d) => {
            opencat_core::sql::escape_literal(d, kind)
        },
        Value::Json(j) => {
            let escaped = opencat_core::sql::escape_literal(j, kind);
            if matches!(kind, DbKind::Postgres) {
                format!("{escaped}::jsonb")
            } else {
                escaped
            }
        },
        Value::Bytes(bytes) => {
            let hex: String = bytes.iter().map(|b| format!("{b:02x}")).collect();
            match kind {
                DbKind::Postgres => format!("'\\x{hex}'::bytea"),
                _ => format!("X'{hex}'"),
            }
        },
    }
}

fn is_numeric(text: &str) -> bool {
    !text.is_empty()
        && text
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '.' | '-' | '+' | 'e' | 'E'))
        && text.chars().any(|c| c.is_ascii_digit())
}

/// `a = b` that also matches when both sides are `NULL`, for lost-update guards.
///
/// Non-NULL values use a plain `=`, which keeps the predicate index-friendly:
/// `IS NOT DISTINCT FROM` is a barrier to index scans on PostgreSQL.
pub fn null_safe_eq(kind: DbKind, column: &str, value: &Value) -> String {
    let quoted = quote_ident(column, kind);
    if value.is_null() {
        return match kind {
            DbKind::Mysql => format!("{quoted} <=> NULL"),
            _ => format!("{quoted} IS NULL"),
        };
    }
    format!("{quoted} = {}", literal(value, kind))
}

/// Quote a possibly dotted relation path.
pub fn relation(scope: &Scope, table: &str, kind: DbKind) -> String {
    let mut parts: Vec<&str> = Vec::new();
    match kind {
        DbKind::Mysql => {
            if let Some(db) = &scope.database {
                parts.push(db.as_str());
            }
        },
        _ => {
            if let Some(db) = &scope.database {
                parts.push(db.as_str());
            }
            if let Some(schema) = &scope.schema {
                parts.push(schema.as_str());
            }
        },
    }
    parts.push(table);
    quote_path(&parts, kind)
}

/// Everything needed to build the `SELECT` behind one page of grid data.
///
/// A struct rather than a long argument list: the call sites read as a
/// description of the query, and adding an option later does not ripple out to
/// every driver.
#[derive(Debug, Clone)]
pub struct PageQuery<'a> {
    pub kind: DbKind,
    pub scope: &'a Scope,
    pub table: &'a str,
    /// Empty means `SELECT *`.
    pub columns: &'a [String],
    pub order_by: &'a [OrderBy],
    /// A raw predicate appended to `WHERE`. Callers are responsible for
    /// validating anything that came from the user.
    pub filter: Option<&'a str>,
    pub limit: u32,
    pub offset: u64,
}

/// Build the canonical `SELECT` used by the data grid.
pub fn paged_select(query: &PageQuery<'_>) -> String {
    let kind = query.kind;

    let cols = if query.columns.is_empty() {
        "*".to_string()
    } else {
        query
            .columns
            .iter()
            .map(|c| quote_ident(c, kind))
            .collect::<Vec<_>>()
            .join(", ")
    };

    let mut sql = format!(
        "SELECT {cols} FROM {}",
        relation(query.scope, query.table, kind)
    );

    if let Some(f) = query.filter.map(str::trim).filter(|f| !f.is_empty()) {
        sql.push_str(" WHERE ");
        sql.push_str(f);
    }

    if !query.order_by.is_empty() {
        let order = query
            .order_by
            .iter()
            .map(|o| {
                format!(
                    "{} {}",
                    quote_ident(&o.column, kind),
                    if o.desc { "DESC" } else { "ASC" }
                )
            })
            .collect::<Vec<_>>()
            .join(", ");
        sql.push_str(" ORDER BY ");
        sql.push_str(&order);
    }

    sql.push_str(&format!(" LIMIT {} OFFSET {}", query.limit, query.offset));
    sql
}

/// Build the matching `SELECT COUNT(*)`.
pub fn count_select(kind: DbKind, scope: &Scope, table: &str, filter: Option<&str>) -> String {
    let mut sql = format!("SELECT COUNT(*) FROM {}", relation(scope, table, kind));
    if let Some(f) = filter.map(str::trim).filter(|f| !f.is_empty()) {
        sql.push_str(" WHERE ");
        sql.push_str(f);
    }
    sql
}

/// Build a `WHERE` clause performing a case-insensitive contains-search.
pub fn search_predicate(kind: DbKind, columns: &[String], needle: &str) -> String {
    let escaped = needle
        .replace('\'', "''")
        .replace('%', "\\%")
        .replace('_', "\\_");
    let pattern = format!("%{escaped}%");
    let parts = columns.iter().map(|c| {
        let col = quote_ident(c, kind);
        match kind {
            DbKind::Postgres => format!("CAST({col} AS TEXT) ILIKE '{pattern}'"),
            DbKind::Mysql => format!("CAST({col} AS CHAR) LIKE '{pattern}'"),
            DbKind::Sqlite => format!("CAST({col} AS TEXT) LIKE '{pattern}'"),
        }
    });
    parts.collect::<Vec<_>>().join(" OR ")
}

/// Derive a `ColumnMeta` list from a `TableSchema` so a grid can be built for a
/// table the user opened directly from the tree.
pub fn columns_from_schema(schema: &opencat_core::model::TableSchema) -> Vec<ColumnMeta> {
    let pk = schema.primary_key_columns();
    schema
        .columns
        .iter()
        .map(|c: &ColumnSchema| ColumnMeta {
            name: c.name.clone(),
            type_name: c.data_type.clone(),
            logical_type: c.logical_type,
            nullable: c.nullable,
            table: Some(schema.name.clone()),
            is_primary_key: pk.contains(&c.name) || c.is_primary_key,
            hidden: false,
            is_auto_increment: c.is_auto_increment,
            default_value: c.default_value.clone(),
            char_max_length: c.char_max_length,
            comment: c.comment.clone(),
        })
        .collect()
}

/// A `QueryResult` describing a completed DML/DDL statement.
pub fn affected_result(
    statement: &str,
    rows_affected: u64,
    last_insert_id: Option<i64>,
    elapsed_ms: f64,
) -> QueryResult {
    QueryResult {
        columns: Vec::new(),
        rows: Vec::new(),
        rows_affected,
        last_insert_id,
        elapsed_ms,
        notices: Vec::new(),
        statement_kind: classify_statement(statement),
        statement: statement.to_string(),
        truncated: false,
    }
}

/// SQLite and MySQL report integers for booleans; normalise display.
pub fn default_statement_kind() -> StatementKind {
    StatementKind::Other
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn maps_mysql_types() {
        assert_eq!(
            logical_type(DbKind::Mysql, "varchar(255)"),
            LogicalType::String
        );
        assert_eq!(
            logical_type(DbKind::Mysql, "VARCHAR(255)"),
            LogicalType::String
        );
        assert_eq!(
            logical_type(DbKind::Mysql, "bigint(20) unsigned"),
            LogicalType::Integer
        );
        assert_eq!(
            logical_type(DbKind::Mysql, "decimal(10,2)"),
            LogicalType::Decimal
        );
        assert_eq!(
            logical_type(DbKind::Mysql, "datetime"),
            LogicalType::DateTime
        );
        assert_eq!(logical_type(DbKind::Mysql, "json"), LogicalType::Json);
    }

    #[test]
    fn maps_postgres_types() {
        assert_eq!(logical_type(DbKind::Postgres, "int4"), LogicalType::Integer);
        assert_eq!(
            logical_type(DbKind::Postgres, "character varying(80)"),
            LogicalType::String
        );
        assert_eq!(
            logical_type(DbKind::Postgres, "timestamp with time zone"),
            LogicalType::Timestamp
        );
        assert_eq!(
            logical_type(DbKind::Postgres, "timestamptz"),
            LogicalType::DateTime
        );
        assert_eq!(logical_type(DbKind::Postgres, "bytea"), LogicalType::Binary);
        assert_eq!(logical_type(DbKind::Postgres, "uuid"), LogicalType::Uuid);
        assert_eq!(logical_type(DbKind::Postgres, "_int4"), LogicalType::Array);
    }

    #[test]
    fn maps_sqlite_types() {
        assert_eq!(
            logical_type(DbKind::Sqlite, "INTEGER"),
            LogicalType::Integer
        );
        assert_eq!(logical_type(DbKind::Sqlite, "TEXT"), LogicalType::Text);
        assert_eq!(logical_type(DbKind::Sqlite, "BLOB"), LogicalType::Binary);
    }

    #[test]
    fn renders_literals_per_dialect() {
        assert_eq!(literal(&Value::Null, DbKind::Mysql), "NULL");
        // ANSI doubled quotes are valid on every dialect we support, including
        // MySQL, so a backslash is never needed for quoting alone.
        assert_eq!(
            literal(&Value::Text("it's".into()), DbKind::Mysql),
            "'it''s'"
        );
        assert_eq!(
            literal(&Value::Text("it's".into()), DbKind::Postgres),
            "'it''s'"
        );
        assert_eq!(
            literal(&Value::Text("a\\b".into()), DbKind::Mysql),
            "'a\\\\b'"
        );
        assert_eq!(literal(&Value::Bool(true), DbKind::Postgres), "TRUE");
        assert_eq!(literal(&Value::Bool(true), DbKind::Sqlite), "1");
        assert_eq!(
            literal(&Value::Bytes(vec![1, 255]), DbKind::Postgres),
            "'\\x01ff'::bytea"
        );
        assert_eq!(
            literal(&Value::Bytes(vec![1, 255]), DbKind::Mysql),
            "X'01ff'"
        );
    }

    #[test]
    fn builds_paged_select() {
        let scope = Scope::schema(Some("db".into()), "public");
        let columns = ["id".to_string(), "name".to_string()];
        let order = [OrderBy {
            column: "id".into(),
            desc: true,
        }];
        let sql = paged_select(&PageQuery {
            kind: DbKind::Postgres,
            scope: &scope,
            table: "users",
            columns: &columns,
            order_by: &order,
            filter: Some("id > 5"),
            limit: 100,
            offset: 200,
        });
        assert_eq!(
            sql,
            r#"SELECT "id", "name" FROM "db"."public"."users" WHERE id > 5 ORDER BY "id" DESC LIMIT 100 OFFSET 200"#
        );
    }

    #[test]
    fn builds_mysql_relation_path() {
        let scope = Scope::database("shop");
        assert_eq!(relation(&scope, "orders", DbKind::Mysql), "`shop`.`orders`");
    }

    #[test]
    fn escapes_search_patterns() {
        let p = search_predicate(DbKind::Postgres, &["a".into(), "b".into()], "50%_x");
        assert!(p.contains(r"ILIKE '%50\%\_x%'"));
        assert!(p.contains(" OR "));
    }
}
