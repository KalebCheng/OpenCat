/**
 * Pure helpers behind the data grid.
 *
 * Column layout, row identity and the SQL a filter box turns into all live
 * here, away from React: the tricky decisions (how a row is addressed, when a
 * value needs the viewer, what a filter means) stay testable and out of the
 * component bodies.
 */

import { escapeSqlLiteral, formatCount } from "@/lib/utils";
import {
  type ColumnMeta,
  type LogicalType,
  NULL_VALUE,
  type TablePage,
  type Value,
  isNull,
  valueText,
} from "@/lib/types";

// ---------------------------------------------------------------------------
// Geometry
// ---------------------------------------------------------------------------

/** Fixed row height. Virtualization is only cheap because every row is equal. */
export const ROW_HEIGHT = 26;
export const HEADER_HEIGHT = 30;
export const FILTER_HEIGHT = 28;
/** Rows drawn outside the viewport so wheel scrolling never shows blanks. */
export const OVERSCAN = 12;

// ---------------------------------------------------------------------------
// Columns
// ---------------------------------------------------------------------------

/** A column the grid paints, plus the slot its value occupies in a row. */
export interface GridColumn {
  meta: ColumnMeta;
  /**
   * Index into the raw `Value[]` row. Hidden columns still occupy a slot, so
   * this is not the same as the column's position on screen.
   */
  index: number;
  width: number;
  numeric: boolean;
}

const NUMERIC_TYPES: ReadonlySet<LogicalType> = new Set<LogicalType>([
  "integer",
  "float",
  "decimal",
]);

/**
 * A width guess per logical type. A `varchar(255)` is unlikely to hold 255
 * visible characters, so the character budget is deliberately generous but
 * capped; the cell truncates with an ellipsis and the tooltip has the rest.
 */
export function columnWidth(meta: ColumnMeta): number {
  switch (meta.logicalType) {
    case "boolean":
      return 90;
    case "integer":
      return 110;
    case "float":
    case "decimal":
      return 132;
    case "date":
    case "time":
      return 122;
    case "date_time":
    case "timestamp":
      return 182;
    case "uuid":
      return 300;
    case "json":
    case "array":
    case "geometry":
      return 260;
    case "binary":
      return 130;
    case "text":
      return 280;
    default: {
      const characters = meta.charMaxLength ?? 24;
      return Math.min(Math.max(characters * 8 + 24, 140), 360);
    }
  }
}

/** Map a page onto the columns the grid renders, keeping hidden values addressable. */
export function buildViewColumns(page: TablePage | null): GridColumn[] {
  if (!page) return [];
  return page.columns
    .map((meta, index) => ({
      meta,
      index,
      width: columnWidth(meta),
      numeric: NUMERIC_TYPES.has(meta.logicalType),
    }))
    .filter((column) => !column.meta.hidden);
}

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

const NUMERIC_TAGS: ReadonlySet<Value["t"]> = new Set<Value["t"]>([
  "int",
  "uint",
  "float",
  "decimal",
]);

/** Numbers are right-aligned, even in a column the schema calls text. */
export function isNumericValue(value: Value | undefined): boolean {
  return value !== undefined && NUMERIC_TAGS.has(value.t);
}

/** What the grid paints in a cell: NULL becomes the configured placeholder. */
export function displayText(value: Value | undefined | null, nullDisplay: string): string {
  if (isNull(value)) return nullDisplay;
  return valueText(value);
}

/** What an editor starts with: NULL is an empty box, not "(NULL)". */
export function editorText(value: Value | undefined | null): string {
  if (isNull(value)) return "";
  return valueText(value);
}

/** True when a cell is worth opening in the viewer rather than reading inline. */
export function isLongValue(value: Value | undefined | null, threshold: number): boolean {
  if (!value) return false;
  if (value.t === "bytes") return true;
  const text = valueText(value);
  return text.length > threshold || text.includes("\n");
}

/**
 * Compare two values for the purpose of "did the user change anything".
 *
 * Tags are ignored on purpose: a `varchar` column can come back as `text` while
 * the editor produces `int` for the same digits, and writing that back would be
 * a no-op UPDATE.
 */
export function valueEquals(left: Value, right: Value): boolean {
  const leftNull = left.t === "null";
  const rightNull = right.t === "null";
  if (leftNull || rightNull) return leftNull === rightNull;
  return valueText(left) === valueText(right);
}

/** Binary values cannot survive a round trip through a text editor. */
export function canEditColumn(meta: ColumnMeta): boolean {
  return meta.logicalType !== "binary";
}

/**
 * Read the primary key out of a row.
 *
 * Returns null when the page did not select a key column: without every key
 * there is no safe WHERE clause, and a write could hit the wrong row.
 */
export function extractRowKeys(page: TablePage, row: Value[]): Record<string, Value> | null {
  if (page.keyColumns.length === 0) return null;
  const keys: Record<string, Value> = {};
  for (const name of page.keyColumns) {
    const index = page.columns.findIndex((column) => column.name === name);
    if (index === -1) return null;
    keys[name] = row[index] ?? NULL_VALUE;
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Filter SQL
// ---------------------------------------------------------------------------

/** Quote an identifier only when it is not already a plain SQL name. */
function quoteIdent(name: string): string {
  return /^[A-Za-z_][A-Za-z0-9_$]*$/.test(name)
    ? name
    : `"${name.replace(/"/g, '""')}"`;
}

/** Numbers, booleans and NULL are compared as literals; anything else is text. */
function scalarLiteral(text: string): string | null {
  if (/^[-+]?\d+(\.\d+)?([eE][-+]?\d+)?$/.test(text)) return text;
  if (/^(true|false)$/i.test(text)) return text.toUpperCase();
  return null;
}

export type FilterOperator = "=" | "!=" | ">" | ">=" | "<" | "<=" | "~";

export interface ParsedFilter {
  operator: FilterOperator;
  operand: string;
}

/**
 * Split one filter box into operator and operand.
 *
 * The box defaults to a "contains" test, but accepts a leading comparison so a
 * quick `>100` does not force the user into the raw WHERE editor.
 */
export function parseFilter(text: string): ParsedFilter {
  const trimmed = text.trim();
  const match = /^(>=|<=|!=|<>|=|>|<|~)/.exec(trimmed);
  if (!match) return { operator: "~", operand: trimmed };
  const operator = (match[1] === "<>" ? "!=" : match[1]) as FilterOperator;
  return { operator, operand: trimmed.slice(match[1].length).trim() };
}

/** Turn one filter box into a WHERE fragment, or null when it is empty. */
export function columnCondition(column: string, text: string): string | null {
  if (!text.trim()) return null;
  const ident = quoteIdent(column);
  const { operator, operand } = parseFilter(text);

  if (/^null$/i.test(operand)) {
    return operator === "!=" ? `${ident} IS NOT NULL` : `${ident} IS NULL`;
  }
  if (!operand) return null;

  if (operator === "~") {
    // Escape the LIKE metacharacters, including the escape character itself.
    // `!` is the escape marker because `ESCAPE '\'` is not a valid string
    // literal on MySQL, where a backslash escapes the closing quote.
    const pattern = operand.replace(/([!%_])/g, "!$1");
    return `${ident} LIKE ${escapeSqlLiteral(`%${pattern}%`)} ESCAPE '!'`;
  }

  const rhs = scalarLiteral(operand) ?? escapeSqlLiteral(operand);
  return `${ident} ${operator} ${rhs}`;
}

/**
 * Combine the per-column filter boxes with the advanced WHERE editor.
 *
 * Both halves are optional and the raw clause is parenthesised so a trailing
 * `OR` in it cannot swallow the column predicates.
 */
export function buildFilterClause(
  filters: Record<string, string>,
  rawWhere: string,
): string | null {
  const parts: string[] = [];
  for (const [column, text] of Object.entries(filters)) {
    const condition = columnCondition(column, text);
    if (condition) parts.push(condition);
  }
  const raw = rawWhere.trim().replace(/;\s*$/, "");
  if (raw) parts.push(`(${raw})`);
  if (parts.length === 0) return null;
  return parts.join("\n  AND ");
}

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

/** "1–500 of 12,345", or the honest version when the total is unknown. */
export function rangeLabel(offset: number, shown: number, total: number | null): string {
  if (shown === 0) {
    return total === null ? "No rows" : `0 of ${formatCount(total)}`;
  }
  const first = formatCount(offset + 1);
  const last = formatCount(offset + shown);
  return total === null ? `${first}–${last}` : `${first}–${last} of ${formatCount(total)}`;
}
