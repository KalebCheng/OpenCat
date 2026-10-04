/**
 * Step 2 of the import wizard: what the file holds, and where each column goes.
 *
 * Split from the wizard so the preview table can stay a dumb renderer — it never
 * needs to know about parsing options or the request that will be sent.
 */

import * as React from "react";
import { ArrowRight } from "lucide-react";

import { Badge, NativeSelect, type BadgeTone } from "@/components/ui/primitives";
import { type Value, valueText } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Section } from "./controls";

export interface ColumnMapperProps {
  fileColumns: string[];
  /** Target columns of the destination table; empty when the schema is unknown. */
  targets: string[];
  mapping: (string | null)[];
  onChange: (index: number, target: string | null) => void;
}

/** One select per file column, defaulting to a name match and falling back to order. */
export function ColumnMapper({
  fileColumns,
  targets,
  mapping,
  onChange,
}: ColumnMapperProps): React.ReactElement {
  const skipped = mapping.filter((target) => target === null).length;

  return (
    <Section
      title="Map columns"
      description="File columns on the left, destination columns on the right. Anything left as Skip is not written."
      action={
        <span className="text-[11px] text-subtle">
          {mapping.length - skipped} of {mapping.length} mapped
        </span>
      }
    >
      <div className="flex max-h-64 flex-col gap-1.5 overflow-auto scrollbar-thin pr-1">
        {fileColumns.map((name, index) => {
          const target = mapping[index] ?? null;
          const byName =
            target !== null && target.trim().toLowerCase() === name.trim().toLowerCase();
          const tone: BadgeTone = target === null ? "neutral" : byName ? "success" : "accent";
          const label = target === null ? "Skipped" : byName ? "Name" : "Manual";
          return (
            <div
              key={`${name}-${index}`}
              className="grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2"
            >
              <span
                title={name}
                className="min-w-0 truncate font-mono text-[11px] text-fg"
              >
                {name}
              </span>
              <ArrowRight className="size-3 text-subtle" />
              <div className="flex min-w-0 items-center gap-1.5">
                <NativeSelect
                  aria-label={`Target column for ${name}`}
                  value={target ?? ""}
                  onChange={(event) =>
                    onChange(index, event.target.value === "" ? null : event.target.value)
                  }
                >
                  <option value="">— Skip —</option>
                  {targets.map((column) => (
                    <option key={column} value={column}>
                      {column}
                    </option>
                  ))}
                </NativeSelect>
                <Badge tone={tone} className="shrink-0">
                  {label}
                </Badge>
              </div>
            </div>
          );
        })}
      </div>
    </Section>
  );
}

export interface PreviewTableProps {
  columns: string[];
  rows: Value[][];
  /** Cap the height so a wide file cannot push the wizard footer off screen. */
  className?: string;
}

/** Compact, read-only view of the parsed rows. */
export function PreviewTable({
  columns,
  rows,
  className,
}: PreviewTableProps): React.ReactElement {
  if (rows.length === 0) {
    return (
      <p className={cn("text-[11px] text-subtle", className)}>
        The file parsed without any data rows.
      </p>
    );
  }

  return (
    <div
      className={cn(
        "max-h-72 min-w-0 overflow-auto scrollbar-thin rounded-md border border-border",
        className,
      )}
    >
      <table className="w-full border-collapse text-left font-mono text-[11px]">
        <thead className="sticky top-0 z-10 bg-grid-header">
          <tr>
            {columns.map((column, index) => (
              <th
                key={`${column}-${index}`}
                className="whitespace-nowrap border-b border-border px-2 py-1 font-semibold text-fg"
              >
                {column}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="odd:bg-grid-alt">
              {columns.map((_, columnIndex) => {
                const value = row[columnIndex];
                const isNull = !value || value.t === "null";
                return (
                  <td
                    key={columnIndex}
                    className={cn(
                      "max-w-[16rem] truncate border-b border-border/60 px-2 py-0.5",
                      isNull ? "italic text-grid-null" : "text-fg",
                    )}
                  >
                    {isNull ? "NULL" : valueText(value)}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
