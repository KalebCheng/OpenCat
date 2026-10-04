/**
 * Format metadata plus the small path/option helpers the transfer dialogs share.
 *
 * Kept out of the components so the export dialog and the import wizard agree on
 * extensions, delimiters and the shape of a {@link CsvOptions} object.
 */

import { type CsvOptions, type TransferFormat } from "@/lib/types";

export interface FormatInfo {
  value: TransferFormat;
  label: string;
  extension: string;
  /** One line shown under each card in the format chooser. */
  blurb: string;
  /** Filters handed to the Tauri file dialogs. */
  filters: { name: string; extensions: string[] }[];
}

export const FORMATS: FormatInfo[] = [
  {
    value: "csv",
    label: "CSV",
    extension: "csv",
    blurb: "Comma separated text — the safest thing to hand to a spreadsheet.",
    filters: [{ name: "CSV", extensions: ["csv"] }],
  },
  {
    value: "tsv",
    label: "TSV",
    extension: "tsv",
    blurb: "Tab separated; use it when the values themselves contain commas.",
    filters: [{ name: "TSV", extensions: ["tsv", "tab"] }],
  },
  {
    value: "json",
    label: "JSON",
    extension: "json",
    blurb: "An array of row objects, typed wherever JSON can express the type.",
    filters: [{ name: "JSON", extensions: ["json"] }],
  },
  {
    value: "sql_insert",
    label: "SQL INSERT",
    extension: "sql",
    blurb: "Batched INSERT statements that replay the rows into the same table.",
    filters: [{ name: "SQL", extensions: ["sql"] }],
  },
];

/** Metadata for `format`; unknown values fall back to CSV, the safe default. */
export function formatInfo(format: TransferFormat): FormatInfo {
  return FORMATS.find((info) => info.value === format) ?? FORMATS[0];
}

/**
 * RFC 4180 with the one deviation OpenCat needs: an empty field means NULL,
 * which is what round trips losslessly through the backend's `Value::Null`.
 */
export const DEFAULT_CSV: CsvOptions = {
  delimiter: ",",
  quote: '"',
  escape: '"',
  hasHeader: true,
  nullLiteral: "",
  emptyAsNull: true,
  lineEnding: "\n",
  includeBom: false,
};

/** One-click presets for the delimiter pickers. */
export const DELIMITER_PRESETS = [
  { value: ",", label: "Comma  ," },
  { value: ";", label: "Semicolon  ;" },
  { value: "|", label: "Pipe  |" },
  { value: "\t", label: "Tab  \\t" },
];

/** Quote characters worth offering as presets. */
export const QUOTE_PRESETS = [
  { value: '"', label: 'Double quote  "' },
  { value: "'", label: "Single quote  '" },
];

/** Escape characters; matching the quote means the doubled-quote convention. */
export const ESCAPE_PRESETS = [
  { value: '"', label: 'Double quote  "  (doubled)' },
  { value: "'", label: "Single quote  '  (doubled)" },
  { value: "\\", label: "Backslash  \\" },
];

/** The three line endings the Rust exporter recognises exactly. */
export const LINE_ENDINGS = [
  { value: "\n", label: "LF  \\n" },
  { value: "\r\n", label: "CRLF  \\r\\n" },
  { value: "\r", label: "CR  \\r" },
];

/**
 * The delimiter that will actually be written.
 *
 * The Rust side treats a TSV export whose delimiter is still the comma default
 * as "use a tab", so the panel shows the same thing rather than a comma the user
 * never typed.
 */
export function effectiveDelimiter(format: TransferFormat, csv: CsvOptions): string {
  return format === "tsv" && csv.delimiter === "," ? "\t" : csv.delimiter;
}

/**
 * Materialise a complete {@link CsvOptions} object.
 *
 * The Rust struct only defaults the whole `csv` field, not the fields inside it,
 * so a partial object is rejected outright. Sending every field — even for the
 * JSON and SQL writers, which ignore them — also means a default that changes on
 * the Rust side can never silently diverge from what this dialog is showing.
 */
export function materialiseCsv(format: TransferFormat, csv: CsvOptions): CsvOptions {
  return { ...csv, delimiter: effectiveDelimiter(format, csv) };
}

/** Join a directory and a file name, keeping whichever separator the dir uses. */
export function joinPath(dir: string, name: string): string {
  if (!dir) return name;
  const separator = dir.includes("\\") ? "\\" : "/";
  return dir.endsWith("/") || dir.endsWith("\\") ? `${dir}${name}` : `${dir}${separator}${name}`;
}

/** `<table>.<ext>`, or `export.<ext>` for a result set with no table behind it. */
export function suggestedFileName(
  table: string | undefined,
  format: TransferFormat,
): string {
  const stem = (table ?? "export").trim().replace(/[\\/:*?"<>|]+/g, "_") || "export";
  return `${stem}.${formatInfo(format).extension}`;
}

/**
 * Swap the extension when the user switches format.
 *
 * Only a path whose extension is one we recognise is rewritten, so a file the
 * user typed by hand (`.dat`, say) keeps the name they chose.
 */
export function rebaseExtension(path: string, format: TransferFormat): string {
  const info = formatInfo(format);
  if (!path) return path;
  const match = /\.[^./\\]+$/.exec(path);
  if (!match || match.index === undefined) return `${path}.${info.extension}`;
  const current = match[0].toLowerCase();
  const known = FORMATS.some((candidate) => `.${candidate.extension}` === current);
  if (!known && current !== ".tab") return path;
  return `${path.slice(0, match.index)}.${info.extension}`;
}

/** `database.schema.table`, matching how the grid labels a relation. */
export function qualifiedName(
  table: string,
  scope: { database?: string | null; schema?: string | null },
): string {
  const parts = [scope.database, scope.schema, table].filter(
    (part): part is string => Boolean(part),
  );
  return parts.length > 0 ? parts.join(".") : table;
}
