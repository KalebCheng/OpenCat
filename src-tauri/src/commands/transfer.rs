//! Import and export commands.

use std::time::Instant;

use tauri::State;

use opencat_driver::transfer::{
    self, ExportRequest, ExportSummary, ImportOptions, ParsedData, TransferFormat,
};
use opencat_driver::QueryOptions;

use crate::error::{coded, CmdResult};
use crate::state::AppState;

/// Write a result set to disk as CSV, TSV, JSON or SQL INSERTs.
#[tauri::command]
pub async fn export_data(request: ExportRequest) -> CmdResult<ExportSummary> {
    Ok(transfer::export(&request)?)
}

/// Parse an import file and return the first rows so the wizard can show a preview.
#[tauri::command]
pub async fn preview_import(
    path: String,
    options: ImportOptions,
    limit: Option<u32>,
) -> CmdResult<ParsedData> {
    let mut parsed = transfer::parse_file(&path, &options)?;
    if let Some(limit) = limit {
        parsed.rows.truncate(limit as usize);
    }
    Ok(parsed)
}

/// How an import relates to existing data.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ImportMode {
    /// Add the parsed rows to whatever is already there.
    Append,
    /// `DELETE FROM` the table first.
    TruncateFirst,
}

/// A fully specified import job.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportRequest {
    pub session_id: String,
    #[serde(default)]
    pub database: Option<String>,
    #[serde(default)]
    pub schema: Option<String>,
    pub table: String,
    pub path: String,
    pub options: ImportOptions,
    #[serde(default = "default_mode")]
    pub mode: ImportMode,
    /// Target column name for each file column, in file order. A `null` entry
    /// means "skip this file column". When omitted the file's own headers are
    /// used verbatim.
    #[serde(default)]
    pub target_columns: Option<Vec<Option<String>>>,
    #[serde(default = "default_batch")]
    pub batch_size: usize,
    /// Skip the first `skip_rows` data rows (e.g. a repeated header).
    #[serde(default)]
    pub offset: usize,
}

fn default_mode() -> ImportMode {
    ImportMode::Append
}

fn default_batch() -> usize {
    100
}

/// The outcome of an import.
#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportSummary {
    pub rows_read: u64,
    pub rows_written: u64,
    pub statements: u64,
    pub elapsed_ms: f64,
    #[serde(default)]
    pub warnings: Vec<String>,
    pub mode: ImportMode,
    pub table: String,
}

/// Read a file and insert its rows into `table`.
#[tauri::command]
pub async fn import_data(
    state: State<'_, AppState>,
    request: ImportRequest,
) -> CmdResult<ImportSummary> {
    let session = state.session(&request.session_id)?;
    let started = Instant::now();

    let parsed = transfer::parse_file(&request.path, &request.options)?;
    let format: TransferFormat = parsed.format;

    if parsed.columns.is_empty() {
        return Err(coded("invalid", "the file has no columns to import"));
    }

    // Map file columns onto target columns. A `None` slot is an explicit skip,
    // which is why the mapping has to line up with the file exactly.
    let mapping: Vec<Option<String>> = match &request.target_columns {
        Some(mapped) if mapped.len() == parsed.columns.len() => mapped.clone(),
        Some(mapped) => {
            return Err(coded(
                "invalid",
                format!(
                    "column mapping has {} entries but the file has {} columns",
                    mapped.len(),
                    parsed.columns.len()
                ),
            ))
        },
        None => parsed.columns.iter().cloned().map(Some).collect(),
    };

    let keep: Vec<usize> = mapping
        .iter()
        .enumerate()
        .filter_map(|(index, target)| target.as_ref().map(|_| index))
        .collect();
    if keep.is_empty() {
        return Err(coded("invalid", "every column was skipped"));
    }
    let columns: Vec<String> = mapping.iter().flatten().cloned().collect();

    // Drop the requested leading rows, then project each row onto the retained
    // columns so a skipped file column never reaches the INSERT.
    let mut rows = parsed.rows;
    if request.offset > 0 {
        rows.drain(0..request.offset.min(rows.len()));
    }
    let mut rows: Vec<Vec<opencat_core::Value>> = rows
        .iter()
        .map(|row| {
            keep.iter()
                .map(|index| {
                    row.get(*index)
                        .cloned()
                        .unwrap_or(opencat_core::Value::Null)
                })
                .collect()
        })
        .collect();
    for row in rows.iter_mut() {
        row.resize(columns.len(), opencat_core::Value::Null);
    }

    super::query::select_scope(
        &session.driver,
        session.kind(),
        request.database.as_deref(),
        request.schema.as_deref(),
    )
    .await;

    let mut statements: Vec<String> = Vec::new();
    match request.mode {
        ImportMode::TruncateFirst => statements.push(opencat_driver::ddl::truncate_table(
            request.database.as_deref(),
            request.schema.as_deref(),
            &request.table,
            session.kind(),
        )),
        ImportMode::Append => {},
    }

    let inserts = transfer::rows_to_inserts(
        &request.table,
        request.database.as_deref(),
        request.schema.as_deref(),
        &columns,
        &rows,
        session.kind(),
        request.batch_size.max(1),
    );
    let insert_count = inserts.len() as u64;
    statements.extend(inserts);

    let mut warnings = Vec::new();
    if format == TransferFormat::SqlInsert {
        warnings.push(
            "the file looked like SQL; its INSERT statements were converted to a mapped import"
                .to_string(),
        );
    }

    let script = statements
        .iter()
        .map(|s| s.trim().trim_end_matches(';'))
        .collect::<Vec<_>>()
        .join(";\n");

    session
        .driver
        .execute(
            &script,
            &QueryOptions {
                max_rows: 1,
                timeout_secs: 3_600,
                read_only: false,
                record_history: true,
            },
        )
        .await?;

    Ok(ImportSummary {
        rows_read: parsed.total_rows,
        rows_written: rows.len() as u64,
        statements: insert_count,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
        warnings,
        mode: request.mode,
        table: request.table,
    })
}

/// Guess the format of a file without reading all of it.
#[tauri::command]
pub async fn detect_import_format(path: String) -> CmdResult<TransferFormat> {
    let head = read_head(&path, 4096)?;
    Ok(transfer::detect_format(&path, &head))
}

fn read_head(path: &str, bytes: usize) -> CmdResult<String> {
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut buffer = vec![0u8; bytes];
    let read = file.read(&mut buffer)?;
    buffer.truncate(read);
    Ok(String::from_utf8_lossy(&buffer).to_string())
}
