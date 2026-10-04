/**
 * The editable data grid.
 *
 * Layout note: the header and the filter row live in their own clipped strip
 * above the scroller and follow its `scrollLeft`, so the virtualizer only ever
 * measures the row list. Sticky headers would work too, but they shift every
 * virtual row by the height of the chrome, which the range math would then have
 * to compensate for.
 */

import * as React from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
  Code2,
  Copy,
  Eye,
  Filter,
  Lock,
  Plus,
  RefreshCw,
  Table2,
  Trash2,
  X,
} from "lucide-react";
import { toast } from "sonner";

import {
  Badge,
  Button,
  CheckboxField,
  EmptyState,
  IconButton,
  NativeSelect,
  Separator,
  Spinner,
  Textarea,
  Toolbar,
  ToolbarSpacer,
} from "@/components/ui/primitives";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuTrigger,
  useConfirm,
} from "@/components/ui/overlays";
import { ipc } from "@/lib/ipc";
import {
  type CellChange,
  type ColumnMeta,
  type ObjectKind,
  NULL_VALUE,
  type RowEdit,
  type RowInsert,
  type Scope,
  type Value,
  isNull,
  makeValue,
  objectKindLabel,
  toErrorPayload,
} from "@/lib/types";
import { cn, formatCount, formatDuration, shortType } from "@/lib/utils";
import { useSettings } from "@/store/settings";

import { CellEditor, type CellEditorCommit, type EditMove } from "./CellEditor";
import { CellViewer } from "./CellViewer";
import { InsertRowDialog } from "./InsertRowDialog";
import {
  FILTER_HEIGHT,
  HEADER_HEIGHT,
  OVERSCAN,
  ROW_HEIGHT,
  canEditColumn,
  displayText,
  extractRowKeys,
  isLongValue,
  isNumericValue,
  rangeLabel,
  valueEquals,
} from "./gridModel";
import { PAGE_SIZES, useTableData } from "./useTableData";
import { useGridSelection } from "./useGridSelection";

export interface DataGridProps {
  sessionId: string;
  scope: Scope;
  table: string;
  objectKind?: ObjectKind;
  /** Called after a successful write so the explorer can refresh counts. */
  onMutated?: () => void;
}

/** Which cell is being edited, and the keystroke that started it. */
interface EditTarget {
  row: number;
  col: number;
  seed?: string;
}

/** Which cell the value viewer is showing. */
interface ViewTarget {
  row: number;
  col: number;
}

/** Module-level constants keep memo identities stable between renders. */
const EMPTY_ROWS: Value[][] = [];
const EMPTY_COLUMNS: ColumnMeta[] = [];

/** Cell chrome: NULLs are quiet, the selection is tinted, the cursor is ringed. */
function cellClassName(options: {
  selected: boolean;
  focused: boolean;
  numeric: boolean;
  nullish: boolean;
}): string {
  const { selected, focused, numeric, nullish } = options;
  return cn(
    "relative flex h-full shrink-0 items-center border-b border-r border-border px-1.5 text-[12px] leading-none",
    // Alignment lives on the value span, which fills the cell; numbers add
    // `text-right` there so they stay right-aligned while truncating.
    numeric && "tnum",
    nullish ? "italic text-grid-null" : "text-fg",
    selected ? "bg-grid-selected" : "group-hover/row:bg-grid-hover",
    focused && "ring-1 ring-inset ring-accent/70",
  );
}

export function DataGrid({
  sessionId,
  scope,
  table,
  objectKind,
  onMutated,
}: DataGridProps): React.ReactElement {
  const nullDisplay = useSettings((state) => state.settings.nullDisplay);
  const defaultPageSize = useSettings((state) => state.settings.defaultPageSize);
  const truncateCellChars = useSettings((state) => state.settings.truncateCellChars);
  const confirmDestructive = useSettings((state) => state.settings.confirmDestructive);
  const confirm = useConfirm();

  const data = useTableData({ sessionId, scope, table, defaultLimit: defaultPageSize });
  const { page, columns: gridColumns, loading, error } = data;
  const rows = page?.rows ?? EMPTY_ROWS;
  const rowCount = rows.length;
  const columnCount = gridColumns.length;
  const totalWidth = React.useMemo(
    () => gridColumns.reduce((sum, column) => sum + column.width, 0),
    [gridColumns],
  );

  const [editing, setEditing] = React.useState<EditTarget | null>(null);
  const [viewer, setViewer] = React.useState<ViewTarget | null>(null);
  const [insertOpen, setInsertOpen] = React.useState(false);
  const [showFilters, setShowFilters] = React.useState(true);
  const [showSql, setShowSql] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const scrollRef = React.useRef<HTMLDivElement | null>(null);
  const headerRef = React.useRef<HTMLDivElement | null>(null);
  const bodyRef = React.useRef<HTMLDivElement | null>(null);

  /** Text of one cell as the user sees it, for the clipboard. */
  const cellText = React.useCallback(
    (row: number, col: number): string => {
      const column = gridColumns[col];
      if (!column) return "";
      return displayText(rows[row]?.[column.index], nullDisplay);
    },
    [gridColumns, rows, nullDisplay],
  );

  const selection = useGridSelection({ rowCount, columnCount, cellText });

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: OVERSCAN,
  });
  const virtualItems = virtualizer.getVirtualItems();
  // Used to decide whether the floating multi-line editor has room below.
  const lastVisible = virtualItems.length > 0 ? virtualItems[virtualItems.length - 1].index : 0;

  const focusGrid = () => bodyRef.current?.focus({ preventScroll: true });

  /** The header strip is not scrollable; it copies the body's scroll position. */
  const syncHeaderScroll = () => {
    const body = scrollRef.current;
    const header = headerRef.current;
    if (body && header) header.scrollLeft = body.scrollLeft;
  };

  /** Wheeling over the header should scroll the rows, as it does over the rows. */
  const forwardWheel = (event: React.WheelEvent<HTMLDivElement>) => {
    const body = scrollRef.current;
    if (!body) return;
    body.scrollTop += event.deltaY;
    body.scrollLeft += event.deltaX;
  };

  // -------------------------------------------------------------------------
  // Effects
  // -------------------------------------------------------------------------

  // Keep the cursor row inside the viewport after a keyboard move or a click.
  React.useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;
    const top = selection.focus.row * ROW_HEIGHT;
    const bottom = top + ROW_HEIGHT;
    if (top < element.scrollTop) {
      element.scrollTop = top;
    } else if (bottom > element.scrollTop + element.clientHeight) {
      element.scrollTop = bottom - element.clientHeight;
    }
  }, [selection.focus]);

  // A fresh page invalidates whatever editor was open against the old rows.
  React.useEffect(() => {
    setEditing(null);
  }, [page]);

  const openViewer = React.useCallback((row: number, col: number) => {
    setViewer({ row, col });
  }, []);

  const startEdit = React.useCallback(
    (row: number, col: number, seed?: string) => {
      const column = gridColumns[col];
      if (!data.editable || !column || !rows[row]) return;
      if (!canEditColumn(column.meta)) {
        // Binary cannot survive a text editor, so show it instead.
        openViewer(row, col);
        return;
      }
      setEditing({ row, col, seed });
    },
    [data.editable, gridColumns, rows, openViewer],
  );

  const copySelection = async () => {
    try {
      const count = await selection.copy();
      if (count > 0) toast.success(`Copied ${formatCount(count)} cells`);
    } catch {
      toast.error("Clipboard is unavailable");
    }
  };

  // -------------------------------------------------------------------------
  // Keyboard
  // -------------------------------------------------------------------------

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    // While an editor is open it owns the keyboard.
    if (editing) return;
    const mod = event.ctrlKey || event.metaKey;

    if (mod && (event.key === "a" || event.key === "A")) {
      event.preventDefault();
      selection.selectAll();
      return;
    }
    if (mod && (event.key === "c" || event.key === "C")) {
      event.preventDefault();
      void copySelection();
      return;
    }
    if (mod && event.key === "Enter") {
      event.preventDefault();
      openViewer(selection.focus.row, selection.focus.col);
      return;
    }
    if (event.key === "Escape") {
      selection.clear();
      return;
    }

    switch (event.key) {
      case "ArrowUp":
        event.preventDefault();
        selection.move(-1, 0, event.shiftKey);
        return;
      case "ArrowDown":
        event.preventDefault();
        selection.move(1, 0, event.shiftKey);
        return;
      case "ArrowLeft":
        event.preventDefault();
        selection.move(0, -1, event.shiftKey);
        return;
      case "ArrowRight":
        event.preventDefault();
        selection.move(0, 1, event.shiftKey);
        return;
      case "Tab":
        event.preventDefault();
        selection.moveTab(event.shiftKey ? -1 : 1);
        return;
      case "Enter":
        // Enter moves down, the way every spreadsheet does.
        event.preventDefault();
        selection.move(event.shiftKey ? -1 : 1, 0, false);
        return;
      default:
        break;
    }

    // Typing over a cell starts an edit seeded with that character.
    if (!mod && !event.altKey && event.key.length === 1 && data.editable) {
      event.preventDefault();
      startEdit(selection.focus.row, selection.focus.col, event.key);
    }
  };

  // -------------------------------------------------------------------------
  // Writes
  // -------------------------------------------------------------------------

  const applyMove = (move: EditMove | null) => {
    if (move === "down") selection.move(1, 0, false);
    else if (move === "up") selection.move(-1, 0, false);
    else if (move === "next") selection.moveTab(1);
    else if (move === "prev") selection.moveTab(-1);
    focusGrid();
  };

  /** One place where a write reports success, failure and the refresh. */
  const runWrite = async (work: () => Promise<void>, success: string) => {
    setBusy(true);
    try {
      await work();
      toast.success(success);
      onMutated?.();
      data.refresh();
    } catch (caught) {
      toast.error(toErrorPayload(caught).message);
      throw caught;
    } finally {
      setBusy(false);
    }
  };

  const buildKeys = (row: number): Record<string, Value> | null => {
    if (!page || !rows[row]) return null;
    return extractRowKeys(page, rows[row]);
  };

  const commitEdit = async (target: EditTarget, commit: CellEditorCommit) => {
    const column = gridColumns[target.col];
    setEditing(null);
    // Move first: waiting for the round trip before moving feels broken.
    applyMove(commit.move);
    if (!column || !page) return;

    const oldValue = rows[target.row]?.[column.index] ?? NULL_VALUE;
    const newValue = commit.asNull ? NULL_VALUE : makeValue(commit.text, column.meta.logicalType);
    if (valueEquals(oldValue, newValue)) return;

    const keys = buildKeys(target.row);
    if (!keys) {
      toast.error("Cannot update: this page does not carry the row's key columns.");
      return;
    }

    const change: CellChange = { column: column.meta.name, oldValue, newValue };
    const edit: RowEdit = {
      database: scope.database ?? null,
      schema: scope.schema ?? null,
      table,
      keys,
      changes: [change],
    };
    try {
      await runWrite(async () => {
        await ipc.data.update(sessionId, edit);
      }, `${column.meta.name} updated`);
    } catch {
      /* already reported through the toast */
    }
  };

  const insertRow = async (values: Record<string, Value>) => {
    const insert: RowInsert = {
      database: scope.database ?? null,
      schema: scope.schema ?? null,
      table,
      values,
    };
    await runWrite(async () => {
      await ipc.data.insert(sessionId, insert);
    }, "Row inserted");
  };

  const deleteRow = async (row: number) => {
    const keys = buildKeys(row);
    if (!keys) {
      toast.error("Cannot delete: this page does not carry the row's key columns.");
      return;
    }
    if (confirmDestructive) {
      const ok = await confirm({
        title: "Delete row?",
        description: "The row is removed from the table. This cannot be undone.",
        confirmLabel: "Delete",
        tone: "danger",
      });
      if (!ok) return;
    }
    const edit: RowEdit = {
      database: scope.database ?? null,
      schema: scope.schema ?? null,
      table,
      keys,
      // Deletes are addressed by `keys`; the change list is for updates.
      changes: [],
    };
    try {
      await runWrite(async () => {
        await ipc.data.remove(sessionId, edit);
      }, "Row deleted");
    } catch {
      /* already reported through the toast */
    }
  };

  const duplicateRow = async (row: number) => {
    const keys = buildKeys(row);
    if (!keys) {
      toast.error("Cannot duplicate: this page does not carry the row's key columns.");
      return;
    }
    try {
      await runWrite(async () => {
        await ipc.data.duplicate(sessionId, scope, table, keys);
      }, "Row duplicated");
    } catch {
      /* already reported through the toast */
    }
  };

  // -------------------------------------------------------------------------
  // Derived values
  // -------------------------------------------------------------------------

  const pageSizes = React.useMemo(() => {
    const sizes = PAGE_SIZES.includes(data.limit) ? [...PAGE_SIZES] : [...PAGE_SIZES, data.limit];
    return sizes.sort((left, right) => left - right);
  }, [data.limit]);

  const range = rangeLabel(data.offset, rowCount, data.totalRows);
  const longThreshold = truncateCellChars > 0 ? truncateCellChars : 120;
  const viewerColumn = viewer ? (gridColumns[viewer.col]?.meta ?? null) : null;
  const viewerValue = viewer
    ? (rows[viewer.row]?.[gridColumns[viewer.col]?.index ?? -1] ?? null)
    : null;
  const openAbove = editing !== null && editing.row > lastVisible - 3;
  const canWrite = data.editable && !busy;

  // -------------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------------

  return (
    <div className="flex h-full min-h-0 flex-col bg-surface text-fg">
      <Toolbar>
        <div className="flex min-w-0 items-center gap-1.5 pl-1">
          <Table2 className="size-3.5 shrink-0 text-muted" />
          <span className="truncate text-xs font-semibold text-fg">{table}</span>
          {objectKind ? (
            <span className="shrink-0 text-[11px] text-subtle">
              · {objectKindLabel(objectKind)}
            </span>
          ) : null}
        </div>

        <Separator orientation="vertical" className="mx-1.5 h-5" />

        <Button size="xs" disabled={!canWrite} onClick={() => setInsertOpen(true)}>
          <Plus className="size-3.5" />
          Insert
        </Button>
        <Button
          size="xs"
          disabled={!canWrite}
          onClick={() => void duplicateRow(selection.focus.row)}
        >
          <Copy className="size-3.5" />
          Duplicate
        </Button>
        <Button
          size="xs"
          disabled={!canWrite}
          onClick={() => void deleteRow(selection.focus.row)}
        >
          <Trash2 className="size-3.5" />
          Delete
        </Button>
        <Button size="xs" disabled={loading} onClick={data.refresh} title="Reload this page">
          <RefreshCw className={cn("size-3.5", loading && "animate-spin-slow")} />
          Refresh
        </Button>

        <ToolbarSpacer />

        {loading ? <Spinner className="mr-1 size-3.5" /> : null}
        <CheckboxField
          checked={data.includeTotal}
          onCheckedChange={data.setIncludeTotal}
          label="Count total"
          className="mr-1.5 items-center"
        />
        <Button
          size="xs"
          variant={showFilters ? "subtle" : "ghost"}
          onClick={() => setShowFilters((current) => !current)}
        >
          <Filter className="size-3.5" />
          Filters
        </Button>
        {data.filtersActive ? (
          <IconButton label="Clear filters" onClick={data.clearFilters}>
            <X className="size-3.5" />
          </IconButton>
        ) : null}
        <Button
          size="xs"
          variant={showSql ? "subtle" : "ghost"}
          onClick={() => setShowSql((current) => !current)}
        >
          <Code2 className="size-3.5" />
          SQL
        </Button>
      </Toolbar>

      {page && !page.editable ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-border bg-sunken px-3 py-1.5 text-[11px] text-muted">
          <Lock className="size-3 shrink-0" />
          <span className="truncate">
            Read-only: {page.reason ?? "this relation cannot be edited from the grid."}
          </span>
        </div>
      ) : null}

      {error ? (
        <div className="flex shrink-0 items-center gap-2 border-b border-danger/30 bg-danger-soft px-3 py-1.5 text-[12px] text-danger">
          <AlertTriangle className="size-3.5 shrink-0" />
          <span className="min-w-0 flex-1 truncate" title={error.detail ?? undefined}>
            {error.message}
          </span>
          <Button size="xs" variant="outline" onClick={data.retry}>
            Retry
          </Button>
        </div>
      ) : null}

      {showSql ? (
        <div className="shrink-0 border-b border-border bg-sunken px-3 py-2">
          <div className="flex items-start gap-2">
            <span className="mt-1 w-14 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-subtle">
              Where
            </span>
            <Textarea
              value={data.whereText}
              onChange={(event) => data.setWhereText(event.target.value)}
              placeholder="status = 'open' AND created_at > '2024-01-01'"
              spellCheck={false}
              className="h-16 font-mono text-[11px]"
            />
          </div>
          <div className="mt-2 flex items-start gap-2">
            <span className="mt-1 w-14 shrink-0 text-[10px] font-semibold uppercase tracking-wide text-subtle">
              SQL
            </span>
            <pre className="max-h-28 min-w-0 flex-1 selectable overflow-auto scrollbar-thin rounded-md border border-border bg-surface p-2 font-mono text-[11px] leading-relaxed text-muted">
              {page?.sql ?? "—"}
            </pre>
          </div>
        </div>
      ) : null}

      <div className="flex min-h-0 flex-1 flex-col">
        <div
          ref={headerRef}
          onWheel={forwardWheel}
          className="shrink-0 overflow-hidden border-b border-border-strong bg-grid-header"
        >
          <div style={{ width: totalWidth > 0 ? totalWidth : undefined }}>
            <div
              role="row"
              className="flex"
              style={{ height: HEADER_HEIGHT, width: totalWidth }}
            >
              {gridColumns.map((column, index) => {
                const orderIndex = data.orderBy.findIndex(
                  (order) => order.column === column.meta.name,
                );
                const order = orderIndex >= 0 ? data.orderBy[orderIndex] : undefined;
                return (
                  <button
                    key={column.meta.name}
                    type="button"
                    role="columnheader"
                    aria-colindex={index + 1}
                    aria-sort={order ? (order.desc ? "descending" : "ascending") : "none"}
                    onClick={(event) => data.toggleSort(column.meta.name, event.shiftKey)}
                    title={`${column.meta.name} · ${column.meta.typeName}${
                      column.meta.isPrimaryKey ? " · primary key" : ""
                    }`}
                    className="flex h-full shrink-0 items-center gap-1 overflow-hidden border-r border-border px-2 text-left hover:bg-hover"
                    style={{ width: column.width }}
                  >
                    <span className="truncate text-[11px] font-semibold text-fg">
                      {column.meta.name}
                    </span>
                    {column.meta.isPrimaryKey ? (
                      <span className="shrink-0 rounded-xs bg-accent-soft px-1 text-[9px] font-semibold uppercase text-accent">
                        pk
                      </span>
                    ) : null}
                    <span className="min-w-0 flex-1 truncate text-[10px] text-subtle">
                      {shortType(column.meta.typeName)}
                    </span>
                    {order ? (
                      <span className="flex shrink-0 items-center gap-0.5 text-accent">
                        {order.desc ? (
                          <ArrowDown className="size-3" />
                        ) : (
                          <ArrowUp className="size-3" />
                        )}
                        {data.orderBy.length > 1 ? (
                          <span className="text-[9px]">{orderIndex + 1}</span>
                        ) : null}
                      </span>
                    ) : null}
                  </button>
                );
              })}
            </div>

            {showFilters ? (
              <div
                role="row"
                className="flex border-t border-border bg-raised"
                style={{ height: FILTER_HEIGHT, width: totalWidth }}
              >
                {gridColumns.map((column) => (
                  <div
                    key={column.meta.name}
                    className="flex h-full shrink-0 items-center border-r border-border px-1"
                    style={{ width: column.width }}
                  >
                    <input
                      value={data.filterText[column.meta.name] ?? ""}
                      onChange={(event) =>
                        data.setFilterText(column.meta.name, event.target.value)
                      }
                      placeholder="filter…"
                      aria-label={`Filter ${column.meta.name}`}
                      spellCheck={false}
                      autoComplete="off"
                      className="h-5 w-full min-w-0 rounded-xs border border-transparent bg-surface px-1 text-[11px] text-fg placeholder:text-subtle focus:border-accent focus:outline-none"
                    />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
        </div>

        <div
          ref={scrollRef}
          onScroll={syncHeaderScroll}
          className="min-h-0 flex-1 overflow-auto scrollbar-thin"
        >
          <ContextMenu>
            <ContextMenuTrigger asChild>
              <div
                ref={bodyRef}
                role="grid"
                tabIndex={0}
                aria-label={`${table} data`}
                aria-rowcount={rowCount}
                aria-colcount={columnCount}
                aria-busy={loading}
                onKeyDown={handleKeyDown}
                className="relative outline-none"
                style={{ width: totalWidth, height: virtualizer.getTotalSize() }}
              >
                {virtualItems.map((virtualRow) => {
                  const rowIndex = virtualRow.index;
                  const row = rows[rowIndex];
                  if (!row) return null;
                  return (
                    <div
                      key={virtualRow.key}
                      role="row"
                      aria-rowindex={rowIndex + 1}
                      className={cn(
                        "group/row absolute left-0 top-0 flex border-b border-border",
                        rowIndex % 2 === 1 && "bg-grid-alt",
                      )}
                      style={{
                        height: ROW_HEIGHT,
                        width: totalWidth,
                        transform: `translateY(${virtualRow.start}px)`,
                      }}
                    >
                      {gridColumns.map((column, colIndex) => {
                        const value = row[column.index];
                        const selected = selection.isSelected(rowIndex, colIndex);
                        const editingHere =
                          editing?.row === rowIndex && editing.col === colIndex;
                        const numeric = isNumericValue(value) || column.numeric;
                        const nullish = isNull(value);
                        const text = displayText(value, nullDisplay);
                        const title = isLongValue(value, longThreshold) ? text : undefined;
                        return (
                          <div
                            key={column.meta.name}
                            role="gridcell"
                            aria-colindex={colIndex + 1}
                            aria-selected={selected}
                            title={title}
                            onMouseDown={(event) => {
                              // Deliberately no preventDefault: an open editor
                              // needs its blur to commit the pending edit.
                              selection.setCell(
                                { row: rowIndex, col: colIndex },
                                event.shiftKey,
                              );
                              focusGrid();
                            }}
                            onDoubleClick={() => startEdit(rowIndex, colIndex)}
                            onContextMenu={() =>
                              selection.setCell({ row: rowIndex, col: colIndex }, false)
                            }
                            className={cellClassName({
                              selected,
                              focused: selection.isFocus(rowIndex, colIndex),
                              numeric,
                              nullish,
                            })}
                            style={{ width: column.width, height: ROW_HEIGHT }}
                          >
                            {/* The span fills the cell, so numbers need their own
                                text alignment rather than the container's. */}
                            <span className={cn("min-w-0 flex-1 truncate", numeric && "text-right")}>
                              {text}
                            </span>
                            {editingHere ? (
                              <CellEditor
                                key={`${rowIndex}-${colIndex}`}
                                column={column.meta}
                                value={value}
                                seed={editing.seed}
                                openAbove={openAbove}
                                onCommit={(commit) =>
                                  void commitEdit({ row: rowIndex, col: colIndex }, commit)
                                }
                                onCancel={() => {
                                  setEditing(null);
                                  focusGrid();
                                }}
                              />
                            ) : null}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </ContextMenuTrigger>
            <ContextMenuContent>
              <ContextMenuLabel>{table}</ContextMenuLabel>
              <ContextMenuItem onSelect={() => void copySelection()}>
                <Copy />
                Copy selection
              </ContextMenuItem>
              <ContextMenuItem
                onSelect={() => openViewer(selection.focus.row, selection.focus.col)}
              >
                <Eye />
                View value…
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem
                disabled={!canWrite}
                onSelect={() => void duplicateRow(selection.focus.row)}
              >
                <Copy />
                Duplicate row
              </ContextMenuItem>
              <ContextMenuItem
                disabled={!canWrite}
                onSelect={() => void deleteRow(selection.focus.row)}
              >
                <Trash2 />
                Delete row
              </ContextMenuItem>
              <ContextMenuSeparator />
              <ContextMenuItem disabled={!canWrite} onSelect={() => setInsertOpen(true)}>
                <Plus />
                Insert row…
              </ContextMenuItem>
              <ContextMenuItem onSelect={data.refresh}>
                <RefreshCw />
                Refresh
              </ContextMenuItem>
            </ContextMenuContent>
          </ContextMenu>

          {rowCount === 0 && !loading ? (
            <div className="flex h-40 items-center justify-center" style={{ width: totalWidth }}>
              <EmptyState
                icon={<Table2 />}
                title="No rows"
                description={
                  data.filtersActive
                    ? "Nothing matches the current filter."
                    : "This relation is empty."
                }
              />
            </div>
          ) : null}
        </div>
      </div>

      <footer className="flex h-7 shrink-0 items-center gap-2.5 border-t border-border bg-raised px-2 text-[11px] text-muted">
        <Badge tone={data.editable ? "success" : "neutral"}>
          {data.editable ? "Editable" : "Read-only"}
        </Badge>
        <span className="tnum">{formatCount(rowCount)} shown</span>
        <span className="tnum">{range}</span>
        <span className="tnum">{page ? formatDuration(page.elapsedMs) : "—"}</span>
        {selection.cellCount > 1 ? (
          <span className="tnum">{formatCount(selection.cellCount)} selected</span>
        ) : null}
        {busy ? <Spinner className="size-3" /> : null}

        <ToolbarSpacer />

        <IconButton label="First page" disabled={!data.canPrevious} onClick={data.firstPage}>
          <ChevronsLeft className="size-3.5" />
        </IconButton>
        <IconButton label="Previous page" disabled={!data.canPrevious} onClick={data.previousPage}>
          <ChevronLeft className="size-3.5" />
        </IconButton>
        <span className="tnum px-0.5">
          Page {formatCount(data.pageIndex + 1)}
          {data.pageCount !== null ? ` / ${formatCount(data.pageCount)}` : ""}
        </span>
        <IconButton label="Next page" disabled={!data.canNext} onClick={data.nextPage}>
          <ChevronRight className="size-3.5" />
        </IconButton>
        <IconButton label="Last page" disabled={!data.canLast} onClick={data.lastPage}>
          <ChevronsRight className="size-3.5" />
        </IconButton>
        <NativeSelect
          value={String(data.limit)}
          onChange={(event) => data.setLimit(Number(event.target.value))}
          aria-label="Rows per page"
          className="h-6 w-[84px] text-[11px]"
        >
          {pageSizes.map((size) => (
            <option key={size} value={size}>
              {formatCount(size)}
            </option>
          ))}
        </NativeSelect>
      </footer>

      <InsertRowDialog
        open={insertOpen}
        onOpenChange={setInsertOpen}
        columns={page?.columns ?? EMPTY_COLUMNS}
        table={table}
        onSubmit={insertRow}
      />

      <CellViewer
        open={viewer !== null}
        onOpenChange={(open) => {
          if (!open) setViewer(null);
        }}
        column={viewerColumn}
        value={viewerValue}
        rowNumber={viewer ? data.offset + viewer.row + 1 : null}
      />
    </div>
  );
}

export default DataGrid;
