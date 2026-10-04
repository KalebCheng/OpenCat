/**
 * Dialect knowledge for the visual table designer.
 *
 * The designer edits raw, engine-specific type strings (`varchar(255)`,
 * `NUMBER(10, 2)`, `TEXT`) because that is exactly what the DDL generator emits
 * and what the server reports back in `ColumnSchema.dataType`. This module is
 * the only place that knows how those strings relate to a {@link LogicalType},
 * so the column editor can offer sensible suggestions without ever rewriting a
 * type the user typed by hand.
 */

import type { DbKind, LogicalType } from "@/lib/types";

// ---------------------------------------------------------------------------
// Identifier helpers
// ---------------------------------------------------------------------------

/** Characters each engine wraps identifiers in, mirrored from the backend. */
export function quoteChar(kind: DbKind): string {
  return kind === "mysql" ? "`" : '"';
}

/** Quote a single identifier, unless it is already quoted. */
export function quoteIdent(name: string, kind: DbKind): string {
  const char = quoteChar(kind);
  if (name.startsWith(char) && name.endsWith(char)) return name;
  return `${char}${name.split(char).join(char + char)}${char}`;
}

// ---------------------------------------------------------------------------
// Type suggestions
// ---------------------------------------------------------------------------

export interface TypeSuggestion {
  /** The type string as it should be written in DDL. */
  value: string;
  /** Short semantic label shown to the right of the type. */
  label: string;
}

/** Suggested types per engine, ordered from most to least commonly used. */
export const TYPE_SUGGESTIONS: Record<DbKind, readonly TypeSuggestion[]> = {
  sqlite: [
    { value: "INTEGER", label: "Integer" },
    { value: "TEXT", label: "Text" },
    { value: "REAL", label: "Float" },
    { value: "NUMERIC", label: "Numeric" },
    { value: "BLOB", label: "Binary" },
    { value: "BOOLEAN", label: "Boolean" },
    { value: "DATE", label: "Date" },
    { value: "DATETIME", label: "Date & time" },
    { value: "VARCHAR(255)", label: "Text, limited" },
  ],
  mysql: [
    { value: "BIGINT", label: "Integer" },
    { value: "INT", label: "Integer" },
    { value: "TINYINT(1)", label: "Boolean" },
    { value: "SMALLINT", label: "Integer" },
    { value: "VARCHAR(255)", label: "Text, limited" },
    { value: "TEXT", label: "Text" },
    { value: "LONGTEXT", label: "Text, large" },
    { value: "DECIMAL(10,2)", label: "Fixed decimal" },
    { value: "DOUBLE", label: "Float" },
    { value: "FLOAT", label: "Float" },
    { value: "DATE", label: "Date" },
    { value: "TIME", label: "Time" },
    { value: "DATETIME", label: "Date & time" },
    { value: "TIMESTAMP", label: "Timestamp" },
    { value: "JSON", label: "JSON" },
    { value: "CHAR(36)", label: "UUID as text" },
    { value: "VARBINARY(255)", label: "Binary" },
    { value: "BLOB", label: "Binary, large" },
    { value: "ENUM('a','b')", label: "Enum" },
    { value: "SET('a','b')", label: "Set" },
  ],
  postgres: [
    { value: "bigserial", label: "Auto-increment" },
    { value: "bigint", label: "Integer" },
    { value: "integer", label: "Integer" },
    { value: "smallint", label: "Integer" },
    { value: "boolean", label: "Boolean" },
    { value: "text", label: "Text" },
    { value: "varchar(255)", label: "Text, limited" },
    { value: "numeric(10,2)", label: "Fixed decimal" },
    { value: "double precision", label: "Float" },
    { value: "real", label: "Float" },
    { value: "date", label: "Date" },
    { value: "time", label: "Time" },
    { value: "timestamp", label: "Timestamp" },
    { value: "timestamptz", label: "Timestamp with zone" },
    { value: "jsonb", label: "JSON" },
    { value: "json", label: "JSON, raw" },
    { value: "uuid", label: "UUID" },
    { value: "bytea", label: "Binary" },
    { value: "text[]", label: "Array of text" },
  ],
} as const;

/** Type suggestions for an engine, filtered by a case-insensitive needle. */
export function suggestTypes(kind: DbKind, needle: string): TypeSuggestion[] {
  const all = TYPE_SUGGESTIONS[kind];
  const trimmed = needle.trim();
  if (!trimmed) return [...all];
  const lower = trimmed.toLowerCase();
  return all.filter(
    (item) =>
      item.value.toLowerCase().includes(lower) || item.label.toLowerCase().includes(lower),
  );
}

// ---------------------------------------------------------------------------
// Type <-> logical type
// ---------------------------------------------------------------------------

/** Strip a length/precision suffix and normalise spacing. */
export function baseType(dataType: string): string {
  return dataType
    .replace(/\([^)]*\)/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** The `(…)` suffix of a type string, without the parentheses. */
export function typeArguments(dataType: string): string {
  const match = /\(([^)]*)\)/.exec(dataType);
  return match ? match[1].trim() : "";
}

/**
 * Replace the `(…)` suffix of a type string.
 *
 * Passing an empty argument list removes the suffix entirely, which is what the
 * designer's "size" field does when the user clears it.
 */
export function withTypeArguments(dataType: string, args: string): string {
  const bare = dataType.replace(/\s*\([^)]*\)/g, "").trim();
  const trimmed = args.trim();
  return trimmed ? `${bare}(${trimmed})` : bare;
}

/**
 * Engines report different names for the same logical type (`int4` vs
 * `integer`, `boolean` vs `tinyint(1)`). This is a deliberately small lookup
 * rather than a full type system: it only needs to be right for the types the
 * designer suggests, and anything unknown stays {@link LogicalType} `unknown`
 * so we never claim to know more than the server told us.
 */
const LOGICAL_BY_TYPE: Record<string, LogicalType> = {
  // booleans
  bool: "boolean",
  boolean: "boolean",
  "tinyint(1)": "boolean",
  bit: "boolean",
  // integers
  int: "integer",
  int2: "integer",
  int4: "integer",
  int8: "integer",
  integer: "integer",
  smallint: "integer",
  mediumint: "integer",
  bigint: "integer",
  tinyint: "integer",
  serial: "integer",
  bigserial: "integer",
  smallserial: "integer",
  // floating point
  real: "float",
  float: "float",
  float4: "float",
  float8: "float",
  double: "float",
  "double precision": "float",
  // exact numerics
  decimal: "decimal",
  dec: "decimal",
  numeric: "decimal",
  money: "decimal",
  // strings
  char: "string",
  character: "string",
  bpchar: "string",
  varchar: "string",
  "character varying": "string",
  nvarchar: "string",
  nchar: "string",
  // free text
  text: "text",
  tinytext: "text",
  mediumtext: "text",
  longtext: "text",
  clob: "text",
  citext: "text",
  // binary
  blob: "binary",
  tinyblob: "binary",
  mediumblob: "binary",
  longblob: "binary",
  bytea: "binary",
  varbinary: "binary",
  binary: "binary",
  // temporal
  date: "date",
  time: "time",
  "time without time zone": "time",
  "time with time zone": "time",
  datetime: "date_time",
  "datetime2": "date_time",
  timestamp: "timestamp",
  timestamptz: "timestamp",
  "timestamp without time zone": "timestamp",
  "timestamp with time zone": "timestamp",
  // structured
  json: "json",
  jsonb: "json",
  uuid: "uuid",
  uniqueidentifier: "uuid",
  enum: "enum",
  set: "enum",
  geometry: "geometry",
  geography: "geometry",
  point: "geometry",
};

/** Best-effort logical type for an engine-specific type name. */
export function logicalTypeOf(dataType: string): LogicalType {
  const base = baseType(dataType);
  if (!base) return "unknown";
  const exact = LOGICAL_BY_TYPE[base];
  if (exact) return exact;
  // Array element types, e.g. `text[]` or `integer[][]`.
  if (base.endsWith("[]")) return "array";
  // Anything with a suffix we do not know (an enum name, a domain, `varchar2`).
  return "unknown";
}

/**
 * The type a column of `logical` should get when the user flips the type of an
 * existing column. Only used as a starting point: the type stays editable text.
 */
export function defaultTypeFor(kind: DbKind, logical: LogicalType): string {
  const table: Record<DbKind, Record<LogicalType, string>> = {
    sqlite: {
      boolean: "INTEGER",
      integer: "INTEGER",
      float: "REAL",
      decimal: "NUMERIC",
      string: "TEXT",
      text: "TEXT",
      binary: "BLOB",
      date: "DATE",
      time: "TIME",
      date_time: "DATETIME",
      timestamp: "DATETIME",
      json: "TEXT",
      uuid: "TEXT",
      enum: "TEXT",
      array: "TEXT",
      geometry: "BLOB",
      unknown: "TEXT",
    },
    mysql: {
      boolean: "TINYINT(1)",
      integer: "BIGINT",
      float: "DOUBLE",
      decimal: "DECIMAL(10,2)",
      string: "VARCHAR(255)",
      text: "TEXT",
      binary: "BLOB",
      date: "DATE",
      time: "TIME",
      date_time: "DATETIME",
      timestamp: "TIMESTAMP",
      json: "JSON",
      uuid: "CHAR(36)",
      enum: "ENUM('a','b')",
      array: "TEXT",
      geometry: "GEOMETRY",
      unknown: "VARCHAR(255)",
    },
    postgres: {
      boolean: "boolean",
      integer: "bigint",
      float: "double precision",
      decimal: "numeric(10,2)",
      string: "varchar(255)",
      text: "text",
      binary: "bytea",
      date: "date",
      time: "time",
      date_time: "timestamp",
      timestamp: "timestamptz",
      json: "jsonb",
      uuid: "uuid",
      enum: "text",
      array: "text[]",
      geometry: "geometry",
      unknown: "text",
    },
  };
  return table[kind][logical];
}

/** The engine's usual primary-key type when a column is first flagged as one. */
export function autoIncrementTypeFor(kind: DbKind): string {
  switch (kind) {
    case "mysql":
      return "BIGINT";
    case "postgres":
      return "bigserial";
    case "sqlite":
      return "INTEGER";
  }
}

/** Serial/bigserial already imply auto-increment, so the backend omits it. */
export function typeImpliesAutoIncrement(kind: DbKind, dataType: string): boolean {
  if (kind !== "postgres") return false;
  return /\b(big|small)?serial\b/i.test(dataType);
}

/** Engines that have a native enum/set type whose members live in the DDL. */
export function typeUsesEnumValues(kind: DbKind, dataType: string): boolean {
  const base = baseType(dataType);
  if (kind === "mysql") return base === "enum" || base === "set";
  if (kind === "postgres") return base === "enum";
  return false;
}

/** Render enum members the way the engine expects them inside the type. */
export function enumMemberString(members: readonly string[]): string {
  return members
    .map((member) => member.trim())
    .filter(Boolean)
    .map((member) => `'${member.replace(/'/g, "''")}'`)
    .join(",");
}

/** Parse the `(…)` argument list of an enum/set type back into members. */
export function parseEnumMembers(dataType: string): string[] {
  const args = typeArguments(dataType);
  if (!args) return [];
  return args
    .split(",")
    .map((member) => member.trim().replace(/^'(.*)'$/, "$1").replace(/''/g, "'"))
    .filter(Boolean);
}

// ---------------------------------------------------------------------------
// Triggers for referenced-column input
// ---------------------------------------------------------------------------

/** Referential actions offered by every supported engine. */
export const REFERENTIAL_ACTIONS = [
  "NO ACTION",
  "CASCADE",
  "SET NULL",
  "SET DEFAULT",
  "RESTRICT",
] as const;

/** Human label for a logical type, used in schema hints. */
export function logicalTypeLabel(logical: LogicalType): string {
  return logical.replace(/_/g, " ");
}
