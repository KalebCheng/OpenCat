//! Statement builders for data-grid edits.
//!
//! Edits are generated as literal SQL rather than bound parameters. Bound
//! parameters are safer in general, but here the *client* is the one assembling
//! the statement and each engine infers parameter types differently (PostgreSQL's
//! extended protocol is especially unforgiving about `text` bound into a `date`
//! slot). A correctly escaped literal is unambiguous on every engine, which is
//! why every desktop database client takes this route. String escaping lives in
//! [`opencat_core::sql::escape_literal`].

use opencat_core::model::DbKind;
use opencat_core::sql::quote_ident;
use opencat_core::value::Value;
use opencat_core::{CoreError, Result};

use crate::common;
use crate::traits::Scope;

/// `UPDATE <table> SET a = .., b = .. WHERE <key guards> AND <old value guards>`
///
/// Key columns identify the row; the previous values of the changed columns are
/// added to the `WHERE` clause so a concurrent modification turns into a
/// zero-row update instead of a silent overwrite.
pub fn build_update(
    kind: DbKind,
    scope: &Scope,
    table: &str,
    keys: &std::collections::BTreeMap<String, Value>,
    key_order: &[String],
    changes: &[(String, Value, Value)],
) -> Result<String> {
    if changes.is_empty() {
        return Err(CoreError::Invalid("no column changes were supplied".into()));
    }

    let assignments = changes
        .iter()
        .map(|(col, _, new)| {
            format!(
                "{} = {}",
                quote_ident(col, kind),
                common::literal(new, kind)
            )
        })
        .collect::<Vec<_>>()
        .join(", ");

    let mut conditions: Vec<String> = Vec::new();
    for key in ordered_keys(keys, key_order) {
        if let Some(v) = keys.get(&key) {
            conditions.push(common::null_safe_eq(kind, &key, v));
        }
    }
    for (col, old, _) in changes {
        conditions.push(common::null_safe_eq(kind, col, old));
    }
    if conditions.is_empty() {
        return Err(CoreError::Invalid(
            "refusing to update without a row identity".into(),
        ));
    }

    Ok(format!(
        "UPDATE {} SET {} WHERE {}",
        common::relation(scope, table, kind),
        assignments,
        conditions.join(" AND ")
    ))
}

/// `INSERT INTO <table> (cols) VALUES (..)`, or `DEFAULT VALUES` when the caller
/// supplied nothing. `skip_nulls` is used by engines where an omitted column lets
/// the server fill in a generated or auto-increment default.
pub fn build_insert(
    kind: DbKind,
    scope: &Scope,
    table: &str,
    values: &std::collections::BTreeMap<String, Value>,
    skip_nulls: bool,
) -> String {
    let usable: Vec<(&String, &Value)> = values
        .iter()
        .filter(|(_, v)| !(skip_nulls && v.is_null()))
        .collect();

    let target = common::relation(scope, table, kind);
    if usable.is_empty() {
        return match kind {
            DbKind::Mysql => format!("INSERT INTO {target} () VALUES ()"),
            _ => format!("INSERT INTO {target} DEFAULT VALUES"),
        };
    }

    let cols = usable
        .iter()
        .map(|(c, _)| quote_ident(c, kind))
        .collect::<Vec<_>>()
        .join(", ");
    let vals = usable
        .iter()
        .map(|(_, v)| common::literal(v, kind))
        .collect::<Vec<_>>()
        .join(", ");
    format!("INSERT INTO {target} ({cols}) VALUES ({vals})")
}

/// `DELETE FROM <table> WHERE <key guards>`
pub fn build_delete(
    kind: DbKind,
    scope: &Scope,
    table: &str,
    keys: &std::collections::BTreeMap<String, Value>,
    key_order: &[String],
) -> Result<String> {
    let ordered = ordered_keys(keys, key_order);
    if ordered.is_empty() {
        return Err(CoreError::Invalid(
            "refusing to delete without a row identity".into(),
        ));
    }
    let conditions = ordered
        .iter()
        .filter_map(|k| keys.get(k).map(|v| common::null_safe_eq(kind, k, v)))
        .collect::<Vec<_>>()
        .join(" AND ");
    Ok(format!(
        "DELETE FROM {} WHERE {}",
        common::relation(scope, table, kind),
        conditions
    ))
}

/// Put the caller's key order first, then any extra keys, so composite keys are
/// applied deterministically.
fn ordered_keys(
    keys: &std::collections::BTreeMap<String, Value>,
    preferred: &[String],
) -> Vec<String> {
    let mut out: Vec<String> = preferred
        .iter()
        .filter(|k| keys.contains_key(*k))
        .cloned()
        .collect();
    for k in keys.keys() {
        if !out.contains(k) {
            out.push(k.clone());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::BTreeMap;

    fn scope() -> Scope {
        Scope::schema(Some("shop".into()), "public")
    }

    #[test]
    fn builds_a_guarded_update() {
        let mut keys = BTreeMap::new();
        keys.insert("id".to_string(), Value::Int(7));
        let sql = build_update(
            DbKind::Postgres,
            &scope(),
            "users",
            &keys,
            &["id".to_string()],
            &[(
                "name".into(),
                Value::Text("old".into()),
                Value::Text("new".into()),
            )],
        )
        .unwrap();
        assert_eq!(
            sql,
            r#"UPDATE "shop"."public"."users" SET "name" = 'new' WHERE "id" = 7 AND "name" = 'old'"#
        );
    }

    #[test]
    fn guards_on_null_old_values() {
        let mut keys = BTreeMap::new();
        keys.insert("id".to_string(), Value::Int(1));
        let sql = build_update(
            DbKind::Postgres,
            &scope(),
            "t",
            &keys,
            &["id".to_string()],
            &[("note".into(), Value::Null, Value::Text("x".into()))],
        )
        .unwrap();
        assert!(sql.contains(r#""note" IS NULL"#), "{sql}");
    }

    #[test]
    fn mysql_uses_null_safe_equals() {
        let mut keys = BTreeMap::new();
        keys.insert("id".to_string(), Value::Null);
        let sql = build_delete(DbKind::Mysql, &Scope::database("shop"), "t", &keys, &[]).unwrap();
        assert_eq!(sql, "DELETE FROM `shop`.`t` WHERE `id` <=> NULL");
    }

    #[test]
    fn insert_can_skip_nulls() {
        let mut values = BTreeMap::new();
        values.insert("name".to_string(), Value::Text("x".into()));
        values.insert("note".to_string(), Value::Null);
        let sql = build_insert(DbKind::Sqlite, &Scope::database("main"), "t", &values, true);
        assert_eq!(sql, r#"INSERT INTO "main"."t" ("name") VALUES ('x')"#);
    }

    #[test]
    fn insert_without_values_uses_defaults() {
        let values = BTreeMap::new();
        assert_eq!(
            build_insert(DbKind::Postgres, &scope(), "t", &values, true),
            r#"INSERT INTO "shop"."public"."t" DEFAULT VALUES"#
        );
        assert_eq!(
            build_insert(DbKind::Mysql, &Scope::database("d"), "t", &values, true),
            "INSERT INTO `d`.`t` () VALUES ()"
        );
    }

    #[test]
    fn refuses_keyless_mutations() {
        let empty = BTreeMap::new();
        assert!(build_delete(DbKind::Postgres, &scope(), "t", &empty, &[]).is_err());
        assert!(build_update(DbKind::Postgres, &scope(), "t", &empty, &[], &[]).is_err());
    }
}
