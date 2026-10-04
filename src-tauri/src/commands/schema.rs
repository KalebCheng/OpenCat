//! Schema editing: table designer preview/apply plus object lifecycle commands.

use tauri::State;

use opencat_core::model::{DbKind, DdlPlan, ObjectKind, QueryResult, TablePlan, TableSchema};
use opencat_driver::{ddl, QueryOptions, Scope};

use crate::error::{coded, CmdResult};
use crate::state::AppState;

/// Render the `CREATE TABLE` a plan expands to, without touching a connection.
#[tauri::command]
pub async fn preview_create_table(plan: TablePlan, kind: DbKind) -> CmdResult<DdlPlan> {
    Ok(ddl::create_table(&plan, kind))
}

/// Render the diff between an existing table and an edited plan.
#[tauri::command]
pub async fn preview_alter_table(
    current: TableSchema,
    plan: TablePlan,
    kind: DbKind,
) -> CmdResult<DdlPlan> {
    Ok(ddl::alter_table(&current, &plan, kind))
}

/// Render `DROP TABLE` / `DROP VIEW`.
#[tauri::command]
pub async fn preview_drop_object(
    database: Option<String>,
    schema: Option<String>,
    name: String,
    kind: ObjectKind,
    db_kind: DbKind,
) -> CmdResult<String> {
    Ok(ddl::drop_object(
        database.as_deref(),
        schema.as_deref(),
        &name,
        kind,
        db_kind,
    ))
}

/// Execute a prepared script (the designer's "Run" button).
#[tauri::command]
pub async fn apply_script(
    state: State<'_, AppState>,
    session_id: String,
    statements: Vec<String>,
    database: Option<String>,
    schema: Option<String>,
) -> CmdResult<Vec<QueryResult>> {
    let session = state.session(&session_id)?;
    super::query::select_scope(
        &session.driver,
        session.kind(),
        database.as_deref(),
        schema.as_deref(),
    )
    .await;

    let sql = statements
        .into_iter()
        .map(|s| s.trim().trim_end_matches(';').to_string())
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join(";\n");

    if sql.trim().is_empty() {
        return Err(coded("invalid", "there is nothing to apply"));
    }

    Ok(session
        .driver
        .execute(
            &sql,
            &QueryOptions {
                max_rows: 1_000,
                timeout_secs: 600,
                read_only: false,
                record_history: true,
            },
        )
        .await?)
}

/// Create a table from a designer plan.
#[tauri::command]
pub async fn create_table(
    state: State<'_, AppState>,
    session_id: String,
    plan: TablePlan,
) -> CmdResult<Vec<QueryResult>> {
    let session = state.session(&session_id)?;
    let rendered = ddl::create_table(&plan, session.kind());
    if rendered.statements.is_empty() {
        return Err(coded("invalid", "the table needs at least one column"));
    }
    apply_script(
        state,
        session_id,
        rendered.statements,
        plan.database.clone(),
        plan.schema.clone(),
    )
    .await
}

/// Apply an edited plan to an existing table.
#[tauri::command]
pub async fn alter_table(
    state: State<'_, AppState>,
    session_id: String,
    current: TableSchema,
    plan: TablePlan,
) -> CmdResult<Vec<QueryResult>> {
    let session = state.session(&session_id)?;
    let rendered = ddl::alter_table(&current, &plan, session.kind());
    if rendered.statements.is_empty() {
        return Err(coded("invalid", "there are no changes to apply"));
    }
    apply_script(
        state,
        session_id,
        rendered.statements,
        plan.database.clone(),
        plan.schema.clone(),
    )
    .await
}

/// Rename a table or view.
#[tauri::command]
pub async fn rename_object(
    state: State<'_, AppState>,
    session_id: String,
    scope: Scope,
    from: String,
    to: String,
    kind: ObjectKind,
) -> CmdResult<()> {
    let session = state.session(&session_id)?;
    if from == to {
        return Ok(());
    }
    Ok(session
        .driver
        .rename_object(&scope, &from, &to, kind)
        .await?)
}

/// Drop a table or view.
#[tauri::command]
pub async fn drop_object(
    state: State<'_, AppState>,
    session_id: String,
    scope: Scope,
    name: String,
    kind: ObjectKind,
) -> CmdResult<()> {
    let session = state.session(&session_id)?;
    Ok(session.driver.drop_object(&scope, &name, kind).await?)
}

/// Remove every row from a table.
#[tauri::command]
pub async fn truncate_table(
    state: State<'_, AppState>,
    session_id: String,
    scope: Scope,
    name: String,
) -> CmdResult<()> {
    let session = state.session(&session_id)?;
    Ok(session.driver.truncate_table(&scope, &name).await?)
}

/// Create an empty database/schema. Engines differ enough that this runs raw DDL.
#[tauri::command]
pub async fn create_database(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
    charset: Option<String>,
) -> CmdResult<()> {
    let session = state.session(&session_id)?;
    let statement = match session.kind() {
        DbKind::Mysql => format!(
            "CREATE DATABASE {} {}",
            opencat_core::sql::quote_ident(&name, DbKind::Mysql),
            charset
                .filter(|c| !c.trim().is_empty())
                .map(|c| format!("DEFAULT CHARACTER SET {c}"))
                .unwrap_or_default()
        ),
        DbKind::Postgres => format!(
            "CREATE DATABASE {}",
            opencat_core::sql::quote_ident(&name, DbKind::Postgres)
        ),
        DbKind::Sqlite => {
            return Err(coded(
                "unsupported",
                "SQLite databases are files — use “New SQLite Database” instead",
            ))
        },
    };

    session
        .driver
        .execute(
            &statement,
            &QueryOptions {
                max_rows: 1,
                timeout_secs: 120,
                read_only: false,
                record_history: true,
            },
        )
        .await?;
    Ok(())
}

/// Drop a database/schema.
#[tauri::command]
pub async fn drop_database(
    state: State<'_, AppState>,
    session_id: String,
    name: String,
) -> CmdResult<()> {
    let session = state.session(&session_id)?;
    let statement = match session.kind() {
        DbKind::Mysql => format!(
            "DROP DATABASE {}",
            opencat_core::sql::quote_ident(&name, DbKind::Mysql)
        ),
        DbKind::Postgres => format!(
            "DROP DATABASE {}",
            opencat_core::sql::quote_ident(&name, DbKind::Postgres)
        ),
        DbKind::Sqlite => {
            return Err(coded(
                "unsupported",
                "SQLite databases are files — delete the file instead",
            ))
        },
    };

    session
        .driver
        .execute(
            &statement,
            &QueryOptions {
                max_rows: 1,
                timeout_secs: 120,
                read_only: false,
                record_history: true,
            },
        )
        .await?;
    Ok(())
}
