/**
 * The columns grid.
 *
 * Every row is a working copy of a column plus one piece of bookkeeping the grid
 * does not show: `originalName`, the name the server knows the column by. The
 * backend diff uses it to tell a rename ("ALTER COLUMN … RENAME TO") apart from
 * a drop plus an add, which would throw the data away. Deleting a row is
 * likewise not a removal — it flips `dropped`, so the column stays visible to
 * the diff and, on SQLite, still gets copied across during a table rebuild.
 */

import * as React from "react";
import {
  ArrowDown,
  ArrowUp,
  Copy,
  Lock,
  Plus,
  Trash2,
  Undo2,
} from "lucide-react";

import type { ColumnPlan, DbKind } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button, IconButton, Input } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlays";

import { Note, TypeCombobox } from "./ui";
import {
  autoIncrementTypeFor,
  baseType,
  enumMemberString,
  parseEnumMembers,
  typeArguments,
  typeImpliesAutoIncrement,
  typeUsesEnumValues,
  withTypeArguments,
} from "./types";

/**
 * One grid definition for the header and every row so the columns line up.
 * `min-w` on the wrapper keeps the numeric columns reachable on narrow panels.
 */
const GRID =
  "grid min-w-[56rem] grid-cols-[1.5rem_minmax(7rem,1.1fr)_minmax(10rem,1.2fr)_4.5rem_minmax(6rem,1fr)_minmax(5rem,0.9fr)_2.5rem_2.5rem_2.5rem_2.5rem_5.5rem] items-center gap-1.5 px-2";

const CAPTION = "text-[10px] font-semibold uppercase tracking-wide text-subtle";

function ToggleHeader({ label, title }: { label: string; title: string }) {
  return (
    <Tooltip content={title}>
      <span className={cn(CAPTION, "cursor-default text-center")}>{label}</span>
    </Tooltip>
  );
}

export interface ColumnEditorProps {
  columns: ColumnPlan[];
  kind: DbKind;
  /** Index of the expanded row, or `null` when every row is collapsed. */
  expanded: number | null;
  onExpandedChange: (index: number | null) => void;
  onChange: (columns: ColumnPlan[]) => void;
  disabled?: boolean;
}

export function ColumnEditor({
  columns,
  kind,
  expanded,
  onExpandedChange,
  onChange,
  disabled = false,
}: ColumnEditorProps) {
  const patch = (index: number, changes: Partial<ColumnPlan>) => {
    onChange(columns.map((column, at) => (at === index ? { ...column, ...changes } : column)));
  };

  /** Type edits keep the enum member list in step with an enum/set type. */
  const setType = (index: number, dataType: string) => {
    const column = columns[index];
    if (!column) return;
    if (typeUsesEnumValues(kind, dataType)) {
      const members =
        column.enumValues.length > 0 ? column.enumValues : parseEnumMembers(dataType);
      patch(index, { dataType, enumValues: members });
    } else {
      patch(index, { dataType });
    }
  };

  const setEnumMembers = (index: number, members: string[]) => {
    const column = columns[index];
    if (!column) return;
    const keyword = kind === "sqlite" ? "TEXT" : kind === "postgres" ? "enum" : baseType(column.dataType);
    patch(index, {
      enumValues: members,
      dataType:
        kind === "sqlite" ? "TEXT" : `${keyword === "set" ? "set" : "enum"}(${enumMemberString(members)})`,
    });
  };

  /** A primary key cannot be nullable, so the two toggles move together. */
  const togglePrimaryKey = (index: number, checked: boolean) => {
    if (checked) patch(index, { isPrimaryKey: true, nullable: false });
    else patch(index, { isPrimaryKey: false });
  };

  const toggleAutoIncrement = (index: number, checked: boolean) => {
    const column = columns[index];
    if (!column) return;
    if (checked && !typeImpliesAutoIncrement(kind, column.dataType) && kind !== "sqlite") {
      // MySQL and PostgreSQL both spell auto-increment into the type.
      patch(index, { isAutoIncrement: true, dataType: autoIncrementTypeFor(kind) });
      return;
    }
    patch(index, { isAutoIncrement: checked });
  };

  const move = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= columns.length) return;
    const next = [...columns];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    onChange(next);
    if (expanded === index) onExpandedChange(target);
    else if (expanded === target) onExpandedChange(index);
  };

  const duplicate = (index: number) => {
    const source = columns[index];
    if (!source) return;
    const taken = new Set(columns.map((column) => column.name));
    const copy: ColumnPlan = {
      ...source,
      name: uniqueName(`${source.name}_copy`, taken),
      // The copy is a new column, so it must not inherit the server's name.
      originalName: null,
      dropped: false,
      // Engines allow one auto-increment column per table.
      isAutoIncrement: false,
      enumValues: [...source.enumValues],
    };
    const next = [...columns];
    next.splice(index + 1, 0, copy);
    onChange(next);
    onExpandedChange(index + 1);
  };

  const remove = (index: number) => {
    const column = columns[index];
    if (!column) return;
    if (column.originalName) {
      // Keep the entry: the diff needs it to emit DROP COLUMN.
      patch(index, { dropped: true });
      onExpandedChange(index);
    } else {
      onChange(columns.filter((_, at) => at !== index));
      onExpandedChange(null);
    }
  };

  const addColumn = () => {
    const taken = new Set(columns.map((column) => column.name));
    const column: ColumnPlan = {
      name: uniqueName("column", taken),
      dataType: kind === "sqlite" ? "TEXT" : kind === "mysql" ? "VARCHAR(255)" : "text",
      nullable: true,
      defaultValue: null,
      isPrimaryKey: false,
      isAutoIncrement: false,
      isUnique: false,
      comment: null,
      originalName: null,
      dropped: false,
      enumValues: [],
    };
    onChange([...columns, column]);
    onExpandedChange(columns.length);
  };

  const droppedCount = columns.filter((column) => column.dropped).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 overflow-x-auto scrollbar-thin border-b border-border bg-raised">
        <div className={cn(GRID, "h-8")}>
          <span className={cn(CAPTION, "text-center")}>#</span>
          <span className={CAPTION}>Name</span>
          <span className={CAPTION}>Type</span>
          <span className={CAPTION}>Size</span>
          <span className={CAPTION}>Default</span>
          <span className={CAPTION}>Comment</span>
          <ToggleHeader label="Null" title="Allow NULL values" />
          <ToggleHeader label="PK" title="Part of the primary key" />
          <ToggleHeader label="AI" title="Auto-increment" />
          <ToggleHeader label="UQ" title="Unique" />
          <span className={cn(CAPTION, "text-center")}>Row</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        {columns.length === 0 ? (
          <p className="px-4 py-6 text-center text-xs text-subtle">
            A table needs at least one column.
          </p>
        ) : null}

        {columns.map((column, index) => {
          const sized = typeArguments(column.dataType).length > 0;
          const problem = validateName(column.name, columns, index);
          return (
            <div
              key={keyFor(column, index)}
              className={cn(
                "border-b border-border/60",
                column.dropped && "bg-sunken/60",
                expanded === index && "bg-accent-soft/40",
              )}
            >
              <div
                className={cn(GRID, "min-h-8 py-0.5", column.dropped && "opacity-60")}
                data-designer-row="column"
              >
                <span className="text-center text-[10px] tabular-nums text-subtle">
                  {index + 1}
                </span>

                <div className="relative">
                  <Input
                    value={column.name}
                    disabled={disabled || column.dropped}
                    aria-label={`Column ${index + 1} name`}
                    aria-invalid={problem !== null}
                    spellCheck={false}
                    onChange={(event) => patch(index, { name: event.target.value })}
                    className={cn(
                      "h-7 px-1.5 font-mono text-[12px]",
                      column.originalName && column.originalName !== column.name && "pr-5",
                      problem !== null && "border-danger",
                    )}
                  />
                  {column.originalName && column.originalName !== column.name ? (
                    <Tooltip
                      side="top"
                      content={`Renamed from ${column.originalName} — sent as a rename, not a drop and re-add`}
                    >
                      <span className="absolute right-1.5 top-1.5 text-accent">
                        <Undo2 className="size-3" />
                      </span>
                    </Tooltip>
                  ) : null}
                </div>

                <TypeCombobox
                  kind={kind}
                  value={column.dataType}
                  disabled={disabled || column.dropped}
                  aria-label={`Column ${index + 1} type`}
                  onChange={(value) => setType(index, value)}
                />

                <Input
                  value={sized ? typeArguments(column.dataType) : ""}
                  disabled={disabled || column.dropped || !sized}
                  placeholder="—"
                  aria-label={`Column ${index + 1} size`}
                  spellCheck={false}
                  onChange={(event) =>
                    patch(index, {
                      dataType: withTypeArguments(column.dataType, event.target.value),
                    })
                  }
                  className="h-7 px-1.5 font-mono text-[11px]"
                />

                <Input
                  value={column.defaultValue ?? ""}
                  disabled={disabled || column.dropped}
                  placeholder="NULL"
                  aria-label={`Column ${index + 1} default`}
                  spellCheck={false}
                  onChange={(event) => patch(index, { defaultValue: event.target.value || null })}
                  className="h-7 px-1.5 font-mono text-[11px]"
                />

                <Input
                  value={column.comment ?? ""}
                  disabled={disabled || column.dropped}
                  placeholder="—"
                  aria-label={`Column ${index + 1} comment`}
                  onChange={(event) => patch(index, { comment: event.target.value || null })}
                  className="h-7 px-1.5 text-[11px]"
                />

                <RowToggle
                  checked={column.nullable}
                  disabled={disabled || column.dropped}
                  label={`Column ${column.name || index + 1} allows NULL`}
                  onChange={(checked) => patch(index, { nullable: checked })}
                />
                <RowToggle
                  checked={column.isPrimaryKey}
                  disabled={disabled || column.dropped}
                  label={`Column ${column.name || index + 1} is part of the primary key`}
                  onChange={(checked) => togglePrimaryKey(index, checked)}
                />
                <RowToggle
                  checked={column.isAutoIncrement}
                  disabled={disabled || column.dropped}
                  label={`Column ${column.name || index + 1} auto-increments`}
                  onChange={(checked) => toggleAutoIncrement(index, checked)}
                />
                <RowToggle
                  checked={column.isUnique}
                  disabled={disabled || column.dropped || column.isPrimaryKey}
                  label={`Column ${column.name || index + 1} is unique`}
                  onChange={(checked) => patch(index, { isUnique: checked })}
                />

                <div className="flex items-center justify-end gap-0.5">
                  <IconButton
                    label="Move up"
                    disabled={disabled || index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Move down"
                    disabled={disabled || index === columns.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown className="size-3.5" />
                  </IconButton>
                  <IconButton
                    label="Duplicate column"
                    disabled={disabled}
                    onClick={() => duplicate(index)}
                  >
                    <Copy className="size-3.5" />
                  </IconButton>
                  {column.dropped ? (
                    <IconButton
                      label="Restore column"
                      disabled={disabled}
                      onClick={() => patch(index, { dropped: false })}
                    >
                      <Undo2 className="size-3.5" />
                    </IconButton>
                  ) : (
                    <IconButton
                      label="Delete column"
                      disabled={disabled}
                      onClick={() => remove(index)}
                      className="text-danger hover:bg-danger-soft hover:text-danger"
                    >
                      <Trash2 className="size-3.5" />
                    </IconButton>
                  )}
                </div>
              </div>

              {expanded === index ? (
                <div className="flex flex-col gap-2.5 border-t border-border/70 bg-surface px-4 py-3">
                  {column.dropped ? (
                    <Note tone="danger">
                      <Trash2 className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        Pending drop. The column stays in the list so the diff emits{" "}
                        <code className="font-mono">DROP COLUMN</code> for the server's column
                        instead of forgetting it existed.
                      </span>
                    </Note>
                  ) : null}

                  {column.isAutoIncrement &&
                  typeImpliesAutoIncrement(kind, column.dataType) ? (
                    <Note>
                      <Lock className="mt-0.5 size-3.5 shrink-0" />
                      <span>
                        <code className="font-mono">{baseType(column.dataType)}</code> already
                        implies auto-increment, so no extra clause is generated.
                      </span>
                    </Note>
                  ) : null}

                  <dl className="grid grid-cols-2 gap-x-6 gap-y-1 text-[11px]">
                    <div className="flex justify-between gap-3">
                      <dt className="text-subtle">Type arguments</dt>
                      <dd className="truncate font-mono text-muted">
                        {typeArguments(column.dataType) || "—"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-subtle">Original name</dt>
                      <dd className="truncate font-mono text-muted">
                        {column.originalName ?? "not on the server yet"}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-subtle">Position</dt>
                      <dd className="font-mono text-muted">
                        {index + 1} of {columns.length}
                      </dd>
                    </div>
                    <div className="flex justify-between gap-3">
                      <dt className="text-subtle">Constraints</dt>
                      <dd className="text-muted">
                        {column.nullable ? "nullable" : "NOT NULL"}
                        {column.isPrimaryKey ? " · primary key" : ""}
                        {column.isUnique ? " · unique" : ""}
                      </dd>
                    </div>
                  </dl>

                  {typeUsesEnumValues(kind, column.dataType) ? (
                    <label className="flex flex-col gap-1.5">
                      <span className="text-xs font-medium text-muted">Members</span>
                      <MembersEditor
                        members={column.enumValues}
                        disabled={disabled || column.dropped}
                        onChange={(members) => setEnumMembers(index, members)}
                      />
                      <span className="text-[11px] text-subtle">
                        Written into the type as{" "}
                        <code className="font-mono">{column.dataType || "—"}</code>.
                      </span>
                    </label>
                  ) : null}

                  {problem ? (
                    <p className="text-[11px] text-danger">{problem}</p>
                  ) : null}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-raised px-2">
        <Button size="xs" variant="secondary" disabled={disabled} onClick={addColumn}>
          <Plus className="size-3.5" /> Add column
        </Button>
        <span className="flex-1" />
        <span className="text-[11px] text-subtle">
          {columns.length} column{columns.length === 1 ? "" : "s"}
          {droppedCount > 0 ? ` · ${droppedCount} pending drop` : ""}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pieces
// ---------------------------------------------------------------------------

/** A bare checkbox: the grid's toggle columns need no extra chrome. */
function RowToggle({
  checked,
  disabled,
  label,
  onChange,
}: {
  checked: boolean;
  disabled?: boolean;
  label: string;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex justify-center">
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
        className="size-3.5 accent-accent disabled:opacity-40"
      />
    </div>
  );
}

/**
 * Comma separated enum members, kept as raw text while the user types so a
 * trailing comma or space is not eaten mid-keystroke.
 */
function MembersEditor({
  members,
  disabled,
  onChange,
}: {
  members: string[];
  disabled?: boolean;
  onChange: (members: string[]) => void;
}) {
  const [text, setText] = React.useState(() => members.join(", "));
  const pushed = React.useRef(members.join(", "));

  // Adopt changes that came from elsewhere (another row expanded, type switch)
  // without fighting the user's own keystrokes.
  React.useEffect(() => {
    const joined = members.join(", ");
    if (joined !== pushed.current) {
      pushed.current = joined;
      setText(joined);
    }
  }, [members]);

  return (
    <Input
      value={text}
      disabled={disabled}
      spellCheck={false}
      placeholder="draft, published, archived"
      aria-label="Enum members"
      onChange={(event) => {
        setText(event.target.value);
        const next = event.target.value
          .split(",")
          .map((member) => member.trim())
          .filter(Boolean);
        pushed.current = next.join(", ");
        onChange(next);
      }}
      className="h-7 font-mono text-[12px]"
    />
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** A key that survives reordering and renaming. */
function keyFor(column: ColumnPlan, index: number): string {
  return `${column.originalName ?? "new"}:${index}`;
}

function uniqueName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}

/** Empty or duplicated names produce DDL the server rejects. */
function validateName(
  name: string,
  columns: readonly ColumnPlan[],
  index: number,
): string | null {
  if (!name.trim()) return `Column ${index + 1} needs a name`;
  const others = columns.filter((_, at) => at !== index).map((column) => column.name);
  if (others.includes(name)) return `Duplicate column name "${name}"`;
  return null;
}
