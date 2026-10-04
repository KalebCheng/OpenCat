/**
 * TypeScript mirrors of the Rust domain model.
 *
 * Every type here corresponds to a struct in `crates/opencat-core/src/model.rs`
 * or `crates/opencat-driver/src/*.rs`, serialized with `#[serde(rename_all =
 * "camelCase")]`. Keep the two sides in lockstep: if you change a Rust field,
 * change it here in the same commit.
 */

// ---------------------------------------------------------------------------
// Engines
// ---------------------------------------------------------------------------

export type DbKind = "sqlite" | "mysql" | "postgres";

export type SslMode = "disable" | "prefer" | "require" | "verifyca" | "verifyfull";

export type Theme = "system" | "light" | "dark";

export interface EngineInfo {
  kind: DbKind;
  name: string;
  defaultPort: number | null;
  fileBased: boolean;
}

export interface AppInfo {
  name: string;
  version: string;
  workspaceDir: string;
  platform: string;
  arch: string;
  engines: EngineInfo[];
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export interface ErrorPayload {
  code: string;
  message: string;
  detail?: string | null;
}

/** Narrow an unknown catch value into an {@link ErrorPayload}. */
export function toErrorPayload(error: unknown): ErrorPayload {
  if (error && typeof error === "object" && "message" in error && "code" in error) {
    return error as ErrorPayload;
  }
  if (error instanceof Error) {
    return { code: "other", message: error.message };
  }
  return { code: "other", message: String(error) };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export interface SshTunnel {
  enabled: boolean;
  host: string;
  port: number;
  username: string;
  password: string;
  privateKeyPath?: string | null;
  passphrase?: string | null;
}

export interface ConnectionProfile {
  id: string;
  name: string;
  kind: DbKind;
  group?: string | null;
  color?: string | null;
  host: string;
  port: number;
  username: string;
  password: string;
  database?: string | null;
  file?: string | null;
  sslMode: SslMode;
  params: Record<string, string>;
  ssh: SshTunnel;
  readOnly: boolean;
  pageSize: number;
  maxRows: number;
  connectTimeoutSecs: number;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ServerInfo {
  version: string;
  edition?: string | null;
  currentUser?: string | null;
  currentDatabase?: string | null;
  serverEncoding?: string | null;
  timezone?: string | null;
  maxConnections?: number | null;
  uptimeSecs?: number | null;
}

export interface SessionInfo {
  sessionId: string;
  profileId: string;
  profileName: string;
  kind: DbKind;
  server: ServerInfo;
  openedAt: string;
  tunnelled: boolean;
}

export interface DatabaseInfo {
  name: string;
  isSystem: boolean;
  sizeBytes?: number | null;
  comment?: string | null;
  charset?: string | null;
}

// ---------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------

export type ObjectKind =
  | "server"
  | "database"
  | "schema"
  | "table"
  | "view"
  | "materialized_view"
  | "column"
  | "index"
  | "foreign_key"
  | "trigger"
  | "function"
  | "procedure"
  | "sequence"
  | "folder";

export interface ObjectRef {
  kind: ObjectKind;
  name: string;
  database?: string | null;
  schema?: string | null;
  comment?: string | null;
  rowCount?: number | null;
  sizeBytes?: number | null;
  extra: Record<string, string>;
}

export interface Scope {
  database?: string | null;
  schema?: string | null;
}

export interface ScopeSummary {
  tables: number;
  views: number;
  routines: number;
}

export type LogicalType =
  | "boolean"
  | "integer"
  | "float"
  | "decimal"
  | "string"
  | "text"
  | "binary"
  | "date"
  | "time"
  | "date_time"
  | "timestamp"
  | "json"
  | "uuid"
  | "enum"
  | "array"
  | "geometry"
  | "unknown";

export interface ColumnSchema {
  name: string;
  dataType: string;
  logicalType: LogicalType;
  nullable: boolean;
  defaultValue?: string | null;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  isUnique: boolean;
  comment?: string | null;
  ordinal: number;
  charMaxLength?: number | null;
  numericPrecision?: number | null;
  numericScale?: number | null;
  extra?: string | null;
  enumValues: string[];
}

export interface IndexSchema {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  indexType?: string | null;
  comment?: string | null;
}

export interface ForeignKeySchema {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  refSchema?: string | null;
  onUpdate?: string | null;
  onDelete?: string | null;
}

export interface TriggerSchema {
  name: string;
  timing?: string | null;
  event?: string | null;
  statement?: string | null;
}

export interface TableSchema {
  name: string;
  kind: ObjectKind;
  database?: string | null;
  schema?: string | null;
  columns: ColumnSchema[];
  indexes: IndexSchema[];
  foreignKeys: ForeignKeySchema[];
  triggers: TriggerSchema[];
  comment?: string | null;
  rowCount?: number | null;
  ddl?: string | null;
  options: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

export type ValueTag =
  | "null"
  | "bool"
  | "int"
  | "uint"
  | "float"
  | "decimal"
  | "text"
  | "json"
  | "bytes"
  | "date"
  | "time"
  | "datetime";

/**
 * A database cell. The Rust side tags every value with its type so the grid can
 * right-align numbers, render NULL subtly, and round-trip edits faithfully.
 */
export type Value =
  | { t: "null" }
  | { t: "bool"; v: boolean }
  | { t: "int"; v: number }
  | { t: "uint"; v: number }
  | { t: "float"; v: number }
  | { t: "decimal"; v: string }
  | { t: "text"; v: string }
  | { t: "json"; v: string }
  | { t: "bytes"; v: string; len?: number }
  | { t: "date"; v: string }
  | { t: "time"; v: string }
  | { t: "datetime"; v: string };

export const NULL_VALUE: Value = { t: "null" };

/** Human-readable form used by the data grid and by clipboard copies. */
export function valueText(value: Value | undefined | null): string {
  if (!value) return "";
  switch (value.t) {
    case "null":
      return "";
    case "bool":
      return value.v ? "true" : "false";
    case "int":
    case "uint":
      return String(value.v);
    case "float":
      return formatFloat(value.v);
    case "decimal":
    case "text":
    case "json":
    case "date":
    case "time":
    case "datetime":
      return value.v;
    case "bytes":
      return `<${value.len ?? Math.floor((value.v.length * 3) / 4)} bytes>`;
  }
}

/** Match the Rust `format_float` behaviour for display. */
export function formatFloat(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  if (Number.isInteger(n) && Math.abs(n) < 1e15) return String(n);
  return String(n);
}

/** Build a text value, which is what most editors produce. */
export function makeValue(text: string, hint: LogicalType = "text"): Value {
  switch (hint) {
    case "integer":
      return /^-?\d+$/.test(text) ? { t: "int", v: Number(text) } : { t: "text", v: text };
    case "float":
    case "decimal":
      return /^-?\d*\.?\d+(e[-+]?\d+)?$/i.test(text)
        ? hint === "decimal"
          ? { t: "decimal", v: text }
          : { t: "float", v: Number(text) }
        : { t: "text", v: text };
    case "boolean":
      return { t: "bool", v: /^(1|true|t|yes|y|on)$/i.test(text) };
    case "date":
      return { t: "date", v: text };
    case "time":
      return { t: "time", v: text };
    case "date_time":
    case "timestamp":
      return { t: "datetime", v: text };
    case "json":
      return { t: "json", v: text };
    default:
      return { t: "text", v: text };
  }
}

export function isNull(value: Value | undefined | null): boolean {
  return !value || value.t === "null";
}

// ---------------------------------------------------------------------------
// Results and pages
// ---------------------------------------------------------------------------

export interface ColumnMeta {
  name: string;
  typeName: string;
  logicalType: LogicalType;
  nullable: boolean;
  table?: string | null;
  isPrimaryKey: boolean;
  hidden: boolean;
  /** Mirrored from the table schema when the column came from a known table. */
  isAutoIncrement: boolean;
  defaultValue?: string | null;
  charMaxLength?: number | null;
  comment?: string | null;
}

export type StatementKind = "select" | "insert" | "update" | "delete" | "ddl" | "other";

export interface QueryResult {
  columns: ColumnMeta[];
  rows: Value[][];
  rowsAffected: number;
  lastInsertId?: number | null;
  elapsedMs: number;
  notices: string[];
  statementKind: StatementKind;
  statement: string;
  truncated: boolean;
}

export interface TablePage {
  columns: ColumnMeta[];
  rows: Value[][];
  offset: number;
  limit: number;
  totalRows?: number | null;
  keyColumns: string[];
  editable: boolean;
  reason?: string | null;
  sql: string;
  elapsedMs: number;
}

export interface OrderBy {
  column: string;
  desc: boolean;
}

export interface PageRequest {
  scope: Scope;
  table: string;
  offset: number;
  limit: number;
  orderBy?: OrderBy[];
  filter?: string | null;
  includeTotal?: boolean;
}

export interface CountRequest {
  scope: Scope;
  table: string;
  filter?: string | null;
  approximate?: boolean;
}

export interface FindRequest {
  scope: Scope;
  table: string;
  columns?: string[];
  needle: string;
  limit?: number;
}

export interface CellChange {
  column: string;
  oldValue: Value;
  newValue: Value;
}

export interface RowEdit {
  database?: string | null;
  schema?: string | null;
  table: string;
  keys: Record<string, Value>;
  changes: CellChange[];
}

export interface RowInsert {
  database?: string | null;
  schema?: string | null;
  table: string;
  values: Record<string, Value>;
}

export interface QueryOptions {
  maxRows: number;
  timeoutSecs: number;
  readOnly: boolean;
  recordHistory: boolean;
}

// ---------------------------------------------------------------------------
// Schema design
// ---------------------------------------------------------------------------

export interface ColumnPlan {
  name: string;
  dataType: string;
  nullable: boolean;
  defaultValue?: string | null;
  isPrimaryKey: boolean;
  isAutoIncrement: boolean;
  isUnique: boolean;
  comment?: string | null;
  originalName?: string | null;
  dropped: boolean;
  enumValues: string[];
}

export interface IndexPlan {
  name: string;
  columns: string[];
  isUnique: boolean;
  isPrimary: boolean;
  isNew: boolean;
  dropped: boolean;
}

export interface ForeignKeyPlan {
  name: string;
  columns: string[];
  refTable: string;
  refColumns: string[];
  refSchema?: string | null;
  onUpdate?: string | null;
  onDelete?: string | null;
  dropped: boolean;
}

export interface TablePlan {
  database?: string | null;
  schema?: string | null;
  name: string;
  originalName?: string | null;
  kind: ObjectKind;
  columns: ColumnPlan[];
  indexes: IndexPlan[];
  foreignKeys: ForeignKeyPlan[];
  options: Record<string, string>;
  isNew: boolean;
}

export interface DdlPlan {
  statements: string[];
  warnings: string[];
  destructive: boolean;
}

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

export type TransferFormat = "csv" | "tsv" | "json" | "sql_insert";

export interface CsvOptions {
  delimiter: string;
  quote: string;
  escape: string;
  hasHeader: boolean;
  nullLiteral: string;
  emptyAsNull: boolean;
  lineEnding: string;
  includeBom: boolean;
}

export interface ExportRequest {
  format: TransferFormat;
  path: string;
  columns: string[];
  rows: Value[][];
  table?: string | null;
  database?: string | null;
  schema?: string | null;
  dbKind: DbKind;
  csv: CsvOptions;
  createTable?: string | null;
  batchSize: number;
}

export interface ExportSummary {
  path: string;
  rows: number;
  bytes: number;
  elapsedMs: number;
}

export interface ImportOptions {
  format?: TransferFormat | null;
  hasHeader: boolean;
  delimiter: string;
  quote: string;
  nullLiteral: string;
  emptyAsNull: boolean;
  skipRows: number;
  maxRows: number;
}

export interface ParsedData {
  columns: string[];
  rows: Value[][];
  format: TransferFormat;
  totalRows: number;
}

export type ImportMode = "append" | "truncate_first";

export interface ImportRequest {
  sessionId: string;
  database?: string | null;
  schema?: string | null;
  table: string;
  path: string;
  options: ImportOptions;
  mode: ImportMode;
  /**
   * Target column for each file column, in file order. A `null` entry skips
   * that file column; the array must line up with the file exactly.
   */
  targetColumns?: (string | null)[] | null;
  batchSize: number;
  offset: number;
}

export interface ImportSummary {
  rowsRead: number;
  rowsWritten: number;
  statements: number;
  elapsedMs: number;
  warnings: string[];
  mode: ImportMode;
  table: string;
}

export interface UiPreferences {
  /** Column widths keyed by `table.column`. */
  gridColumnWidths: Record<string, number>;
  sidebarWidth: number;
  detailPanelHeight: number;
  showSystemDatabases: boolean;
}

// ---------------------------------------------------------------------------
// Settings, history, snippets
// ---------------------------------------------------------------------------

export interface AppSettings {
  theme: Theme;
  accent: string;
  uiFontFamily: string;
  uiFontSize: number;
  editorFontFamily: string;
  editorFontSize: number;
  editorTabSize: number;
  editorWordWrap: boolean;
  editorLineNumbers: boolean;
  truncateCellChars: number;
  defaultPageSize: number;
  maxRows: number;
  autoCommit: boolean;
  confirmDestructive: boolean;
  showSystemDatabases: boolean;
  historyLimit: number;
  saveQueryHistory: boolean;
  nullDisplay: string;
  dateFormat: string;
  exportDefaultDir?: string | null;
  locale: string;
}

export interface HistoryEntry {
  id: string;
  profileId: string;
  profileName: string;
  database?: string | null;
  sql: string;
  startedAt: string;
  elapsedMs: number;
  rowCount: number;
  success: boolean;
  error?: string | null;
  background: boolean;
}

export interface SavedQuery {
  id: string;
  name: string;
  profileId?: string | null;
  database?: string | null;
  sql: string;
  tags: string[];
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// Model helpers
// ---------------------------------------------------------------------------

/** Default settings mirroring `AppSettings::default()` in Rust. */
export function defaultSettings(): AppSettings {
  return {
    theme: "system",
    accent: "violet",
    uiFontFamily: "",
    uiFontSize: 13,
    editorFontFamily: "JetBrains Mono, Cascadia Code, Consolas, monospace",
    editorFontSize: 13,
    editorTabSize: 2,
    editorWordWrap: false,
    editorLineNumbers: true,
    truncateCellChars: 0,
    defaultPageSize: 500,
    maxRows: 50_000,
    autoCommit: true,
    confirmDestructive: true,
    showSystemDatabases: true,
    historyLimit: 2_000,
    saveQueryHistory: true,
    nullDisplay: "(NULL)",
    dateFormat: "%Y-%m-%d %H:%M:%S",
    exportDefaultDir: null,
    locale: "zh-CN",
  };
}

/** A blank profile with per-engine defaults, mirroring `ConnectionProfile::new`. */
export function blankProfile(kind: DbKind): ConnectionProfile {
  const defaultPort = kind === "mysql" ? 3306 : kind === "postgres" ? 5432 : 0;
  return {
    id: crypto.randomUUID(),
    name: "",
    kind,
    group: null,
    color: null,
    host: "127.0.0.1",
    port: defaultPort,
    username: kind === "postgres" ? "postgres" : kind === "mysql" ? "root" : "",
    password: "",
    database: null,
    file: null,
    sslMode: "prefer",
    params: {},
    ssh: {
      enabled: false,
      host: "",
      port: 22,
      username: "",
      password: "",
      privateKeyPath: null,
      passphrase: null,
    },
    readOnly: false,
    pageSize: 500,
    maxRows: 50_000,
    connectTimeoutSecs: 15,
    createdAt: null,
    updatedAt: null,
  };
}

/** The sentinel the backend substitutes for a stored secret. */
export const SECRET_MASK = "\u2022\u2022\u2022\u2022\u2022\u2022";

/** True when a table/view node can be opened in the data grid. */
export function isRelation(kind: ObjectKind): boolean {
  return kind === "table" || kind === "view" || kind === "materialized_view";
}

/** Human label for an object kind, used by the tree and breadcrumbs. */
export function objectKindLabel(kind: ObjectKind): string {
  const labels: Record<ObjectKind, string> = {
    server: "Server",
    database: "Database",
    schema: "Schema",
    table: "Table",
    view: "View",
    materialized_view: "Materialized view",
    column: "Column",
    index: "Index",
    foreign_key: "Foreign key",
    trigger: "Trigger",
    function: "Function",
    procedure: "Procedure",
    sequence: "Sequence",
    folder: "Folder",
  };
  return labels[kind] ?? kind;
}

/**
 * Engine-specific reserved schema names.
 *
 * Mirrors `opencat_core::is_system_schema` so the tree greys out exactly the
 * objects the backend considers internal.
 */
export function isSystemSchema(kind: DbKind, name: string): boolean {
  const lower = name.toLowerCase();
  switch (kind) {
    case "sqlite":
      return lower.startsWith("sqlite_");
    case "mysql":
      return ["information_schema", "performance_schema", "mysql", "sys"].includes(lower);
    case "postgres":
      return (
        ["pg_catalog", "information_schema", "pg_toast"].includes(lower) ||
        lower.startsWith("pg_temp") ||
        lower.startsWith("pg_toast_temp")
      );
  }
}

/** The default TCP port for an engine, or `null` for file-based ones. */
export function defaultPort(kind: DbKind): number | null {
  return kind === "mysql" ? 3306 : kind === "postgres" ? 5432 : null;
}
