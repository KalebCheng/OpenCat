/**
 * Read-only result grid for the SQL editor.
 *
 * Deliberately independent of `features/grid` (which edits tables): a query
 * result has no row identity, so there is nothing to write back.
 */

import { useCallback, useMemo, useRef, useState } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import { AlertTriangle, Copy, Eye, Hash } from "lucide-react";

import { Badge, IconButton } from "@/components/ui/primitives";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Tooltip,
} from "@/components/ui/overlays";
import type { ColumnMeta, QueryResult, Value } from "@/lib/types";
import { valueText } from "@/lib/types";
import { Button } from "@/components/ui/primitives";
import { cn, formatCount, formatDuration, shortType, toTsv } from "@/lib/utils";
import { useSettings } from "@/store/settings";

const ROW_HEIGHT = 24;

export interface ResultGridProps {
  result: QueryResult;
  /** Maximum rendered rows; the rest are reported as not shown. */
  maxRender?: number;
}

export function ResultGrid({ result, maxRender = 20_000 }: ResultGridProps) {
  const nullDisplay = useSettings((state) => state.settings.nullDisplay);
  const truncateAt = useSettings((state) => state.settings.truncateCellChars);
  const [viewing, setViewing] = useState<{ column: string; value: Value } | null>(null);
  const [selected, setSelected] = useState<{ row: number; column: number } | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const visibleColumns = useMemo(
    () => result.columns.map((column, index) => ({ column, index })),
    [result.columns],
  );

  const rows = useMemo(
    () => result.rows.slice(0, maxRender),
    [result.rows, maxRender],
  );

  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 24,
  });

  const copyAll = useCallback(async () => {
    const header = visibleColumns.map(({ column }) => column.name);
    const body = rows.map((row) =>
      visibleColumns.map(({ index }) => valueText(row[index])),
    );
    await navigator.clipboard.writeText(toTsv([header, ...body]));
  }, [rows, visibleColumns]);

  if (result.columns.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 text-center">
        <Hash className="size-6 text-subtle" />
        <p className="text-xs text-muted">
          {result.rowsAffected > 0
            ? `${formatCount(result.rowsAffected)} row${result.rowsAffected === 1 ? "" : "s"} affected`
            : "Statement completed with no result set."}
        </p>
        <p className="text-[11px] text-subtle">{formatDuration(result.elapsedMs)}</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-7 shrink-0 items-center gap-2 border-b border-border bg-raised px-2 text-[11px] text-muted">
        <Badge tone="info">{formatCount(result.rows.length)} rows</Badge>
        <Badge tone="neutral">{result.columns.length} cols</Badge>
        <span className="tnum">{formatDuration(result.elapsedMs)}</span>
        {result.truncated ? (
          <span className="flex items-center gap-1 text-warning">
            <AlertTriangle className="size-3" />
            truncated by the row cap
          </span>
        ) : null}
        {result.rows.length > maxRender ? (
          <span className="text-subtle">
            showing the first {formatCount(maxRender)}
          </span>
        ) : null}
        <div className="flex-1" />
        <Tooltip content="Copy all rows as TSV">
          <IconButton label="Copy all rows" size="icon-sm" variant="ghost" onClick={copyAll}>
            <Copy className="size-3" />
          </IconButton>
        </Tooltip>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto scrollbar-thin">
        <div
          className="relative min-w-full"
          style={{ height: virtualizer.getTotalSize() + ROW_HEIGHT }}
        >
          {/* header */}
          <div className="sticky top-0 z-10 flex h-6 min-w-full border-b border-border bg-grid-header">
            <div className="flex w-12 shrink-0 items-center justify-end border-r border-border px-2 text-[10px] text-subtle">
              #
            </div>
            {visibleColumns.map(({ column }) => (
              <HeaderCell key={column.name} column={column} />
            ))}
          </div>

          {/* body */}
          <div style={{ position: "relative" }}>
            {virtualizer.getVirtualItems().map((virtualRow) => {
              const row = rows[virtualRow.index];
              if (!row) return null;
              return (
                <div
                  key={virtualRow.key}
                  className={cn(
                    "absolute left-0 flex w-full border-b border-border/60",
                    virtualRow.index % 2 === 1 && "bg-grid-alt",
                    "hover:bg-grid-hover",
                  )}
                  style={{
                    top: virtualRow.start,
                    height: ROW_HEIGHT,
                  }}
                >
                  <div className="flex w-12 shrink-0 items-center justify-end border-r border-border px-2 text-[10px] text-subtle tnum">
                    {virtualRow.index + 1}
                  </div>
                  {visibleColumns.map(({ column, index }) => {
                    const value = row[index];
                    const isSelected =
                      selected?.row === virtualRow.index && selected.column === index;
                    return (
                      <Cell
                        key={column.name}
                        value={value}
                        column={column}
                        nullDisplay={nullDisplay}
                        truncateAt={truncateAt}
                        selected={isSelected}
                        onSelect={() =>
                          setSelected({ row: virtualRow.index, column: index })
                        }
                        onInspect={() => setViewing({ column: column.name, value })}
                      />
                    );
                  })}
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {viewing ? (
        <ValueViewer
          column={viewing.column}
          value={viewing.value}
          onClose={() => setViewing(null)}
        />
      ) : null}
    </div>
  );
}

function HeaderCell({ column }: { column: ColumnMeta }) {
  return (
    <div
      className="flex min-w-[8rem] max-w-[22rem] flex-1 shrink-0 flex-col justify-center border-r border-border px-2"
      title={`${column.name} — ${column.typeName}`}
    >
      <span className="flex items-center gap-1 truncate text-[11px] font-medium text-fg">
        {column.isPrimaryKey ? <Hash className="size-2.5 shrink-0 text-warning" /> : null}
        {column.name}
      </span>
      <span className="truncate text-[9px] uppercase tracking-wide text-subtle">
        {shortType(column.typeName)}
      </span>
    </div>
  );
}

function Cell({
  value,
  column,
  nullDisplay,
  truncateAt,
  selected,
  onSelect,
  onInspect,
}: {
  value: Value | undefined;
  column: ColumnMeta;
  nullDisplay: string;
  truncateAt: number;
  selected: boolean;
  onSelect: () => void;
  onInspect: () => void;
}) {
  const isNull = !value || value.t === "null";
  const rightAligned = ["integer", "float", "decimal"].includes(column.logicalType);
  const text = isNull ? nullDisplay : valueText(value);
  const display = truncateAt > 0 && text.length > truncateAt ? `${text.slice(0, truncateAt)}…` : text;

  return (
    <div
      role="gridcell"
      tabIndex={0}
      onClick={onSelect}
      onFocus={onSelect}
      onDoubleClick={onInspect}
      title={text}
      className={cn(
        "flex min-w-[8rem] max-w-[22rem] flex-1 shrink-0 items-center gap-1 border-r border-border/60 px-2 text-[12px]",
        rightAligned && "justify-end tnum",
        isNull && "italic text-grid-null",
        selected && "bg-grid-selected ring-1 ring-inset ring-accent",
      )}
    >
      <span className="min-w-0 flex-1 truncate text-left">{display}</span>
      {text.length > 40 ? (
        <button
          type="button"
          aria-label="View full value"
          onClick={(event) => {
            event.stopPropagation();
            onInspect();
          }}
          className="shrink-0 text-subtle opacity-0 transition-opacity hover:text-accent focus:opacity-100 group-hover:opacity-100 [div:hover>&]:opacity-100"
        >
          <Eye className="size-3" />
        </button>
      ) : null}
    </div>
  );
}

/** Modal that shows one value in full, formatted for its type. */
export function ValueViewer({
  column,
  value,
  onClose,
}: {
  column: string;
  value: Value | undefined;
  onClose: () => void;
}) {
  const text = valueText(value);
  const pretty = useMemo(() => {
    if (value?.t === "json") {
      try {
        return JSON.stringify(JSON.parse(value.v), null, 2);
      } catch {
        return value.v;
      }
    }
    return text;
  }, [value, text]);

  const bytesLength = value?.t === "bytes" ? (value.len ?? 0) : 0;

  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent size="lg" className="max-h-[80vh]">
        <DialogHeader title={column} description={value ? `type: ${value.t}` : "NULL"} />
        <DialogBody className="p-0">
          {value?.t === "bytes" ? (
            <div className="flex flex-col gap-2 p-4">
              <p className="text-xs text-muted">
                Binary value · {formatCount(bytesLength)} bytes
              </p>
              <pre className="selectable max-h-[50vh] overflow-auto scrollbar-thin rounded-md border border-border bg-sunken p-3 font-mono text-[11px] leading-relaxed">
                {hexDump(value.v)}
              </pre>
            </div>
          ) : (
            <pre className="selectable max-h-[60vh] overflow-auto scrollbar-thin whitespace-pre-wrap break-all p-4 font-mono text-[12px] leading-relaxed">
              {pretty || "(empty)"}
            </pre>
          )}
        </DialogBody>
        <DialogFooter>
          <Button
            onClick={() => {
              void navigator.clipboard.writeText(pretty);
            }}
          >
            <Copy className="size-3.5" />
            Copy
          </Button>
          <Button variant="primary" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Render base64 bytes as a classic hex + ASCII dump. */
function hexDump(base64: string): string {
  let bytes: Uint8Array;
  try {
    const binary = atob(base64);
    bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  } catch {
    return "(could not decode)";
  }

  const lines: string[] = [];
  const limit = Math.min(bytes.length, 4096);
  for (let offset = 0; offset < limit; offset += 16) {
    const slice = bytes.subarray(offset, offset + 16);
    const hex = Array.from(slice)
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join(" ")
      .padEnd(47, " ");
    const ascii = Array.from(slice)
      .map((byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : "."))
      .join("");
    lines.push(`${offset.toString(16).padStart(8, "0")}  ${hex}  |${ascii}|`);
  }
  if (bytes.length > limit) {
    lines.push(`… ${formatCount(bytes.length - limit)} more bytes`);
  }
  return lines.join("\n");
}
