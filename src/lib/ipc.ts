/**
 * The single place that talks to the Rust backend.
 *
 * Every Tauri `invoke` is wrapped here so components never spell command names
 * as strings and never have to remember argument names. Any rejected call is
 * normalized to an {@link ErrorPayload}.
 */

import { invoke } from "@tauri-apps/api/core";

import {
  type AppInfo,
  type AppSettings,
  type ConnectionProfile,
  type CountRequest,
  type DatabaseInfo,
  type DdlPlan,
  type DbKind,
  type ExportRequest,
  type ExportSummary,
  type FindRequest,
  type HistoryEntry,
  type ImportRequest,
  type ImportSummary,
  type ObjectKind,
  type ObjectRef,
  type PageRequest,
  type ParsedData,
  type QueryOptions,
  type QueryResult,
  type RowEdit,
  type RowInsert,
  type SavedQuery,
  type Scope,
  type ScopeSummary,
  type ServerInfo,
  type SessionInfo,
  type TablePage,
  type TablePlan,
  type TableSchema,
  type TransferFormat,
  type Value,
  type ImportOptions,
  toErrorPayload,
} from "./types";

/** Call a command and normalize failures. */
async function call<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw toErrorPayload(error);
  }
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export const app = {
  info: () => call<AppInfo>("app_info"),
  getSettings: () => call<AppSettings>("get_settings"),
  saveSettings: (settings: AppSettings) =>
    call<AppSettings>("save_settings", { settings }),
  revealWorkspace: () => call<void>("reveal_workspace"),
  focusMainWindow: () => call<void>("focus_main_window"),
  copyToClipboard: (text: string) => call<void>("copy_to_clipboard", { text }),
  readClipboard: () => call<string>("read_clipboard"),
  readTextFile: (path: string) => call<string>("read_text_file", { path }),
  writeTextFile: (path: string, contents: string) =>
    call<void>("write_text_file", { path, contents }),
  pathExists: (path: string) => call<boolean>("path_exists", { path }),
};

// ---------------------------------------------------------------------------
// History and snippets
// ---------------------------------------------------------------------------

export const history = {
  list: (limit?: number) => call<HistoryEntry[]>("list_history", { limit: limit ?? null }),
  clear: () => call<void>("clear_history"),
  remove: (id: string) => call<void>("delete_history", { id }),
};

export const snippets = {
  list: () => call<SavedQuery[]>("list_snippets"),
  save: (snippet: SavedQuery) => call<SavedQuery>("save_snippet", { snippet }),
  remove: (id: string) => call<void>("delete_snippet", { id }),
};

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

export const connections = {
  list: () => call<ConnectionProfile[]>("list_connections"),
  save: (profile: ConnectionProfile) =>
    call<ConnectionProfile>("save_connection", { profile }),
  remove: (id: string) => call<boolean>("delete_connection", { id }),
  duplicate: (id: string, name?: string) =>
    call<ConnectionProfile>("duplicate_connection", { id, name: name ?? null }),
  /** Quick handshake only. */
  test: (profile: ConnectionProfile) =>
    call<ServerInfo>("test_connection", { profile }),
  /** Handshake plus a trivial query. */
  validate: (profile: ConnectionProfile) =>
    call<ServerInfo>("validate_connection", { profile }),
  open: (profileId: string, database?: string) =>
    call<SessionInfo>("open_connection", { profileId, database: database ?? null }),
  close: (sessionId: string) => call<boolean>("close_connection", { sessionId }),
  sessions: () => call<SessionInfo[]>("list_sessions"),
  ping: (sessionId: string) => call<number>("ping_session", { sessionId }),
};

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

export const explorer = {
  databases: (sessionId: string) =>
    call<DatabaseInfo[]>("list_databases", { sessionId }),
  schemas: (sessionId: string, database?: string) =>
    call<string[]>("list_schemas", { sessionId, database: database ?? null }),
  objects: (sessionId: string, scope: Scope) =>
    call<ObjectRef[]>("list_objects", { sessionId, scope }),
  routines: (sessionId: string, scope: Scope) =>
    call<ObjectRef[]>("list_routines", { sessionId, scope }),
  summarise: (sessionId: string, scope: Scope) =>
    call<ScopeSummary>("summarise_scope", { sessionId, scope }),
  describe: (sessionId: string, scope: Scope, name: string, kind: ObjectKind) =>
    call<TableSchema>("describe_table", { sessionId, scope, name, kind }),
  ddl: (sessionId: string, scope: Scope, name: string, kind: ObjectKind) =>
    call<string>("table_ddl", { sessionId, scope, name, kind }),
};

// ---------------------------------------------------------------------------
// Query execution
// ---------------------------------------------------------------------------

export const query = {
  execute: (
    sessionId: string,
    sql: string,
    options?: Partial<QueryOptions>,
    database?: string,
    schema?: string,
  ) =>
    call<QueryResult[]>("execute_query", {
      sessionId,
      sql,
      options: options ?? null,
      database: database ?? null,
      schema: schema ?? null,
    }),
  explain: (
    sessionId: string,
    sql: string,
    database?: string,
    schema?: string,
    analyse?: boolean,
  ) =>
    call<QueryResult>("explain_query", {
      sessionId,
      sql,
      database: database ?? null,
      schema: schema ?? null,
      analyse: analyse ?? false,
    }),
  countStatements: (sql: string) => call<number>("count_statements", { sql }),
  classify: (sql: string) => call<string>("classify_sql", { sql }),
};

// ---------------------------------------------------------------------------
// Data grid
// ---------------------------------------------------------------------------

export const data = {
  page: (sessionId: string, request: PageRequest) =>
    call<TablePage>("fetch_page", { sessionId, request }),
  count: (sessionId: string, request: CountRequest) =>
    call<number>("count_rows", { sessionId, request }),
  find: (sessionId: string, request: FindRequest) =>
    call<TablePage>("find_rows", { sessionId, request }),
  update: (sessionId: string, edit: RowEdit) =>
    call<number>("update_row", { sessionId, edit }),
  insert: (sessionId: string, insert: RowInsert) =>
    call<number>("insert_row", { sessionId, insert }),
  remove: (sessionId: string, edit: RowEdit) =>
    call<number>("delete_row", { sessionId, edit }),
  duplicate: (
    sessionId: string,
    scope: Scope,
    table: string,
    keys: Record<string, Value>,
  ) => call<number>("duplicate_row", { sessionId, scope, table, keys }),
  collect: (
    sessionId: string,
    sql: string,
    maxRows?: number,
    database?: string,
    schema?: string,
  ) =>
    call<QueryResult>("collect_rows", {
      sessionId,
      sql,
      maxRows: maxRows ?? null,
      database: database ?? null,
      schema: schema ?? null,
    }),
};

// ---------------------------------------------------------------------------
// Schema editing
// ---------------------------------------------------------------------------

export const schema = {
  previewCreate: (plan: TablePlan, kind: DbKind) =>
    call<DdlPlan>("preview_create_table", { plan, kind }),
  previewAlter: (current: TableSchema, plan: TablePlan, kind: DbKind) =>
    call<DdlPlan>("preview_alter_table", { current, plan, kind }),
  previewDrop: (
    database: string | null | undefined,
    schemaName: string | null | undefined,
    name: string,
    kind: ObjectKind,
    dbKind: DbKind,
  ) =>
    call<string>("preview_drop_object", {
      database: database ?? null,
      schema: schemaName ?? null,
      name,
      kind,
      dbKind,
    }),
  apply: (
    sessionId: string,
    statements: string[],
    database?: string,
    schemaName?: string,
  ) =>
    call<QueryResult[]>("apply_script", {
      sessionId,
      statements,
      database: database ?? null,
      schema: schemaName ?? null,
    }),
  createTable: (sessionId: string, plan: TablePlan) =>
    call<QueryResult[]>("create_table", { sessionId, plan }),
  alterTable: (sessionId: string, current: TableSchema, plan: TablePlan) =>
    call<QueryResult[]>("alter_table", { sessionId, current, plan }),
  rename: (
    sessionId: string,
    scope: Scope,
    from: string,
    to: string,
    kind: ObjectKind,
  ) => call<void>("rename_object", { sessionId, scope, from, to, kind }),
  drop: (sessionId: string, scope: Scope, name: string, kind: ObjectKind) =>
    call<void>("drop_object", { sessionId, scope, name, kind }),
  truncate: (sessionId: string, scope: Scope, name: string) =>
    call<void>("truncate_table", { sessionId, scope, name }),
  createDatabase: (sessionId: string, name: string, charset?: string) =>
    call<void>("create_database", { sessionId, name, charset: charset ?? null }),
  dropDatabase: (sessionId: string, name: string) =>
    call<void>("drop_database", { sessionId, name }),
};

// ---------------------------------------------------------------------------
// Import / export
// ---------------------------------------------------------------------------

export const transfer = {
  exportData: (request: ExportRequest) =>
    call<ExportSummary>("export_data", { request }),
  previewImport: (path: string, options: ImportOptions, limit?: number) =>
    call<ParsedData>("preview_import", { path, options, limit: limit ?? null }),
  importData: (request: ImportRequest) =>
    call<ImportSummary>("import_data", { request }),
  detectFormat: (path: string) =>
    call<TransferFormat>("detect_import_format", { path }),
};

/** Everything, for `import { ipc } from "@/lib/ipc"` style call sites. */
export const ipc = {
  app,
  history,
  snippets,
  connections,
  explorer,
  query,
  data,
  schema,
  transfer,
};

export default ipc;
