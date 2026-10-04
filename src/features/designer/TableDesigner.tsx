/**
 * The visual table designer.
 *
 * The component holds three pieces of state that together describe a change:
 *
 * - `original`, the {@link TableSchema} the server last reported, or `null` for
 *   a table that does not exist yet;
 * - `plan`, the working copy the user is editing;
 * - `baseline`, the plan the working copy was loaded from, which is what the
 *   dirty indicator and Revert compare against.
 *
 * Every edit lands in `plan`, a 300 ms debounce calls the backend's DDL
 * generator (the same code `create_table` / `alter_table` run), and the result
 * is shown before anything touches the database. Apply sends either the plan or,
 * when the user edited the script, that script verbatim.
 */

import * as React from "react";
import {
  AlertTriangle,
  ArrowLeftRight,
  Columns3,
  PanelRight,
  RefreshCw,
  Settings2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import type {
  DdlPlan,
  DbKind,
  ObjectKind,
  Scope,
  TablePlan,
  TableSchema,
} from "@/lib/types";
import { objectKindLabel, toErrorPayload } from "@/lib/types";
import ipc from "@/lib/ipc";
import { cn, formatCount } from "@/lib/utils";
import {
  Badge,
  Button,
  EmptyState,
  IconButton,
  Input,
  Spinner,
  Toolbar,
  ToolbarSpacer,
} from "@/components/ui/primitives";
import { useConfirm, Tooltip } from "@/components/ui/overlays";
import { useConnections } from "@/store/connections";
import { useExplorer } from "@/store/explorer";

import { ColumnEditor } from "./ColumnEditor";
import { ForeignKeyEditor } from "./ForeignKeyEditor";
import { IndexEditor } from "./IndexEditor";
import { SqlPreview } from "./SqlPreview";
import { Note, Row } from "./ui";
import {
  isPlanDirty,
  liveColumns,
  newTablePlan,
  planFromSchema,
  scopePrefix,
  summariseChanges,
} from "./plan";

/** How long the designer waits after a keystroke before asking for SQL. */
const PREVIEW_DEBOUNCE_MS = 300;

type TabKey = "columns" | "indexes" | "foreignKeys" | "options";

const TABS: { key: TabKey; label: string }[] = [
  { key: "columns", label: "Columns" },
  { key: "indexes", label: "Indexes" },
  { key: "foreignKeys", label: "Foreign keys" },
  { key: "options", label: "Options" },
];

export interface TableDesignerProps {
  sessionId: string;
  scope: Scope;
  /** Omitted when creating a brand new table. */
  table?: string;
  /** "table" (default) or "view". */
  objectKind?: ObjectKind;
  /** Called after a successful apply so the explorer can refresh. */
  onApplied?: () => void;
}

export function TableDesigner({
  sessionId,
  scope,
  table,
  objectKind = "table",
  onApplied,
}: TableDesignerProps): React.ReactElement {
  const confirm = useConfirm();
  const kind = useConnections(
    (state) => state.sessions[sessionId]?.info.kind ?? "sqlite",
  );

  const [original, setOriginal] = React.useState<TableSchema | null>(null);
  const [plan, setPlan] = React.useState<TablePlan | null>(null);
  const [baseline, setBaseline] = React.useState<TablePlan | null>(null);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [reloadToken, setReloadToken] = React.useState(0);

  const [tab, setTab] = React.useState<TabKey>("columns");
  const [expanded, setExpanded] = React.useState<number | null>(null);
  const [showPreview, setShowPreview] = React.useState(true);
  const [editing, setEditing] = React.useState(false);
  const [editedStatements, setEditedStatements] = React.useState<string[] | null>(null);

  const [preview, setPreview] = React.useState<DdlPlan | null>(null);
  const [previewLoading, setPreviewLoading] = React.useState(false);
  const [previewError, setPreviewError] = React.useState<string | null>(null);
  const [applyError, setApplyError] = React.useState<string | null>(null);
  const [applying, setApplying] = React.useState(false);

  // -- load -----------------------------------------------------------------

  React.useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError(null);
    setApplyError(null);
    setEditing(false);
    setEditedStatements(null);
    setExpanded(null);

    const load = async () => {
      if (!table) {
        const fresh = newTablePlan(kind, scope, "", objectKind);
        if (cancelled) return;
        setOriginal(null);
        setPlan(fresh);
        setBaseline(fresh);
        return;
      }
      const schema = await ipc.explorer.describe(sessionId, scope, table, objectKind);
      if (cancelled) return;
      const loaded = planFromSchema(schema, scope, objectKind);
      setOriginal(schema);
      setPlan(loaded);
      setBaseline(loaded);
    };

    load()
      .catch((error: unknown) => {
        if (cancelled) return;
        setLoadError(toErrorPayload(error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
    // `scope` is compared field by field so an inline object literal does not
    // re-run the load on every render.
  }, [sessionId, scope.database, scope.schema, table, objectKind, kind, reloadToken]);

  // -- live preview ---------------------------------------------------------

  React.useEffect(() => {
    if (!plan) return;
    let cancelled = false;
    const handle = window.setTimeout(() => {
      setPreviewLoading(true);
      const request =
        original && !plan.isNew
          ? ipc.schema.previewAlter(original, plan, kind)
          : ipc.schema.previewCreate(plan, kind);
      request
        .then((next) => {
          if (cancelled) return;
          setPreview(next);
          setPreviewError(null);
        })
        .catch((error: unknown) => {
          if (cancelled) return;
          setPreview(null);
          setPreviewError(toErrorPayload(error).message);
        })
        .finally(() => {
          if (!cancelled) setPreviewLoading(false);
        });
    }, PREVIEW_DEBOUNCE_MS);

    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [plan, original, kind]);

  // -- derived --------------------------------------------------------------

  const dirty = plan ? isPlanDirty(plan, baseline) : false;
  const isNew = plan?.isNew ?? !table;
  const summary = React.useMemo(
    () => (plan ? summariseChanges(plan, baseline) : null),
    [plan, baseline],
  );
  const existingIndexNames = React.useMemo(
    () => new Set((baseline?.indexes ?? []).filter((index) => !index.isNew).map((index) => index.name)),
    [baseline],
  );
  const existingKeyNames = React.useMemo(
    () => new Set((baseline?.foreignKeys ?? []).map((fk) => fk.name)),
    [baseline],
  );
  const columnNames = React.useMemo(
    () => (plan ? liveColumns(plan).map((column) => column.name).filter(Boolean) : []),
    [plan],
  );

  const pendingStatements = editing && editedStatements ? editedStatements : null;
  const statementCount = pendingStatements
    ? pendingStatements.length
    : (preview?.statements.length ?? 0);
  // The backend refuses an empty script, so nothing to run means nothing to do.
  // MySQL re-renders every column as MODIFY COLUMN, so an untouched plan still
  // previews a statement; the dirty flag keeps Apply out of reach until
  // something actually changed (or the user edited the script deliberately).
  const canApply = !applying && statementCount > 0 && (dirty || isNew || editing);
  const destructive = preview?.destructive ?? false;

  // -- actions --------------------------------------------------------------

  const revert = () => {
    const source = original ? planFromSchema(original, scope, objectKind) : null;
    if (source) setPlan(source);
    else if (plan) setPlan(newTablePlan(kind, scope, plan.name, objectKind));
    setEditing(false);
    setEditedStatements(null);
    setApplyError(null);
  };

  const reload = () => {
    setReloadToken((token) => token + 1);
    toast.info(table ? `Re-read ${table}` : "Started a new table");
  };

  const apply = async () => {
    if (!plan) return;
    const target = plan.name || (table ?? "");
    const script = pendingStatements;

    const confirmed = await confirm({
      title: isNew ? `Create ${objectKindLabel(objectKind).toLowerCase()}?` : `Apply changes?`,
      description: script
        ? `Run ${script.length} edited statement${script.length === 1 ? "" : "s"} against ${
            scope.database ? `${scope.database}.` : ""
          }${target || "the database"}.`
        : `${statementCount} statement${statementCount === 1 ? "" : "s"} will run against ${
            scope.database ? `${scope.database}.` : ""
          }${target || "the database"}.`,
      confirmLabel: isNew ? "Create" : "Apply",
      tone: destructive ? "danger" : "default",
    });
    if (!confirmed) return;

    setApplying(true);
    setApplyError(null);
    try {
      if (script) {
        await ipc.schema.apply(sessionId, script, scope.database ?? undefined, scope.schema ?? undefined);
      } else if (isNew) {
        await ipc.schema.createTable(sessionId, plan);
      } else if (original) {
        await ipc.schema.alterTable(sessionId, original, plan);
      }

      toast.success(
        isNew
          ? `Created ${plan.name || "table"}`
          : `Applied changes to ${plan.name || table || "the table"}`,
      );
      useExplorer.getState().invalidate(scopePrefix(sessionId, scope));
      onApplied?.();
      setEditing(false);
      setEditedStatements(null);
      // Re-read so the designer now reflects what the server actually stores.
      setReloadToken((token) => token + 1);
    } catch (error) {
      const message = toErrorPayload(error).message;
      setApplyError(message);
      toast.error(isNew ? "Could not create the table" : "Could not apply the changes", {
        description: message,
      });
    } finally {
      setApplying(false);
    }
  };

  // -- render ---------------------------------------------------------------

  if (loading) {
    return (
      <div className="flex h-full items-center justify-center gap-2 text-muted">
        <Spinner />
        <span className="text-xs">{table ? `Reading ${table}…` : "Preparing the designer…"}</span>
      </div>
    );
  }

  if (loadError) {
    return (
      <EmptyState
        icon={<AlertTriangle />}
        title="Could not read the object"
        description={loadError}
        action={
          <Button variant="secondary" onClick={reload}>
            <RefreshCw className="size-3.5" /> Try again
          </Button>
        }
      />
    );
  }

  if (!plan) {
    return <EmptyState icon={<Columns3 />} title="Nothing to design" />;
  }

  return (
    <div className="flex h-full min-h-0 flex-col bg-canvas">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-surface px-3">
        <span className="text-muted [&>svg]:size-4">
          {objectKind === "view" ? <ArrowLeftRight /> : <Columns3 />}
        </span>
        <Input
          value={plan.name}
          aria-label="Object name"
          spellCheck={false}
          placeholder={isNew ? "new_table" : undefined}
          onChange={(event) => setPlan({ ...plan, name: event.target.value })}
          className="h-7 w-56 px-2 font-mono text-[13px]"
        />
        <Badge tone="neutral">{objectKindLabel(objectKind)}</Badge>
        <Badge tone="info">{kind}</Badge>
        {original?.rowCount !== null && original?.rowCount !== undefined ? (
          <span className="text-[11px] text-subtle">{formatCount(original.rowCount)} rows</span>
        ) : null}
        {dirty ? (
          <Tooltip content="Unsaved changes">
            <span className="flex items-center gap-1 text-[11px] text-warning">
              <span className="size-1.5 rounded-full bg-warning" />
              unsaved
              {summary && summary.total > 0
                ? ` · ${summary.total} change${summary.total === 1 ? "" : "s"}`
                : ""}
            </span>
          </Tooltip>
        ) : (
          <span className="text-[11px] text-subtle">
            {isNew ? "new table" : "in sync with the server"}
          </span>
        )}
        <ToolbarSpacer />
        <IconButton
          label={showPreview ? "Hide SQL preview" : "Show SQL preview"}
          onClick={() => setShowPreview((value) => !value)}
          className={cn(showPreview && "bg-accent-soft text-accent")}
        >
          <PanelRight className="size-3.5" />
        </IconButton>
        <Button
          size="sm"
          variant="secondary"
          disabled={!dirty && !isNew}
          onClick={revert}
          title={isNew ? "Start over from a blank table" : "Re-read the schema from the server"}
        >
          <RefreshCw className="size-3.5" /> Revert
        </Button>
        <Button size="sm" variant="primary" loading={applying} disabled={!canApply} onClick={apply}>
          {isNew ? "Create" : "Apply"}
          {statementCount > 0 ? (
            <span className="text-accent-fg/80">({statementCount})</span>
          ) : null}
        </Button>
      </header>

      {applyError ? (
        <div className="flex shrink-0 items-start gap-2 border-b border-danger/30 bg-danger-soft px-3 py-2 text-danger">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <p className="text-[12px] font-medium">The database rejected the change</p>
            <p className="selectable whitespace-pre-wrap break-words font-mono text-[11px] leading-snug">
              {applyError}
            </p>
          </div>
          <IconButton
            label="Dismiss"
            onClick={() => setApplyError(null)}
            className="text-danger hover:bg-danger/15"
          >
            <X className="size-3.5" />
          </IconButton>
        </div>
      ) : null}

      {objectKind === "view" ? (
        <Note tone="warning" className="m-3 mb-0">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Views are definitions, not tables: the backend cannot alter their columns. Use the SQL
            editor to run <code className="font-mono">CREATE OR REPLACE VIEW</code>.
          </span>
        </Note>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <Toolbar>
          {TABS.map((entry) => (
            <button
              key={entry.key}
              type="button"
              onClick={() => setTab(entry.key)}
              className={cn(
                "flex h-7 items-center gap-1.5 rounded-sm px-2 text-xs font-medium",
                tab === entry.key
                  ? "bg-accent-soft text-accent"
                  : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              {entry.label}
              <TabCount tab={entry.key} plan={plan} />
            </button>
          ))}
          <ToolbarSpacer />
          {summary && dirty ? (
            <span className="pr-1 text-[11px] text-subtle">
              {[
                summary.addedColumns > 0 ? `+${summary.addedColumns} col` : null,
                summary.droppedColumns > 0 ? `-${summary.droppedColumns} col` : null,
                summary.renamedColumns > 0 ? `${summary.renamedColumns} renamed` : null,
                summary.changedColumns > 0 ? `${summary.changedColumns} altered` : null,
                summary.addedIndexes > 0 ? `+${summary.addedIndexes} idx` : null,
                summary.droppedIndexes > 0 ? `-${summary.droppedIndexes} idx` : null,
                summary.addedForeignKeys > 0 ? `+${summary.addedForeignKeys} fk` : null,
                summary.droppedForeignKeys > 0 ? `-${summary.droppedForeignKeys} fk` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
            </span>
          ) : null}
        </Toolbar>

        <div className="flex min-h-0 flex-1">
          <div className="flex min-h-0 min-w-0 flex-1 flex-col">
            {tab === "columns" ? (
              <ColumnEditor
                columns={plan.columns}
                kind={kind}
                expanded={expanded}
                onExpandedChange={setExpanded}
                onChange={(columns) => setPlan({ ...plan, columns })}
              />
            ) : null}

            {tab === "indexes" ? (
              <IndexEditor
                indexes={plan.indexes}
                columns={columnNames}
                existingNames={existingIndexNames}
                onChange={(indexes) => setPlan({ ...plan, indexes })}
              />
            ) : null}

            {tab === "foreignKeys" ? (
              <ForeignKeyEditor
                foreignKeys={plan.foreignKeys}
                kind={kind}
                columns={columnNames}
                existingNames={existingKeyNames}
                sessionId={sessionId}
                scope={scope}
                onChange={(foreignKeys) => setPlan({ ...plan, foreignKeys })}
              />
            ) : null}

            {tab === "options" ? (
              <OptionsTab
                plan={plan}
                kind={kind}
                onChange={(next) => setPlan(next)}
                scope={scope}
                original={original}
              />
            ) : null}
          </div>

          {showPreview ? (
            <SqlPreview
              plan={preview}
              loading={previewLoading}
              error={previewError}
              editing={editing}
              onEditingChange={setEditing}
              onEditedScriptChange={setEditedStatements}
              className="w-[26rem] shrink-0 border-l border-border"
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

export default TableDesigner;

// ---------------------------------------------------------------------------
// Tab pieces
// ---------------------------------------------------------------------------

/** A count next to each tab label so an untouched tab is obviously untouched. */
function TabCount({ tab, plan }: { tab: TabKey; plan: TablePlan }) {
  switch (tab) {
    case "columns":
      return <TabBadge value={liveColumns(plan).length} />;
    case "indexes":
      return <TabBadge value={plan.indexes.filter((index) => !index.dropped).length} />;
    case "foreignKeys":
      return <TabBadge value={plan.foreignKeys.filter((fk) => !fk.dropped).length} />;
    case "options":
      return null;
  }
}

function TabBadge({ value }: { value: number }) {
  return (
    <span className="rounded-full bg-sunken px-1.5 py-px text-[10px] tabular-nums text-muted">
      {value}
    </span>
  );
}

/**
 * Table options. Only what the engine actually supports is rendered — MySQL
 * reads engine/charset/collation out of `plan.options`, PostgreSQL carries its
 * table comment, and SQLite passes its own type affinities through the column
 * types, so it has nothing to configure here.
 */
function OptionsTab({
  plan,
  kind,
  scope,
  original,
  onChange,
}: {
  plan: TablePlan;
  kind: DbKind;
  scope: Scope;
  original: TableSchema | null;
  onChange: (plan: TablePlan) => void;
}) {
  const setOption = (key: string, value: string) => {
    const options = { ...plan.options };
    if (value.trim()) options[key] = value.trim();
    else delete options[key];
    onChange({ ...plan, options });
  };

  return (
    <div className="min-h-0 flex-1 overflow-auto scrollbar-thin p-4">
      <div className="mx-auto flex max-w-2xl flex-col gap-4">
        <Row label="Name">
          <Input
            value={plan.name}
            spellCheck={false}
            aria-label="Object name"
            placeholder="new_table"
            onChange={(event) => onChange({ ...plan, name: event.target.value })}
            className="h-8 max-w-72 font-mono text-[13px]"
          />
        </Row>

        <Row label="Location">
          <p className="pt-1.5 font-mono text-[12px] text-muted">
            {[scope.database, scope.schema].filter(Boolean).join(".") || "—"}
            {scope.database || scope.schema ? "." : ""}
            {plan.name || "…"}
          </p>
        </Row>

        {kind === "mysql" ? (
          <>
            <Row label="Engine" hint="Written as ENGINE=…, for example InnoDB.">
              <Input
                value={plan.options.engine ?? ""}
                spellCheck={false}
                placeholder="InnoDB"
                onChange={(event) => setOption("engine", event.target.value)}
                className="h-8 max-w-72 font-mono text-[12px]"
              />
            </Row>
            <Row label="Charset" hint="Written as DEFAULT CHARSET=…">
              <Input
                value={plan.options.charset ?? ""}
                spellCheck={false}
                placeholder="utf8mb4"
                onChange={(event) => setOption("charset", event.target.value)}
                className="h-8 max-w-72 font-mono text-[12px]"
              />
            </Row>
            <Row label="Collation" hint="Written as COLLATE=…">
              <Input
                value={plan.options.collation ?? ""}
                spellCheck={false}
                placeholder="utf8mb4_0900_ai_ci"
                onChange={(event) => setOption("collation", event.target.value)}
                className="h-8 max-w-72 font-mono text-[12px]"
              />
            </Row>
          </>
        ) : null}

        {kind === "postgres" ? (
          <Row
            label="Comment"
            hint="PostgreSQL stores table comments separately; the designer only shows the one the server reported."
          >
            <p className="selectable min-h-8 rounded-md border border-border bg-sunken px-2.5 py-1.5 text-[12px] text-muted">
              {original?.comment ?? "—"}
            </p>
          </Row>
        ) : null}

        {kind === "sqlite" ? (
          <Note>
            <Settings2 className="mt-0.5 size-3.5 shrink-0" />
            <span>
              SQLite has no table options: every column carries its own type affinity, which is
              edited in the Columns tab.
            </span>
          </Note>
        ) : null}
      </div>
    </div>
  );
}
