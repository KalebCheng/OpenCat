/**
 * Public surface of the data-grid feature.
 *
 * The named export and the default export are the same component so callers can
 * `import { DataGrid }` or `import DataGrid` interchangeably.
 */

export { DataGrid, default } from "./DataGrid";
export type { DataGridProps } from "./DataGrid";

export { CellEditor } from "./CellEditor";
export type { CellEditorCommit, CellEditorProps, EditMove } from "./CellEditor";

export { CellViewer } from "./CellViewer";
export type { CellViewerProps } from "./CellViewer";

export { InsertRowDialog } from "./InsertRowDialog";
export type { InsertRowDialogProps } from "./InsertRowDialog";

export { PAGE_SIZES, useTableData } from "./useTableData";
export type { TableData, UseTableDataOptions } from "./useTableData";

export { useGridSelection } from "./useGridSelection";
export type {
  CellPos,
  GridSelection,
  SelectionRect,
  UseGridSelectionOptions,
} from "./useGridSelection";

export {
  FILTER_HEIGHT,
  HEADER_HEIGHT,
  OVERSCAN,
  ROW_HEIGHT,
  buildFilterClause,
  buildViewColumns,
  canEditColumn,
  columnCondition,
  columnWidth,
  displayText,
  editorText,
  extractRowKeys,
  isLongValue,
  isNumericValue,
  parseFilter,
  rangeLabel,
  valueEquals,
} from "./gridModel";
export type { FilterOperator, GridColumn, ParsedFilter } from "./gridModel";
