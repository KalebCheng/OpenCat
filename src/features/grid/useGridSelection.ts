/**
 * Cell cursor and rectangular selection for the grid.
 *
 * The grid keeps two points: an anchor (where the selection started) and a
 * focus (where the cursor is now). A rectangle only exists when both are inside
 * the current page, which is why clamping happens here rather than in the
 * render path.
 */

import * as React from "react";

import { toTsv } from "@/lib/utils";

export interface CellPos {
  row: number;
  col: number;
}

export interface SelectionRect {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

export interface UseGridSelectionOptions {
  rowCount: number;
  columnCount: number;
  /** Text of one cell, used by the TSV copy. */
  cellText: (row: number, col: number) => string;
}

export interface GridSelection {
  /** Where the selection started. */
  anchor: CellPos;
  /** Where the cursor is; also the cell the keyboard acts on. */
  focus: CellPos;
  rect: SelectionRect | null;
  /** Number of cells the rectangle covers. */
  cellCount: number;
  setCell: (pos: CellPos, extend?: boolean) => void;
  move: (deltaRow: number, deltaCol: number, extend?: boolean) => void;
  /** Tab / Shift+Tab, wrapping across rows at the ends of the grid. */
  moveTab: (delta: 1 | -1) => void;
  selectAll: () => void;
  /** Collapse the rectangle back onto the cursor. */
  clear: () => void;
  isSelected: (row: number, col: number) => boolean;
  isFocus: (row: number, col: number) => boolean;
  /** Copy the rectangle as TSV; resolves with the number of cells copied. */
  copy: () => Promise<number>;
}

const ORIGIN: CellPos = { row: 0, col: 0 };

function clampIndex(value: number, count: number): number {
  if (count <= 0) return 0;
  return Math.min(Math.max(value, 0), count - 1);
}

/** Pull a cursor back inside the page, keeping its identity when it already fits. */
function clampPos(pos: CellPos, rows: number, columns: number): CellPos {
  const row = clampIndex(pos.row, rows);
  const col = clampIndex(pos.col, columns);
  return row === pos.row && col === pos.col ? pos : { row, col };
}

export function useGridSelection({
  rowCount,
  columnCount,
  cellText,
}: UseGridSelectionOptions): GridSelection {
  const [anchor, setAnchor] = React.useState<CellPos>(ORIGIN);
  const [focus, setFocus] = React.useState<CellPos>(ORIGIN);

  // A new page can be shorter than the last one, or sorted differently. Move the
  // cursor back in range instead of pointing it at a row that no longer exists.
  React.useEffect(() => {
    setAnchor((prev) => clampPos(prev, rowCount, columnCount));
    setFocus((prev) => clampPos(prev, rowCount, columnCount));
  }, [rowCount, columnCount]);

  const rect = React.useMemo<SelectionRect | null>(() => {
    if (rowCount === 0 || columnCount === 0) return null;
    return {
      top: Math.min(anchor.row, focus.row),
      bottom: Math.max(anchor.row, focus.row),
      left: Math.min(anchor.col, focus.col),
      right: Math.max(anchor.col, focus.col),
    };
  }, [anchor, focus, rowCount, columnCount]);

  const setCell = React.useCallback(
    (pos: CellPos, extend = false) => {
      const next = clampPos(pos, rowCount, columnCount);
      if (extend) {
        setFocus(next);
        return;
      }
      setAnchor(next);
      setFocus(next);
    },
    [rowCount, columnCount],
  );

  const move = React.useCallback(
    (deltaRow: number, deltaCol: number, extend = false) => {
      const next = clampPos(
        { row: focus.row + deltaRow, col: focus.col + deltaCol },
        rowCount,
        columnCount,
      );
      setFocus(next);
      // Without shift the rectangle collapses onto the new cursor.
      if (!extend) setAnchor(next);
    },
    [focus, rowCount, columnCount],
  );

  const moveTab = React.useCallback(
    (delta: 1 | -1) => {
      const raw = focus.col + delta;
      // Tab off either end of a row lands on the neighbouring row and wraps.
      const next = clampPos(
        {
          row: raw < 0 ? focus.row - 1 : raw >= columnCount ? focus.row + 1 : focus.row,
          col: raw < 0 ? columnCount - 1 : raw >= columnCount ? 0 : raw,
        },
        rowCount,
        columnCount,
      );
      setFocus(next);
      setAnchor(next);
    },
    [focus, rowCount, columnCount],
  );

  const selectAll = React.useCallback(() => {
    if (rowCount === 0 || columnCount === 0) return;
    setAnchor(ORIGIN);
    setFocus({ row: rowCount - 1, col: columnCount - 1 });
  }, [rowCount, columnCount]);

  const clear = React.useCallback(() => {
    setAnchor(focus);
  }, [focus]);

  const isSelected = React.useCallback(
    (row: number, col: number) =>
      rect !== null &&
      row >= rect.top &&
      row <= rect.bottom &&
      col >= rect.left &&
      col <= rect.right,
    [rect],
  );

  const isFocus = React.useCallback(
    (row: number, col: number) => focus.row === row && focus.col === col,
    [focus],
  );

  const copy = React.useCallback(async () => {
    if (!rect) return 0;
    const lines: string[][] = [];
    for (let row = rect.top; row <= rect.bottom; row += 1) {
      const line: string[] = [];
      for (let col = rect.left; col <= rect.right; col += 1) line.push(cellText(row, col));
      lines.push(line);
    }
    await navigator.clipboard.writeText(toTsv(lines));
    return lines.length * (rect.right - rect.left + 1);
  }, [rect, cellText]);

  const cellCount = rect ? (rect.bottom - rect.top + 1) * (rect.right - rect.left + 1) : 0;

  return {
    anchor,
    focus,
    rect,
    cellCount,
    setCell,
    move,
    moveTab,
    selectAll,
    clear,
    isSelected,
    isFocus,
    copy,
  };
}
