/**
 * The visual table designer.
 *
 * `TableDesigner` is the entry point; the editors, the SQL preview and the
 * dialect helpers are exported alongside it so a host tab can compose them (for
 * example to render just the preview) without reaching into the folder.
 */

export { TableDesigner, default } from "./TableDesigner";
export type { TableDesignerProps } from "./TableDesigner";

export { ColumnEditor } from "./ColumnEditor";
export type { ColumnEditorProps } from "./ColumnEditor";

export { IndexEditor } from "./IndexEditor";
export type { IndexEditorProps } from "./IndexEditor";

export { ForeignKeyEditor } from "./ForeignKeyEditor";
export type { ForeignKeyEditorProps } from "./ForeignKeyEditor";

export { SqlPreview, splitStatements } from "./SqlPreview";
export type { SqlPreviewProps } from "./SqlPreview";

export { Note, Row, TypeCombobox } from "./ui";
export type { TypeComboboxProps } from "./ui";

export {
  autoIncrementTypeFor,
  baseType,
  defaultTypeFor,
  enumMemberString,
  logicalTypeLabel,
  logicalTypeOf,
  parseEnumMembers,
  quoteChar,
  quoteIdent,
  REFERENTIAL_ACTIONS,
  suggestTypes,
  typeArguments,
  typeImpliesAutoIncrement,
  typeUsesEnumValues,
  TYPE_SUGGESTIONS,
  withTypeArguments,
} from "./types";
export type { TypeSuggestion } from "./types";

export {
  blankColumn,
  isPlanDirty,
  liveColumns,
  liveForeignKeys,
  liveIndexes,
  moveItem,
  newColumn,
  newForeignKeyPlan,
  newIndexPlan,
  newTablePlan,
  planFingerprint,
  planFromSchema,
  replaceAt,
  scopePrefix,
  summariseChanges,
} from "./plan";
export type { PlanChangeSummary, PlanColumn } from "./plan";
