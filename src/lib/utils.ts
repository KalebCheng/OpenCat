import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge conditional class names, letting later Tailwind utilities win. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** Format a byte count for the explorer and export summaries. */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes === null || bytes === undefined) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : value >= 10 ? 1 : 2)} ${units[unit]}`;
}

/** Group digits for row counts. */
export function formatCount(value: number | null | undefined): string {
  if (value === null || value === undefined) return "—";
  return new Intl.NumberFormat().format(value);
}

/** Milliseconds rendered the way a SQL client should: µs, ms or s. */
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms)) return "—";
  if (ms < 1) return `${(ms * 1000).toFixed(0)} µs`;
  if (ms < 1000) return `${ms.toFixed(ms < 10 ? 2 : 0)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

/** Short, human timestamp for history rows. */
export function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const now = Date.now();
  const diff = now - date.getTime();
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Colour for a connection dot in the sidebar. */
export const CONNECTION_COLORS = [
  "#8b5cf6",
  "#3b82f6",
  "#06b6d4",
  "#10b981",
  "#f59e0b",
  "#ef4444",
  "#ec4899",
  "#64748b",
] as const;

/** Pick a stable colour for a profile that has none set. */
export function connectionColor(profile: { id: string; color?: string | null }): string {
  if (profile.color) return profile.color;
  let hash = 0;
  for (let i = 0; i < profile.id.length; i += 1) {
    hash = (hash * 31 + profile.id.charCodeAt(i)) >>> 0;
  }
  return CONNECTION_COLORS[hash % CONNECTION_COLORS.length];
}

/** Initials shown on the connection badge. */
export function initials(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "?";
  const parts = trimmed.split(/[\s._-]+/).filter(Boolean);
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

/** Debounce a callback; used by the grid's filter box. */
export function debounce<T extends (...args: never[]) => void>(fn: T, ms: number): T {
  let handle: ReturnType<typeof setTimeout> | undefined;
  return ((...args: Parameters<T>) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => fn(...args), ms);
  }) as T;
}

/** Stable debounce for React callers that need to cancel on unmount. */
export function useDebouncedCallback<T extends (...args: never[]) => void>(
  fn: T,
  ms: number,
): { run: T; cancel: () => void } {
  let handle: ReturnType<typeof setTimeout> | undefined;
  const run = ((...args: Parameters<T>) => {
    if (handle) clearTimeout(handle);
    handle = setTimeout(() => fn(...args), ms);
  }) as T;
  return {
    run,
    cancel: () => {
      if (handle) clearTimeout(handle);
    },
  };
}

/** Normalize a dialect type name into something short enough for a header. */
export function shortType(typeName: string): string {
  return typeName
    .replace(/^character varying/i, "varchar")
    .replace(/^timestamp with time zone/i, "timestamptz")
    .replace(/^timestamp without time zone/i, "timestamp")
    .replace(/^double precision/i, "double")
    .replace(/^integer/i, "int");
}

/** Escape a value so it can be pasted back as SQL. */
export function escapeSqlLiteral(text: string): string {
  return `'${text.replace(/'/g, "''")}'`;
}

/** Copy a 2D selection as TSV, which pastes cleanly into a spreadsheet. */
export function toTsv(rows: string[][]): string {
  return rows.map((row) => row.join("\t")).join("\n");
}
