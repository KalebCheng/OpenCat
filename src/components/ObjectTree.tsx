/**
 * The lazy object tree.
 *
 * Every node loads its children the first time it is expanded and caches them in
 * `useExplorer`. Node identity is a stable string key so a refresh can drop just
 * the affected subtree.
 */

import { useCallback, useMemo, useState } from "react";
import {
  ChevronRight,
  Columns3,
  Database,
  Eye,
  FolderTree,
  Hash,
  KeyRound,
  Layers,
  Link2,
  Loader2,
  MoreHorizontal,
  RefreshCw,
  Sigma,
  Table2,
  Wrench,
  Zap,
} from "lucide-react";
import { toast } from "sonner";

import { IconButton, Spinner } from "@/components/ui/primitives";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/overlays";
import ipc from "@/lib/ipc";
import { useConfirm, usePrompt } from "@/components/ui/overlays";
import {
  type ColumnSchema,
  type DbKind,
  type ObjectKind,
  type ObjectRef,
  type Scope,
  type TableSchema,
  isSystemSchema,
  objectKindLabel,
  toErrorPayload,
} from "@/lib/types";
import { cn, formatCount, shortType } from "@/lib/utils";
import { databaseKey, objectKey, schemaKey, useExplorer } from "@/store/explorer";
import { useTabs } from "@/store/tabs";

// ---------------------------------------------------------------------------
// Row chrome
// ---------------------------------------------------------------------------

interface RowProps {
  depth: number;
  icon: React.ReactNode;
  label: React.ReactNode;
  secondary?: React.ReactNode;
  expandable?: boolean;
  expanded?: boolean;
  loading?: boolean;
  selected?: boolean;
  tone?: "default" | "relation" | "schema" | "folder";
  onToggle?: () => void;
  onClick?: () => void;
  onDoubleClick?: () => void;
  trailing?: React.ReactNode;
  title?: string;
}

function Row({
  depth,
  icon,
  label,
  secondary,
  expandable,
  expanded,
  loading,
  selected,
  tone = "default",
  onToggle,
  onClick,
  onDoubleClick,
  trailing,
  title,
}: RowProps) {
  return (
    <div
      role="treeitem"
      aria-expanded={expandable ? expanded : undefined}
      tabIndex={0}
      title={title}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onKeyDown={(event) => {
        if (event.key === "Enter") onDoubleClick?.();
        if (event.key === "ArrowRight" && expandable && !expanded) onToggle?.();
        if (event.key === "ArrowLeft" && expandable && expanded) onToggle?.();
      }}
      className={cn(
        "group flex h-6 select-none items-center gap-1 pr-1 text-[12px] leading-none",
        "cursor-default outline-none",
        selected ? "bg-accent-soft text-fg" : "hover:bg-hover",
        "focus-visible:bg-hover",
      )}
      style={{ paddingLeft: depth * 12 + 4 }}
    >
      <button
        type="button"
        tabIndex={-1}
        aria-hidden={!expandable}
        onClick={(event) => {
          event.stopPropagation();
          onToggle?.();
        }}
        className={cn(
          "grid size-4 shrink-0 place-content-center rounded-xs text-subtle",
          expandable ? "hover:bg-active hover:text-fg" : "invisible",
        )}
      >
        {loading ? (
          <Loader2 className="size-3 animate-spin-slow" />
        ) : (
          <ChevronRight
            className={cn("size-3 transition-transform duration-100", expanded && "rotate-90")}
          />
        )}
      </button>

      <span
        className={cn(
          "grid size-4 shrink-0 place-content-center [&>svg]:size-3.5",
          tone === "relation" && "text-info",
          tone === "schema" && "text-warning",
          tone === "folder" && "text-subtle",
          tone === "default" && "text-muted",
        )}
      >
        {icon}
      </span>

      <span className="min-w-0 flex-1 truncate">{label}</span>

      {secondary ? (
        <span className="shrink-0 text-[10px] text-subtle tnum">{secondary}</span>
      ) : null}

      <span className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        {trailing}
      </span>
    </div>
  );
}

/** Shared expand/collapse bookkeeping for a lazy node. */
function useNode(key: string, load: () => Promise<unknown>) {
  const expanded = useExplorer((state) => !!state.expanded[key]);
  const loading = useExplorer((state) => state.nodes[key]?.loading ?? false);
  const error = useExplorer((state) => state.nodes[key]?.error);
  const [, force] = useState(0);

  const toggle = useCallback(
    (forceReload = false) => {
      const store = useExplorer.getState();
      if (store.expanded[key] && !forceReload) {
        store.collapse(key);
        return;
      }
      store.expand(key);
      void load().catch((err) => {
        toast.error(toErrorPayload(err).message);
      });
    },
    [key, load],
  );

  const refresh = useCallback(() => {
    useExplorer.getState().invalidate(key);
    void load().catch(() => undefined);
    force((n) => n + 1);
  }, [key, load]);

  return { expanded, loading, error, toggle, refresh };
}

// ---------------------------------------------------------------------------
// Tree root
// ---------------------------------------------------------------------------

export interface ObjectTreeProps {
  sessionId: string;
  dbKind: DbKind;
  filter?: string;
}

export function ObjectTree({ sessionId, dbKind, filter = "" }: ObjectTreeProps) {
  const databases = useExplorer((state) => state.nodes[databaseKey(sessionId)]?.databases);
  const loading = useExplorer((state) => state.nodes[databaseKey(sessionId)]?.loading);
  const error = useExplorer((state) => state.nodes[databaseKey(sessionId)]?.error);

  const load = useCallback(
    () => useExplorer.getState().databases(sessionId, true),
    [sessionId],
  );

  const node = useNode(databaseKey(sessionId), load);

  // Load once on first render.
  const [booted, setBooted] = useState(false);
  if (!booted && !databases && !loading && !error) {
    setBooted(true);
    void load().catch(() => undefined);
  }

  const needle = filter.trim().toLowerCase();
  const visible = useMemo(
    () => (databases ?? []).filter((db) => !needle || db.name.toLowerCase().includes(needle)),
    [databases, needle],
  );

  if (loading && !databases) {
    return (
      <div className="flex items-center gap-2 px-3 py-2 text-[11px] text-subtle">
        <Spinner className="size-3" />
        Loading databases…
      </div>
    );
  }

  if (error && !databases) {
    return (
      <div className="flex flex-col gap-2 px-3 py-2">
        <p className="text-[11px] leading-snug text-danger">{error}</p>
        <button
          type="button"
          onClick={() => node.refresh()}
          className="self-start text-[11px] text-accent hover:underline"
        >
          Retry
        </button>
      </div>
    );
  }

  if (visible.length === 0) {
    return (
      <p className="px-3 py-2 text-[11px] text-subtle">
        {needle ? "No database matches the filter." : "This connection exposes no databases."}
      </p>
    );
  }

  return (
    <div role="tree" className="py-0.5">
      {visible.map((db) => (
        <DatabaseNode
          key={`${sessionId}:${db.name}`}
          sessionId={sessionId}
          dbKind={dbKind}
          database={db.name}
          isSystem={db.isSystem}
          sizeBytes={db.sizeBytes ?? null}
          filter={filter}
        />
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Database / schema / folder
// ---------------------------------------------------------------------------

function DatabaseNode({
  sessionId,
  dbKind,
  database,
  isSystem,
  sizeBytes,
  filter,
  depth = 0,
}: {
  sessionId: string;
  dbKind: DbKind;
  database: string;
  isSystem: boolean;
  sizeBytes: number | null;
  filter: string;
  depth?: number;
}) {
  const scope: Scope = { database, schema: null };
  const key = schemaKey(sessionId, database);
  const [selected, setSelected] = useState(false);

  const load = useCallback(async () => {
    if (dbKind === "postgres") {
      await useExplorer.getState().schemas(sessionId, database, true);
    } else {
      await useExplorer.getState().objects(sessionId, scope, true);
    }
  }, [dbKind, sessionId, database, scope]);

  const node = useNode(key, load);
  const schemas = useExplorer((state) => state.nodes[key]?.schemas);
  const needle = filter.trim().toLowerCase();

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div onClick={() => setSelected(true)}>
            <Row
              depth={depth}
              icon={<Database />}
              label={<span className={cn("truncate", isSystem && "text-muted")}>{database}</span>}
              secondary={sizeBytes ? formatBytesShort(sizeBytes) : undefined}
              expandable
              expanded={node.expanded}
              loading={node.loading}
              selected={selected}
              tone="default"
              onToggle={() => node.toggle()}
              onDoubleClick={() => node.toggle(true)}
              trailing={
                <DatabaseActions
                  sessionId={sessionId}
                  database={database}
                  onRefresh={node.refresh}
                  isSystem={isSystem}
                />
              }
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>{database}</ContextMenuLabel>
          <ContextMenuItem onSelect={() => node.toggle(true)}>Refresh</ContextMenuItem>
          <ContextMenuItem
            onSelect={() => void createQueryTab(sessionId, { database, schema: null })}
          >
            New query
          </ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            danger
            disabled={isSystem}
            onSelect={() => void dropDatabase(sessionId, database)}
          >
            Drop database…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {node.expanded ? (
        dbKind === "postgres" ? (
          (schemas ?? [])
            .filter((name) => !needle || name.toLowerCase().includes(needle))
            .map((name) => (
              <SchemaNode
                key={`${database}.${name}`}
                sessionId={sessionId}
                dbKind={dbKind}
                database={database}
                schema={name}
                depth={depth + 1}
                filter={filter}
              />
            ))
        ) : (
          <ObjectFolder
            sessionId={sessionId}
            dbKind={dbKind}
            scope={{ database, schema: null }}
            folder="tables"
            depth={depth + 1}
            filter={filter}
          />
        )
      ) : null}
    </>
  );
}

function DatabaseActions({
  sessionId,
  database,
  onRefresh,
  isSystem,
}: {
  sessionId: string;
  database: string;
  onRefresh: () => void;
  isSystem: boolean;
}) {
  const prompt = usePrompt();

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <IconButton
          label="Database actions"
          size="icon-sm"
          variant="ghost"
          className="size-4"
          onClick={(event) => event.stopPropagation()}
        >
          <MoreHorizontal className="size-3.5" />
        </IconButton>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start">
        <DropdownMenuItem onSelect={onRefresh}>
          <RefreshCw /> Refresh
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={async () => {
            const name = await prompt({
              title: `Rename database ${database}`,
              label: "New name",
              initialValue: database,
              validate: (value) => (value.trim() ? null : "a name is required"),
            });
            if (!name || name === database) return;
            toast.info(
              "Renaming a database is not supported by every engine — run ALTER DATABASE from the SQL editor.",
            );
          }}
        >
          <Wrench /> Rename…
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        <DropdownMenuItem
          danger
          disabled={isSystem}
          onSelect={() => void dropDatabase(sessionId, database)}
        >
          Drop database…
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function SchemaNode({
  sessionId,
  dbKind,
  database,
  schema,
  depth,
  filter,
}: {
  sessionId: string;
  dbKind: DbKind;
  database: string;
  schema: string;
  depth: number;
  filter: string;
}) {
  const scope: Scope = { database, schema };
  const key = objectKey(sessionId, scope);

  const load = useCallback(
    () => useExplorer.getState().objects(sessionId, scope, true),
    [sessionId, scope],
  );

  const node = useNode(key, load);

  return (
    <>
      <Row
        depth={depth}
        icon={<Layers />}
        label={schema}
        expandable
        expanded={node.expanded}
        loading={node.loading}
        tone="schema"
        onToggle={() => node.toggle()}
        onDoubleClick={() => node.toggle(true)}
        trailing={
          <IconButton
            label="Refresh schema"
            size="icon-sm"
            variant="ghost"
            className="size-4"
            onClick={(event) => {
              event.stopPropagation();
              node.refresh();
            }}
          >
            <RefreshCw className="size-3" />
          </IconButton>
        }
      />
      {node.expanded ? (
        <>
          <ObjectFolder
            sessionId={sessionId}
            dbKind={dbKind}
            scope={scope}
            folder="tables"
            depth={depth + 1}
            filter={filter}
          />
          <ObjectFolder
            sessionId={sessionId}
            dbKind={dbKind}
            scope={scope}
            folder="routines"
            depth={depth + 1}
            filter={filter}
          />
        </>
      ) : null}
    </>
  );
}

type FolderKind = "tables" | "routines";

function ObjectFolder({
  sessionId,
  dbKind,
  scope,
  folder,
  depth,
  filter,
}: {
  sessionId: string;
  dbKind: DbKind;
  scope: Scope;
  folder: FolderKind;
  depth: number;
  filter: string;
}) {
  const key = `${objectKey(sessionId, scope)}:${folder}`;

  const load = useCallback(async () => {
    if (folder === "routines") {
      await useExplorer.getState().routines(sessionId, scope, true);
      return;
    }
    await Promise.all([
      useExplorer.getState().objects(sessionId, scope, true),
      useExplorer.getState().routines(sessionId, scope, true),
    ]);
  }, [folder, sessionId, scope]);

  const node = useNode(key, load);

  const objects = useExplorer((state) => state.nodes[objectKey(sessionId, scope)]?.objects);
  const routines = useExplorer((state) => state.nodes[`${objectKey(sessionId, scope)}:routines`]?.routines);

  const needle = filter.trim().toLowerCase();
  const matching = useMemo(() => {
    const pool: ObjectRef[] =
      folder === "routines"
        ? (routines ?? []).filter((r) => !isRelationKind(r.kind))
        : (objects ?? []).filter((o) => isRelationKind(o.kind));
    return pool.filter((o) => !needle || o.name.toLowerCase().includes(needle));
  }, [folder, objects, routines, needle]);

  const tables = (objects ?? []).filter((o) => o.kind === "table").length;
  const views = (objects ?? []).filter((o) => isRelationKind(o.kind) && o.kind !== "table").length;

  return (
    <>
      <Row
        depth={depth}
        icon={folder === "routines" ? <Sigma /> : <FolderTree />}
        label={folder === "routines" ? "Routines" : "Tables"}
        secondary={
          folder === "tables"
            ? formatCount(tables + views)
            : formatCount((routines ?? []).length)
        }
        expandable
        expanded={node.expanded}
        loading={node.loading}
        tone="folder"
        onToggle={() => node.toggle()}
        trailing={
          <IconButton
            label="Refresh"
            size="icon-sm"
            variant="ghost"
            className="size-4"
            onClick={(event) => {
              event.stopPropagation();
              node.refresh();
            }}
          >
            <RefreshCw className="size-3" />
          </IconButton>
        }
      />
      {node.expanded ? (
        matching.length === 0 ? (
          <p
            className="py-1 text-[11px] text-subtle"
            style={{ paddingLeft: (depth + 1) * 12 + 24 }}
          >
            {folder === "routines" ? "No functions or procedures." : "No tables or views."}
          </p>
        ) : (
          matching.map((object) => (
            <RelationNode
              key={`${objectKey(sessionId, scope)}:${object.kind}:${object.name}`}
              sessionId={sessionId}
              dbKind={dbKind}
              scope={scope}
              object={object}
              depth={depth + 1}
            />
          ))
        )
      ) : null}
    </>
  );
}

function isRelationKind(kind: ObjectKind): boolean {
  return kind === "table" || kind === "view" || kind === "materialized_view";
}

// ---------------------------------------------------------------------------
// Relations
// ---------------------------------------------------------------------------

function RelationNode({
  sessionId,
  dbKind,
  scope,
  object,
  depth,
}: {
  sessionId: string;
  dbKind: DbKind;
  scope: Scope;
  object: ObjectRef;
  depth: number;
}) {
  const [selected, setSelected] = useState(false);
  const [schema, setSchema] = useState<TableSchema | null>(null);
  const [loading, setLoading] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const confirm = useConfirm();
  const prompt = usePrompt();
  const openTab = useTabs((state) => state.openOrFocus);
  const closeForSession = useTabs((state) => state.closeForSession);

  const loadSchema = useCallback(async () => {
    if (schema) return;
    setLoading(true);
    try {
      setSchema(await ipc.explorer.describe(sessionId, scope, object.name, object.kind));
    } catch (error) {
      toast.error(toErrorPayload(error).message);
    } finally {
      setLoading(false);
    }
  }, [schema, sessionId, scope, object.name, object.kind]);

  const toggle = useCallback(() => {
    const next = !expanded;
    setExpanded(next);
    if (next) void loadSchema();
  }, [expanded, loadSchema]);

  const openData = useCallback(() => {
    openTab({
      kind: "table",
      sessionId,
      scope,
      table: object.name,
      objectKind: object.kind,
      title: object.name,
    });
  }, [openTab, sessionId, scope, object.name, object.kind]);

  const openDesigner = useCallback(() => {
    openTab({
      kind: "designer",
      sessionId,
      scope,
      table: object.name,
      objectKind: object.kind,
      title: `${object.name} (design)`,
    });
  }, [openTab, sessionId, scope, object.name, object.kind]);

  const refresh = useCallback(() => {
    setSchema(null);
    useExplorer.getState().invalidate(objectKey(sessionId, scope));
    void reloadParent(sessionId, scope);
    if (expanded) void loadSchema();
  }, [sessionId, scope, expanded, loadSchema]);

  return (
    <>
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div onClick={() => setSelected(true)}>
            <Row
              depth={depth}
              icon={object.kind === "table" ? <Table2 /> : <Eye />}
              label={object.name}
              secondary={object.rowCount != null ? formatCount(object.rowCount) : undefined}
              expandable
              expanded={expanded}
              loading={loading}
              selected={selected}
              tone="relation"
              title={object.comment ?? object.name}
              onToggle={toggle}
              onDoubleClick={openData}
              trailing={
                <IconButton
                  label="Refresh"
                  size="icon-sm"
                  variant="ghost"
                  className="size-4"
                  onClick={(event) => {
                    event.stopPropagation();
                    refresh();
                  }}
                >
                  <RefreshCw className="size-3" />
                </IconButton>
              }
            />
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>
          <ContextMenuLabel>
            {objectKindLabel(object.kind)} · {object.name}
          </ContextMenuLabel>
          <ContextMenuItem onSelect={openData}>Open data</ContextMenuItem>
          <ContextMenuItem onSelect={openDesigner}>Design…</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={() =>
              void createQueryTab(sessionId, scope, `SELECT * FROM ${qualify(scope, object.name, dbKind)} LIMIT 200;\n`)
            }
          >
            Generate SELECT
          </ContextMenuItem>
          <ContextMenuItem
            onSelect={() => void ipc.app.copyToClipboard(object.name).catch(() => undefined)}
          >
            Copy name
          </ContextMenuItem>
          <ContextMenuItem onSelect={refresh}>Refresh</ContextMenuItem>
          <ContextMenuSeparator />
          <ContextMenuItem
            onSelect={async () => {
              const ddl = await ipc.explorer
                .ddl(sessionId, scope, object.name, object.kind)
                .catch((error: unknown) => {
                  toast.error(toErrorPayload(error).message);
                  return null;
                });
              if (ddl) await createQueryTab(sessionId, scope, ddl, `${object.name} DDL`);
            }}
          >
            Show CREATE statement
          </ContextMenuItem>
          {object.kind === "table" ? (
            <ContextMenuItem
              danger
              onSelect={async () => {
                const ok = await confirm({
                  title: `Truncate ${object.name}?`,
                  description:
                    "Every row will be removed. This cannot be undone outside a transaction.",
                  confirmLabel: "Truncate",
                  tone: "danger",
                });
                if (!ok) return;
                try {
                  await ipc.schema.truncate(sessionId, scope, object.name);
                  toast.success(`${object.name} truncated`);
                  refresh();
                } catch (error) {
                  toast.error(toErrorPayload(error).message);
                }
              }}
            >
              Truncate table…
            </ContextMenuItem>
          ) : null}
          <ContextMenuItem
            onSelect={async () => {
              const name = await prompt({
                title: `Rename ${object.name}`,
                label: "New name",
                initialValue: object.name,
                confirmLabel: "Rename",
                validate: (value) => (value.trim() ? null : "a name is required"),
              });
              if (!name || name === object.name) return;
              try {
                await ipc.schema.rename(sessionId, scope, object.name, name, object.kind);
                toast.success(`Renamed to ${name}`);
                refresh();
              } catch (error) {
                toast.error(toErrorPayload(error).message);
              }
            }}
          >
            Rename…
          </ContextMenuItem>
          <ContextMenuItem
            danger
            onSelect={async () => {
              const ok = await confirm({
                title: `Drop ${object.name}?`,
                description: "The object and all of its data will be permanently removed.",
                confirmLabel: "Drop",
                tone: "danger",
              });
              if (!ok) return;
              try {
                await ipc.schema.drop(sessionId, scope, object.name, object.kind);
                toast.success(`${object.name} dropped`);
                closeForSession(sessionId);
                refresh();
              } catch (error) {
                toast.error(toErrorPayload(error).message);
              }
            }}
          >
            Drop…
          </ContextMenuItem>
        </ContextMenuContent>
      </ContextMenu>

      {expanded ? (
        loading && !schema ? (
          <p
            className="py-1 text-[11px] text-subtle"
            style={{ paddingLeft: (depth + 1) * 12 + 24 }}
          >
            Loading columns…
          </p>
        ) : schema ? (
          <RelationDetails schema={schema} depth={depth + 1} scope={scope} />
        ) : null
      ) : null}
    </>
  );
}

function RelationDetails({
  schema,
  depth,
  scope,
}: {
  schema: TableSchema;
  depth: number;
  scope: Scope;
}) {
  const [open, setOpen] = useState<Record<string, boolean>>({ columns: true });

  const groups: Array<{
    id: string;
    label: string;
    icon: React.ReactNode;
    count: number;
    render: () => React.ReactNode;
  }> = [
    {
      id: "columns",
      label: "Columns",
      icon: <Columns3 />,
      count: schema.columns.length,
      render: () => <ColumnList columns={schema.columns} depth={depth + 1} />,
    },
    {
      id: "indexes",
      label: "Indexes",
      icon: <Hash />,
      count: schema.indexes.length,
      render: () => (
        <DetailList
          depth={depth + 1}
          rows={schema.indexes.map((index) => ({
            key: index.name,
            icon: index.isPrimary ? <KeyRound /> : <Hash />,
            label: index.name,
            secondary: index.columns.join(", "),
          }))}
          empty="No indexes."
        />
      ),
    },
    {
      id: "foreignKeys",
      label: "Foreign keys",
      icon: <Link2 />,
      count: schema.foreignKeys.length,
      render: () => (
        <DetailList
          depth={depth + 1}
          rows={schema.foreignKeys.map((fk) => ({
            key: fk.name,
            icon: <Link2 />,
            label: fk.name,
            secondary: `${fk.columns.join(", ")} → ${fk.refTable}(${fk.refColumns.join(", ")})`,
          }))}
          empty="No foreign keys."
        />
      ),
    },
    {
      id: "triggers",
      label: "Triggers",
      icon: <Zap />,
      count: schema.triggers.length,
      render: () => (
        <DetailList
          depth={depth + 1}
          rows={schema.triggers.map((trigger) => ({
            key: trigger.name,
            icon: <Zap />,
            label: trigger.name,
            secondary: [trigger.timing, trigger.event].filter(Boolean).join(" "),
          }))}
          empty="No triggers."
        />
      ),
    },
  ];

  return (
    <>
      {groups.map((group) => (
        <div key={group.id}>
          <Row
            depth={depth}
            icon={group.icon}
            label={group.label}
            secondary={formatCount(group.count)}
            expandable
            expanded={!!open[group.id]}
            tone="folder"
            onToggle={() => setOpen((state) => ({ ...state, [group.id]: !state[group.id] }))}
          />
          {open[group.id] ? group.render() : null}
        </div>
      ))}
      <p
        className="py-0.5 text-[10px] text-subtle"
        style={{ paddingLeft: (depth + 1) * 12 + 24 }}
        title={scope.schema ?? scope.database ?? undefined}
      >
        {schema.ddl ? "DDL available via right-click" : ""}
      </p>
    </>
  );
}

function ColumnList({ columns, depth }: { columns: ColumnSchema[]; depth: number }) {
  if (columns.length === 0) {
    return (
      <p className="py-1 text-[11px] text-subtle" style={{ paddingLeft: depth * 12 + 24 }}>
        No columns.
      </p>
    );
  }
  return (
    <>
      {columns.map((column) => (
        <Row
          key={column.name}
          depth={depth}
          icon={column.isPrimaryKey ? <KeyRound /> : <Columns3 />}
          label={
            <span className="flex items-center gap-1.5">
              <span className={cn("truncate", !column.nullable && "font-medium")}>
                {column.name}
              </span>
              <span className="shrink-0 text-[10px] text-subtle">
                {shortType(column.dataType)}
              </span>
            </span>
          }
          secondary={column.nullable ? "" : "NOT NULL"}
          title={`${column.name} ${column.dataType}${column.comment ? ` — ${column.comment}` : ""}`}
        />
      ))}
    </>
  );
}

function DetailList({
  rows,
  depth,
  empty,
}: {
  rows: Array<{ key: string; icon: React.ReactNode; label: string; secondary?: string }>;
  depth: number;
  empty: string;
}) {
  if (rows.length === 0) {
    return (
      <p className="py-1 text-[11px] text-subtle" style={{ paddingLeft: depth * 12 + 24 }}>
        {empty}
      </p>
    );
  }
  return (
    <>
      {rows.map((row) => (
        <Row
          key={row.key}
          depth={depth}
          icon={row.icon}
          label={row.label}
          secondary={row.secondary}
          title={row.secondary}
        />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createQueryTab(
  sessionId: string,
  scope: Scope,
  sql = "",
  title = "Query",
) {
  useTabs.getState().open({ kind: "query", sessionId, scope, sql, title });
}

async function reloadParent(sessionId: string, scope: Scope) {
  try {
    await useExplorer.getState().objects(sessionId, scope, true);
  } catch {
    /* the node may have been removed; a later refresh will settle it */
  }
}

async function dropDatabase(sessionId: string, database: string) {
  try {
    await ipc.schema.dropDatabase(sessionId, database);
    toast.success(`Database ${database} dropped`);
    useExplorer.getState().invalidate(databaseKey(sessionId));
  } catch (error) {
    toast.error(toErrorPayload(error).message);
  }
}

/** `schema.table` / `db.table`, quoted for the dialect. */
function qualify(scope: Scope, name: string, kind: DbKind): string {
  const quote = (value: string) =>
    kind === "mysql" ? `\`${value}\`` : `"${value.replace(/"/g, '""')}"`;
  const parts = [scope.database, scope.schema, name].filter(
    (part): part is string => !!part && part.length > 0,
  );
  // MySQL treats the first part as the database; PostgreSQL wants schema.table.
  const trimmed = kind === "mysql" ? parts.slice(-2) : parts.slice(-2);
  return trimmed.map(quote).join(".");
}

function formatBytesShort(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  const units = ["K", "M", "G", "T"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 10 ? 0 : 1)}${units[unit]}`;
}

/** Hidden helper kept for symmetry with the Rust-side system-schema rules. */
export function isSystemDatabase(kind: DbKind, name: string): boolean {
  return isSystemSchema(kind, name);
}
