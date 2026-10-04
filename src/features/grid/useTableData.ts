/**
 * Paging, sorting and filtering for one relation.
 *
 * The hook owns a single `query` object rather than a handful of `useState`
 * calls: its identity changes exactly when the request changes, which makes the
 * fetch effect fire once per real change and never on an unrelated re-render.
 */

import * as React from "react";

import { ipc } from "@/lib/ipc";
import {
  type ErrorPayload,
  type OrderBy,
  type PageRequest,
  type Scope,
  type TablePage,
  type Value,
  toErrorPayload,
} from "@/lib/types";

import { type GridColumn, buildFilterClause, buildViewColumns } from "./gridModel";

/** The sizes the pager offers. */
export const PAGE_SIZES: number[] = [100, 500, 1000, 5000];

/** Stable empty row list so derived memos do not churn on every render. */
const NO_ROWS: Value[][] = [];

export interface UseTableDataOptions {
  sessionId: string;
  scope: Scope;
  table: string;
  /** Page size from settings, adopted until the user picks one here. */
  defaultLimit?: number;
  /** How long a filter box waits after the last keystroke. */
  debounceMs?: number;
}

export interface TableData {
  page: TablePage | null;
  /** Columns to paint; hidden ones are excluded but still present in `page`. */
  columns: GridColumn[];
  loading: boolean;
  error: ErrorPayload | null;
  editable: boolean;
  reason: string | null;

  // Query state.
  offset: number;
  limit: number;
  orderBy: OrderBy[];
  /** Live text in the per-column filter boxes. */
  filterText: Record<string, string>;
  /** Live text in the advanced WHERE box. */
  whereText: string;
  includeTotal: boolean;
  filtersActive: boolean;
  totalRows: number | null;
  /** 0-based index of the page on screen. */
  pageIndex: number;
  pageCount: number | null;
  canPrevious: boolean;
  canNext: boolean;
  canLast: boolean;

  // Actions.
  refresh: () => void;
  retry: () => void;
  setOffset: (offset: number) => void;
  firstPage: () => void;
  previousPage: () => void;
  nextPage: () => void;
  lastPage: () => void;
  setLimit: (limit: number) => void;
  toggleSort: (column: string, additive: boolean) => void;
  setFilterText: (column: string, value: string) => void;
  setWhereText: (value: string) => void;
  setIncludeTotal: (value: boolean) => void;
  clearFilters: () => void;
}

interface QueryState {
  offset: number;
  limit: number;
  orderBy: OrderBy[];
  /** Applied per-column filters, keyed by column name. */
  filters: Record<string, string>;
  /** Applied raw WHERE fragment. */
  where: string;
  includeTotal: boolean;
}

/** Drop boxes the user cleared so the request carries only real predicates. */
function appliedFilters(filterText: Record<string, string>): Record<string, string> {
  const filters: Record<string, string> = {};
  for (const [column, text] of Object.entries(filterText)) {
    if (text.trim()) filters[column] = text;
  }
  return filters;
}

function sameFilters(left: Record<string, string>, right: Record<string, string>): boolean {
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => left[key] === right[key]);
}

export function useTableData({
  sessionId,
  scope,
  table,
  defaultLimit = 500,
  debounceMs = 300,
}: UseTableDataOptions): TableData {
  const [query, setQuery] = React.useState<QueryState>(() => ({
    offset: 0,
    limit: defaultLimit,
    orderBy: [],
    filters: {},
    where: "",
    includeTotal: true,
  }));
  const [page, setPage] = React.useState<TablePage | null>(null);
  const [loading, setLoading] = React.useState(true);
  const [error, setError] = React.useState<ErrorPayload | null>(null);

  const [filterText, setFilterText] = React.useState<Record<string, string>>({});
  const [whereText, setWhereText] = React.useState("");

  // The caller may hand us a fresh scope object on every render, so the request
  // is built from its primitive parts and those are the effect's dependencies.
  const database = scope.database ?? null;
  const schema = scope.schema ?? null;
  const requestScope = React.useMemo<Scope>(() => ({ database, schema }), [database, schema]);

  const scopeKey = `${sessionId}\u0000${database ?? ""}\u0000${schema ?? ""}\u0000${table}`;
  const previousScope = React.useRef(scopeKey);
  const limitTouched = React.useRef(false);
  /** Ticket of the newest request; older answers are dropped when they land. */
  const ticket = React.useRef(0);

  // A different relation starts from a clean slate: offsets, sort keys and
  // filters all describe the table that was open a moment ago.
  React.useEffect(() => {
    if (previousScope.current === scopeKey) return;
    previousScope.current = scopeKey;
    limitTouched.current = false;
    setFilterText({});
    setWhereText("");
    setQuery((prev) => ({
      offset: 0,
      limit: defaultLimit,
      orderBy: [],
      filters: {},
      where: "",
      includeTotal: prev.includeTotal,
    }));
  }, [scopeKey, defaultLimit]);

  // Settings load asynchronously at startup, so the saved page size can arrive
  // after the first fetch. Adopt it until the user chooses a size in the pager.
  React.useEffect(() => {
    if (limitTouched.current) return;
    setQuery((prev) =>
      prev.limit === defaultLimit ? prev : { ...prev, limit: defaultLimit, offset: 0 },
    );
  }, [defaultLimit]);

  // Debounce the filter boxes. Applying a filter rewinds to the first page,
  // because the previous offset describes a result set that no longer exists.
  React.useEffect(() => {
    const handle = setTimeout(() => {
      setQuery((prev) => {
        const filters = appliedFilters(filterText);
        const where = whereText.trim();
        if (sameFilters(prev.filters, filters) && prev.where === where) return prev;
        return { ...prev, filters, where, offset: 0 };
      });
    }, debounceMs);
    return () => clearTimeout(handle);
  }, [filterText, whereText, debounceMs]);

  const run = React.useCallback(async () => {
    const current = (ticket.current += 1);
    setLoading(true);
    setError(null);
    try {
      const request: PageRequest = {
        scope: requestScope,
        table,
        offset: query.offset,
        limit: query.limit,
        orderBy: query.orderBy.length > 0 ? query.orderBy : undefined,
        filter: buildFilterClause(query.filters, query.where),
        includeTotal: query.includeTotal,
      };
      const result = await ipc.data.page(sessionId, request);
      // A newer request already started; this answer is stale.
      if (current !== ticket.current) return;
      setPage(result);
      // Deleting the last row of the last page would otherwise strand the user
      // on an empty page, so step back and let the effect fetch again.
      if (result.rows.length === 0 && result.offset > 0) {
        setQuery((prev) =>
          prev.offset === result.offset
            ? { ...prev, offset: Math.max(0, result.offset - result.limit) }
            : prev,
        );
      }
    } catch (caught) {
      if (current !== ticket.current) return;
      setError(toErrorPayload(caught));
    } finally {
      if (current === ticket.current) setLoading(false);
    }
  }, [sessionId, table, requestScope, query]);

  React.useEffect(() => {
    void run();
  }, [run]);

  const refresh = React.useCallback(() => {
    void run();
  }, [run]);

  const setOffset = React.useCallback((offset: number) => {
    setQuery((prev) => {
      const next = Math.max(0, offset);
      return prev.offset === next ? prev : { ...prev, offset: next };
    });
  }, []);

  const setLimit = React.useCallback((limit: number) => {
    limitTouched.current = true;
    setQuery((prev) =>
      prev.limit === limit && prev.offset === 0 ? prev : { ...prev, limit, offset: 0 },
    );
  }, []);

  const firstPage = React.useCallback(() => setOffset(0), [setOffset]);

  const previousPage = React.useCallback(() => {
    setQuery((prev) => {
      const next = Math.max(0, prev.offset - prev.limit);
      return prev.offset === next ? prev : { ...prev, offset: next };
    });
  }, []);

  const nextPage = React.useCallback(() => {
    setQuery((prev) => ({ ...prev, offset: prev.offset + prev.limit }));
  }, []);

  const lastPage = React.useCallback(() => {
    setQuery((prev) => {
      const total = page?.totalRows ?? null;
      if (total === null) return prev;
      const next = Math.max(0, Math.floor(Math.max(0, total - 1) / prev.limit) * prev.limit);
      return prev.offset === next ? prev : { ...prev, offset: next };
    });
  }, [page]);

  const toggleSort = React.useCallback((column: string, additive: boolean) => {
    setQuery((prev) => {
      const existing = prev.orderBy.find((order) => order.column === column);
      if (!additive) {
        // A plain click cycles this column alone: ascending, descending, none.
        const next: OrderBy | null = !existing
          ? { column, desc: false }
          : existing.desc
            ? null
            : { column, desc: true };
        return { ...prev, orderBy: next ? [next] : [], offset: 0 };
      }
      // Shift extends the sort key list, keeping the other keys in place.
      if (!existing) {
        return { ...prev, orderBy: [...prev.orderBy, { column, desc: false }], offset: 0 };
      }
      if (!existing.desc) {
        return {
          ...prev,
          orderBy: prev.orderBy.map((order) =>
            order.column === column ? { column, desc: true } : order,
          ),
          offset: 0,
        };
      }
      return {
        ...prev,
        orderBy: prev.orderBy.filter((order) => order.column !== column),
        offset: 0,
      };
    });
  }, []);

  const updateFilterText = React.useCallback((column: string, value: string) => {
    setFilterText((prev) => ({ ...prev, [column]: value }));
  }, []);

  const updateWhereText = React.useCallback((value: string) => {
    setWhereText(value);
  }, []);

  const updateIncludeTotal = React.useCallback((value: boolean) => {
    setQuery((prev) => (prev.includeTotal === value ? prev : { ...prev, includeTotal: value }));
  }, []);

  const clearFilters = React.useCallback(() => {
    setFilterText({});
    setWhereText("");
  }, []);

  const columns = React.useMemo(() => buildViewColumns(page), [page]);
  const rows = page?.rows ?? NO_ROWS;
  const totalRows = page?.totalRows ?? null;
  const pageIndex = Math.floor(query.offset / Math.max(1, query.limit));
  const pageCount =
    totalRows === null ? null : Math.max(1, Math.ceil(totalRows / Math.max(1, query.limit)));
  const canPrevious = query.offset > 0;
  const canNext = pageCount !== null ? pageIndex + 1 < pageCount : rows.length >= query.limit;

  return {
    page,
    columns,
    loading,
    error,
    editable: page?.editable ?? false,
    reason: page?.reason ?? null,

    offset: query.offset,
    limit: query.limit,
    orderBy: query.orderBy,
    filterText,
    whereText,
    includeTotal: query.includeTotal,
    filtersActive: Object.keys(query.filters).length > 0 || query.where !== "",
    totalRows,
    pageIndex,
    pageCount,
    canPrevious,
    canNext,
    canLast: pageCount !== null && pageIndex + 1 < pageCount,

    refresh,
    retry: refresh,
    setOffset,
    firstPage,
    previousPage,
    nextPage,
    lastPage,
    setLimit,
    toggleSort,
    setFilterText: updateFilterText,
    setWhereText: updateWhereText,
    setIncludeTotal: updateIncludeTotal,
    clearFilters,
  };
}
