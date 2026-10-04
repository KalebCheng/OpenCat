/**
 * The foreign keys tab.
 *
 * An existing key's target is on another table, so the referenced columns
 * cannot be read from the plan: they are fetched with `explorer.describe` when
 * the referenced table is named. Until that succeeds the columns field stays a
 * free-text box, which also keeps keys that point at a table outside the current
 * schema editable.
 */

import * as React from "react";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { KeyRound, Link2, Plus, Trash2, Undo2 } from "lucide-react";

import type { DbKind, ForeignKeyPlan, ObjectKind, Scope, TableSchema } from "@/lib/types";
import { cn } from "@/lib/utils";
import ipc from "@/lib/ipc";
import { Badge, Button, IconButton, Input, NativeSelect } from "@/components/ui/primitives";

import { Note, Row } from "./ui";
import { newForeignKeyPlan } from "./plan";
import { REFERENTIAL_ACTIONS } from "./types";

/** Columns of a referenced table, or `null` while they are being fetched. */
function useReferencedColumns(
  sessionId: string,
  scope: Scope,
  table: string,
  enabled: boolean,
): string[] | null {
  const [columns, setColumns] = React.useState<string[] | null>(null);

  React.useEffect(() => {
    const name = table.trim();
    if (!enabled || !name) {
      setColumns(null);
      return;
    }
    let cancelled = false;
    setColumns(null);
    ipc.explorer
      .describe(sessionId, scope, name, "table" as ObjectKind)
      .then((schema: TableSchema) => {
        if (!cancelled) setColumns(schema.columns.map((column) => column.name));
      })
      .catch(() => {
        if (cancelled) return;
        // A missing table is not a hard error: the user may be naming one that
        // does not exist yet, so fall back to free-text entry.
        setColumns([]);
      });
    return () => {
      cancelled = true;
    };
  }, [sessionId, scope.database, scope.schema, table, enabled]);

  return columns;
}

/** Split a comma or space separated list, which is how ref columns are typed. */
function parseList(text: string): string[] {
  return text
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

export interface ForeignKeyEditorProps {
  foreignKeys: ForeignKeyPlan[];
  kind: DbKind;
  /** Column names on the table being designed. */
  columns: readonly string[];
  /** Names of keys that already exist on the server. */
  existingNames: ReadonlySet<string>;
  sessionId: string;
  scope: Scope;
  onChange: (foreignKeys: ForeignKeyPlan[]) => void;
  disabled?: boolean;
}

export function ForeignKeyEditor({
  foreignKeys,
  kind,
  columns,
  existingNames,
  sessionId,
  scope,
  onChange,
  disabled = false,
}: ForeignKeyEditorProps) {
  const active = foreignKeys.filter((fk) => !fk.dropped);
  const dropped = foreignKeys.filter((fk) => fk.dropped);

  const patch = (target: ForeignKeyPlan, changes: Partial<ForeignKeyPlan>) => {
    onChange(foreignKeys.map((fk) => (fk === target ? { ...fk, ...changes } : fk)));
  };

  const addForeignKey = () => {
    const taken = new Set(foreignKeys.map((fk) => fk.name));
    const name = uniqueName("fk", taken);
    onChange([...foreignKeys, newForeignKeyPlan(kind, name)]);
  };

  const remove = (target: ForeignKeyPlan) => {
    if (existingNames.has(target.name)) {
      // Keep the entry so the diff can emit DROP FOREIGN KEY.
      patch(target, { dropped: true });
      return;
    }
    onChange(foreignKeys.filter((fk) => fk !== target));
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="min-h-0 flex-1 overflow-auto scrollbar-thin p-3">
        <div className="flex flex-col gap-3">
          {active.length === 0 ? (
            <p className="py-6 text-center text-xs text-subtle">
              No foreign keys on this table yet.
            </p>
          ) : null}

          {active.map((fk, index) => (
            <ForeignKeyCard
              key={existingNames.has(fk.name) ? `fk:${fk.name}` : `new:${index}`}
              fk={fk}
              kind={kind}
              columns={columns}
              sessionId={sessionId}
              scope={scope}
              disabled={disabled}
              onPatch={(changes) => patch(fk, changes)}
              onRemove={() => remove(fk)}
            />
          ))}

          {dropped.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">
                Pending drop
              </span>
              {dropped.map((fk) => (
                <div
                  key={`dropped:${fk.name}`}
                  className="flex items-center gap-2 rounded-md border border-border bg-sunken/60 px-2 py-1"
                >
                  <Trash2 className="size-3 shrink-0 text-danger" />
                  <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-muted line-through">
                    {fk.name}
                  </span>
                  <span className="truncate font-mono text-[11px] text-subtle">
                    → {fk.refTable}
                  </span>
                  <Button
                    size="xs"
                    variant="ghost"
                    disabled={disabled}
                    onClick={() => patch(fk, { dropped: false })}
                  >
                    <Undo2 className="size-3" /> Restore
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
        </div>
      </div>

      <div className="flex h-9 shrink-0 items-center gap-2 border-t border-border bg-raised px-2">
        <Button size="xs" variant="secondary" disabled={disabled} onClick={addForeignKey}>
          <Plus className="size-3.5" /> Add foreign key
        </Button>
        <span className="flex-1" />
        <span className="text-[11px] text-subtle">
          {active.length} key{active.length === 1 ? "" : "s"}
          {dropped.length > 0 ? ` · ${dropped.length} pending drop` : ""}
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// One key
// ---------------------------------------------------------------------------

function ForeignKeyCard({
  fk,
  kind,
  columns,
  sessionId,
  scope,
  disabled,
  onPatch,
  onRemove,
}: {
  fk: ForeignKeyPlan;
  kind: DbKind;
  columns: readonly string[];
  sessionId: string;
  scope: Scope;
  disabled?: boolean;
  onPatch: (changes: Partial<ForeignKeyPlan>) => void;
  onRemove: () => void;
}) {
  const referenced = useReferencedColumns(sessionId, scope, fk.refTable, true);
  const referencedKnown = referenced !== null && referenced.length > 0;

  const toggleLocal = (column: string, checked: boolean) => {
    const next = checked
      ? [...fk.columns, column]
      : fk.columns.filter((current) => current !== column);
    onPatch({ columns: next });
  };

  const toggleReferenced = (column: string, checked: boolean) => {
    const next = checked
      ? [...fk.refColumns, column]
      : fk.refColumns.filter((current) => current !== column);
    onPatch({ refColumns: next });
  };

  const mismatched =
    fk.columns.length > 0 && fk.refColumns.length > 0 && fk.columns.length !== fk.refColumns.length;

  return (
    <section className="flex flex-col gap-3 rounded-lg border border-border bg-surface p-3">
      <header className="flex items-center gap-2">
        <span className="text-muted">
          <Link2 className="size-3.5" />
        </span>
        <Input
          value={fk.name}
          disabled={disabled}
          aria-label="Foreign key name"
          spellCheck={false}
          onChange={(event) => onPatch({ name: event.target.value })}
          className="h-7 max-w-64 px-1.5 font-mono text-[12px]"
        />
        <Badge tone="neutral">
          <KeyRound className="size-3" /> {fk.columns.length} → {fk.refColumns.length}
        </Badge>
        <span className="flex-1" />
        <IconButton
          label="Delete foreign key"
          disabled={disabled}
          onClick={onRemove}
          className="text-danger hover:bg-danger-soft hover:text-danger"
        >
          <Trash2 className="size-3.5" />
        </IconButton>
      </header>

      <Row label="Columns">
        <MultiSelect
          options={columns}
          selected={fk.columns}
          disabled={disabled}
          emptyLabel="No columns on this table"
          onToggle={toggleLocal}
        />
      </Row>

      <Row label="References">
        <div className="flex items-center gap-2">
          {kind === "postgres" ? (
            <Input
              value={fk.refSchema ?? ""}
              disabled={disabled}
              placeholder="schema"
              aria-label="Referenced schema"
              spellCheck={false}
              onChange={(event) => onPatch({ refSchema: event.target.value || null })}
              className="h-7 w-28 px-1.5 font-mono text-[12px]"
            />
          ) : null}
          <Input
            value={fk.refTable}
            disabled={disabled}
            placeholder="referenced_table"
            aria-label="Referenced table"
            spellCheck={false}
            onChange={(event) => onPatch({ refTable: event.target.value, refColumns: [] })}
            className="h-7 max-w-64 px-1.5 font-mono text-[12px]"
          />
        </div>
      </Row>

      <Row
        label="Ref columns"
        hint={
          referenced === null
            ? "Looking up the referenced table…"
            : referencedKnown
              ? undefined
              : "The referenced table could not be read; type the column names instead."
        }
      >
        {referencedKnown ? (
          <MultiSelect
            options={referenced}
            selected={fk.refColumns}
            disabled={disabled}
            onToggle={toggleReferenced}
          />
        ) : (
          <Input
            value={fk.refColumns.join(", ")}
            disabled={disabled}
            placeholder="id"
            aria-label="Referenced columns"
            spellCheck={false}
            onChange={(event) => onPatch({ refColumns: parseList(event.target.value) })}
            className="h-7 max-w-72 px-1.5 font-mono text-[12px]"
          />
        )}
      </Row>

      <div className="flex items-end gap-4">
        <Row label="On update" className="flex-1">
          <NativeSelect
            value={fk.onUpdate ?? ""}
            disabled={disabled}
            aria-label="On update action"
            onChange={(event) => onPatch({ onUpdate: event.target.value || null })}
            className="h-7 max-w-40 text-[12px]"
          >
            <option value="">(none)</option>
            {REFERENTIAL_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </NativeSelect>
        </Row>
        <Row label="On delete" className="flex-1">
          <NativeSelect
            value={fk.onDelete ?? ""}
            disabled={disabled}
            aria-label="On delete action"
            onChange={(event) => onPatch({ onDelete: event.target.value || null })}
            className="h-7 max-w-40 text-[12px]"
          >
            <option value="">(none)</option>
            {REFERENTIAL_ACTIONS.map((action) => (
              <option key={action} value={action}>
                {action}
              </option>
            ))}
          </NativeSelect>
        </Row>
      </div>

      {kind === "mysql" ? (
        <Note>
          <span>MySQL rejects SET DEFAULT; the server will refuse the statement if you pick it.</span>
        </Note>
      ) : null}

      {mismatched ? (
        <Note tone="warning">
          <span>
            {fk.columns.length} local column{fk.columns.length === 1 ? "" : "s"} but{" "}
            {fk.refColumns.length} referenced column{fk.refColumns.length === 1 ? "" : "s"} — a key
            needs the same number on both sides.
          </span>
        </Note>
      ) : null}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Multi-select
// ---------------------------------------------------------------------------

function MultiSelect({
  options,
  selected,
  disabled,
  emptyLabel = "No columns",
  onToggle,
}: {
  options: readonly string[];
  selected: readonly string[];
  disabled?: boolean;
  emptyLabel?: string;
  onToggle: (option: string, checked: boolean) => void;
}) {
  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {selected.length === 0 ? (
        <span className="text-[11px] text-subtle">none selected</span>
      ) : null}
      {selected.map((option) => (
        <span
          key={option}
          className="inline-flex items-center gap-1 rounded-sm border border-accent/30 bg-accent-soft px-1.5 py-0.5 text-accent"
        >
          <span className="max-w-32 truncate font-mono text-[11px]">{option}</span>
          <button
            type="button"
            aria-label={`Remove ${option}`}
            disabled={disabled}
            onClick={() => onToggle(option, false)}
            className="rounded-xs p-0.5 hover:bg-accent/15 disabled:opacity-30"
          >
            <Trash2 className="size-2.5" />
          </button>
        </span>
      ))}
      <PopoverPrimitive.Root>
        <PopoverPrimitive.Trigger asChild>
          <button
            type="button"
            disabled={disabled || options.length === 0}
            className={cn(
              "h-6 rounded-sm border border-dashed border-border-strong px-1.5 text-[11px] text-muted",
              "hover:border-accent hover:text-fg",
              "disabled:cursor-not-allowed disabled:opacity-40",
            )}
          >
            + column
          </button>
        </PopoverPrimitive.Trigger>
        <PopoverPrimitive.Portal>
          <PopoverPrimitive.Content
            sideOffset={4}
            align="start"
            className="z-50 max-h-56 w-56 overflow-auto scrollbar-thin rounded-lg border border-border bg-raised p-1 shadow-popover"
          >
            {options.length === 0 ? (
              <p className="px-2 py-1.5 text-[11px] text-subtle">{emptyLabel}</p>
            ) : null}
            {options.map((option) => {
              const checked = selected.includes(option);
              return (
                <button
                  key={option}
                  type="button"
                  onClick={() => onToggle(option, !checked)}
                  className={cn(
                    "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left font-mono text-[12px]",
                    checked ? "bg-accent-soft text-accent" : "text-fg hover:bg-hover",
                  )}
                >
                  <span className="flex-1 truncate">{option}</span>
                  {checked ? <span className="text-[10px]">selected</span> : null}
                </button>
              );
            })}
          </PopoverPrimitive.Content>
        </PopoverPrimitive.Portal>
      </PopoverPrimitive.Root>
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
