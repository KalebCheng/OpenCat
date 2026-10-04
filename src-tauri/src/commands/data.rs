//! Data-grid commands: paged reads and row-level edits.

use std::collections::BTreeMap;

use tauri::State;

use opencat_core::model::{ObjectKind, QueryResult, RowEdit, RowInsert, TablePage};
use opencat_core::value::Value;
use opencat_driver::{CountRequest, FindRequest, PageRequest, QueryOptions, Scope};

use crate::error::{coded, CmdResult};
use crate::state::AppState;

/// One page of table data plus the information needed to edit it.
#[tauri::command]
pub async fn fetch_page(
    state: State<'_, AppState>,
    session_id: String,
    request: PageRequest,
) -> CmdResult<TablePage> {
    let session = state.session(&session_id)?;
    Ok(session.driver.fetch_page(&request).await?)
}

/// Row count for a table, optionally filtered.
#[tauri::command]
pub async fn count_rows(
    state: State<'_, AppState>,
    session_id: String,
    request: CountRequest,
) -> CmdResult<i64> {
    let session = state.session(&session_id)?;
    Ok(session.driver.count_rows(&request).await?)
}

/// Server-side search across the requested columns.
#[tauri::command]
pub async fn find_rows(
    state: State<'_, AppState>,
    session_id: String,
    request: FindRequest,
) -> CmdResult<TablePage> {
    let session = state.session(&session_id)?;
    Ok(session.driver.find_rows(&request).await?)
}

/// Apply cell edits to one row.
#[tauri::command]
pub async fn update_row(
    state: State<'_, AppState>,
    session_id: String,
    edit: RowEdit,
) -> CmdResult<u64> {
    let session = state.session(&session_id)?;
    Ok(session.driver.update_row(&edit).await?)
}

/// Insert one row.
#[tauri::command]
pub async fn insert_row(
    state: State<'_, AppState>,
    session_id: String,
    insert: RowInsert,
) -> CmdResult<u64> {
    let session = state.session(&session_id)?;
    Ok(session.driver.insert_row(&insert).await?)
}

/// Delete one row identified by its key columns.
#[tauri::command]
pub async fn delete_row(
    state: State<'_, AppState>,
    session_id: String,
    edit: RowEdit,
) -> CmdResult<u64> {
    let session = state.session(&session_id)?;
    Ok(session.driver.delete_row(&edit).await?)
}

/// Duplicate a row, letting the engine assign a fresh primary key.
///
/// Auto-increment and identity columns are deliberately omitted so the copy
/// gets its own key instead of colliding with the original.
#[tauri::command]
pub async fn duplicate_row(
    state: State<'_, AppState>,
    session_id: String,
    scope: Scope,
    table: String,
    keys: BTreeMap<String, Value>,
) -> CmdResult<u64> {
    let session = state.session(&session_id)?;
    let schema = session
        .driver
        .table_schema(&scope, &table, ObjectKind::Table)
        .await?;

    let predicate = keys
        .iter()
        .map(|(column, value)| opencat_driver::common::null_safe_eq(session.kind(), column, value))
        .collect::<Vec<_>>()
        .join(" AND ");

    let page = session
        .driver
        .fetch_page(&PageRequest {
            scope: scope.clone(),
            table: table.clone(),
            offset: 0,
            limit: 1,
            order_by: Vec::new(),
            filter: Some(predicate),
            include_total: false,
        })
        .await?;

    let row = page
        .rows
        .first()
        .ok_or_else(|| coded("not_found", "the row no longer exists"))?;

    let mut values = BTreeMap::new();
    for (index, column) in page.columns.iter().enumerate() {
        if column.hidden {
            continue;
        }
        let Some(cell) = row.get(index) else { continue };
        let schema_column = schema.columns.iter().find(|c| c.name == column.name);
        let is_generated_key = schema_column
            .map(|c| c.is_auto_increment || (c.is_primary_key && c.default_value.is_some()))
            .unwrap_or(false);
        if is_generated_key {
            continue;
        }
        values.insert(column.name.clone(), cell.clone());
    }

    if values.is_empty() {
        return Err(coded("invalid", "there is nothing to copy"));
    }

    Ok(session
        .driver
        .insert_row(&RowInsert {
            database: scope.database,
            schema: scope.schema,
            table,
            values,
        })
        .await?)
}

/// Run a query and return every row, for export.
///
/// Unlike the grid this does not page: the caller passes the statement the user
/// is looking at, and `max_rows` caps the result.
#[tauri::command]
pub async fn collect_rows(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    max_rows: Option<u32>,
    database: Option<String>,
    schema: Option<String>,
) -> CmdResult<QueryResult> {
    let session = state.session(&session_id)?;
    super::query::select_scope(
        &session.driver,
        session.kind(),
        database.as_deref(),
        schema.as_deref(),
    )
    .await;

    let results = session
        .driver
        .execute(
            &sql,
            &QueryOptions {
                max_rows: max_rows.unwrap_or(1_000_000),
                timeout_secs: 600,
                read_only: true,
                record_history: false,
            },
        )
        .await?;

    results
        .into_iter()
        .next()
        .ok_or_else(|| coded("query", "the statement returned no result set"))
}
