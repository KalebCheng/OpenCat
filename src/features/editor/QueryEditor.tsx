/**
 * The SQL editor tab: a CodeMirror document, a result area and a message log.
 *
 * Execution always goes through `ipc.query.execute`, which runs the whole script
 * and returns one `QueryResult` per statement, so a multi-statement script shows
 * up as multiple result tabs rather than a single blob.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { open as openFileDialog, save as saveFileDialog } from "@tauri-apps/plugin-dialog";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  Download,
  Eraser,
  FileDown,
  FileUp,
  Info,
  Play,
  Save,
  Square,
  Terminal,
  Wand2,
} from "lucide-react";
import { toast } from "sonner";

import { Badge, Button, IconButton, NativeSelect, Spinner, Toolbar } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlays";
import ipc from "@/lib/ipc";
import type { DbKind, QueryResult, Scope } from "@/lib/types";
import { toErrorPayload } from "@/lib/types";
import { cn, formatCount, formatDuration } from "@/lib/utils";
import { ResizableHandle } from "@/components/ResizableHandle";
import { databaseKey, objectKey, useExplorer } from "@/store/explorer";
import { useSettings } from "@/store/settings";
import { useTabs } from "@/store/tabs";
import type { ExportTarget } from "@/App";
import { ResultGrid } from "./ResultGrid";
import { SqlCodeMirror } from "./SqlCodeMirror";

export interface QueryEditorProps {
  tabId: string;
  sessionId: string;
  scope: Scope;
  dbKind: DbKind;
  initialSql?: string;
  filePath?: string;
  onExport: (target: ExportTarget) => void;
}

/** One executed script's worth of output. */
interface RunOutcome {
  results: QueryResult[];
  error: string | null;
  totalMs: number;
  startedAt: number;
  sql: string;
}

export function QueryEditor({
  tabId,
  sessionId,
  scope,
  dbKind,
  initialSql = "",
  filePath,
  onExport,
}: QueryEditorProps) {
  const settings = useSettings((state) => state.settings);
  const updateTab = useTabs((state) => state.update);

  const [sql, setSql] = useState(initialSql);
  const [outcome, setOutcome] = useState<RunOutcome | null>(null);
  const [running, setRunning] = useState(false);
  const [activeResult, setActiveResult] = useState(0);
  const [showMessages, setShowMessages] = useState(false);
  const [database, setDatabase] = useState<string | null>(scope.database ?? null);
  const [schema, setSchema] = useState<string | null>(scope.schema ?? null);
  const [resultHeight, setResultHeight] = useState(300);
  const [savedPath, setSavedPath] = useState<string | undefined>(filePath);

  // -- autocomplete vocabulary ---------------------------------------------
  const objects = useExplorer((state) => state.nodes[objectKey(sessionId, scope)]?.objects);
  const [schemaTables, setSchemaTables] = useState<string[]>([]);

  useEffect(() => {
    if (objects && objects.length > 0) {
      setSchemaTables(
        objects
          .filter((object) => object.kind === "table" || object.kind === "view")
          .map((object) => object.name),
      );
      return;
    }
    void useExplorer
      .getState()
      .objects(sessionId, scope)
      .then((list) =>
        setSchemaTables(
          list
            .filter((object) => object.kind === "table" || object.kind === "view")
            .map((object) => object.name),
        ),
      )
      .catch(() => setSchemaTables([]));
  }, [objects, sessionId, scope]);

  // -- database picker ------------------------------------------------------
  const databases = useExplorer((state) => state.nodes[databaseKey(sessionId)]?.databases);
  useEffect(() => {
    if (!databases) {
      void useExplorer.getState().databases(sessionId).catch(() => undefined);
    }
  }, [databases, sessionId]);

  const schemas = useExplorer((state) =>
    database ? state.nodes[`${sessionId}/${database}/schemas`]?.schemas : undefined,
  );
  useEffect(() => {
    if (dbKind === "postgres" && database && !schemas) {
      void useExplorer.getState().schemas(sessionId, database).catch(() => undefined);
    }
  }, [dbKind, database, schemas, sessionId]);

  // -- keep the tab's title and dirty flag in sync --------------------------
  useEffect(() => {
    const firstLine = sql.trim().split("\n")[0]?.slice(0, 40) ?? "";
    updateTab(tabId, {
      sql,
      title: firstLine || "Query",
      dirty: sql.trim().length > 0 && sql !== initialSql,
    });
    // `initialSql` is intentionally excluded: it is only the starting document.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sql, tabId, updateTab]);

  // -- execution ------------------------------------------------------------
  const run = useCallback(
    async (overrideSql?: string) => {
      const script = (overrideSql ?? sql).trim();
      if (!script) {
        toast.info("Nothing to run");
        return;
      }

      setRunning(true);
      setShowMessages(false);
      const startedAt = Date.now();
      try {
        const results = await ipc.query.execute(
          sessionId,
          script,
          {
            maxRows: settings.maxRows,
            timeoutSecs: 120,
            readOnly: false,
            recordHistory: settings.saveQueryHistory,
          },
          database ?? undefined,
          schema ?? undefined,
        );
        setOutcome({
          results,
          error: null,
          totalMs: Date.now() - startedAt,
          startedAt,
          sql: script,
        });
        setActiveResult(0);

        const totalRows = results.reduce((sum, r) => sum + r.rows.length, 0);
        const affected = results.reduce((sum, r) => sum + r.rowsAffected, 0);
        if (totalRows > 0) {
          toast.success(`${formatCount(totalRows)} rows in ${formatDuration(Date.now() - startedAt)}`);
        } else if (affected > 0) {
          toast.success(`${formatCount(affected)} rows affected`);
        } else {
          toast.success(`Done in ${formatDuration(Date.now() - startedAt)}`);
        }
      } catch (error) {
        const payload = toErrorPayload(error);
        setOutcome({
          results: [],
          error: payload.message,
          totalMs: Date.now() - startedAt,
          startedAt,
          sql: script,
        });
        setShowMessages(true);
        toast.error(payload.message);
      } finally {
        setRunning(false);
      }
    },
    [sql, sessionId, settings.maxRows, settings.saveQueryHistory, database, schema],
  );

  const explain = useCallback(async () => {
    if (!sql.trim()) return;
    setRunning(true);
    const startedAt = Date.now();
    try {
      const result = await ipc.query.explain(
        sessionId,
        sql,
        database ?? undefined,
        schema ?? undefined,
        false,
      );
      setOutcome({
        results: [result],
        error: null,
        totalMs: Date.now() - startedAt,
        startedAt,
        sql,
      });
      setActiveResult(0);
    } catch (error) {
      const payload = toErrorPayload(error);
      setOutcome({
        results: [],
        error: payload.message,
        totalMs: Date.now() - startedAt,
        startedAt,
        sql,
      });
      setShowMessages(true);
      toast.error(payload.message);
    } finally {
      setRunning(false);
    }
  }, [sql, sessionId, database, schema]);

  // -- file handling --------------------------------------------------------
  const openFile = useCallback(async () => {
    const picked = await openFileDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "SQL script", extensions: ["sql", "txt"] }],
    });
    if (typeof picked !== "string") return;
    try {
      const contents = await ipc.app.readTextFile(picked);
      setSql(contents);
      setSavedPath(picked);
      updateTab(tabId, { filePath: picked });
      toast.success(`Opened ${picked.split(/[\\/]/).pop()}`);
    } catch (error) {
      toast.error(toErrorPayload(error).message);
    }
  }, [tabId, updateTab]);

  const saveFile = useCallback(
    async (saveAs = false) => {
      let target = savedPath;
      if (!target || saveAs) {
        const picked = await saveFileDialog({
          defaultPath: target ?? "query.sql",
          filters: [{ name: "SQL script", extensions: ["sql"] }],
        });
        if (typeof picked !== "string") return;
        target = picked;
      }
      try {
        await ipc.app.writeTextFile(target, sql);
        setSavedPath(target);
        updateTab(tabId, { filePath: target, dirty: false });
        toast.success("Saved");
      } catch (error) {
        toast.error(toErrorPayload(error).message);
      }
    },
    [savedPath, sql, tabId, updateTab],
  );

  const currentResult = outcome?.results[activeResult];
  const hasError = !!outcome?.error;

  const status = useMemo(() => {
    if (running) return { tone: "accent" as const, label: "Running…", icon: Spinner };
    if (hasError) return { tone: "danger" as const, label: "Failed", icon: AlertCircle };
    if (outcome) return { tone: "success" as const, label: "Succeeded", icon: CheckCircle2 };
    return { tone: "neutral" as const, label: "Ready", icon: Info };
  }, [running, hasError, outcome]);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <Toolbar className="gap-1.5">
        <Button
          variant="primary"
          size="sm"
          onClick={() => void run()}
          disabled={running}
          title="Run (Ctrl+Enter)"
        >
          {running ? <Spinner className="size-3.5" /> : <Play className="size-3.5" />}
          Run
        </Button>
        <Tooltip content="Run only the selected text" shortcut="Ctrl+Shift+Enter">
          <Button
            size="sm"
            onClick={() => {
              const selection = window.getSelection()?.toString().trim();
              void run(selection || undefined);
            }}
            disabled={running}
          >
            <Wand2 className="size-3.5" />
            Selection
          </Button>
        </Tooltip>
        <Tooltip content="Abandon the client-side wait (the server keeps running)">
          <Button size="sm" onClick={() => setRunning(false)} disabled={!running}>
            <Square className="size-3" />
            Stop
          </Button>
        </Tooltip>

        <span className="mx-1 h-4 w-px bg-border" />

        <Button size="sm" onClick={explain} disabled={running}>
          <Terminal className="size-3.5" />
          Explain
        </Button>

        <span className="mx-1 h-4 w-px bg-border" />

        <Tooltip content="Open a .sql file">
          <IconButton label="Open file" onClick={() => void openFile()}>
            <FileUp className="size-3.5" />
          </IconButton>
        </Tooltip>
        <Tooltip content="Save to disk">
          <IconButton label="Save file" onClick={() => void saveFile(false)}>
            <Save className="size-3.5" />
          </IconButton>
        </Tooltip>
        <Tooltip content="Save as…">
          <IconButton label="Save as" onClick={() => void saveFile(true)}>
            <FileDown className="size-3.5" />
          </IconButton>
        </Tooltip>

        <span className="mx-1 h-4 w-px bg-border" />

        <Tooltip content="Clear the editor and results">
          <IconButton
            label="Clear"
            onClick={() => {
              setSql("");
              setOutcome(null);
            }}
          >
            <Eraser className="size-3.5" />
          </IconButton>
        </Tooltip>

        <div className="flex-1" />

        {dbKind !== "sqlite" ? (
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide text-subtle">db</span>
            <NativeSelect
              value={database ?? ""}
              onChange={(event) => setDatabase(event.target.value || null)}
              className="h-6 w-40 text-[11px]"
            >
              <option value="">(default)</option>
              {(databases ?? []).map((db) => (
                <option key={db.name} value={db.name}>
                  {db.name}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}

        {dbKind === "postgres" ? (
          <div className="flex items-center gap-1">
            <span className="text-[10px] uppercase tracking-wide text-subtle">schema</span>
            <NativeSelect
              value={schema ?? ""}
              onChange={(event) => setSchema(event.target.value || null)}
              className="h-6 w-36 text-[11px]"
            >
              <option value="">(default)</option>
              {(schemas ?? []).map((name) => (
                <option key={name} value={name}>
                  {name}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : null}

        {currentResult && currentResult.columns.length > 0 ? (
          <Tooltip content="Export this result set">
            <Button
              size="sm"
              onClick={() =>
                onExport({
                  sessionId,
                  scope: { database, schema },
                  dbKind,
                  sql: outcome?.sql,
                  columns: currentResult.columns.map((column) => column.name),
                })
              }
            >
              <Download className="size-3.5" />
              Export
            </Button>
          </Tooltip>
        ) : null}
      </Toolbar>

      {/* editor */}
      <div className="min-h-0 flex-1 overflow-hidden bg-surface">
        <SqlCodeMirror
          value={sql}
          onChange={setSql}
          dbKind={dbKind}
          tables={schemaTables}
          wordWrap={settings.editorWordWrap}
          lineNumbers={settings.editorLineNumbers}
          tabSize={settings.editorTabSize}
          onRun={() => void run()}
          onRunSelection={() => {
            const selection = window.getSelection()?.toString().trim();
            void run(selection || undefined);
          }}
          className="h-full"
        />
      </div>

      <ResizableHandle
        side="right"
        onResize={(delta) =>
          setResultHeight((height) => Math.min(760, Math.max(120, height - delta)))
        }
        className="!h-px !w-full cursor-row-resize"
      />

      {/* results */}
      <div style={{ height: resultHeight }} className="flex min-h-0 shrink-0 flex-col bg-surface">
        <div className="flex h-7 shrink-0 items-center gap-1 border-b border-border bg-raised px-2">
          {outcome && outcome.results.length > 0 ? (
            outcome.results.map((result, index) => (
              <button
                key={index}
                type="button"
                onClick={() => setActiveResult(index)}
                className={cn(
                  "flex items-center gap-1.5 rounded-sm px-2 py-0.5 text-[11px]",
                  index === activeResult
                    ? "bg-accent-soft text-accent"
                    : "text-muted hover:bg-hover hover:text-fg",
                )}
              >
                <span>Result {index + 1}</span>
                {result.columns.length > 0 ? (
                  <span className="text-[10px] text-subtle tnum">{formatCount(result.rows.length)}</span>
                ) : (
                  <span className="text-[10px] text-subtle tnum">{formatCount(result.rowsAffected)}</span>
                )}
              </button>
            ))
          ) : (
            <span className="px-1 text-[11px] text-subtle">Results</span>
          )}

          <div className="flex-1" />

          <button
            type="button"
            onClick={() => setShowMessages((value) => !value)}
            className={cn(
              "flex items-center gap-1 rounded-sm px-2 py-0.5 text-[11px]",
              showMessages ? "bg-accent-soft text-accent" : "text-muted hover:bg-hover",
            )}
          >
            <ChevronDown className={cn("size-3 transition-transform", showMessages && "rotate-180")} />
            Messages
            {hasError ? <span className="size-1.5 rounded-full bg-danger" /> : null}
          </button>

          <Badge tone={status.tone}>{status.label}</Badge>
          {outcome ? (
            <span className="text-[10px] text-subtle tnum">{formatDuration(outcome.totalMs)}</span>
          ) : null}
        </div>

        <div className="min-h-0 flex-1">
          {showMessages || !currentResult ? (
            <MessageLog outcome={outcome} />
          ) : (
            <ResultGrid result={currentResult} />
          )}
        </div>
      </div>
    </div>
  );
}

/** Error text plus per-statement notices. */
function MessageLog({ outcome }: { outcome: RunOutcome | null }) {
  if (!outcome) {
    return (
      <div className="flex h-full items-center justify-center text-center">
        <p className="text-xs text-subtle">
          Run a statement with <kbd className="rounded-xs border border-border bg-sunken px-1">Ctrl</kbd>
          {" + "}
          <kbd className="rounded-xs border border-border bg-sunken px-1">Enter</kbd>
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col gap-1 overflow-auto scrollbar-thin p-3 font-mono text-[11px]">
      {outcome.error ? (
        <div className="flex items-start gap-2 rounded-md border border-danger/30 bg-danger-soft p-2 text-danger">
          <AlertCircle className="mt-px size-3.5 shrink-0" />
          <pre className="selectable whitespace-pre-wrap break-words">{outcome.error}</pre>
        </div>
      ) : (
        <div className="flex items-center gap-2 text-success">
          <CheckCircle2 className="size-3.5" />
          <span>
            {outcome.results.length} statement{outcome.results.length === 1 ? "" : "s"} completed in{" "}
            {formatDuration(outcome.totalMs)}
          </span>
        </div>
      )}

      {outcome.results.map((result, index) => (
        <div key={index} className="flex flex-col gap-0.5 border-t border-border pt-1 text-muted">
          <span className="text-subtle">
            [{index + 1}] {result.statementKind.toUpperCase()} · {formatDuration(result.elapsedMs)}
            {result.columns.length > 0
              ? ` · ${formatCount(result.rows.length)} rows`
              : ` · ${formatCount(result.rowsAffected)} affected`}
            {result.lastInsertId != null ? ` · last id ${result.lastInsertId}` : ""}
          </span>
          <pre className="selectable truncate text-[10px] text-subtle">{result.statement}</pre>
          {result.notices.map((notice, noticeIndex) => (
            <span key={noticeIndex} className="text-warning">
              {notice}
            </span>
          ))}
          {result.truncated ? (
            <span className="text-warning">
              result was truncated at the configured row cap
            </span>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Re-exported so the shell can keep its imports tidy. */
export { SqlCodeMirror };
