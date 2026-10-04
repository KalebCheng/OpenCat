//! Import and export pipelines (CSV / TSV / JSON / SQL).
//!
//! Everything here works on [`Value`]s rather than engine rows: the data grid
//! already holds them, and keeping the transfer layer typed means an export is
//! a pure function of what the user sees, while an import hands back values a
//! driver can bind without a second guessing pass.
//!
//! * **Export** ([`export`]) writes a file in one of four shapes — delimited
//!   text, JSON, or a script of batched `INSERT`s — and reports how much it
//!   wrote. Values are rendered with [`Value::display_text`] for text formats
//!   and with [`crate::common::literal`] for SQL so the dialect rules (boolean
//!   spelling, bytea hex, `jsonb` casts) stay in exactly one place.
//! * **Import** ([`parse_file`]) sniffs the format from the file name and a peek
//!   at the content, parses it into a column list plus rows, and leaves the
//!   column typing to [`value_from_text`], which is also what the "import into
//!   table" dialog calls per column once it knows the target schema.
//!
//! Nothing in this module panics on user input: malformed files come back as
//! [`CoreError::Invalid`] and unreadable paths as [`CoreError::Io`].

use std::collections::HashMap;
use std::path::Path;
use std::time::Instant;

use opencat_core::model::{DbKind, LogicalType};
use opencat_core::sql::{quote_ident, split_statements, strip_sql_noise, summarise};
use opencat_core::value::Value;
use opencat_core::{CoreError, Result};

use crate::common;
use crate::traits::Scope;

/// How many characters of a file are inspected when guessing its format.
const HEAD_PEEK_CHARS: usize = 4096;

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/// A file format understood by the transfer pipeline.
#[derive(Debug, Clone, Copy, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum TransferFormat {
    /// Delimiter separated values (a comma unless the options say otherwise).
    Csv,
    /// Tab separated values: CSV with the delimiter fixed to `\t`.
    Tsv,
    /// A JSON array of row objects.
    Json,
    /// A script of `INSERT` statements, optionally preceded by `CREATE TABLE`.
    SqlInsert,
}

/// Dialect knobs for delimited text files.
///
/// The defaults are RFC 4180 with the one deviation OpenCat needs: an empty
/// field means `NULL`, because that is what every other database client does
/// and what round trips losslessly through [`Value::Null`].
#[derive(Debug, Clone, PartialEq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CsvOptions {
    /// Field separator; ignored by [`TransferFormat::Tsv`] unless changed from
    /// the comma default.
    pub delimiter: char,
    /// Character that starts and ends a quoted field.
    pub quote: char,
    /// Character used to escape a quote when it differs from [`Self::quote`];
    /// equal to it means the usual doubled-quote convention.
    pub escape: char,
    /// Write a header row on export / read one on import.
    pub has_header: bool,
    /// Text token in the file that means SQL NULL.
    pub null_literal: String,
    /// Treat an empty, unquoted field as NULL too.
    pub empty_as_null: bool,
    /// Record separator written by the export; `\n`, `\r\n` and `\r` are
    /// recognised exactly, anything else falls back to `\n`.
    pub line_ending: String,
    /// Prepend a UTF-8 byte order mark so Excel opens the file as UTF-8.
    pub include_bom: bool,
}

impl Default for CsvOptions {
    fn default() -> Self {
        CsvOptions {
            delimiter: ',',
            quote: '"',
            escape: '"',
            has_header: true,
            null_literal: String::new(),
            empty_as_null: true,
            line_ending: "\n".to_string(),
            include_bom: false,
        }
    }
}

/// Everything the exporter needs.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportRequest {
    pub format: TransferFormat,
    /// Destination file; it is created (and truncated) by the export.
    pub path: String,
    pub columns: Vec<String>,
    pub rows: Vec<Vec<opencat_core::Value>>,
    /// Target table, required by [`TransferFormat::SqlInsert`].
    pub table: Option<String>,
    pub database: Option<String>,
    pub schema: Option<String>,
    pub db_kind: DbKind,
    #[serde(default)]
    pub csv: CsvOptions,
    /// Optional `CREATE TABLE` script emitted before INSERTs (SqlInsert format).
    #[serde(default)]
    pub create_table: Option<String>,
    /// Rows per multi-row INSERT (1 = one INSERT per row).
    #[serde(default = "default_batch")]
    pub batch_size: usize,
}

/// Default number of rows packed into a multi-row `INSERT`.
pub fn default_batch() -> usize {
    100
}

/// How much the export actually wrote.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportSummary {
    pub path: String,
    pub rows: u64,
    pub bytes: u64,
    pub elapsed_ms: f64,
}

/// Everything the importer needs.
///
/// The defaults describe a plain comma separated file with a header, which is
/// what the "Import" dialog starts from.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportOptions {
    /// `None` means auto-detect from the file name and content.
    #[serde(default)]
    pub format: Option<TransferFormat>,
    #[serde(default = "default_true")]
    pub has_header: bool,
    #[serde(default = "default_comma")]
    pub delimiter: char,
    #[serde(default = "default_quote")]
    pub quote: char,
    #[serde(default)]
    pub null_literal: String,
    #[serde(default = "default_true")]
    pub empty_as_null: bool,
    #[serde(default)]
    pub skip_rows: usize,
    /// 0 means unlimited.
    #[serde(default)]
    pub max_rows: u64,
}

/// The serde default for the boolean flags that start out enabled.
pub fn default_true() -> bool {
    true
}

/// The default field separator.
pub fn default_comma() -> char {
    ','
}

/// The default field quote.
pub fn default_quote() -> char {
    '"'
}

impl Default for ImportOptions {
    fn default() -> Self {
        ImportOptions {
            format: None,
            has_header: default_true(),
            delimiter: default_comma(),
            quote: default_quote(),
            null_literal: String::new(),
            empty_as_null: default_true(),
            skip_rows: 0,
            max_rows: 0,
        }
    }
}

/// The result of parsing an import file.
#[derive(Debug, Clone, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ParsedData {
    pub columns: Vec<String>,
    pub rows: Vec<Vec<opencat_core::Value>>,
    pub format: TransferFormat,
    /// Data rows actually read, i.e. `rows.len()` after `skip_rows` and the
    /// `max_rows` cap.
    pub total_rows: u64,
}

// ---------------------------------------------------------------------------
// Format detection
// ---------------------------------------------------------------------------

/// Guess the format from the path extension and a peek at the content.
///
/// The extension wins when it is one we recognise — a `.csv` holding one column
/// is still a CSV. `.txt` and unknown extensions fall back to sniffing: a JSON
/// document starts with `[` or `{`, a script starts with a SQL keyword, and
/// otherwise the first non-empty line is scanned for a tab (TSV) or a comma
/// (CSV, the default).
pub fn detect_format(path: &str, content_head: &str) -> TransferFormat {
    let extension = Path::new(path)
        .extension()
        .and_then(|ext| ext.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();

    match extension.as_str() {
        "csv" => TransferFormat::Csv,
        "tsv" | "tab" => TransferFormat::Tsv,
        "json" | "ndjson" | "jsonl" => TransferFormat::Json,
        "sql" => TransferFormat::SqlInsert,
        "txt" => sniff_delimited(content_head),
        _ => sniff_content(content_head),
    }
}

/// Identify a file with a useless (or missing) extension by looking at it.
fn sniff_content(content_head: &str) -> TransferFormat {
    // Dumps usually open with a banner comment, so look past leading comments
    // before deciding what the file is.
    let trimmed = strip_leading_comments(content_head.trim_start_matches('\u{feff}'));

    if trimmed.starts_with('[') || trimmed.starts_with('{') {
        return TransferFormat::Json;
    }

    let keyword: String = trimmed
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase();
    if matches!(
        keyword.as_str(),
        "insert"
            | "replace"
            | "create"
            | "begin"
            | "start"
            | "alter"
            | "drop"
            | "set"
            | "use"
            | "pragma"
            | "comment"
    ) {
        return TransferFormat::SqlInsert;
    }

    sniff_delimited(trimmed)
}

/// Skip leading `--` / `#` line comments and `/* … */` blocks.
fn strip_leading_comments(input: &str) -> &str {
    let mut rest = input.trim_start();
    loop {
        if rest.starts_with("--") || rest.starts_with('#') {
            match rest.find('\n') {
                Some(index) => {
                    rest = rest[index + 1..].trim_start();
                    continue;
                },
                None => return "",
            }
        }
        if rest.starts_with("/*") {
            match rest[2..].find("*/") {
                Some(index) => {
                    rest = rest[index + 4..].trim_start();
                    continue;
                },
                None => return "",
            }
        }
        return rest;
    }
}

/// Choose between CSV and TSV from the first non-empty line.
fn sniff_delimited(content_head: &str) -> TransferFormat {
    let line = content_head
        .lines()
        .find(|line| !line.trim().is_empty())
        .unwrap_or("");
    if line.contains('\t') {
        TransferFormat::Tsv
    } else {
        TransferFormat::Csv
    }
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/// Write an export file. Returns how much was written.
///
/// The whole document is rendered into memory first: the rows are already
/// resident, and building the text up front means a failure never leaves a
/// half-written file behind.
pub fn export(req: &ExportRequest) -> Result<ExportSummary> {
    let started = Instant::now();

    let bytes = match req.format {
        TransferFormat::Csv | TransferFormat::Tsv => export_delimited(req)?,
        TransferFormat::Json => export_json(req)?,
        TransferFormat::SqlInsert => export_sql(req)?.into_bytes(),
    };

    std::fs::write(&req.path, &bytes)?;

    Ok(ExportSummary {
        path: req.path.clone(),
        rows: req.rows.len() as u64,
        bytes: bytes.len() as u64,
        elapsed_ms: started.elapsed().as_secs_f64() * 1000.0,
    })
}

/// Render a CSV/TSV document, BOM included.
fn export_delimited(req: &ExportRequest) -> Result<Vec<u8>> {
    let opts = &req.csv;
    let mut buffer: Vec<u8> = Vec::new();
    if opts.include_bom {
        buffer.extend_from_slice("\u{feff}".as_bytes());
    }

    {
        let mut builder = csv::WriterBuilder::new();
        builder
            .delimiter(as_byte(
                delimiter_for(opts.delimiter, req.format),
                "delimiter",
            )?)
            .quote(as_byte(opts.quote, "quote")?)
            .escape(as_byte(opts.escape, "escape")?)
            .double_quote(opts.escape == opts.quote)
            .terminator(terminator(&opts.line_ending));

        let mut writer = builder.from_writer(&mut buffer);

        if opts.has_header {
            writer
                .write_record(req.columns.iter().map(String::as_str))
                .map_err(csv_error)?;
        }

        for row in &req.rows {
            let fields: Vec<String> = row
                .iter()
                .map(|value| match value {
                    Value::Null => opts.null_literal.clone(),
                    Value::Bytes(bytes) => base64_encode(bytes),
                    other => other.display_text().unwrap_or_default(),
                })
                .collect();
            writer
                .write_record(fields.iter().map(String::as_str))
                .map_err(csv_error)?;
        }

        writer.flush()?;
    }

    Ok(buffer)
}

/// Render a JSON array of row objects, pretty printed with two-space
/// indentation.
///
/// The text is assembled field by field rather than through
/// `serde_json::Value`, because an object built from a `serde_json::Map` loses
/// the column order the grid shows (the map is sorted). Values are still
/// serialised by `serde_json`, so escaping and number formatting are its own.
fn export_json(req: &ExportRequest) -> Result<Vec<u8>> {
    let mut out = String::from("[");

    for (row_index, row) in req.rows.iter().enumerate() {
        if row_index > 0 {
            out.push(',');
        }
        if row.is_empty() {
            out.push_str("\n  {}");
            continue;
        }

        out.push_str("\n  {");
        for (index, value) in row.iter().enumerate() {
            if index > 0 {
                out.push(',');
            }
            let key = match req.columns.get(index) {
                Some(name) => name.clone(),
                None => format!("column_{}", index + 1),
            };
            out.push_str("\n    ");
            out.push_str(&json_text(&serde_json::Value::String(key)));
            out.push_str(": ");
            out.push_str(&indent_lines(
                &json_text(&json_from_value(value)),
                JSON_FIELD_INDENT,
            ));
        }
        out.push_str("\n  }");
    }

    if !req.rows.is_empty() {
        out.push('\n');
    }
    out.push_str("]\n");

    Ok(out.into_bytes())
}

/// The indentation of a JSON field inside the row objects of an export.
const JSON_FIELD_INDENT: usize = 4;

/// Render a SQL script: optional DDL, then batched INSERTs.
fn export_sql(req: &ExportRequest) -> Result<String> {
    let table = req
        .table
        .as_deref()
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| CoreError::Invalid("SQL export needs a table name".into()))?;

    let statements = rows_to_inserts(
        table,
        req.database.as_deref(),
        req.schema.as_deref(),
        &req.columns,
        &req.rows,
        req.db_kind,
        req.batch_size,
    );

    let ddl = req
        .create_table
        .as_deref()
        .map(str::trim)
        .filter(|script| !script.is_empty());

    let mut out = String::new();
    if let Some(script) = ddl {
        out.push_str(&terminate(script));
        out.push_str("\n\n");
    }

    // A single statement stays bare so the file can be pasted into a console;
    // several statements are wrapped so a partial failure rolls back.
    let wrap = statements.len() + usize::from(ddl.is_some()) > 1;
    if wrap {
        out.push_str("BEGIN;\n");
    }
    for statement in &statements {
        out.push_str(statement);
        out.push_str(";\n");
    }
    if wrap {
        out.push_str("COMMIT;\n");
    }

    Ok(out)
}

/// Turn parsed rows into `INSERT` statements for the given dialect.
///
/// `batch_size > 1` produces multi-row `INSERT INTO t (a, b) VALUES (..), (..)`;
/// `batch_size <= 1` produces one statement per row. Values are rendered with
/// [`crate::common::literal`], so a boolean becomes `TRUE` on PostgreSQL and `1`
/// on SQLite, and byte strings use each engine's own literal syntax.
///
/// `database` and `schema` qualify the table the way [`crate::common::relation`]
/// does for the data grid: MySQL takes `database.table`, the others take
/// `database.schema.table` when both are known.
pub fn rows_to_inserts(
    table: &str,
    database: Option<&str>,
    schema: Option<&str>,
    columns: &[String],
    rows: &[Vec<opencat_core::Value>],
    kind: DbKind,
    batch_size: usize,
) -> Vec<String> {
    if rows.is_empty() {
        return Vec::new();
    }

    let scope = Scope {
        database: database.map(str::to_string).filter(|name| !name.is_empty()),
        schema: schema.map(str::to_string).filter(|name| !name.is_empty()),
    };
    let target = common::relation(&scope, table, kind);

    // Without a column list there is nothing to name in the VALUES tuple, so
    // fall back to each dialect's "insert all defaults" form — which cannot be
    // batched on SQLite/PostgreSQL the way a real tuple list can.
    if columns.is_empty() {
        return rows
            .iter()
            .map(|_| match kind {
                DbKind::Mysql => format!("INSERT INTO {target} () VALUES ()"),
                _ => format!("INSERT INTO {target} DEFAULT VALUES"),
            })
            .collect();
    }

    let column_list = columns
        .iter()
        .map(|column| quote_ident(column, kind))
        .collect::<Vec<_>>()
        .join(", ");

    rows.chunks(batch_size.max(1))
        .map(|chunk| {
            let tuples = chunk
                .iter()
                .map(|row| {
                    let values = (0..columns.len())
                        .map(|index| match row.get(index) {
                            Some(value) => common::literal(value, kind),
                            None => "NULL".to_string(),
                        })
                        .collect::<Vec<_>>()
                        .join(", ");
                    format!("({values})")
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("INSERT INTO {target} ({column_list}) VALUES {tuples}")
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

/// Read and parse an import file.
///
/// The file must be readable as UTF-8; invalid sequences are replaced rather
/// than rejected so a stray byte in one column cannot block the whole import.
/// A leading byte order mark is ignored.
pub fn parse_file(path: &str, opts: &ImportOptions) -> Result<ParsedData> {
    let bytes = std::fs::read(path)?;
    let decoded = String::from_utf8_lossy(&bytes);
    let text = decoded.strip_prefix('\u{feff}').unwrap_or(&decoded);

    let format = match opts.format {
        Some(format) => format,
        None => detect_format(path, head_of(text)),
    };

    match format {
        TransferFormat::Csv | TransferFormat::Tsv => parse_delimited(text, opts, format),
        TransferFormat::Json => parse_json(text, opts, format),
        TransferFormat::SqlInsert => parse_sql_inserts(text, opts, format),
    }
}

/// The first [`HEAD_PEEK_CHARS`] characters of `text`, cut on a char boundary.
fn head_of(text: &str) -> &str {
    match text.char_indices().nth(HEAD_PEEK_CHARS) {
        Some((index, _)) => &text[..index],
        None => text,
    }
}

/// Parse delimited text (CSV or TSV).
///
/// Ragged rows are padded with `NULL` (and overlong ones truncated) instead of
/// failing, because that is the only way to import the hand-edited exports that
/// show up in practice. Column names come from the header row when there is
/// one, and are synthesised as `column_1`, `column_2`, … otherwise.
fn parse_delimited(text: &str, opts: &ImportOptions, format: TransferFormat) -> Result<ParsedData> {
    let delimiter = as_byte(delimiter_for(opts.delimiter, format), "delimiter")?;
    let quote = as_byte(opts.quote, "quote")?;

    // `flexible` keeps a short row from aborting the whole file; the default
    // terminator already accepts `\n`, `\r\n` and `\r`, and the default
    // double-quote handling covers `""`.
    let mut reader = csv::ReaderBuilder::new()
        .delimiter(delimiter)
        .quote(quote)
        .has_headers(false)
        .flexible(true)
        .from_reader(text.as_bytes());

    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut window = RowWindow::new(opts);
    let mut records = reader.records();

    if opts.has_header {
        match records.next() {
            Some(Ok(record)) => columns = record.iter().map(str::to_string).collect(),
            Some(Err(err)) => return Err(csv_error(err)),
            None => {},
        }
    }

    let mut width = columns.len();
    for record in records {
        match window.next() {
            RowAction::Stop => break,
            RowAction::Skip => continue,
            RowAction::Keep => {},
        }

        let record = record.map_err(csv_error)?;
        if width == 0 {
            width = record.len();
        }
        rows.push(
            (0..width)
                .map(|index| {
                    value_from_text(
                        record.get(index).unwrap_or(""),
                        LogicalType::Unknown,
                        &opts.null_literal,
                        opts.empty_as_null,
                    )
                })
                .collect(),
        );
    }

    if columns.is_empty() {
        columns = (1..=width).map(|index| format!("column_{index}")).collect();
    }

    let total_rows = rows.len() as u64;
    Ok(ParsedData {
        columns,
        rows,
        format,
        total_rows,
    })
}

/// Parse a JSON document holding rows.
///
/// Accepts a top-level array of objects, or an object with exactly one array
/// field (the shape REST payloads and `FOR JSON`-style exports produce). The
/// column list is the union of the keys of every row in the order they first
/// appear in the document; keys missing from a row become `NULL`.
fn parse_json(text: &str, opts: &ImportOptions, format: TransferFormat) -> Result<ParsedData> {
    let source = read_json_rows(text)?;

    // The union of the keys, in first-seen document order. `position` keeps a
    // column's index so each row can then be filled in a single pass.
    let mut columns: Vec<String> = Vec::new();
    let mut position: HashMap<&str, usize> = HashMap::new();
    for row in &source {
        for (key, _) in &row.0 {
            if !position.contains_key(key.as_str()) {
                position.insert(key.as_str(), columns.len());
                columns.push(key.clone());
            }
        }
    }

    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut window = RowWindow::new(opts);
    for row in &source {
        match window.next() {
            RowAction::Stop => break,
            RowAction::Skip => continue,
            RowAction::Keep => {},
        }
        let mut cells = vec![Value::Null; columns.len()];
        for (key, value) in &row.0 {
            if let Some(&index) = position.get(key.as_str()) {
                cells[index] = json_to_value(value);
            }
        }
        rows.push(cells);
    }

    let total_rows = rows.len() as u64;
    Ok(ParsedData {
        columns,
        rows,
        format,
        total_rows,
    })
}

/// The row objects of a JSON document, in document order.
///
/// `serde_json::Value` cannot be used here: it stores objects in a map that
/// loses the key order, and the column list has to follow the file. Reading the
/// document through a visitor keeps the entries exactly as they were written.
fn read_json_rows(text: &str) -> Result<Vec<OrderedRow>> {
    match text.trim_start().chars().next() {
        // A bare array of row objects, read as a stream.
        Some('[') => match serde_json::from_str::<Vec<OrderedRow>>(text) {
            Ok(rows) => Ok(rows),
            Err(_) => Err(shape_error(text)),
        },
        // A wrapper object holding the rows in one of its fields.
        Some('{') => {
            let fields = match serde_json::from_str::<WrappedFields>(text) {
                Ok(fields) => fields,
                Err(_) => return Err(shape_error(text)),
            };
            let mut candidates: Vec<Vec<OrderedRow>> = fields
                .0
                .into_iter()
                .filter_map(|(_, field)| match field {
                    RowField::Rows(rows) => Some(rows),
                    RowField::Other(_) => None,
                })
                .collect();
            if candidates.len() == 1 {
                Ok(candidates.pop().unwrap_or_default())
            } else {
                Err(shape_error(text))
            }
        },
        // Anything else (a scalar, or an empty file) is not a row set.
        _ => Err(shape_error(text)),
    }
}

/// A row object captured in document order.
struct OrderedRow(Vec<(String, serde_json::Value)>);

impl<'de> serde::Deserialize<'de> for OrderedRow {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct RowVisitor;

        impl<'de> serde::de::Visitor<'de> for RowVisitor {
            type Value = OrderedRow;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON object of column names to values")
            }

            fn visit_map<A>(self, mut access: A) -> std::result::Result<OrderedRow, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                let mut entries = Vec::with_capacity(access.size_hint().unwrap_or(0));
                while let Some((key, value)) = access.next_entry::<String, serde_json::Value>()? {
                    entries.push((key, value));
                }
                Ok(OrderedRow(entries))
            }
        }

        deserializer.deserialize_map(RowVisitor)
    }
}

/// A wrapper object whose fields are inspected for the row array.
struct WrappedFields(Vec<(String, RowField)>);

impl<'de> serde::Deserialize<'de> for WrappedFields {
    fn deserialize<D>(deserializer: D) -> std::result::Result<Self, D::Error>
    where
        D: serde::Deserializer<'de>,
    {
        struct FieldsVisitor;

        impl<'de> serde::de::Visitor<'de> for FieldsVisitor {
            type Value = WrappedFields;

            fn expecting(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                formatter.write_str("a JSON object")
            }

            fn visit_map<A>(self, mut access: A) -> std::result::Result<WrappedFields, A::Error>
            where
                A: serde::de::MapAccess<'de>,
            {
                let mut entries = Vec::with_capacity(access.size_hint().unwrap_or(0));
                while let Some(key) = access.next_key::<String>()? {
                    let value = access.next_value::<RowField>()?;
                    entries.push((key, value));
                }
                Ok(WrappedFields(entries))
            }
        }

        deserializer.deserialize_map(FieldsVisitor)
    }
}

/// One field of a wrapper object: the row array, or anything else.
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum RowField {
    Rows(Vec<OrderedRow>),
    Other(serde::de::IgnoredAny),
}

/// Explain why a document that should have held rows did not.
fn shape_error(text: &str) -> CoreError {
    match serde_json::from_str::<serde_json::Value>(text) {
        Ok(root) => json_shape_error(&root),
        Err(err) => CoreError::Invalid(format!("invalid JSON: {err}")),
    }
}

/// Describe the shape problem with an already parsed document.
fn json_shape_error(root: &serde_json::Value) -> CoreError {
    match root {
        serde_json::Value::Array(items) => match items.iter().find(|item| !item.is_object()) {
            Some(item) => CoreError::Invalid(format!(
                "JSON import expects an array of objects, found {}",
                json_type_name(item)
            )),
            None => CoreError::Invalid("JSON import could not read the rows".into()),
        },
        serde_json::Value::Object(map) => {
            let arrays = map.values().filter(|value| value.is_array()).count();
            match arrays {
                1 => CoreError::Invalid(
                    "JSON import expects the array field to hold row objects".into(),
                ),
                count => CoreError::Invalid(format!(
                    "JSON import needs an object with exactly one array of row objects, found {count} array fields"
                )),
            }
        }
        other => CoreError::Invalid(format!(
            "JSON import expects an array of objects or an object with a single array field, found {}",
            json_type_name(other)
        )),
    }
}

/// Parse the `INSERT` statements out of a SQL script.
///
/// Only `INSERT`/`REPLACE` statements carry rows, so the DDL, `SET` and
/// transaction markers found in a dump are skipped; an `INSERT` that cannot be
/// understood is reported with its text rather than silently dropped. The
/// column list comes from the first `INSERT` that has one.
fn parse_sql_inserts(
    text: &str,
    opts: &ImportOptions,
    format: TransferFormat,
) -> Result<ParsedData> {
    let mut columns: Vec<String> = Vec::new();
    let mut rows: Vec<Vec<Value>> = Vec::new();
    let mut window = RowWindow::new(opts);

    'statements: for statement in split_statements(text) {
        if !matches!(leading_keyword(&statement).as_str(), "insert" | "replace") {
            continue;
        }

        let parsed = parse_insert_statement(&statement).ok_or_else(|| {
            CoreError::Invalid(format!(
                "cannot parse SQL statement: {}",
                summarise(&statement, 160)
            ))
        })?;

        if columns.is_empty() {
            columns = match parsed.columns {
                Some(explicit) => explicit,
                None => (1..=parsed.width())
                    .map(|index| format!("column_{index}"))
                    .collect(),
            };
        }

        for tuple in parsed.tuples {
            match window.next() {
                RowAction::Stop => break 'statements,
                RowAction::Skip => continue,
                RowAction::Keep => {},
            }
            let values = tuple.iter().map(|raw| literal_to_value(raw)).collect();
            rows.push(normalise_row(values, columns.len()));
        }
    }

    let total_rows = rows.len() as u64;
    Ok(ParsedData {
        columns,
        rows,
        format,
        total_rows,
    })
}

/// Convert a raw text field into a typed [`Value`], honouring the NULL rules and
/// the target column's logical type.
///
/// The text is never trimmed: leading and trailing spaces are data, and only the
/// exporter knows whether they matter. `null_literal` is matched exactly (an
/// empty `null_literal` therefore matches nothing) and, when `empty_as_null` is
/// set, an empty field is `NULL` as well.
///
/// A value that does not fit the requested type is kept as text rather than
/// dropped, so a bad cell shows up in the grid instead of disappearing.
pub fn value_from_text(
    text: &str,
    logical: LogicalType,
    null_literal: &str,
    empty_as_null: bool,
) -> opencat_core::Value {
    if !null_literal.is_empty() && text == null_literal {
        return Value::Null;
    }
    if empty_as_null && text.is_empty() {
        return Value::Null;
    }

    match logical {
        LogicalType::Integer => match text.parse::<i64>() {
            Ok(number) => Value::Int(number),
            Err(_) => Value::Text(text.to_string()),
        },
        LogicalType::Float => match text.parse::<f64>() {
            Ok(number) => Value::Float(number),
            Err(_) => Value::Text(text.to_string()),
        },
        LogicalType::Decimal => Value::Decimal(text.to_string()),
        LogicalType::Boolean => match text.to_ascii_lowercase().as_str() {
            "1" | "true" | "t" | "yes" => Value::Bool(true),
            "0" | "false" | "f" | "no" => Value::Bool(false),
            _ => Value::Text(text.to_string()),
        },
        LogicalType::Date => Value::Date(text.to_string()),
        LogicalType::Time => Value::Time(text.to_string()),
        LogicalType::DateTime | LogicalType::Timestamp => Value::DateTime(normalise_datetime(text)),
        LogicalType::Json => {
            if serde_json::from_str::<serde_json::Value>(text).is_ok() {
                Value::Json(text.to_string())
            } else {
                Value::Text(text.to_string())
            }
        },
        LogicalType::Binary => match base64_decode(text) {
            Some(bytes) => Value::Bytes(bytes),
            None => Value::Text(text.to_string()),
        },
        _ => Value::Text(text.to_string()),
    }
}

/// `2024-01-01T10:00:00Z` → `2024-01-01 10:00:00`.
///
/// Only the ISO `T` between the date and the time is rewritten, and only a
/// trailing `Z` is dropped: the rest of the text is preserved byte for byte.
fn normalise_datetime(text: &str) -> String {
    let mut normalised = match text.char_indices().nth(10) {
        Some((index, 'T')) => {
            let mut s = String::with_capacity(text.len());
            s.push_str(&text[..index]);
            s.push(' ');
            s.push_str(&text[index + 1..]);
            s
        },
        _ => text.to_string(),
    };
    if normalised.ends_with('Z') {
        normalised.pop();
    }
    normalised
}

// ---------------------------------------------------------------------------
// Row window (skip_rows / max_rows)
// ---------------------------------------------------------------------------

/// What to do with the next data row of an import file.
enum RowAction {
    /// Keep it: it counts towards the result.
    Keep,
    /// Drop it: it is inside the `skip_rows` window.
    Skip,
    /// Stop reading: `max_rows` rows have already been kept.
    Stop,
}

/// `skip_rows` / `max_rows` bookkeeping, shared by the three parsers so the two
/// options cannot drift apart.
struct RowWindow {
    skip: usize,
    max: u64,
    index: usize,
    kept: usize,
}

impl RowWindow {
    fn new(opts: &ImportOptions) -> Self {
        RowWindow {
            skip: opts.skip_rows,
            max: opts.max_rows,
            index: 0,
            kept: 0,
        }
    }

    /// Classify the next data row in the file.
    fn next(&mut self) -> RowAction {
        if self.max > 0 && self.kept as u64 >= self.max {
            return RowAction::Stop;
        }
        let index = self.index;
        self.index += 1;
        if index < self.skip {
            RowAction::Skip
        } else {
            self.kept += 1;
            RowAction::Keep
        }
    }
}

/// Pad or truncate `values` so every row matches the column list.
fn normalise_row(mut values: Vec<Value>, width: usize) -> Vec<Value> {
    values.truncate(width);
    while values.len() < width {
        values.push(Value::Null);
    }
    values
}

// ---------------------------------------------------------------------------
// Value projection
// ---------------------------------------------------------------------------

/// The JSON projection of a value used by the JSON exporter.
///
/// Numbers and booleans keep their JSON type so a downstream tool can sort and
/// aggregate them; everything the JSON data model cannot express literally
/// (decimals, dates, times, byte strings) becomes a string, and a non-finite
/// float becomes `null` because JSON has no spelling for it.
fn json_from_value(value: &Value) -> serde_json::Value {
    match value {
        Value::Null => serde_json::Value::Null,
        Value::Bool(flag) => serde_json::Value::Bool(*flag),
        Value::Int(number) => serde_json::Value::Number((*number).into()),
        Value::Uint(number) => serde_json::Value::Number((*number).into()),
        Value::Float(number) => serde_json::Number::from_f64(*number)
            .map(serde_json::Value::Number)
            .unwrap_or(serde_json::Value::Null),
        Value::Decimal(text) => match serde_json::from_str::<serde_json::Number>(text) {
            Ok(number) => serde_json::Value::Number(number),
            Err(_) => serde_json::Value::String(text.clone()),
        },
        Value::Text(text) => serde_json::Value::String(text.clone()),
        Value::Bytes(bytes) => serde_json::Value::String(base64_encode(bytes)),
        Value::Date(text) | Value::Time(text) | Value::DateTime(text) => {
            serde_json::Value::String(text.clone())
        },
        Value::Json(text) => {
            serde_json::from_str(text).unwrap_or_else(|_| serde_json::Value::String(text.clone()))
        },
    }
}

/// The inverse of [`json_from_value`] for import.
///
/// A JSON string is always text — the file cannot say that it meant a date or a
/// blob — while nested arrays and objects are kept as raw JSON so the target
/// column can receive them verbatim.
fn json_to_value(value: &serde_json::Value) -> Value {
    match value {
        serde_json::Value::Null => Value::Null,
        serde_json::Value::Bool(flag) => Value::Bool(*flag),
        serde_json::Value::Number(number) => {
            if let Some(int) = number.as_i64() {
                Value::Int(int)
            } else if let Some(uint) = number.as_u64() {
                Value::Uint(uint)
            } else if let Some(float) = number.as_f64() {
                Value::Float(float)
            } else {
                Value::Text(number.to_string())
            }
        },
        serde_json::Value::String(text) => Value::Text(text.clone()),
        nested => Value::Json(nested.to_string()),
    }
}

/// A name for a JSON value's type, used in error messages.
fn json_type_name(value: &serde_json::Value) -> &'static str {
    match value {
        serde_json::Value::Null => "null",
        serde_json::Value::Bool(_) => "a boolean",
        serde_json::Value::Number(_) => "a number",
        serde_json::Value::String(_) => "a string",
        serde_json::Value::Array(_) => "an array",
        serde_json::Value::Object(_) => "an object",
    }
}

/// Base64 text for a byte string.
///
/// This crate does not depend on the `base64` crate directly; the canonical
/// encoder already lives in `opencat-core` as the payload of the IPC projection
/// of [`Value::Bytes`], so the projection is reused here instead of duplicated.
fn base64_encode(bytes: &[u8]) -> String {
    Value::Bytes(bytes.to_vec())
        .to_json()
        .get("v")
        .and_then(serde_json::Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Inverse of [`base64_encode`]; `None` when `text` is not valid base64.
fn base64_decode(text: &str) -> Option<Vec<u8>> {
    match opencat_core::value::from_json(&serde_json::json!({ "t": "bytes", "v": text })) {
        Ok(Value::Bytes(bytes)) => Some(bytes),
        _ => None,
    }
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

/// The delimiter to use for `format`: the configured character, except that a
/// TSV export/import whose delimiter is still the comma default means a tab.
fn delimiter_for(configured: char, format: TransferFormat) -> char {
    match format {
        TransferFormat::Tsv if configured == default_comma() => '\t',
        _ => configured,
    }
}

/// Narrow a delimiter/quote/escape character to the single byte the `csv` crate
/// works with. Anything outside ASCII is rejected instead of truncated.
fn as_byte(character: char, what: &str) -> Result<u8> {
    if character.is_ascii() {
        Ok(character as u8)
    } else {
        Err(CoreError::Invalid(format!(
            "{what} must be a single ASCII character, got `{character}`"
        )))
    }
}

/// The `csv` record terminator for a configured line ending.
///
/// The crate only models `\r\n` or one arbitrary byte, so any other multi-byte
/// ending falls back to `\n` rather than corrupting the file.
fn terminator(line_ending: &str) -> csv::Terminator {
    match line_ending {
        "\r\n" => csv::Terminator::CRLF,
        other => match other.as_bytes() {
            [byte] => csv::Terminator::Any(*byte),
            _ => csv::Terminator::Any(b'\n'),
        },
    }
}

/// Map a `csv` failure onto the OpenCat error type, keeping I/O failures I/O.
fn csv_error(err: csv::Error) -> CoreError {
    match err.kind() {
        csv::ErrorKind::Io(io) => CoreError::Io(std::io::Error::new(io.kind(), io.to_string())),
        _ => CoreError::Invalid(format!("CSV: {err}")),
    }
}

/// Serialise a JSON value for the exporter; a `Value` never fails to serialise.
fn json_text(value: &serde_json::Value) -> String {
    serde_json::to_string_pretty(value).unwrap_or_else(|_| "null".to_string())
}

/// Indent every line of `text` after the first by `indent` spaces.
fn indent_lines(text: &str, indent: usize) -> String {
    if !text.contains('\n') {
        return text.to_string();
    }
    let padding = " ".repeat(indent);
    text.replace('\n', &format!("\n{padding}"))
}

/// Make sure a script fragment ends with exactly one `;`.
fn terminate(script: &str) -> String {
    let body = script.trim_end().trim_end_matches(';').trim_end();
    format!("{body};")
}

// ---------------------------------------------------------------------------
// SQL INSERT parsing
// ---------------------------------------------------------------------------

/// A parsed `INSERT ... VALUES ...` statement.
struct ParsedInsert {
    /// The explicit column list, when the statement carried one.
    columns: Option<Vec<String>>,
    /// One entry per `(...)` tuple, each holding the raw value expressions.
    tuples: Vec<Vec<String>>,
}

impl ParsedInsert {
    /// The number of values per tuple, taken from the column list or the first
    /// tuple.
    fn width(&self) -> usize {
        match &self.columns {
            Some(columns) => columns.len(),
            None => self.tuples.first().map(Vec::len).unwrap_or(0),
        }
    }
}

/// The leading keyword of a statement, ignoring comments and literals.
fn leading_keyword(sql: &str) -> String {
    strip_sql_noise(sql)
        .trim_start()
        .chars()
        .take_while(|c| c.is_ascii_alphabetic())
        .collect::<String>()
        .to_ascii_lowercase()
}

/// Parse the `INSERT`/`REPLACE` statement `statement`, or `None` when it is too
/// exotic to understand (which the caller reports as invalid input).
///
/// The grammar understood is deliberately small — `INSERT [IGNORE] INTO
/// [db.][schema.]table [(cols)] [OVERRIDING ...] VALUES (..), (..)` — because a
/// data-import file is generated, not hand crafted. Anything after the tuple
/// list (`ON CONFLICT`, `RETURNING`, …) is ignored.
fn parse_insert_statement(statement: &str) -> Option<ParsedInsert> {
    let mut scanner = Scanner::new(statement);

    if !(scanner.keyword("insert") || scanner.keyword("replace")) {
        return None;
    }
    // MySQL's `INSERT IGNORE INTO` is still a plain insert for our purposes.
    let _ = scanner.keyword("ignore");
    if !scanner.keyword("into") {
        return None;
    }
    scanner.relation()?;

    scanner.skip_whitespace();
    let columns = if scanner.peek() == Some('(') {
        let group = scanner.group()?;
        let names: Vec<String> = split_top_level(group, ',')
            .iter()
            .map(|item| unquote_ident(item))
            .filter(|name| !name.is_empty())
            .collect();
        if names.is_empty() {
            None
        } else {
            Some(names)
        }
    } else {
        None
    };

    // PostgreSQL's identity-column override sits between the column list and
    // `VALUES`.
    if scanner.keyword("overriding") {
        let _ = scanner.keyword("system") || scanner.keyword("user");
        let _ = scanner.keyword("value");
    }

    if scanner.keyword("values") {
        let tuples = scanner.tuples()?;
        return Some(ParsedInsert { columns, tuples });
    }
    if scanner.keyword("default") && scanner.keyword("values") {
        return Some(ParsedInsert {
            columns,
            tuples: Vec::new(),
        });
    }

    None
}

/// A cursor over a SQL statement, used only by [`parse_insert_statement`].
struct Scanner<'a> {
    text: &'a str,
    pos: usize,
}

impl<'a> Scanner<'a> {
    fn new(text: &'a str) -> Self {
        Scanner { text, pos: 0 }
    }

    fn rest(&self) -> &'a str {
        &self.text[self.pos..]
    }

    fn peek(&self) -> Option<char> {
        self.rest().chars().next()
    }

    fn bump(&mut self) {
        if let Some(character) = self.peek() {
            self.pos += character.len_utf8();
        }
    }

    fn skip_whitespace(&mut self) {
        while self.peek().is_some_and(char::is_whitespace) {
            self.bump();
        }
    }

    /// Consume `keyword` (ASCII, case-insensitive) when it sits at the cursor
    /// and is not merely the prefix of a longer identifier.
    fn keyword(&mut self, keyword: &str) -> bool {
        self.skip_whitespace();
        let rest = self.rest();
        match rest.get(..keyword.len()) {
            Some(head) if head.eq_ignore_ascii_case(keyword) => {
                let after = rest[keyword.len()..].chars().next();
                if after.is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$') {
                    return false;
                }
                self.pos += keyword.len();
                true
            },
            _ => false,
        }
    }

    /// Consume a quoted literal/identifier, leaving the cursor after its closing
    /// quote. Returns `None` when the quote is never closed.
    fn quoted(&mut self) -> Option<()> {
        let quote = self.peek()?;
        self.bump();
        while let Some(character) = self.peek() {
            self.bump();
            if character == '\\' {
                // MySQL-style `\'` and `\\`. Doubling (`''`) is handled below and
                // a lone backslash stays literal, which is what standard SQL
                // wants.
                if self
                    .peek()
                    .is_some_and(|next| next == '\\' || next == quote)
                {
                    self.bump();
                }
                continue;
            }
            if character == quote {
                if self.peek() == Some(quote) {
                    self.bump();
                    continue;
                }
                return Some(());
            }
        }
        None
    }

    /// Consume a balanced `( ... )` group and return the text between the
    /// parentheses.
    fn group(&mut self) -> Option<&'a str> {
        self.skip_whitespace();
        if self.peek() != Some('(') {
            return None;
        }
        self.bump();
        let start = self.pos;
        let mut depth = 1usize;
        while let Some(character) = self.peek() {
            match character {
                '\'' | '"' | '`' => self.quoted()?,
                '(' => {
                    depth += 1;
                    self.bump();
                },
                ')' => {
                    depth -= 1;
                    if depth == 0 {
                        let inner = &self.text[start..self.pos];
                        self.bump();
                        return Some(inner);
                    }
                    self.bump();
                },
                _ => self.bump(),
            }
        }
        None
    }

    /// Consume a comma separated list of `( ... )` tuples.
    fn tuples(&mut self) -> Option<Vec<Vec<String>>> {
        let mut tuples = Vec::new();
        loop {
            self.skip_whitespace();
            if self.peek() != Some('(') {
                break;
            }
            let group = self.group()?;
            tuples.push(
                split_top_level(group, ',')
                    .iter()
                    .map(|value| value.trim().to_string())
                    .collect(),
            );
            self.skip_whitespace();
            if self.peek() == Some(',') {
                self.bump();
                continue;
            }
            break;
        }

        if tuples.is_empty() {
            None
        } else {
            Some(tuples)
        }
    }

    /// Consume a possibly dotted (and possibly quoted) relation name.
    fn relation(&mut self) -> Option<String> {
        let mut parts = Vec::new();
        loop {
            parts.push(self.ident()?);
            self.skip_whitespace();
            if self.peek() == Some('.') {
                self.bump();
            } else {
                break;
            }
        }
        Some(parts.join("."))
    }

    /// Consume one identifier, stripping its quoting.
    fn ident(&mut self) -> Option<String> {
        self.skip_whitespace();
        let first = self.peek()?;

        if first == '"' || first == '`' || first == '[' {
            let close = if first == '[' { ']' } else { first };
            self.bump();
            let mut name = String::new();
            while let Some(character) = self.peek() {
                self.bump();
                if character == close {
                    if first != '[' && self.peek() == Some(close) {
                        name.push(close);
                        self.bump();
                        continue;
                    }
                    return Some(name);
                }
                name.push(character);
            }
            return None;
        }

        if !(first.is_alphabetic() || first == '_') {
            return None;
        }
        let start = self.pos;
        while self
            .peek()
            .is_some_and(|c| c.is_alphanumeric() || c == '_' || c == '$')
        {
            self.bump();
        }
        Some(self.text[start..self.pos].to_string())
    }
}

/// Strip the quoting from a column name in an explicit column list.
fn unquote_ident(raw: &str) -> String {
    let trimmed = raw.trim();
    for quote in ['"', '`', '\''] {
        if trimmed.len() >= 2 && trimmed.starts_with(quote) && trimmed.ends_with(quote) {
            let inner = &trimmed[quote.len_utf8()..trimmed.len() - quote.len_utf8()];
            return inner.replace(&format!("{quote}{quote}"), &quote.to_string());
        }
    }
    if trimmed.len() >= 2 && trimmed.starts_with('[') && trimmed.ends_with(']') {
        return trimmed[1..trimmed.len() - 1].to_string();
    }
    trimmed.to_string()
}

/// Split `text` on `separator`, ignoring separators nested in parentheses,
/// brackets or quoted literals.
fn split_top_level(text: &str, separator: char) -> Vec<String> {
    let mut parts = Vec::new();
    let mut current = String::new();
    let mut depth = 0i32;
    let chars: Vec<char> = text.chars().collect();
    let mut index = 0usize;

    while index < chars.len() {
        let character = chars[index];

        if character == '\'' || character == '"' || character == '`' {
            let quote = character;
            current.push(character);
            index += 1;
            while index < chars.len() {
                let inner = chars[index];
                current.push(inner);
                index += 1;
                if inner == '\\' {
                    if index < chars.len() {
                        current.push(chars[index]);
                        index += 1;
                    }
                    continue;
                }
                if inner == quote {
                    if index < chars.len() && chars[index] == quote {
                        current.push(quote);
                        index += 1;
                        continue;
                    }
                    break;
                }
            }
            continue;
        }

        match character {
            '(' | '[' => depth += 1,
            ')' | ']' => depth -= 1,
            _ if character == separator && depth == 0 => {
                parts.push(std::mem::take(&mut current));
                index += 1;
                continue;
            },
            _ => {},
        }
        current.push(character);
        index += 1;
    }

    parts.push(current);
    parts
}

/// Interpret one SQL value expression as a [`Value`].
///
/// Simple literals become typed values. A `::type` cast is honoured for the two
/// cases the exporter itself emits (`::bytea` and `::jsonb`); anything more
/// elaborate — a function call, an arithmetic expression, an array constructor —
/// is preserved verbatim as text so a round trip never silently drops data.
fn literal_to_value(raw: &str) -> Value {
    let text = raw.trim();
    if text.is_empty() {
        return Value::Null;
    }

    let (body, cast) = split_cast(text);
    let cast = cast.map(str::to_ascii_lowercase);

    if let Some(hex) = hex_literal(body) {
        if let Some(bytes) = decode_hex(hex) {
            return Value::Bytes(bytes);
        }
    }

    if body.len() >= 2 && body.starts_with('\'') && body.ends_with('\'') {
        let text_value = unescape_sql_string(body);
        return match cast.as_deref() {
            Some("bytea") => decode_bytea(&text_value)
                .map(Value::Bytes)
                .unwrap_or(Value::Text(text_value)),
            Some("json") | Some("jsonb") => json_or_text(text_value),
            _ => Value::Text(text_value),
        };
    }

    if body.eq_ignore_ascii_case("null") || body.eq_ignore_ascii_case("default") {
        return Value::Null;
    }
    if body.eq_ignore_ascii_case("true") {
        return Value::Bool(true);
    }
    if body.eq_ignore_ascii_case("false") {
        return Value::Bool(false);
    }
    if let Ok(number) = body.parse::<i64>() {
        return Value::Int(number);
    }
    if let Ok(number) = body.parse::<u64>() {
        return Value::Uint(number);
    }
    if is_numeric_literal(body) {
        if body.contains('e') || body.contains('E') {
            if let Ok(number) = body.parse::<f64>() {
                return Value::Float(number);
            }
        }
        return Value::Decimal(body.to_string());
    }

    match cast.as_deref() {
        Some("json") | Some("jsonb") => json_or_text(body.to_string()),
        _ => Value::Text(body.to_string()),
    }
}

/// Keep JSON text typed as JSON when it really parses, as text otherwise.
fn json_or_text(text: String) -> Value {
    if serde_json::from_str::<serde_json::Value>(&text).is_ok() {
        Value::Json(text)
    } else {
        Value::Text(text)
    }
}

/// Split a value expression into its literal part and a trailing `::type` cast.
fn split_cast(text: &str) -> (&str, Option<&str>) {
    let chars: Vec<(usize, char)> = text.char_indices().collect();
    let mut index = 0usize;

    while index < chars.len() {
        let (offset, character) = chars[index];

        if character == '\'' || character == '"' || character == '`' {
            index += 1;
            while index < chars.len() {
                let (_, inner) = chars[index];
                index += 1;
                if inner == '\\' {
                    index += 1;
                    continue;
                }
                if inner == character {
                    break;
                }
            }
            continue;
        }

        if character == ':' && chars.get(index + 1).map(|(_, c)| *c) == Some(':') {
            let after = text[offset + 2..].trim_start();
            let end = after
                .char_indices()
                .find(|(_, c)| !(c.is_alphanumeric() || *c == '_' || *c == ' '))
                .map(|(i, _)| i)
                .unwrap_or(after.len());
            let cast = after[..end].trim_end();
            return (
                &text[..offset],
                if cast.is_empty() { None } else { Some(cast) },
            );
        }

        index += 1;
    }

    (text, None)
}

/// The digits of an `X'01ff'` blob literal.
fn hex_literal(text: &str) -> Option<&str> {
    let mut chars = text.chars();
    let prefix = chars.next()?;
    if prefix != 'x' && prefix != 'X' {
        return None;
    }
    let rest = chars.as_str();
    if rest.len() >= 2 && rest.starts_with('\'') && rest.ends_with('\'') {
        Some(&rest[1..rest.len() - 1])
    } else {
        None
    }
}

/// Decode an even-length run of hex digits.
fn decode_hex(text: &str) -> Option<Vec<u8>> {
    let digits: Vec<u8> = text
        .chars()
        .filter(|c| !c.is_whitespace())
        .map(|c| c.to_digit(16).map(|d| d as u8))
        .collect::<Option<Vec<u8>>>()?;
    if digits.len() % 2 != 0 {
        return None;
    }
    Some(
        digits
            .chunks(2)
            .map(|pair| pair[0] * 16 + pair[1])
            .collect(),
    )
}

/// Decode PostgreSQL's `\x01ff` bytea input syntax.
fn decode_bytea(text: &str) -> Option<Vec<u8>> {
    decode_hex(text.strip_prefix("\\x")?)
}

/// Undo the quoting of a single-quoted SQL string literal, including the
/// surrounding quotes.
fn unescape_sql_string(literal: &str) -> String {
    let inner = &literal[1..literal.len() - 1];
    let mut out = String::with_capacity(inner.len());
    let mut chars = inner.chars().peekable();

    while let Some(character) = chars.next() {
        if character == '\'' && chars.peek() == Some(&'\'') {
            chars.next();
            out.push('\'');
            continue;
        }
        if character == '\\' {
            if let Some(&next) = chars.peek() {
                if next == '\\' || next == '\'' {
                    chars.next();
                    out.push(next);
                    continue;
                }
            }
        }
        out.push(character);
    }

    out
}

/// Whether a bare token is an (unsigned) numeric literal.
fn is_numeric_literal(text: &str) -> bool {
    !text.is_empty()
        && text.chars().any(|c| c.is_ascii_digit())
        && text
            .chars()
            .all(|c| c.is_ascii_digit() || matches!(c, '+' | '-' | '.' | 'e' | 'E'))
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicUsize, Ordering};

    /// A scratch file that deletes itself when the test ends, so a failing
    /// assertion cannot leave debris in the temp directory.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            static NEXT: AtomicUsize = AtomicUsize::new(0);
            let unique = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "opencat-transfer-{}-{tag}-{unique}",
                std::process::id()
            ));
            Scratch(path)
        }

        fn path(&self) -> String {
            self.0.to_string_lossy().to_string()
        }

        fn text(&self) -> String {
            std::fs::read_to_string(&self.0).expect("scratch file should exist")
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            std::fs::remove_file(&self.0).ok();
        }
    }

    fn request(
        format: TransferFormat,
        file: &Scratch,
        columns: &[&str],
        rows: Vec<Vec<Value>>,
    ) -> ExportRequest {
        ExportRequest {
            format,
            path: file.path(),
            columns: columns.iter().map(|c| c.to_string()).collect(),
            rows,
            table: Some("t".into()),
            database: None,
            schema: None,
            db_kind: DbKind::Sqlite,
            csv: CsvOptions::default(),
            create_table: None,
            batch_size: 1,
        }
    }

    fn importing(format: TransferFormat) -> ImportOptions {
        ImportOptions {
            format: Some(format),
            ..ImportOptions::default()
        }
    }

    #[test]
    fn csv_options_default_to_rfc4180() {
        let options = CsvOptions::default();
        assert_eq!(options.delimiter, ',');
        assert_eq!(options.quote, '"');
        assert_eq!(options.escape, '"');
        assert!(options.has_header);
        assert!(options.null_literal.is_empty());
        assert!(options.empty_as_null);
        assert_eq!(options.line_ending, "\n");
        assert!(!options.include_bom);
        assert_eq!(default_batch(), 100);
    }

    #[test]
    fn csv_round_trip_keeps_awkward_fields() {
        let file = Scratch::new("csv");
        let awkward = Value::Text("a,b\"c\nd".into());

        let req = request(
            TransferFormat::Csv,
            &file,
            &["id", "note", "nil"],
            vec![vec![Value::Int(1), awkward.clone(), Value::Null]],
        );
        let summary = export(&req).expect("export should succeed");
        assert_eq!(summary.rows, 1);
        assert!(summary.bytes > 0);
        assert_eq!(summary.path, file.path());

        let raw = file.text();
        assert!(raw.starts_with("id,note,nil\n"), "{raw}");
        // The delimiter, quote character and newline are all quoted, and the
        // quote character itself is doubled.
        assert!(raw.contains("\"a,b\"\"c\nd\""), "{raw}");

        let parsed = parse_file(&file.path(), &importing(TransferFormat::Csv)).expect("parse");
        assert_eq!(parsed.format, TransferFormat::Csv);
        assert_eq!(parsed.columns, vec!["id", "note", "nil"]);
        assert_eq!(parsed.total_rows, 1);
        assert_eq!(
            parsed.rows,
            vec![vec![Value::Text("1".into()), awkward, Value::Null]]
        );

        // With the target schema known, the same text types correctly.
        assert_eq!(
            value_from_text("1", LogicalType::Integer, "", true),
            Value::Int(1)
        );
    }

    #[test]
    fn tsv_round_trip_uses_tabs() {
        let file = Scratch::new("tsv");
        let tabbed = Value::Text("x\ty".into());

        let req = request(
            TransferFormat::Tsv,
            &file,
            &["name", "value"],
            vec![vec![Value::Text("Ann".into()), tabbed.clone()]],
        );
        export(&req).expect("export should succeed");

        let raw = file.text();
        assert!(raw.starts_with("name\tvalue\n"), "{raw}");
        assert!(raw.contains("\"x\ty\""), "{raw}");

        let parsed = parse_file(&file.path(), &importing(TransferFormat::Tsv)).expect("parse");
        assert_eq!(parsed.format, TransferFormat::Tsv);
        assert_eq!(parsed.columns, vec!["name", "value"]);
        assert_eq!(parsed.rows, vec![vec![Value::Text("Ann".into()), tabbed]]);
    }

    #[test]
    fn csv_export_honours_bom_null_literal_and_line_ending() {
        let file = Scratch::new("csv-options");
        let mut req = request(
            TransferFormat::Csv,
            &file,
            &["a", "b"],
            vec![vec![Value::Null, Value::Text("v".into())]],
        );
        req.csv.include_bom = true;
        req.csv.null_literal = "\\N".into();
        req.csv.line_ending = "\r\n".into();
        req.csv.has_header = false;
        export(&req).expect("export should succeed");

        let raw = file.text();
        assert!(raw.starts_with('\u{feff}'), "{raw:?}");
        assert_eq!(raw, "\u{feff}\\N,v\r\n");
    }

    #[test]
    fn json_export_and_import_round_trip() {
        let file = Scratch::new("json");
        let req = request(
            TransferFormat::Json,
            &file,
            &["id", "name", "extra"],
            vec![vec![
                Value::Int(42),
                Value::Text("héllo".into()),
                Value::Null,
            ]],
        );
        export(&req).expect("export should succeed");

        let raw = file.text();
        // Two space indentation, native JSON types and the grid's column order.
        assert!(raw.contains("\n  {"), "{raw}");
        assert!(raw.contains("\"id\": 42"), "{raw}");
        assert!(raw.contains("\"extra\": null"), "{raw}");
        let id_at = raw.find("\"id\"").expect("id is present");
        let name_at = raw.find("\"name\"").expect("name is present");
        assert!(id_at < name_at, "columns keep their order: {raw}");

        let parsed = parse_file(&file.path(), &importing(TransferFormat::Json)).expect("parse");
        assert_eq!(parsed.format, TransferFormat::Json);
        assert_eq!(parsed.columns, vec!["id", "name", "extra"]);
        assert_eq!(parsed.total_rows, 1);
        assert_eq!(
            parsed.rows,
            vec![vec![
                Value::Int(42),
                Value::Text("héllo".into()),
                Value::Null
            ]]
        );
    }

    #[test]
    fn json_export_keeps_floats_booleans_and_bytes() {
        let file = Scratch::new("json-types");
        let req = request(
            TransferFormat::Json,
            &file,
            &["f", "b", "blob", "when"],
            vec![vec![
                Value::Float(1.5),
                Value::Bool(true),
                Value::Bytes(vec![1, 255]),
                Value::Date("2024-05-01".into()),
            ]],
        );
        export(&req).expect("export should succeed");

        let parsed = parse_file(&file.path(), &importing(TransferFormat::Json)).expect("parse");
        assert_eq!(
            parsed.rows,
            vec![vec![
                Value::Float(1.5),
                Value::Bool(true),
                // A JSON string cannot say "this was base64", so it comes back
                // as text and is re-typed from the column schema.
                Value::Text("Af8=".into()),
                Value::Text("2024-05-01".into()),
            ]]
        );
    }

    #[test]
    fn json_import_unions_object_keys() {
        let file = Scratch::new("json-keys");
        std::fs::write(
            file.0.clone(),
            r#"{"rows":[{"a":1},{"b":"x","a":2}],"total":2}"#,
        )
        .expect("write");

        let parsed = parse_file(&file.path(), &importing(TransferFormat::Json)).expect("parse");
        assert_eq!(parsed.columns, vec!["a", "b"]);
        assert_eq!(parsed.total_rows, 2);
        assert_eq!(
            parsed.rows,
            vec![
                vec![Value::Int(1), Value::Null],
                vec![Value::Int(2), Value::Text("x".into())],
            ]
        );
    }

    #[test]
    fn json_import_rejects_an_ambiguous_wrapper() {
        let file = Scratch::new("json-ambiguous");
        std::fs::write(file.0.clone(), r#"{"a":[{"x":1}],"b":[{"y":2}]}"#).expect("write");

        let err = parse_file(&file.path(), &importing(TransferFormat::Json))
            .expect_err("two array fields cannot be told apart");
        assert_eq!(err.code(), "invalid");
        assert!(err.to_string().contains("exactly one array"), "{err}");
    }

    #[test]
    fn malformed_json_is_an_error_not_a_panic() {
        let file = Scratch::new("json-bad");
        std::fs::write(file.0.clone(), r#"{"rows": [{"a": 1},"#).expect("write");

        let err = parse_file(&file.path(), &importing(TransferFormat::Json))
            .expect_err("truncated JSON must fail");
        assert_eq!(err.code(), "invalid");
        assert!(err.to_string().contains("invalid JSON"), "{err}");

        // Valid JSON of the wrong shape is rejected too.
        std::fs::write(file.0.clone(), "[1, 2, 3]").expect("write");
        let err = parse_file(&file.path(), &importing(TransferFormat::Json))
            .expect_err("non-object rows must fail");
        assert_eq!(err.code(), "invalid");
        assert!(err.to_string().contains("array of objects"), "{err}");
    }

    #[test]
    fn sql_inserts_for_a_single_row_per_dialect() {
        let sqlite = rows_to_inserts(
            "users",
            None,
            None,
            &["id".into(), "name".into()],
            &[vec![Value::Int(1), Value::Text("O'Hara".into())]],
            DbKind::Sqlite,
            1,
        );
        assert_eq!(
            sqlite,
            vec![r#"INSERT INTO "users" ("id", "name") VALUES (1, 'O''Hara')"#]
        );

        let postgres = rows_to_inserts(
            "users",
            None,
            Some("public"),
            &["id".into(), "ok".into(), "data".into()],
            &[vec![
                Value::Int(7),
                Value::Bool(true),
                Value::Bytes(vec![1, 255]),
            ]],
            DbKind::Postgres,
            1,
        );
        assert_eq!(
            postgres,
            vec![
                r#"INSERT INTO "public"."users" ("id", "ok", "data") VALUES (7, TRUE, '\x01ff'::bytea)"#
            ]
        );

        let mysql = rows_to_inserts(
            "orders",
            Some("shop"),
            None,
            &["id".into()],
            &[vec![Value::Int(1)]],
            DbKind::Mysql,
            0,
        );
        assert_eq!(mysql, vec!["INSERT INTO `shop`.`orders` (`id`) VALUES (1)"]);
    }

    #[test]
    fn sql_inserts_batch_multiple_rows() {
        let rows = vec![
            vec![Value::Int(1)],
            vec![Value::Int(2)],
            vec![Value::Int(3)],
        ];

        let batched = rows_to_inserts("t", None, None, &["a".into()], &rows, DbKind::Sqlite, 2);
        assert_eq!(
            batched,
            vec![
                r#"INSERT INTO "t" ("a") VALUES (1), (2)"#,
                r#"INSERT INTO "t" ("a") VALUES (3)"#,
            ]
        );

        let postgres = rows_to_inserts(
            "t",
            Some("db"),
            Some("public"),
            &["a".into(), "b".into()],
            &rows,
            DbKind::Postgres,
            100,
        );
        assert_eq!(
            postgres,
            vec![
                r#"INSERT INTO "db"."public"."t" ("a", "b") VALUES (1, NULL), (2, NULL), (3, NULL)"#
            ]
        );

        // An empty row set produces no statements at all.
        assert!(
            rows_to_inserts("t", None, None, &["a".into()], &[], DbKind::Sqlite, 10).is_empty()
        );
    }

    #[test]
    fn sql_export_script_includes_ddl_and_transaction() {
        let file = Scratch::new("sql");
        let mut req = request(
            TransferFormat::SqlInsert,
            &file,
            &["id", "name"],
            vec![
                vec![Value::Int(1), Value::Text("Ann".into())],
                vec![Value::Int(2), Value::Text("Bob".into())],
            ],
        );
        req.create_table = Some("CREATE TABLE t (id INTEGER, name TEXT)".into());
        req.batch_size = 1;
        export(&req).expect("export should succeed");

        let raw = file.text();
        assert_eq!(
            raw,
            "CREATE TABLE t (id INTEGER, name TEXT);\n\
             \n\
             BEGIN;\n\
             INSERT INTO \"t\" (\"id\", \"name\") VALUES (1, 'Ann');\n\
             INSERT INTO \"t\" (\"id\", \"name\") VALUES (2, 'Bob');\n\
             COMMIT;\n"
        );

        // A single statement stays unwrapped so it can be pasted directly.
        let single = Scratch::new("sql-single");
        let mut req = request(
            TransferFormat::SqlInsert,
            &single,
            &["id"],
            vec![vec![Value::Int(1)]],
        );
        req.batch_size = 1;
        export(&req).expect("export should succeed");
        assert_eq!(single.text(), "INSERT INTO \"t\" (\"id\") VALUES (1);\n");
    }

    #[test]
    fn sql_export_needs_a_table() {
        let file = Scratch::new("sql-no-table");
        let mut req = request(
            TransferFormat::SqlInsert,
            &file,
            &["id"],
            vec![vec![Value::Int(1)]],
        );
        req.table = None;
        let err = export(&req).expect_err("a table name is required");
        assert_eq!(err.code(), "invalid");
    }

    #[test]
    fn value_from_text_applies_the_null_rules() {
        assert_eq!(
            value_from_text("NULL", LogicalType::Integer, "NULL", true),
            Value::Null
        );
        assert_eq!(
            value_from_text("", LogicalType::Integer, "NULL", true),
            Value::Null
        );
        // An empty null literal only matches when empty-as-null is on.
        assert_eq!(
            value_from_text("", LogicalType::Text, "", false),
            Value::Text(String::new())
        );
        assert_eq!(
            value_from_text("", LogicalType::Text, "\\N", true),
            Value::Null
        );
        // `\N` is a literal, not the null token, when the token is different.
        assert_eq!(
            value_from_text("\\N", LogicalType::Text, "", false),
            Value::Text("\\N".into())
        );
    }

    #[test]
    fn value_from_text_types_each_logical_family() {
        assert_eq!(
            value_from_text("42", LogicalType::Integer, "", false),
            Value::Int(42)
        );
        assert_eq!(
            value_from_text("1.25", LogicalType::Float, "", false),
            Value::Float(1.25)
        );
        assert_eq!(
            value_from_text("10.001", LogicalType::Decimal, "", false),
            Value::Decimal("10.001".into())
        );
        assert_eq!(
            value_from_text("not a number", LogicalType::Integer, "", false),
            Value::Text("not a number".into())
        );

        for truthy in ["1", "true", "TRUE", "t", "Yes"] {
            assert_eq!(
                value_from_text(truthy, LogicalType::Boolean, "", false),
                Value::Bool(true),
                "{truthy}"
            );
        }
        for falsy in ["0", "false", "F", "no"] {
            assert_eq!(
                value_from_text(falsy, LogicalType::Boolean, "", false),
                Value::Bool(false),
                "{falsy}"
            );
        }
        assert_eq!(
            value_from_text("maybe", LogicalType::Boolean, "", false),
            Value::Text("maybe".into())
        );

        assert_eq!(
            value_from_text(r#"{"a": 1}"#, LogicalType::Json, "", false),
            Value::Json(r#"{"a": 1}"#.into())
        );
        assert_eq!(
            value_from_text("{oops", LogicalType::Json, "", false),
            Value::Text("{oops".into())
        );

        assert_eq!(
            value_from_text("2024-05-01", LogicalType::Date, "", false),
            Value::Date("2024-05-01".into())
        );
        assert_eq!(
            value_from_text("2024-05-01T10:00:00Z", LogicalType::DateTime, "", false),
            Value::DateTime("2024-05-01 10:00:00".into())
        );
        assert_eq!(
            value_from_text("10:00:00", LogicalType::Time, "", false),
            Value::Time("10:00:00".into())
        );
        assert_eq!(
            value_from_text("Af8=", LogicalType::Binary, "", false),
            Value::Bytes(vec![1, 255])
        );
        assert_eq!(
            value_from_text("not base64!", LogicalType::Binary, "", false),
            Value::Text("not base64!".into())
        );
        // Whitespace is data, never trimmed.
        assert_eq!(
            value_from_text(" 7 ", LogicalType::Integer, "", false),
            Value::Text(" 7 ".into())
        );
    }

    #[test]
    fn detect_format_reads_the_extension_and_the_content() {
        assert_eq!(detect_format("rows.csv", ""), TransferFormat::Csv);
        assert_eq!(
            detect_format(r"C:\data\rows.JSON", ""),
            TransferFormat::Json
        );
        assert_eq!(detect_format("dump.sql", ""), TransferFormat::SqlInsert);
        assert_eq!(detect_format("rows.tsv", ""), TransferFormat::Tsv);

        // `.txt` and unknown extensions fall back to the content.
        assert_eq!(
            detect_format("rows.txt", "a\tb\n1\t2\n"),
            TransferFormat::Tsv
        );
        assert_eq!(detect_format("rows.txt", "a,b\n1,2\n"), TransferFormat::Csv);
        assert_eq!(
            detect_format("blob", "\u{feff}[\n {\"a\": 1}\n]"),
            TransferFormat::Json
        );
        assert_eq!(
            detect_format("blob", "-- dump\nINSERT INTO t VALUES (1)"),
            TransferFormat::SqlInsert
        );
        assert_eq!(detect_format("blob", ""), TransferFormat::Csv);
    }

    #[test]
    fn csv_import_synthesises_columns_and_applies_limits() {
        let file = Scratch::new("csv-limits");
        std::fs::write(file.0.clone(), "a,b\n1,2\n3,4\n5,6\n").expect("write");

        let parsed = parse_file(
            &file.path(),
            &ImportOptions {
                format: None,
                has_header: false,
                skip_rows: 1,
                max_rows: 2,
                ..ImportOptions::default()
            },
        )
        .expect("parse");
        assert_eq!(parsed.format, TransferFormat::Csv);
        assert_eq!(parsed.columns, vec!["column_1", "column_2"]);
        assert_eq!(parsed.total_rows, 2);
        // `skip_rows` drops the leading "a,b" line, then `max_rows` caps the
        // window at two data rows.
        assert_eq!(
            parsed.rows,
            vec![
                vec![Value::Text("1".into()), Value::Text("2".into())],
                vec![Value::Text("3".into()), Value::Text("4".into())],
            ]
        );

        // Without a header the first line becomes data as well.
        let parsed = parse_file(
            &file.path(),
            &ImportOptions {
                has_header: false,
                max_rows: 1,
                ..ImportOptions::default()
            },
        )
        .expect("parse");
        assert_eq!(parsed.rows[0][0], Value::Text("a".into()));
        assert_eq!(parsed.total_rows, 1);
    }

    #[test]
    fn csv_import_pads_ragged_rows() {
        let file = Scratch::new("csv-ragged");
        std::fs::write(file.0.clone(), "a,b,c\n1,2\n").expect("write");

        let parsed = parse_file(&file.path(), &importing(TransferFormat::Csv)).expect("parse");
        assert_eq!(
            parsed.rows,
            vec![vec![
                Value::Text("1".into()),
                Value::Text("2".into()),
                Value::Null
            ]]
        );
    }

    #[test]
    fn import_rejects_a_non_ascii_delimiter() {
        let file = Scratch::new("csv-bad-delimiter");
        std::fs::write(file.0.clone(), "a;b\n1;2\n").expect("write");

        let err = parse_file(
            &file.path(),
            &ImportOptions {
                format: Some(TransferFormat::Csv),
                delimiter: 'é',
                ..ImportOptions::default()
            },
        )
        .expect_err("a non-ASCII delimiter cannot be represented");
        assert_eq!(err.code(), "invalid");
        assert!(err.to_string().contains("delimiter"), "{err}");
    }

    #[test]
    fn parse_file_reports_a_missing_file_as_io() {
        let path = Scratch::new("missing");
        let err = parse_file(&path.path(), &ImportOptions::default())
            .expect_err("the file does not exist");
        assert_eq!(err.code(), "io");
    }

    #[test]
    fn sql_import_parses_insert_statements() {
        let file = Scratch::new("sql-import");
        std::fs::write(
            file.0.clone(),
            "CREATE TABLE t (id INTEGER, name TEXT, note TEXT, blob BLOB);\n\
             BEGIN;\n\
             INSERT INTO \"t\" (\"id\", \"name\", \"note\", \"blob\") VALUES (1, 'O''Hara', NULL, X'01ff'), (2, 'Bob', -3.5, '\\x00'::bytea);\n\
             COMMIT;\n",
        )
        .expect("write");

        let parsed =
            parse_file(&file.path(), &importing(TransferFormat::SqlInsert)).expect("parse");
        assert_eq!(parsed.format, TransferFormat::SqlInsert);
        assert_eq!(parsed.columns, vec!["id", "name", "note", "blob"]);
        assert_eq!(parsed.total_rows, 2);
        assert_eq!(
            parsed.rows,
            vec![
                vec![
                    Value::Int(1),
                    Value::Text("O'Hara".into()),
                    Value::Null,
                    Value::Bytes(vec![1, 255]),
                ],
                vec![
                    Value::Int(2),
                    Value::Text("Bob".into()),
                    Value::Decimal("-3.5".into()),
                    Value::Bytes(vec![0]),
                ],
            ]
        );
    }

    #[test]
    fn sql_import_synthesises_columns_without_a_list() {
        let file = Scratch::new("sql-no-columns");
        std::fs::write(file.0.clone(), "insert into t values (1, 'a'), (2, 'b');").expect("write");

        let parsed =
            parse_file(&file.path(), &importing(TransferFormat::SqlInsert)).expect("parse");
        assert_eq!(parsed.columns, vec!["column_1", "column_2"]);
        assert_eq!(parsed.rows.len(), 2);
        assert_eq!(parsed.rows[0][1], Value::Text("a".into()));
    }

    #[test]
    fn sql_import_reports_unparseable_inserts() {
        let file = Scratch::new("sql-bad");
        std::fs::write(file.0.clone(), "INSERT INTO t (a) VALUES (1").expect("write");

        let err = parse_file(&file.path(), &importing(TransferFormat::SqlInsert))
            .expect_err("an unbalanced INSERT must fail");
        assert_eq!(err.code(), "invalid");
        assert!(
            err.to_string().contains("cannot parse SQL statement"),
            "{err}"
        );
    }

    #[test]
    fn sql_round_trips_through_export_and_import() {
        let file = Scratch::new("sql-round");
        let mut req = request(
            TransferFormat::SqlInsert,
            &file,
            &["id", "name", "ok"],
            vec![
                vec![
                    Value::Int(1),
                    Value::Text("O'Hara".into()),
                    Value::Bool(true),
                ],
                vec![Value::Int(2), Value::Null, Value::Bool(false)],
            ],
        );
        // PostgreSQL spells booleans `TRUE`/`FALSE`, which survives the round
        // trip; SQLite spells them `1`/`0` and they come back as integers.
        req.db_kind = DbKind::Postgres;
        export(&req).expect("export should succeed");

        let parsed =
            parse_file(&file.path(), &importing(TransferFormat::SqlInsert)).expect("parse");
        assert_eq!(parsed.columns, vec!["id", "name", "ok"]);
        assert_eq!(
            parsed.rows,
            vec![
                vec![
                    Value::Int(1),
                    Value::Text("O'Hara".into()),
                    Value::Bool(true)
                ],
                vec![Value::Int(2), Value::Null, Value::Bool(false)],
            ]
        );
    }

    #[test]
    fn export_creates_the_file_it_reports() {
        let file = Scratch::new("summary");
        let req = request(
            TransferFormat::Csv,
            &file,
            &["a"],
            vec![vec![Value::Text("x".into())]],
        );
        let summary = export(&req).expect("export should succeed");
        let on_disk = std::fs::metadata(file.0.clone())
            .expect("the export should exist")
            .len();
        assert_eq!(summary.bytes, on_disk);
    }
}
