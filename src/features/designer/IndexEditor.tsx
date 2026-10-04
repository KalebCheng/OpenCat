/**
 * The indexes tab.
 *
 * The primary-key index is shown, not edited: it belongs to the column grid,
 * which is where the backend reads it from when it renders `PRIMARY KEY (…)`.
 * Everything else can be renamed, re-ordered, dropped and restored. A dropped
 * index stays in the list with `dropped: true` for the same reason a dropped
 * column does — the diff has to be able to say `DROP INDEX`.
 */

import {
  ArrowLeft,
  ArrowRight,
  KeyRound,
  Lock,
  Plus,
  ShieldCheck,
  Trash2,
  Undo2,
} from "lucide-react";

import type { IndexPlan } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge, Button, IconButton, Input } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlays";

import { Note } from "./ui";
import { newIndexPlan } from "./plan";

const GRID =
  "grid grid-cols-[minmax(8rem,1fr)_minmax(10rem,1.4fr)_3.5rem_6.5rem] items-center gap-1.5 px-2";
const CAPTION = "text-[10px] font-semibold uppercase tracking-wide text-subtle";

export interface IndexEditorProps {
  indexes: IndexPlan[];
  /** Column names available on the table, in table order. */
  columns: readonly string[];
  /** Names of indexes that already exist on the server. */
  existingNames: ReadonlySet<string>;
  onChange: (indexes: IndexPlan[]) => void;
  disabled?: boolean;
}

export function IndexEditor({
  indexes,
  columns,
  existingNames,
  onChange,
  disabled = false,
}: IndexEditorProps) {
  const active = indexes.filter((index) => !index.dropped);
  const dropped = indexes.filter((index) => index.dropped);

  const patch = (target: IndexPlan, changes: Partial<IndexPlan>) => {
    onChange(indexes.map((index) => (index === target ? { ...index, ...changes } : index)));
  };

  const addIndex = () => {
    const taken = new Set(indexes.map((index) => index.name));
    const name = uniqueName("idx", taken);
    onChange([...indexes, newIndexPlan(name, columns.length > 0 ? [columns[0]] : [])]);
  };

  const remove = (target: IndexPlan) => {
    if (existingNames.has(target.name)) {
      // Keep the entry so the diff can emit DROP INDEX.
      patch(target, { dropped: true });
      return;
    }
    onChange(indexes.filter((index) => index !== target));
  };

  const restore = (target: IndexPlan) => patch(target, { dropped: false });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="shrink-0 overflow-x-auto scrollbar-thin border-b border-border bg-raised">
        <div className={cn(GRID, "h-8 min-w-[34rem]")}>
          <span className={CAPTION}>Name</span>
          <span className={CAPTION}>Columns</span>
          <Tooltip content="Reject duplicate key values">
            <span className={cn(CAPTION, "cursor-default text-center")}>Unique</span>
          </Tooltip>
          <span className={cn(CAPTION, "text-center")}>Row</span>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <div className="min-w-[34rem]">
          {active.length === 0 ? (
            <p className="px-4 py-6 text-center text-xs text-subtle">
              No indexes on this table yet.
            </p>
          ) : null}

          {active.map((index) => (
            <div
              key={existingNames.has(index.name) ? `idx:${index.name}` : `new:${index.name}`}
              className={cn(
                GRID,
                "min-h-9 border-b border-border/60 py-1",
                index.isPrimary && "bg-sunken/50",
              )}
              data-designer-row="index"
            >
              <div className="flex min-w-0 items-center gap-1.5">
                {index.isPrimary ? (
                  <Lock className="size-3 shrink-0 text-subtle" />
                ) : null}
                <Input
                  value={index.name}
                  disabled={disabled || index.isPrimary}
                  aria-label="Index name"
                  spellCheck={false}
                  onChange={(event) => patch(index, { name: event.target.value })}
                  className="h-7 px-1.5 font-mono text-[12px]"
                />
                {index.isNew ? <Badge tone="accent">new</Badge> : null}
              </div>

              <ColumnList
                columns={columns}
                value={index.columns}
                disabled={disabled || index.isPrimary}
                onChange={(next) => patch(index, { columns: next })}
              />

              <div className="flex justify-center">
                <input
                  type="checkbox"
                  checked={index.isUnique || index.isPrimary}
                  disabled={disabled || index.isPrimary}
                  aria-label={`Index ${index.name} is unique`}
                  onChange={(event) => patch(index, { isUnique: event.target.checked })}
                  className="size-3.5 accent-accent disabled:opacity-40"
                />
              </div>

              <div className="flex items-center justify-end gap-0.5">
                {index.isPrimary ? (
                  <Tooltip content="Manage key columns in the Columns tab">
                    <span className="text-subtle">
                      <KeyRound className="size-3.5" />
                    </span>
                  </Tooltip>
                ) : (
                  <IconButton
                    label="Delete index"
                    disabled={disabled}
                    onClick={() => remove(index)}
                    className="text-danger hover:bg-danger-soft hover:text-danger"
                  >
                    <Trash2 className="size-3.5" />
                  </IconButton>
                )}
              </div>
            </div>
          ))}

          {dropped.length > 0 ? (
            <div className="flex flex-col gap-1 px-2 py-3">
              <span className={CAPTION}>Pending drop</span>
              {dropped.map((index) => (
                <div
                  key={`dropped:${index.name}`}
                  className="flex items-center gap-2 rounded-md border border-border bg-sunken/60 px-2 py-1"
                >
                  <Trash2 className="size-3 shrink-0 text-danger" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted line-through">
                    {index.name}
                  </span>
                  <span className="truncate font-mono text-[11px] text-subtle">
                    ({index.columns.join(", ")})
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => restore(index)}
                  >
                    <Undo2 className="size-3" /> Restore
                  </Button>
                </div>
              ))}
            </div>
          ) : null}

          <Note className="mx-2 my-3">
            <ShieldCheck className="mt-0.5 size-3.5 shrink-0" />
            <span>
              PostgreSQL cannot edit an index in place — changing an existing index's columns or
              uniqueness is applied as a drop plus a create, which the diff reports as destructive.
            </span>
          </Note>
        </div>
      </div>

      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-raised px-2">
        <Button size="xs" variant="secondary" disabled={disabled} onClick={addIndex}>
          <Plus className="size-3.5" /> Add index
        </Button>
        <span className="flex-1" />
        <span className="text-[11px] text-subtle">
          {active.length} index{active.length === 1 ? "" : "es"}
          {dropped.length > 0 ? ` · ${dropped.length} pending drop` : ""}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Ordered column list
// ---------------------------------------------------------------------------

/**
 * An ordered set of column names. Order matters for a composite index, so
 * picking is a list operation rather than a set: chips can be nudged left and
 * right once they are in.
 */
function ColumnList({
  columns,
  value,
  disabled,
  onChange,
  emptyHint = "No columns yet",
}: {
  columns: readonly string[];
  value: string[];
  disabled?: boolean;
  onChange: (columns: string[]) => void;
  emptyHint?: string;
}) {
  const missing = columns.filter((column) => !value.includes(column));

  const nudge = (index: number, delta: number) => {
    const target = index + delta;
    if (target < 0 || target >= value.length) return;
    const next = [...value];
    const [moved] = next.splice(index, 1);
    next.splice(target, 0, moved);
    onChange(next);
  };

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {value.length === 0 ? (
        <span className="text-[11px] text-subtle">{emptyHint}</span>
      ) : null}

      {value.map((column, index) => (
        <span
          key={`${column}:${index}`}
          className="inline-flex items-center gap-0.5 rounded-sm border border-accent/30 bg-accent-soft py-0.5 pl-1.5 pr-0.5 text-accent"
        >
          <span className="max-w-32 truncate font-mono text-[11px]">{column}</span>
          <button
            type="button"
            aria-label={`Move ${column} left`}
            disabled={disabled || index === 0}
            onClick={() => nudge(index, -1)}
            className="rounded-xs p-0.5 hover:bg-accent/15 disabled:opacity-30"
          >
            <ArrowLeft className="size-2.5" />
          </button>
          <button
            type="button"
            aria-label={`Move ${column} right`}
            disabled={disabled || index === value.length - 1}
            onClick={() => nudge(index, 1)}
            className="rounded-xs p-0.5 hover:bg-accent/15 disabled:opacity-30"
          >
            <ArrowRight className="size-2.5" />
          </button>
          <button
            type="button"
            aria-label={`Remove ${column}`}
            disabled={disabled}
            onClick={() => onChange(value.filter((_, at) => at !== index))}
            className="rounded-xs p-0.5 hover:bg-accent/15 disabled:opacity-30"
          >
            <Trash2 className="size-2.5" />
          </button>
        </span>
      ))}

      <label className="inline-flex items-center gap-1">
        <select
          value=""
          disabled={disabled || missing.length === 0}
          aria-label="Add a column"
          onChange={(event) => {
            const column = event.target.value;
            if (column) onChange([...value, column]);
            event.target.value = "";
          }}
          className={cn(
            "h-6 max-w-32 rounded-sm border border-dashed border-border-strong bg-transparent px-1",
            "text-[11px] text-muted hover:border-accent hover:text-fg",
            "focus:border-accent focus:outline-none disabled:opacity-40",
          )}
        >
          <option value="">+ column</option>
          {missing.map((column) => (
            <option key={column} value={column}>
              {column}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function uniqueName(base: string, taken: ReadonlySet<string>): string {
  for (let suffix = 1; suffix < 1000; suffix += 1) {
    const candidate = suffix === 1 ? base : `${base}_${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${base}_${Date.now()}`;
}
