//! Object explorer: databases, schemas, relations, routines and table metadata.

use tauri::State;

use opencat_core::model::{DatabaseInfo, ObjectKind, ObjectRef, TableSchema};
use opencat_driver::Scope;

use crate::error::CmdResult;
use crate::state::AppState;

/// Databases (MySQL/SQLite) or catalogs (PostgreSQL) visible to the user.
#[tauri::command]
pub async fn list_databases(
    state: State<'_, AppState>,
    session_id: String,
) -> CmdResult<Vec<DatabaseInfo>> {
    let session = state.session(&session_id)?;
    Ok(session.driver.list_databases().await?)
}

/// Schemas inside `database` (PostgreSQL); empty for engines without them.
#[tauri::command]
pub async fn list_schemas(
    state: State<'_, AppState>,
    session_id: String,
    database: Option<String>,
) -> CmdResult<Vec<String>> {
    let session = state.session(&session_id)?;
    Ok(session.driver.list_schemas(database.as_deref()).await?)
}

/// Tables and views inside `scope`.
#[tauri::command]
pub async fn list_objects(
    state: State<'_, AppState>,
    session_id: String,
    scope: Scope,
) -> CmdResult<Vec<ObjectRef>> {
    let session = state.session(&session_id)?;
    Ok(session.driver.list_objects(&scope).await?)
}

/// Functions, procedures and sequences inside `scope`.
#[tauri::command]
pub async fn list_routines(
    state: State<'_, AppState>,
    session_id: String,
    scope: Scope,
) -> CmdResult<Vec<ObjectRef>> {
    let session = state.session(&session_id)?;
    Ok(session.driver.list_routines(&scope).await?)
}

/// Full description of one table or view.
#[tauri::command]
pub async fn describe_table(
    state: State<'_, AppState>,
    session_id: String,
    scope: Scope,
    name: String,
    kind: ObjectKind,
) -> CmdResult<TableSchema> {
    let session = state.session(&session_id)?;
    Ok(session.driver.table_schema(&scope, &name, kind).await?)
}

/// The engine's own `CREATE` text, where it stores one.
#[tauri::command]
pub async fn table_ddl(
    state: State<'_, AppState>,
    session_id: String,
    scope: Scope,
    name: String,
    kind: ObjectKind,
) -> CmdResult<String> {
    let session = state.session(&session_id)?;
    Ok(session.driver.table_ddl(&scope, &name, kind).await?)
}

/// Object counts per scope, used to render the tree badges without loading
/// every child node.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScopeSummary {
    pub tables: usize,
    pub views: usize,
    pub routines: usize,
}

#[tauri::command]
pub async fn summarise_scope(
    state: State<'_, AppState>,
    session_id: String,
    scope: Scope,
) -> CmdResult<ScopeSummary> {
    let session = state.session(&session_id)?;
    let objects = session.driver.list_objects(&scope).await?;
    let routines = session
        .driver
        .list_routines(&scope)
        .await
        .unwrap_or_default();
    Ok(ScopeSummary {
        tables: objects
            .iter()
            .filter(|o| matches!(o.kind, ObjectKind::Table))
            .count(),
        views: objects
            .iter()
            .filter(|o| matches!(o.kind, ObjectKind::View | ObjectKind::MaterializedView))
            .count(),
        routines: routines.len(),
    })
}
