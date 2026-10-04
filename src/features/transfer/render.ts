/**
 * Client-side renderers for the export dialog's clipboard action.
 *
 * The file itself is always written by the Rust exporter — this module exists so
 * "Copy to clipboard" hands over exactly the text the format implies without a
 * round trip through the file system. The value rules deliberately mirror
 * `opencat-driver`'s `json_from_value` / `common::literal` so a paste looks like
 * the file would have.
 */

import {
  type CsvOptions,
  type DbKind,
  type TransferFormat,
  type Value,
  valueText,
} from "@/lib/types";
import { effectiveDelimiter } from "./formats";

export interface RenderRequest {
  format: TransferFormat;
  columns: string[];
  rows: Value[][];
  csv: CsvOptions;
  /** JSON only: indent the output instead of one compact line. */
  pretty: boolean;
  table?: string | null;
  database?: string | null;
  schema?: string | null;
  dbKind: DbKind;
  /** Rows per INSERT; only the SQL renderer reads it. */
  batchSize: number;
}

/** Render `request` as the text its format implies. */
export function renderExport(request: RenderRequest): string {
  switch (request.format) {
    case "csv":
    case "tsv":
      return renderDelimited(request);
    case "json":
      return renderJson(request.columns, request.rows, request.pretty);
    case "sql_insert":
      return renderInserts(request);
  }
}

// ---------------------------------------------------------------------------
// Delimited text
// ---------------------------------------------------------------------------

/**
 * Render CSV/TSV.
 *
 * Quoting only kicks in when a field actually needs it — a delimiter, a quote or
 * a line break — which is what the `csv` crate does on the Rust side.
 */
export function renderDelimited({
  format,
  columns,
  rows,
  csv,
}: RenderRequest): string {
  const delimiter = effectiveDelimiter(format, csv);
  const lines: string[] = [];
  if (csv.hasHeader) {
    lines.push(columns.map((name) => quoteField(name, delimiter, csv)).join(delimiter));
  }
  for (const row of rows) {
    const fields = row.map((value) => {
      const text = value.t === "null" ? csv.nullLiteral : valueText(value);
      return quoteField(text, delimiter, csv);
    });
    lines.push(fields.join(delimiter));
  }
  return `${csv.includeBom ? "\u{feff}" : ""}${lines.join(csv.lineEnding)}${csv.lineEnding}`;
}

function quoteField(text: string, delimiter: string, csv: CsvOptions): string {
  const needsQuote =
    text.includes(delimiter) ||
    text.includes(csv.quote) ||
    text.includes("\n") ||
    text.includes("\r");
  if (!needsQuote) return text;
  // Doubling the quote is the RFC 4180 convention; a distinct escape character
  // instead prefixes the quote, which is what `csv::WriterBuilder` does with
  // `double_quote(false)`.
  const escaped =
    csv.escape === csv.quote
      ? text.split(csv.quote).join(csv.quote + csv.quote)
      : text.split(csv.quote).join(csv.escape + csv.quote);
  return `${csv.quote}${escaped}${csv.quote}`;
}

// ---------------------------------------------------------------------------
// JSON
// ---------------------------------------------------------------------------

/**
 * JSON projection of a value.
 *
 * Numbers and booleans keep their JSON type so a downstream tool can sort them;
 * decimals, dates, times and byte strings (already base64 in the wire format)
 * become strings, and a non-finite float becomes `null` because JSON has no
 * spelling for it.
 */
function jsonValue(value: Value): unknown {
  switch (value.t) {
    case "null":
      return null;
    case "bool":
    case "int":
    case "uint":
      return value.v;
    case "float":
      return Number.isFinite(value.v) ? value.v : null;
    case "decimal":
      return isNumeric(value.v) ? Number(value.v) : value.v;
    case "json":
      try {
        return JSON.parse(value.v) as unknown;
      } catch {
        return value.v;
      }
    default:
      // text, bytes (base64), date, time and datetime are all strings.
      return value.v;
  }
}

/** Wrap the rows as an array of objects, keeping the result-set column order. */
export function renderJson(columns: string[], rows: Value[][], pretty: boolean): string {
  const objects = rows.map((row) => {
    const object: Record<string, unknown> = {};
    row.forEach((value, index) => {
      object[columns[index] ?? `column_${index + 1}`] = jsonValue(value);
    });
    return object;
  });
  return JSON.stringify(objects, null, pretty ? 2 : 0) ?? "[]";
}

// ---------------------------------------------------------------------------
// SQL
// ---------------------------------------------------------------------------

/** Render batched `INSERT` statements, wrapped in a transaction when needed. */
function renderInserts(request: RenderRequest): string {
  const { columns, rows, dbKind } = request;
  const table = (request.table ?? "").trim();
  if (!table || rows.length === 0) return "";

  const target = qualify(request.database, request.schema, table, dbKind);
  const columnList = columns.map((name) => quoteIdent(name, dbKind)).join(", ");
  const batch = Math.max(1, Math.floor(request.batchSize));
  const statements: string[] = [];

  for (let start = 0; start < rows.length; start += batch) {
    const tuples = rows
      .slice(start, start + batch)
      .map((row) => `(${columns.map((_, index) => literal(row[index], dbKind)).join(", ")})`);
    statements.push(`INSERT INTO ${target} (${columnList}) VALUES ${tuples.join(", ")}`);
  }

  // Several statements are wrapped so a partial failure rolls back, exactly like
  // the Rust exporter does.
  if (statements.length === 1) return `${statements[0]};\n`;
  return `BEGIN;\n${statements.map((statement) => `${statement};\n`).join("")}COMMIT;\n`;
}

/** Mirror of `common::literal`: NULL, typed numbers, quoted text. */
function literal(value: Value | undefined, kind: DbKind): string {
  if (!value) return "NULL";
  switch (value.t) {
    case "null":
      return "NULL";
    case "bool":
      if (kind === "postgres") return value.v ? "TRUE" : "FALSE";
      return value.v ? "1" : "0";
    case "int":
    case "uint":
      return String(value.v);
    case "float":
      return Number.isFinite(value.v) ? valueText(value) : "NULL";
    case "decimal":
      return isNumeric(value.v) ? value.v : escapeLiteral(value.v, kind);
    case "bytes": {
      const hex = base64ToHex(value.v);
      return kind === "postgres" ? `'\\x${hex}'::bytea` : `X'${hex}'`;
    }
    case "json":
      return kind === "postgres"
        ? `${escapeLiteral(value.v, kind)}::jsonb`
        : escapeLiteral(value.v, kind);
    default:
      // text, date, time, datetime
      return escapeLiteral(value.v, kind);
  }
}

function escapeLiteral(text: string, kind: DbKind): string {
  const doubled = text.replace(/'/g, "''");
  return kind === "mysql"
    ? `'${doubled.replace(/\\/g, "\\\\")}'`
    : `'${doubled}'`;
}

function quoteIdent(name: string, kind: DbKind): string {
  const quote = kind === "mysql" ? "`" : '"';
  return `${quote}${name.split(quote).join(quote + quote)}${quote}`;
}

/** `database.schema.table`, the same shape `common::relation` produces. */
function qualify(
  database: string | null | undefined,
  schema: string | null | undefined,
  table: string,
  kind: DbKind,
): string {
  const parts = [database, kind === "mysql" ? null : schema, table].filter(
    (part): part is string => Boolean(part),
  );
  return parts.map((part) => quoteIdent(part, kind)).join(".");
}

function isNumeric(text: string): boolean {
  return (
    text.length > 0 &&
    /^[-+.0-9eE]+$/.test(text) &&
    /[0-9]/.test(text) &&
    Number.isFinite(Number(text))
  );
}

/** Base64 → lowercase hex, tolerating a value the browser cannot decode. */
function base64ToHex(base64: string): string {
  try {
    const binary = atob(base64);
    let hex = "";
    for (let index = 0; index < binary.length; index += 1) {
      hex += binary.charCodeAt(index).toString(16).padStart(2, "0");
    }
    return hex;
  } catch {
    return "";
  }
}
