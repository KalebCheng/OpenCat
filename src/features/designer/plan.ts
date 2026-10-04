/**
 * Plan <-> schema conversion and the dirty check.
 *
 * The designer keeps a {@link TablePlan} as its working copy. For an existing
 * table that plan starts out as an exact description of the server's
 * {@link TableSchema}; every edit is then a small mutation on top. Two details
 * matter for the diff the backend performs:
 *
 * 1. `originalName` records the server-side name of a column. Without it a
 *    rename looks like "drop the old column, add a new one" and the data is
 *    lost, so it is set on load and kept when the name changes.
 * 2. Deleting a column only sets `dropped: true`. The entry stays in the list so
 *    the diff can still emit `DROP COLUMN` and, on SQLite, copy the remaining
 *    data across during a table rebuild.
 */

import type {
  ColumnSchema,
  DbKind,
  ForeignKeyPlan,
  IndexPlan,
  ObjectKind,
  Scope,
  TablePlan,
  TableSchema,
} from "@/lib/types";

import { autoIncrementTypeFor } from "./types";

/** The column a brand new table starts with. */
export function blankColumn(kind: DbKind, name = "id"): TablePlan["columns"][number] {
  return {
    name,
    dataType: autoIncrementTypeFor(kind),
    nullable: false,
    defaultValue: null,
    isPrimaryKey: true,
    isAutoIncrement: true,
    isUnique: false,
    comment: null,
    originalName: null,
    dropped: false,
    enumValues: [],
  };
}

/** A column that is not part of the primary key — used by "Add column". */
export function newColumn(kind: DbKind, name: string): TablePlan["columns"][number] {
  return {
    name,
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
}

/** A plan for a relation that does not exist yet. */
export function newTablePlan(
  kind: DbKind,
  scope: Scope,
  name: string,
  objectKind: ObjectKind,
): TablePlan {
  return {
    database: scope.database ?? null,
    schema: scope.schema ?? null,
    name,
    originalName: null,
    kind: objectKind,
    columns: [blankColumn(kind, "id")],
    indexes: [],
    foreignKeys: [],
    options: {},
    isNew: true,
  };
}

/**
 * Turn a described table into an editable plan.
 *
 * `dataType` and `enumValues` are taken from the server verbatim so that an
 * untouched column produces no diff at all; the primary key that the server
 * reports as an index is attached to the column that carries it.
 */
export function planFromSchema(
  schema: TableSchema,
  scope: Scope,
  objectKind: ObjectKind,
): TablePlan {
  const primaryColumns = new Set<string>();
  for (const index of schema.indexes) {
    if (index.isPrimary) for (const column of index.columns) primaryColumns.add(column);
  }

  const columns = [...schema.columns]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((column: ColumnSchema) => ({
      name: column.name,
      dataType: column.dataType,
      nullable: column.nullable,
      defaultValue: column.defaultValue ?? null,
      isPrimaryKey: column.isPrimaryKey || primaryColumns.has(column.name),
      isAutoIncrement: column.isAutoIncrement,
      // A single-column primary key already implies uniqueness; flagging it
      // again would add a redundant UNIQUE to the generated DDL.
      isUnique: column.isUnique && !column.isPrimaryKey,
      comment: column.comment ?? null,
      originalName: column.name,
      dropped: false,
      enumValues: column.enumValues ?? [],
    }));

  return {
    database: scope.database ?? schema.database ?? null,
    schema: scope.schema ?? schema.schema ?? null,
    name: schema.name,
    originalName: schema.name,
    kind: objectKind,
    columns,
    indexes: schema.indexes.map(toIndexPlan),
    foreignKeys: schema.foreignKeys.map((fk) => ({
      name: fk.name,
      columns: [...fk.columns],
      refTable: fk.refTable,
      refColumns: [...fk.refColumns],
      refSchema: fk.refSchema ?? null,
      onUpdate: fk.onUpdate ?? null,
      onDelete: fk.onDelete ?? null,
      dropped: false,
    })),
    options: { ...schema.options },
    isNew: false,
  };
}

function toIndexPlan(index: TableSchema["indexes"][number]): IndexPlan {
  return {
    name: index.name,
    columns: [...index.columns],
    isUnique: index.isUnique,
    isPrimary: index.isPrimary,
    isNew: false,
    dropped: false,
  };
}

/** A new, empty index over the first column of the table. */
export function newIndexPlan(name: string, columns: string[]): IndexPlan {
  return { name, columns, isUnique: false, isPrimary: false, isNew: true, dropped: false };
}

/** A new foreign key; the caller fills in the columns and the target. */
export function newForeignKeyPlan(kind: DbKind, name: string): ForeignKeyPlan {
  return {
    name,
    columns: [],
    refTable: "",
    refColumns: [],
    refSchema: null,
    // MySQL rejects SET DEFAULT outright, so start from the portable default.
    onUpdate: kind === "mysql" ? "RESTRICT" : null,
    onDelete: kind === "mysql" ? "RESTRICT" : null,
    dropped: false,
  };
}

// ---------------------------------------------------------------------------
// Change detection
// ---------------------------------------------------------------------------

/** Columns the user can still see, i.e. everything not marked dropped. */
export function liveColumns(plan: TablePlan): TablePlan["columns"] {
  return plan.columns.filter((column) => !column.dropped);
}

/** Indexes and foreign keys that are not marked dropped. */
export function liveIndexes(plan: TablePlan): IndexPlan[] {
  return plan.indexes.filter((index) => !index.dropped);
}

export function liveForeignKeys(plan: TablePlan): ForeignKeyPlan[] {
  return plan.foreignKeys.filter((fk) => !fk.dropped);
}

export type PlanColumn = TablePlan["columns"][number];

/**
 * A structural fingerprint of a plan, ignoring `isNew` (which never changes
 * while a plan is open). Comparing the serialised forms is enough here: both
 * sides are built by the same reducers, so property order is stable.
 */
export function planFingerprint(plan: TablePlan): string {
  return JSON.stringify({
    database: plan.database,
    schema: plan.schema,
    name: plan.name,
    originalName: plan.originalName,
    kind: plan.kind,
    columns: plan.columns,
    indexes: plan.indexes,
    foreignKeys: plan.foreignKeys,
    options: plan.options,
  });
}

/** Defining properties of a column, excluding whether it is being dropped. */
function columnDefinition(column: PlanColumn): string {
  return JSON.stringify({
    name: column.name,
    dataType: column.dataType,
    nullable: column.nullable,
    defaultValue: column.defaultValue,
    isPrimaryKey: column.isPrimaryKey,
    isAutoIncrement: column.isAutoIncrement,
    isUnique: column.isUnique,
    comment: column.comment,
    enumValues: column.enumValues,
  });
}

/** True when `plan` differs from the plan it was loaded from. */
export function isPlanDirty(plan: TablePlan, baseline: TablePlan | null): boolean {
  if (!baseline) return false;
  return planFingerprint(plan) !== planFingerprint(baseline);
}

/** Counts shown next to the dirty indicator in the header. */
export interface PlanChangeSummary {
  addedColumns: number;
  renamedColumns: number;
  droppedColumns: number;
  changedColumns: number;
  addedIndexes: number;
  droppedIndexes: number;
  addedForeignKeys: number;
  droppedForeignKeys: number;
  total: number;
}

/** Summarise what a plan changes, for the header badge. */
export function summariseChanges(plan: TablePlan, baseline: TablePlan | null): PlanChangeSummary {
  const summary: PlanChangeSummary = {
    addedColumns: 0,
    renamedColumns: 0,
    droppedColumns: 0,
    changedColumns: 0,
    addedIndexes: 0,
    droppedIndexes: 0,
    addedForeignKeys: 0,
    droppedForeignKeys: 0,
    total: 0,
  };

  const before = new Map<string, PlanColumn>();
  for (const column of baseline?.columns ?? []) {
    before.set(column.originalName ?? column.name, column);
  }

  for (const column of plan.columns) {
    const source = column.originalName ? before.get(column.originalName) : undefined;
    if (column.dropped) {
      if (source) summary.droppedColumns += 1;
      continue;
    }
    if (!source) {
      summary.addedColumns += 1;
      continue;
    }
    if (source.name !== column.name) summary.renamedColumns += 1;
    else if (columnDefinition(source) !== columnDefinition(column)) summary.changedColumns += 1;
  }

  if (baseline) {
    const beforeIndexes = new Set(baseline.indexes.map((index) => index.name));
    for (const index of plan.indexes) {
      if (index.dropped) {
        if (beforeIndexes.has(index.name)) summary.droppedIndexes += 1;
      } else if (!beforeIndexes.has(index.name)) {
        summary.addedIndexes += 1;
      }
    }
    const beforeKeys = new Set(baseline.foreignKeys.map((fk) => fk.name));
    for (const fk of plan.foreignKeys) {
      if (fk.dropped) {
        if (beforeKeys.has(fk.name)) summary.droppedForeignKeys += 1;
      } else if (!beforeKeys.has(fk.name)) {
        summary.addedForeignKeys += 1;
      }
    }
  } else {
    summary.addedColumns = liveColumns(plan).length;
    summary.addedIndexes = liveIndexes(plan).length;
    summary.addedForeignKeys = liveForeignKeys(plan).length;
  }

  summary.total =
    summary.addedColumns +
    summary.renamedColumns +
    summary.droppedColumns +
    summary.changedColumns +
    summary.addedIndexes +
    summary.droppedIndexes +
    summary.addedForeignKeys +
    summary.droppedForeignKeys;
  return summary;
}

/** Scope prefix accepted by `useExplorer.invalidate`. */
export function scopePrefix(sessionId: string, scope: Scope): string {
  return `${sessionId}/${scope.database ?? ""}`;
}

// ---------------------------------------------------------------------------
// Immutable list helpers
// ---------------------------------------------------------------------------

export function replaceAt<T>(list: readonly T[], index: number, next: T): T[] {
  return list.map((item, position) => (position === index ? next : item));
}

/** Move an item by `delta`, clamped to the list — used by the up/down buttons. */
export function moveItem<T>(list: readonly T[], index: number, delta: number): T[] {
  const target = index + delta;
  if (index < 0 || index >= list.length || target < 0 || target >= list.length) {
    return [...list];
  }
  const next = [...list];
  const [moved] = next.splice(index, 1);
  next.splice(target, 0, moved);
  return next;
}

/** Insert a copy of `list[index]` directly after the original. */
export function duplicateAt<T>(list: readonly T[], index: number): T[] {
  const source = list[index];
  if (!source) return [...list];
  const next = [...list];
  next.splice(index + 1, 0, source);
  return next;
}
