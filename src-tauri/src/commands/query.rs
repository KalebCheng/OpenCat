//! Statement execution for the SQL editor.

use tauri::State;

use opencat_core::model::{DbKind, QueryResult, StatementKind};
use opencat_core::sql::{classify_statement, summarise};
use opencat_core::HistoryEntry;
use opencat_driver::{QueryOptions, SharedDriver};

use crate::error::CmdResult;
use crate::state::AppState;

/// Execute a script, returning one result per statement.
///
/// `database` / `schema` optionally re-point the session before running, which
/// is how the editor's database picker works.
#[tauri::command]
pub async fn execute_query(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    options: Option<QueryOptions>,
    database: Option<String>,
    schema: Option<String>,
) -> CmdResult<Vec<QueryResult>> {
    let session = state.session(&session_id)?;
    let options = options.unwrap_or_default();

    select_scope(
        &session.driver,
        session.kind(),
        database.as_deref(),
        schema.as_deref(),
    )
    .await;

    let result = session.driver.execute(&sql, &options).await;

    if options.record_history {
        record_history(&state, &session, &sql, &result);
    }

    Ok(result?)
}

/// Run `EXPLAIN` for the first statement in `sql`.
#[tauri::command]
pub async fn explain_query(
    state: State<'_, AppState>,
    session_id: String,
    sql: String,
    database: Option<String>,
    schema: Option<String>,
    analyse: Option<bool>,
) -> CmdResult<QueryResult> {
    let session = state.session(&session_id)?;
    let statement = opencat_core::sql::split_statements(&sql)
        .into_iter()
        .next()
        .ok_or_else(|| crate::error::coded("invalid", "there is nothing to explain"))?;

    select_scope(
        &session.driver,
        session.kind(),
        database.as_deref(),
        schema.as_deref(),
    )
    .await;

    let prefix = match session.kind() {
        DbKind::Postgres => {
            if analyse.unwrap_or(false) {
                "EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) "
            } else {
                "EXPLAIN "
            }
        },
        DbKind::Mysql => {
            if analyse.unwrap_or(false) {
                "EXPLAIN ANALYZE "
            } else {
                "EXPLAIN "
            }
        },
        DbKind::Sqlite => "EXPLAIN QUERY PLAN ",
    };

    let results = session
        .driver
        .execute(
            &format!("{prefix}{statement}"),
            &QueryOptions {
                max_rows: 10_000,
                timeout_secs: 120,
                read_only: true,
                record_history: false,
            },
        )
        .await?;

    results
        .into_iter()
        .next()
        .ok_or_else(|| crate::error::coded("query", "the engine returned no execution plan"))
}

/// Count the statements in a script (used by the editor's status bar).
#[tauri::command]
pub async fn count_statements(sql: String) -> CmdResult<usize> {
    Ok(opencat_core::sql::split_statements(&sql).len())
}

/// Classify a statement so the UI can warn before running a destructive script.
#[tauri::command]
pub async fn classify_sql(sql: String) -> CmdResult<String> {
    Ok(match classify_statement(&sql) {
        StatementKind::Select => "select",
        StatementKind::Insert => "insert",
        StatementKind::Update => "update",
        StatementKind::Delete => "delete",
        StatementKind::Ddl => "ddl",
        StatementKind::Other => "other",
    }
    .to_string())
}

/// Point the session at a database/schema.
///
/// Sessions run with a single pooled connection, so a `USE` / `SET search_path`
/// reliably applies to everything that follows.
pub(crate) async fn select_scope(
    driver: &SharedDriver,
    kind: DbKind,
    database: Option<&str>,
    schema: Option<&str>,
) {
    let statement = match kind {
        DbKind::Mysql => database
            .filter(|d| !d.trim().is_empty())
            .map(|d| format!("USE {}", opencat_core::sql::quote_ident(d, DbKind::Mysql))),
        DbKind::Postgres => {
            let target = schema
                .filter(|s| !s.trim().is_empty())
                .or_else(|| database.filter(|d| !d.trim().is_empty()));
            target.map(|s| {
                format!(
                    "SET search_path TO {}",
                    opencat_core::sql::quote_ident(s, DbKind::Postgres)
                )
            })
        },
        DbKind::Sqlite => None,
    };

    let Some(statement) = statement else { return };
    let options = QueryOptions {
        max_rows: 1,
        timeout_secs: 10,
        read_only: false,
        record_history: false,
    };
    if let Err(err) = driver.execute(&statement, &options).await {
        tracing::debug!("could not switch scope with `{statement}`: {err}");
    }
}

/// Append the executed script to the history store.
fn record_history(
    state: &State<'_, AppState>,
    session: &crate::state::Session,
    sql: &str,
    result: &opencat_core::Result<Vec<QueryResult>>,
) {
    let mut entry = HistoryEntry::new(session.profile.id.clone(), sql.trim().to_string());
    entry.profile_name = session.profile.name.clone();
    entry.database = session.profile.database.clone();
    entry.background = false;

    match result {
        Ok(results) => {
            entry.success = true;
            entry.elapsed_ms = results.iter().map(|r| r.elapsed_ms).sum();
            entry.row_count = results
                .iter()
                .map(|r| {
                    if r.rows.is_empty() {
                        r.rows_affected as i64
                    } else {
                        r.rows.len() as i64
                    }
                })
                .sum();
        },
        Err(err) => {
            entry.success = false;
            entry.error = Some(summarise(&err.to_string(), 500));
        },
    }

    state.with_workspace_mut(|ws| {
        if let Err(err) = ws.push_history(entry) {
            tracing::warn!("could not persist query history: {err}");
        }
    });
}
