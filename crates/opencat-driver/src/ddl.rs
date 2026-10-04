//! DDL generation for the visual table designer.
//!
//! These are pure functions: they turn a [`TablePlan`] into the statements that
//! would apply it, without touching a connection. That lets the designer show a
//! live SQL preview, lets the user review before committing, and keeps the logic
//! unit-testable.
//!
//! SQLite is the awkward one 鈥?it cannot change a column's type in place, so
//! structural changes expand into the documented "rebuild" recipe.

use opencat_core::model::{
    ColumnPlan, DbKind, DdlPlan, ForeignKeyPlan, IndexPlan, ObjectKind, TablePlan, TableSchema,
};
use opencat_core::sql::{quote_ident, quote_path};

// ---------------------------------------------------------------------------
// Create
// ---------------------------------------------------------------------------

/// Render `CREATE TABLE` for `plan`.
pub fn create_table(plan: &TablePlan, kind: DbKind) -> DdlPlan {
    let mut warnings = Vec::new();
    let mut lines: Vec<String> = Vec::new();

    let live: Vec<&ColumnPlan> = plan.columns.iter().filter(|c| !c.dropped).collect();
    if live.is_empty() {
        return DdlPlan::new(vec![]).with_warning("no columns were defined");
    }

    let pk_cols: Vec<String> = live
        .iter()
        .filter(|c| c.is_primary_key)
        .map(|c| c.name.clone())
        .collect();

    // SQLite expresses a single integer auto-increment key inline.
    let sqlite_inline_pk = kind == DbKind::Sqlite
        && pk_cols.len() == 1
        && live.iter().any(|c| c.is_primary_key && c.is_auto_increment);

    for col in &live {
        let inline_pk = sqlite_inline_pk && col.is_primary_key;
        lines.push(render_column(kind, col, inline_pk));
    }

    if !sqlite_inline_pk && !pk_cols.is_empty() {
        lines.push(format!(
            "PRIMARY KEY ({})",
            pk_cols
                .iter()
                .map(|c| quote_ident(c, kind))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    for idx in plan
        .indexes
        .iter()
        .filter(|i| !i.dropped && i.is_unique && !i.is_primary)
    {
        if idx.columns.is_empty() {
            continue;
        }
        lines.push(format!(
            "CONSTRAINT {} UNIQUE ({})",
            quote_ident(&idx.name, kind),
            idx.columns
                .iter()
                .map(|c| quote_ident(c, kind))
                .collect::<Vec<_>>()
                .join(", ")
        ));
    }

    for fk in plan.foreign_keys.iter().filter(|f| !f.dropped) {
        if let Some(rendered) = render_fk(kind, fk, true) {
            lines.push(rendered);
        }
    }

    let body = lines.join(",\n    ");
    let mut sql = format!("CREATE TABLE {} (\n    {body}\n)", target(plan, kind));

    let mut tail: Vec<String> = Vec::new();
    if kind == DbKind::Mysql {
        for key in ["engine", "charset", "collation"] {
            if let Some((_, value)) = plan
                .options
                .iter()
                .find(|(k, _)| k.eq_ignore_ascii_case(key))
            {
                let clause = match key {
                    "engine" => format!("ENGINE={value}"),
                    "charset" => format!("DEFAULT CHARSET={value}"),
                    _ => format!("COLLATE={value}"),
                };
                tail.push(clause);
            }
        }
    }
    if !tail.is_empty() {
        sql.push(' ');
        sql.push_str(&tail.join(" "));
    }

    let mut statements = vec![sql];

    // Non-unique indexes are separate statements on every engine.
    for idx in plan
        .indexes
        .iter()
        .filter(|i| !i.dropped && !i.is_primary && !i.is_unique)
    {
        if idx.columns.is_empty() {
            continue;
        }
        statements.push(create_index(plan, idx, kind));
    }

    if kind == DbKind::Postgres {
        for col in &live {
            if let Some(comment) = col.comment.as_deref().filter(|c| !c.is_empty()) {
                statements.push(format!(
                    "COMMENT ON COLUMN {}.{} IS {}",
                    target(plan, kind),
                    quote_ident(&col.name, kind),
                    literal(comment)
                ));
            }
        }
    }

    if plan.kind == ObjectKind::View {
        warnings
            .push("views are created from a query; the designer only edits their columns".into());
    }

    DdlPlan {
        statements,
        warnings,
        destructive: false,
    }
}

/// Render one column definition.
fn render_column(kind: DbKind, col: &ColumnPlan, inline_pk: bool) -> String {
    let mut parts: Vec<String> = Vec::new();
    parts.push(quote_ident(&col.name, kind));

    let data_type = if col.data_type.trim().is_empty() {
        default_type(kind)
    } else {
        col.data_type.trim().to_string()
    };
    parts.push(data_type.clone());

    if col.is_auto_increment {
        match kind {
            DbKind::Mysql => parts.push("AUTO_INCREMENT".into()),
            DbKind::Postgres => {
                if !data_type.to_ascii_lowercase().contains("serial") {
                    parts.push("GENERATED BY DEFAULT AS IDENTITY".into());
                }
            },
            DbKind::Sqlite => {},
        }
    }

    if inline_pk {
        parts.push("PRIMARY KEY".into());
        if col.is_auto_increment && kind == DbKind::Sqlite {
            parts.push("AUTOINCREMENT".into());
        }
    }

    if !col.nullable {
        parts.push("NOT NULL".into());
    }

    if let Some(default) = col
        .default_value
        .as_deref()
        .map(str::trim)
        .filter(|d| !d.is_empty())
    {
        // A bare word that is not a known keyword is treated as a string literal
        // so the designer cannot silently emit invalid SQL.
        parts.push(format!("DEFAULT {}", normalise_default(default)));
    }

    if col.is_unique && !inline_pk {
        parts.push("UNIQUE".into());
    }

    if kind == DbKind::Mysql {
        if let Some(comment) = col.comment.as_deref().filter(|c| !c.is_empty()) {
            parts.push(format!("COMMENT {}", literal(comment)));
        }
    }

    parts.join(" ")
}

/// Keywords that must not be quoted when used as a column default.
const DEFAULT_KEYWORDS: [&str; 12] = [
    "CURRENT_TIMESTAMP",
    "CURRENT_DATE",
    "CURRENT_TIME",
    "NOW()",
    "NULL",
    "TRUE",
    "FALSE",
    "LOCALTIME",
    "LOCALTIMESTAMP",
    "CURRENT_USER",
    "GEN_RANDOM_UUID()",
    "UUID()",
];

fn normalise_default(default: &str) -> String {
    let upper = default.to_ascii_uppercase();
    if DEFAULT_KEYWORDS.iter().any(|k| upper == *k) {
        return default.to_string();
    }
    // Numbers, function calls and already-quoted literals pass through.
    if default.starts_with('\'')
        || default.contains('(')
        || default.starts_with("nextval")
        || default.parse::<f64>().is_ok()
        || default.starts_with("B'")
        || default.starts_with("X'")
    {
        return default.to_string();
    }
    literal(default)
}

fn literal(text: &str) -> String {
    format!("'{}'", text.replace('\'', "''"))
}

/// Compare two declared types ignoring case and spacing.
///
/// `information_schema` reports `varchar(255)` while a user may type
/// `VARCHAR(255)`; those are the same column and must not produce an `ALTER`.
pub fn types_differ(left: &str, right: &str) -> bool {
    normalise_type(left) != normalise_type(right)
}

fn normalise_type(value: &str) -> String {
    value
        .to_ascii_lowercase()
        .chars()
        .filter(|c| !c.is_whitespace())
        .collect()
}

/// True when a plan's column differs from the stored definition in any
/// attribute the engine can alter.
fn column_changed(old: &opencat_core::model::ColumnSchema, new: &ColumnPlan) -> bool {
    types_differ(&old.data_type, &new.data_type)
        || old.nullable != new.nullable
        || old.is_auto_increment != new.is_auto_increment
        || normalise_default_opt(old.default_value.as_deref())
            != normalise_default_opt(new.default_value.as_deref())
        || old.comment.clone().unwrap_or_default() != new.comment.clone().unwrap_or_default()
}

/// Treat "no default" and "empty default" as the same thing.
fn normalise_default_opt(value: Option<&str>) -> Option<String> {
    value
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(|v| v.trim_matches('\'').to_string())
}

fn default_type(kind: DbKind) -> String {
    match kind {
        DbKind::Mysql => "varchar(255)".into(),
        DbKind::Postgres => "text".into(),
        DbKind::Sqlite => "TEXT".into(),
    }
}

fn target(plan: &TablePlan, kind: DbKind) -> String {
    let mut parts: Vec<&str> = Vec::new();
    match kind {
        DbKind::Mysql => {
            if let Some(db) = &plan.database {
                parts.push(db.as_str());
            }
        },
        _ => {
            if let Some(db) = &plan.database {
                parts.push(db.as_str());
            }
            if let Some(schema) = &plan.schema {
                parts.push(schema.as_str());
            }
        },
    }
    parts.push(plan.name.as_str());
    quote_path(&parts, kind)
}

fn create_index(plan: &TablePlan, idx: &IndexPlan, kind: DbKind) -> String {
    let cols = idx
        .columns
        .iter()
        .map(|c| quote_ident(c, kind))
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "CREATE {}INDEX {} ON {} ({cols})",
        if idx.is_unique { "UNIQUE " } else { "" },
        quote_ident(&idx.name, kind),
        target(plan, kind)
    )
}

fn render_fk(kind: DbKind, fk: &ForeignKeyPlan, inline_in_create: bool) -> Option<String> {
    if fk.columns.is_empty() || fk.ref_columns.is_empty() {
        return None;
    }
    let cols = fk
        .columns
        .iter()
        .map(|c| quote_ident(c, kind))
        .collect::<Vec<_>>()
        .join(", ");
    let ref_cols = fk
        .ref_columns
        .iter()
        .map(|c| quote_ident(c, kind))
        .collect::<Vec<_>>()
        .join(", ");
    let ref_table = quote_ident(&fk.ref_table, kind);

    let mut sql = format!(
        "{}FOREIGN KEY ({cols}) REFERENCES {ref_table} ({ref_cols})",
        if inline_in_create {
            format!("CONSTRAINT {} ", quote_ident(&fk.name, kind))
        } else {
            String::new()
        }
    );
    if let Some(action) = fk.on_delete.as_deref().filter(|a| !a.is_empty()) {
        sql.push_str(&format!(" ON DELETE {action}"));
    }
    if let Some(action) = fk.on_update.as_deref().filter(|a| !a.is_empty()) {
        sql.push_str(&format!(" ON UPDATE {action}"));
    }
    Some(sql)
}

// ---------------------------------------------------------------------------
// Alter
// ---------------------------------------------------------------------------

/// Render the statements that turn `current` into `plan`.
pub fn alter_table(current: &TableSchema, plan: &TablePlan, kind: DbKind) -> DdlPlan {
    if plan.kind == ObjectKind::View {
        return alter_view(current, plan, kind);
    }
    match kind {
        DbKind::Sqlite => alter_sqlite(current, plan),
        DbKind::Postgres => alter_postgres(current, plan),
        DbKind::Mysql => alter_mysql(current, plan),
    }
}

fn table_ref(name: &str, database: Option<&str>, schema: Option<&str>, kind: DbKind) -> String {
    let mut parts: Vec<&str> = Vec::new();
    match kind {
        DbKind::Mysql => {
            if let Some(db) = database {
                parts.push(db);
            }
        },
        _ => {
            if let Some(db) = database {
                parts.push(db);
            }
            if let Some(s) = schema {
                parts.push(s);
            }
        },
    }
    parts.push(name);
    quote_path(&parts, kind)
}

/// Views cannot have their columns altered, but a rename is still expressible.
fn alter_view(current: &TableSchema, plan: &TablePlan, kind: DbKind) -> DdlPlan {
    let mut statements: Vec<String> = Vec::new();

    if let Some(original) = plan.original_name.as_deref().filter(|o| *o != plan.name) {
        let old = table_ref(
            original,
            plan.database.as_deref(),
            plan.schema.as_deref(),
            kind,
        );
        match kind {
            DbKind::Postgres => statements.push(format!(
                "ALTER VIEW {old} RENAME TO {}",
                quote_ident(&plan.name, kind)
            )),
            DbKind::Mysql => statements.push(format!(
                "RENAME TABLE {old} TO {}",
                table_ref(&plan.name, plan.database.as_deref(), None, kind)
            )),
            DbKind::Sqlite => statements.push(format!(
                "ALTER TABLE {old} RENAME TO {}",
                quote_ident(&plan.name, kind)
            )),
        }
    }

    DdlPlan {
        statements,
        warnings: vec![
            format!(
                "`{}` is a view, so only its name can be changed here.",
                current.name
            ),
            format!(
                "replace the definition from the SQL editor: CREATE OR REPLACE VIEW {}",
                quote_ident(&plan.name, kind)
            ),
        ],
        destructive: false,
    }
}

/// PostgreSQL: one statement per change.
fn alter_postgres(current: &TableSchema, plan: &TablePlan) -> DdlPlan {
    let kind = DbKind::Postgres;
    let mut statements: Vec<String> = Vec::new();
    let mut warnings = Vec::new();

    // Rename first so later statements target the new name.
    if let Some(original) = plan.original_name.as_deref().filter(|o| *o != plan.name) {
        let old = table_ref(
            original,
            plan.database.as_deref(),
            plan.schema.as_deref(),
            kind,
        );
        statements.push(format!(
            "ALTER TABLE {old} RENAME TO {}",
            quote_ident(&plan.name, kind)
        ));
    }
    let table = table_ref(
        &plan.name,
        plan.database.as_deref(),
        plan.schema.as_deref(),
        kind,
    );

    for col in plan.columns.iter().filter(|c| c.dropped) {
        statements.push(format!(
            "ALTER TABLE {table} DROP COLUMN {}",
            quote_ident(&col.name, kind)
        ));
    }

    for col in plan.columns.iter().filter(|c| !c.dropped) {
        let original = current.columns.iter().find(|c| {
            c.name
                == col
                    .original_name
                    .clone()
                    .unwrap_or_else(|| col.name.clone())
        });
        match original {
            None => statements.push(format!(
                "ALTER TABLE {table} ADD COLUMN {}",
                render_column(kind, col, false)
            )),
            Some(old) => {
                if old.name != col.name {
                    statements.push(format!(
                        "ALTER TABLE {table} RENAME COLUMN {} TO {}",
                        quote_ident(&old.name, kind),
                        quote_ident(&col.name, kind)
                    ));
                }
                if types_differ(&old.data_type, &col.data_type) {
                    statements.push(format!(
                        "ALTER TABLE {table} ALTER COLUMN {} TYPE {} USING {}::{}",
                        quote_ident(&col.name, kind),
                        col.data_type,
                        quote_ident(&col.name, kind),
                        col.data_type
                    ));
                }
                if old.nullable != col.nullable {
                    statements.push(format!(
                        "ALTER TABLE {table} ALTER COLUMN {} {} NOT NULL",
                        quote_ident(&col.name, kind),
                        if col.nullable { "DROP" } else { "SET" }
                    ));
                }
                if old.default_value != col.default_value {
                    match col.default_value.as_deref().filter(|d| !d.is_empty()) {
                        Some(d) => statements.push(format!(
                            "ALTER TABLE {table} ALTER COLUMN {} SET DEFAULT {}",
                            quote_ident(&col.name, kind),
                            normalise_default(d)
                        )),
                        None => statements.push(format!(
                            "ALTER TABLE {table} ALTER COLUMN {} DROP DEFAULT",
                            quote_ident(&col.name, kind)
                        )),
                    }
                }
                // PostgreSQL stores comments out of band, so they need their own
                // statement rather than being part of the column definition.
                let old_comment = old.comment.clone().unwrap_or_default();
                let new_comment = col.comment.clone().unwrap_or_default();
                if old_comment != new_comment {
                    statements.push(format!(
                        "COMMENT ON COLUMN {table}.{} IS {}",
                        quote_ident(&col.name, kind),
                        if new_comment.is_empty() {
                            "NULL".to_string()
                        } else {
                            literal(&new_comment)
                        }
                    ));
                }
            },
        }
    }

    for idx in plan.indexes.iter().filter(|i| i.dropped && !i.is_primary) {
        statements.push(format!(
            "DROP INDEX IF EXISTS {}",
            quote_ident(&idx.name, kind)
        ));
    }
    for idx in plan.indexes.iter().filter(|i| !i.dropped) {
        let existed = current.indexes.iter().any(|i| i.name == idx.name);
        if !existed && !idx.is_primary && !idx.columns.is_empty() {
            statements.push(create_index(plan, idx, kind));
        }
    }

    for fk in plan.foreign_keys.iter().filter(|f| f.dropped) {
        statements.push(format!(
            "ALTER TABLE {table} DROP CONSTRAINT {}",
            quote_ident(&fk.name, kind)
        ));
    }
    for fk in plan.foreign_keys.iter().filter(|f| !f.dropped) {
        let existed = current.foreign_keys.iter().any(|f| f.name == fk.name);
        if !existed {
            if let Some(rendered) = render_fk(kind, fk, false) {
                statements.push(format!("ALTER TABLE {table} ADD {rendered}"));
            }
        }
    }

    if statements.is_empty() {
        warnings.push("no changes to apply".into());
    }
    DdlPlan {
        statements,
        warnings,
        destructive: false,
    }
}

/// MySQL: `MODIFY COLUMN` needs the whole definition, so renames and type
/// changes are expressed as `CHANGE COLUMN`.
fn alter_mysql(current: &TableSchema, plan: &TablePlan) -> DdlPlan {
    let kind = DbKind::Mysql;
    let table = table_ref(&plan.name, plan.database.as_deref(), None, kind);
    let mut statements: Vec<String> = Vec::new();
    let mut warnings = Vec::new();

    if let Some(original) = plan.original_name.as_deref().filter(|o| *o != plan.name) {
        let old = table_ref(original, plan.database.as_deref(), None, kind);
        statements.push(format!("RENAME TABLE {old} TO {table}"));
    }

    let clauses: Vec<String> = {
        let mut v = Vec::new();
        for col in plan.columns.iter().filter(|c| c.dropped) {
            v.push(format!("DROP COLUMN {}", quote_ident(&col.name, kind)));
        }
        for col in plan.columns.iter().filter(|c| !c.dropped) {
            let original_name = col
                .original_name
                .clone()
                .unwrap_or_else(|| col.name.clone());
            let original = current.columns.iter().find(|c| c.name == original_name);
            match original {
                None => v.push(format!("ADD COLUMN {}", render_column(kind, col, false))),
                Some(old) => {
                    // MySQL has no per-attribute ALTER, so an unchanged column
                    // must be left alone rather than re-declared.
                    let renamed = original_name != col.name;
                    if !renamed && !column_changed(old, col) {
                        continue;
                    }
                    let def = render_column(kind, col, false);
                    if renamed {
                        v.push(format!(
                            "CHANGE COLUMN {} {def}",
                            quote_ident(&original_name, kind)
                        ));
                    } else {
                        v.push(format!("MODIFY COLUMN {def}"));
                    }
                },
            }
        }
        for idx in plan.indexes.iter().filter(|i| i.dropped && !i.is_primary) {
            v.push(format!("DROP INDEX {}", quote_ident(&idx.name, kind)));
        }
        for idx in plan.indexes.iter().filter(|i| !i.dropped) {
            let existed = current.indexes.iter().any(|i| i.name == idx.name);
            if !existed && !idx.is_primary && !idx.columns.is_empty() {
                let cols = idx
                    .columns
                    .iter()
                    .map(|c| quote_ident(c, kind))
                    .collect::<Vec<_>>()
                    .join(", ");
                v.push(format!(
                    "ADD {}INDEX {} ({cols})",
                    if idx.is_unique { "UNIQUE " } else { "" },
                    quote_ident(&idx.name, kind)
                ));
            }
        }
        for fk in plan.foreign_keys.iter().filter(|f| f.dropped) {
            v.push(format!("DROP FOREIGN KEY {}", quote_ident(&fk.name, kind)));
        }
        for fk in plan.foreign_keys.iter().filter(|f| !f.dropped) {
            let existed = current.foreign_keys.iter().any(|f| f.name == fk.name);
            if !existed {
                if let Some(rendered) = render_fk(kind, fk, false) {
                    v.push(format!("ADD {rendered}"));
                }
            }
        }
        v
    };

    if clauses.is_empty() {
        warnings.push("no changes to apply".into());
    } else {
        statements.push(format!(
            "ALTER TABLE {table}\n    {}",
            clauses.join(",\n    ")
        ));
    }

    DdlPlan {
        statements,
        warnings,
        destructive: false,
    }
}

/// SQLite: simple operations stay native, anything structural triggers the
/// documented rebuild procedure.
fn alter_sqlite(current: &TableSchema, plan: &TablePlan) -> DdlPlan {
    let kind = DbKind::Sqlite;
    let table = quote_ident(&plan.name, kind);
    let mut statements: Vec<String> = Vec::new();
    let mut warnings: Vec<String> = Vec::new();

    if let Some(original) = plan.original_name.as_deref().filter(|o| *o != plan.name) {
        statements.push(format!(
            "ALTER TABLE {} RENAME TO {}",
            quote_ident(original, kind),
            table
        ));
    }

    let mut needs_rebuild = false;

    for col in plan.columns.iter().filter(|c| c.dropped) {
        statements.push(format!(
            "ALTER TABLE {table} DROP COLUMN {}",
            quote_ident(&col.name, kind)
        ));
    }

    for col in plan.columns.iter().filter(|c| !c.dropped) {
        let original_name = col
            .original_name
            .clone()
            .unwrap_or_else(|| col.name.clone());
        match current.columns.iter().find(|c| c.name == original_name) {
            None => statements.push(format!(
                "ALTER TABLE {table} ADD COLUMN {}",
                render_column(kind, col, false)
            )),
            Some(old) => {
                if old.name != col.name {
                    statements.push(format!(
                        "ALTER TABLE {table} RENAME COLUMN {} TO {}",
                        quote_ident(&old.name, kind),
                        quote_ident(&col.name, kind)
                    ));
                }
                if types_differ(&old.data_type, &col.data_type)
                    || old.nullable != col.nullable
                    || normalise_default_opt(old.default_value.as_deref())
                        != normalise_default_opt(col.default_value.as_deref())
                {
                    // SQLite cannot express these in place.
                    needs_rebuild = true;
                }
            },
        }
    }

    let indexes_changed = plan
        .indexes
        .iter()
        .any(|i| i.dropped || !current.indexes.iter().any(|c| c.name == i.name));
    if indexes_changed {
        needs_rebuild = true;
    }
    if plan.foreign_keys.iter().any(|f| f.dropped)
        || plan
            .foreign_keys
            .iter()
            .any(|f| !current.foreign_keys.iter().any(|c| c.name == f.name))
    {
        needs_rebuild = true;
    }

    if needs_rebuild {
        warnings.push(
            "SQLite cannot alter column definitions in place; OpenCat rebuilds the table \
             (create, copy, drop, rename) inside a transaction."
                .into(),
        );
        return rebuild_sqlite(current, plan).with_warning(warnings.join(" "));
    }

    if statements.is_empty() {
        warnings.push("no changes to apply".into());
    }
    DdlPlan {
        statements,
        warnings,
        destructive: false,
    }
}

/// The SQLite "12-step" table rebuild, reduced to the part OpenCat needs.
fn rebuild_sqlite(current: &TableSchema, plan: &TablePlan) -> DdlPlan {
    let kind = DbKind::Sqlite;
    let shadow = format!("__opencat_rebuild_{}", current.name);
    let live: Vec<&ColumnPlan> = plan.columns.iter().filter(|c| !c.dropped).collect();

    let rebuild_plan = TablePlan {
        name: shadow.clone(),
        original_name: None,
        is_new: true,
        ..plan.clone()
    };
    let create = create_table(&rebuild_plan, kind);
    let create_stmt = create
        .statements
        .first()
        .cloned()
        .unwrap_or_else(|| format!("CREATE TABLE {} ()", quote_ident(&shadow, kind)));

    let new_cols: Vec<String> = live.iter().map(|c| quote_ident(&c.name, kind)).collect();
    // Columns that exist on both sides carry their data across.
    let carried: Vec<(String, String)> = live
        .iter()
        .filter_map(|c| {
            let source = c.original_name.clone().unwrap_or_else(|| c.name.clone());
            current
                .columns
                .iter()
                .find(|old| old.name == source)
                .map(|_| (c.name.clone(), source))
        })
        .collect();

    let statement_list = {
        let mut v = vec![
            "PRAGMA foreign_keys = OFF".to_string(),
            "BEGIN".to_string(),
            create_stmt,
        ];
        if !carried.is_empty() {
            v.push(format!(
                "INSERT INTO {} ({}) SELECT {} FROM {}",
                quote_ident(&shadow, kind),
                carried
                    .iter()
                    .map(|(new, _)| quote_ident(new, kind))
                    .collect::<Vec<_>>()
                    .join(", "),
                carried
                    .iter()
                    .map(|(_, old)| quote_ident(old, kind))
                    .collect::<Vec<_>>()
                    .join(", "),
                quote_ident(&current.name, kind)
            ));
        }
        v.push(format!("DROP TABLE {}", quote_ident(&current.name, kind)));
        v.push(format!(
            "ALTER TABLE {} RENAME TO {}",
            quote_ident(&shadow, kind),
            quote_ident(&plan.name, kind)
        ));
        for idx in plan
            .indexes
            .iter()
            .filter(|i| !i.dropped && !i.is_primary && i.name != "sqlite_autoindex")
        {
            if idx.columns.is_empty() {
                continue;
            }
            let cols = idx
                .columns
                .iter()
                .map(|c| quote_ident(c, kind))
                .collect::<Vec<_>>()
                .join(", ");
            v.push(format!(
                "CREATE {}INDEX {} ON {} ({cols})",
                if idx.is_unique { "UNIQUE " } else { "" },
                quote_ident(&idx.name, kind),
                quote_ident(&plan.name, kind)
            ));
        }
        v.push("COMMIT".to_string());
        v.push("PRAGMA foreign_keys = ON".to_string());
        v
    };

    let _ = new_cols;
    DdlPlan {
        statements: statement_list,
        warnings: Vec::new(),
        destructive: true,
    }
}

// ---------------------------------------------------------------------------
// Drop
// ---------------------------------------------------------------------------

/// `DROP TABLE` / `DROP VIEW`.
pub fn drop_object(
    database: Option<&str>,
    schema: Option<&str>,
    name: &str,
    object_kind: ObjectKind,
    kind: DbKind,
) -> String {
    let keyword = match object_kind {
        ObjectKind::View => "DROP VIEW",
        ObjectKind::MaterializedView => "DROP MATERIALIZED VIEW",
        _ => "DROP TABLE",
    };
    let mut parts: Vec<&str> = Vec::new();
    match kind {
        DbKind::Mysql => {
            if let Some(db) = database {
                parts.push(db);
            }
        },
        _ => {
            if let Some(db) = database {
                parts.push(db);
            }
            if let Some(s) = schema {
                parts.push(s);
            }
        },
    }
    parts.push(name);
    format!("{keyword} {}", quote_path(&parts, kind))
}

/// `TRUNCATE TABLE`, or `DELETE FROM` where the engine has no `TRUNCATE`.
pub fn truncate_table(
    database: Option<&str>,
    schema: Option<&str>,
    name: &str,
    kind: DbKind,
) -> String {
    let target = drop_object(database, schema, name, ObjectKind::Table, kind)
        .split_once(' ')
        .map(|(_, rest)| rest.to_string())
        .unwrap_or_else(|| quote_ident(name, kind));
    match kind {
        DbKind::Sqlite => format!("DELETE FROM {target}"),
        DbKind::Mysql => format!("TRUNCATE TABLE {target}"),
        DbKind::Postgres => format!("TRUNCATE TABLE {target}"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use opencat_core::model::{ColumnSchema, LogicalType};

    fn plan(kind: DbKind) -> TablePlan {
        TablePlan {
            database: if kind == DbKind::Mysql {
                Some("shop".into())
            } else {
                None
            },
            schema: if kind == DbKind::Postgres {
                Some("public".into())
            } else {
                None
            },
            name: "users".into(),
            original_name: None,
            kind: ObjectKind::Table,
            columns: vec![
                ColumnPlan {
                    name: "id".into(),
                    data_type: if kind == DbKind::Postgres {
                        "bigserial".into()
                    } else {
                        "BIGINT".into()
                    },
                    nullable: false,
                    default_value: None,
                    is_primary_key: true,
                    is_auto_increment: true,
                    is_unique: false,
                    comment: None,
                    original_name: None,
                    dropped: false,
                    enum_values: vec![],
                },
                ColumnPlan {
                    name: "email".into(),
                    data_type: "varchar(255)".into(),
                    nullable: false,
                    default_value: None,
                    is_primary_key: false,
                    is_auto_increment: false,
                    is_unique: true,
                    comment: Some("login".into()),
                    original_name: None,
                    dropped: false,
                    enum_values: vec![],
                },
            ],
            indexes: vec![],
            foreign_keys: vec![],
            options: Default::default(),
            is_new: true,
        }
    }

    #[test]
    fn creates_a_postgres_table() {
        let ddl = create_table(&plan(DbKind::Postgres), DbKind::Postgres);
        let sql = &ddl.statements[0];
        assert!(sql.contains(r#"CREATE TABLE "public"."users""#), "{sql}");
        assert!(sql.contains(r#""id" bigserial NOT NULL"#), "{sql}");
        assert!(sql.contains("PRIMARY KEY"), "{sql}");
        assert!(
            sql.contains(r#""email" varchar(255) NOT NULL UNIQUE"#),
            "{sql}"
        );
        // column comment becomes a separate statement
        assert!(ddl
            .statements
            .iter()
            .any(|s| s.starts_with("COMMENT ON COLUMN")));
    }

    #[test]
    fn creates_a_mysql_table_with_engine() {
        let mut p = plan(DbKind::Mysql);
        p.options.insert("engine".into(), "InnoDB".into());
        p.options.insert("charset".into(), "utf8mb4".into());
        let ddl = create_table(&p, DbKind::Mysql);
        let sql = &ddl.statements[0];
        assert!(sql.contains("`shop`.`users`"), "{sql}");
        assert!(sql.contains("AUTO_INCREMENT"), "{sql}");
        assert!(sql.contains("ENGINE=InnoDB"), "{sql}");
        assert!(sql.contains("DEFAULT CHARSET=utf8mb4"), "{sql}");
    }

    #[test]
    fn creates_a_sqlite_table_with_inline_pk() {
        let ddl = create_table(&plan(DbKind::Sqlite), DbKind::Sqlite);
        let sql = &ddl.statements[0];
        assert!(
            sql.contains(r#""id" BIGINT PRIMARY KEY AUTOINCREMENT"#),
            "{sql}"
        );
    }

    #[test]
    fn adds_a_column_in_every_dialect() {
        let current = TableSchema {
            name: "users".into(),
            kind: ObjectKind::Table,
            database: Some("shop".into()),
            schema: Some("public".into()),
            columns: vec![ColumnSchema {
                name: "id".into(),
                data_type: "bigint".into(),
                logical_type: LogicalType::Integer,
                nullable: false,
                default_value: None,
                is_primary_key: true,
                is_auto_increment: true,
                is_unique: false,
                comment: None,
                ordinal: 1,
                char_max_length: None,
                numeric_precision: None,
                numeric_scale: None,
                extra: None,
                enum_values: vec![],
            }],
            indexes: vec![],
            foreign_keys: vec![],
            triggers: vec![],
            comment: None,
            row_count: None,
            ddl: None,
            options: Default::default(),
        };
        let mut p = plan(DbKind::Postgres);
        p.columns = vec![ColumnPlan {
            name: "age".into(),
            data_type: "int4".into(),
            nullable: true,
            default_value: Some("0".into()),
            is_primary_key: false,
            is_auto_increment: false,
            is_unique: false,
            comment: None,
            original_name: None,
            dropped: false,
            enum_values: vec![],
        }];
        let ddl = alter_table(&current, &p, DbKind::Postgres);
        assert_eq!(ddl.statements.len(), 1);
        assert!(ddl.statements[0].contains(r#"ADD COLUMN "age" int4 DEFAULT 0"#));
    }

    #[test]
    fn sqlite_type_change_rebuilds_the_table() {
        let current = TableSchema {
            name: "t".into(),
            kind: ObjectKind::Table,
            database: None,
            schema: None,
            columns: vec![ColumnSchema {
                name: "a".into(),
                data_type: "TEXT".into(),
                logical_type: LogicalType::Text,
                nullable: true,
                default_value: None,
                is_primary_key: false,
                is_auto_increment: false,
                is_unique: false,
                comment: None,
                ordinal: 1,
                char_max_length: None,
                numeric_precision: None,
                numeric_scale: None,
                extra: None,
                enum_values: vec![],
            }],
            indexes: vec![],
            foreign_keys: vec![],
            triggers: vec![],
            comment: None,
            row_count: None,
            ddl: None,
            options: Default::default(),
        };
        let p = TablePlan {
            database: None,
            schema: None,
            name: "t".into(),
            original_name: None,
            kind: ObjectKind::Table,
            columns: vec![ColumnPlan {
                name: "a".into(),
                data_type: "INTEGER".into(),
                nullable: true,
                default_value: None,
                is_primary_key: false,
                is_auto_increment: false,
                is_unique: false,
                comment: None,
                original_name: Some("a".into()),
                dropped: false,
                enum_values: vec![],
            }],
            indexes: vec![],
            foreign_keys: vec![],
            options: Default::default(),
            is_new: false,
        };
        let ddl = alter_table(&current, &p, DbKind::Sqlite);
        assert!(ddl.destructive);
        assert!(ddl.statements.iter().any(|s| s.starts_with("BEGIN")));
        assert!(ddl.statements.iter().any(|s| s.starts_with("INSERT INTO")));
        assert!(ddl.statements.iter().any(|s| s.starts_with("DROP TABLE")));
    }

    #[test]
    fn normalises_defaults() {
        assert_eq!(normalise_default("CURRENT_TIMESTAMP"), "CURRENT_TIMESTAMP");
        assert_eq!(normalise_default("0"), "0");
        assert_eq!(normalise_default("now()"), "now()");
        assert_eq!(normalise_default("draft"), "'draft'");
        assert_eq!(normalise_default("'x'"), "'x'");
    }

    /// Reopening the designer and pressing Apply without touching anything must
    /// be a no-op on every dialect.
    #[test]
    fn an_untouched_plan_produces_no_statements() {
        let schema = single_column_schema("varchar(255)", true);

        for (kind, data_type) in [
            (DbKind::Mysql, "VARCHAR(255)"),
            (DbKind::Postgres, "varchar(255)"),
        ] {
            let plan = TablePlan {
                database: None,
                schema: None,
                name: "t".into(),
                original_name: None,
                kind: ObjectKind::Table,
                columns: vec![ColumnPlan {
                    name: "a".into(),
                    data_type: data_type.into(),
                    // The schema says the column is NULLable.
                    nullable: true,
                    default_value: None,
                    is_primary_key: false,
                    is_auto_increment: false,
                    is_unique: false,
                    comment: None,
                    original_name: Some("a".into()),
                    dropped: false,
                    enum_values: vec![],
                }],
                indexes: vec![],
                foreign_keys: vec![],
                options: Default::default(),
                is_new: false,
            };
            let ddl = alter_table(&schema, &plan, kind);
            assert!(
                ddl.statements.is_empty(),
                "{kind:?} produced {:?}",
                ddl.statements
            );
        }
    }

    #[test]
    fn postgres_emits_a_comment_statement_for_comment_edits() {
        let schema = single_column_schema("text", false);
        let plan = TablePlan {
            database: None,
            schema: None,
            name: "t".into(),
            original_name: None,
            kind: ObjectKind::Table,
            columns: vec![ColumnPlan {
                name: "a".into(),
                data_type: "text".into(),
                nullable: false,
                default_value: None,
                is_primary_key: false,
                is_auto_increment: false,
                is_unique: false,
                comment: Some("now documented".into()),
                original_name: Some("a".into()),
                dropped: false,
                enum_values: vec![],
            }],
            indexes: vec![],
            foreign_keys: vec![],
            options: Default::default(),
            is_new: false,
        };
        let ddl = alter_table(&schema, &plan, DbKind::Postgres);
        assert_eq!(ddl.statements.len(), 1, "{:?}", ddl.statements);
        assert!(ddl.statements[0].starts_with("COMMENT ON COLUMN"));
    }

    fn single_column_schema(data_type: &str, nullable: bool) -> TableSchema {
        TableSchema {
            name: "t".into(),
            kind: ObjectKind::Table,
            database: None,
            schema: None,
            columns: vec![ColumnSchema {
                name: "a".into(),
                data_type: data_type.into(),
                logical_type: LogicalType::Text,
                nullable,
                default_value: None,
                is_primary_key: false,
                is_auto_increment: false,
                is_unique: false,
                comment: None,
                ordinal: 1,
                char_max_length: None,
                numeric_precision: None,
                numeric_scale: None,
                extra: None,
                enum_values: vec![],
            }],
            indexes: vec![],
            foreign_keys: vec![],
            triggers: vec![],
            comment: None,
            row_count: None,
            ddl: None,
            options: Default::default(),
        }
    }
}
