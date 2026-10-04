/**
 * Export result set dialog.
 *
 * The dialog owns three things the backend deliberately does not: choosing a
 * destination, choosing which columns travel, and collecting rows that the grid
 * has not materialised yet. Everything it builds is a plain {@link ExportRequest}
 * — the Rust exporter renders and writes the file in one shot.
 */

import * as React from "react";
import { toast } from "sonner";
import { save } from "@tauri-apps/plugin-dialog";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import {
  Braces,
  Check,
  Copy,
  Download,
  FileCode2,
  FileSpreadsheet,
  FolderOpen,
  RefreshCw,
  Table2,
} from "lucide-react";

import {
  Button,
  Checkbox,
  CheckboxField,
  Field,
  IconButton,
  Input,
  Spinner,
} from "@/components/ui/primitives";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
} from "@/components/ui/overlays";
import ipc from "@/lib/ipc";
import {
  type CsvOptions,
  type DbKind,
  type ExportRequest,
  type ExportSummary,
  NULL_VALUE,
  type Scope,
  type TransferFormat,
  type Value,
  toErrorPayload,
} from "@/lib/types";
import { formatBytes, formatCount, formatDuration } from "@/lib/utils";
import { useSettings } from "@/store/settings";
import { CsvOptionsPanel } from "./CsvOptionsPanel";
import { NumberField, Section } from "./controls";
import {
  DEFAULT_CSV,
  FORMATS,
  formatInfo,
  joinPath,
  materialiseCsv,
  rebaseExtension,
  suggestedFileName,
} from "./formats";
import { renderExport } from "./render";

export interface ExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  scope: Scope;
  dbKind: DbKind;
  table?: string;
  /** The statement that produced the current result set. */
  sql?: string;
  /** Columns of the current result set, in order. */
  columns: string[];
  /** Rows already in memory. When omitted the dialog collects them via `sql`. */
  rows?: Value[][];
}

/** The format cards, in the order they are offered. */
const FORMAT_ICONS: Record<TransferFormat, React.ReactNode> = {
  csv: <FileSpreadsheet className="size-4" />,
  tsv: <Table2 className="size-4" />,
  json: <Braces className="size-4" />,
  sql_insert: <FileCode2 className="size-4" />,
};

export function ExportDialog(props: ExportDialogProps): React.ReactElement {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* The body is mounted per open so every export starts from clean state
          instead of whatever the previous run left behind. */}
      {open ? <ExportDialogBody {...props} /> : null}
    </Dialog>
  );
}

type BodyProps = Omit<ExportDialogProps, "open">;

function ExportDialogBody({
  onOpenChange,
  sessionId,
  scope,
  dbKind,
  table,
  sql,
  columns,
  rows,
}: BodyProps): React.ReactElement {
  const exportDefaultDir = useSettings((state) => state.settings.exportDefaultDir);

  const [format, setFormat] = React.useState<TransferFormat>("csv");
  const [csv, setCsv] = React.useState<CsvOptions>(DEFAULT_CSV);
  const [pretty, setPretty] = React.useState(true);
  const [batchSize, setBatchSize] = React.useState(100);
  const [path, setPath] = React.useState(() =>
    exportDefaultDir
      ? joinPath(exportDefaultDir, suggestedFileName(table, "csv"))
      : suggestedFileName(table, "csv"),
  );

  // Columns are keyed by index rather than name: a result set may repeat a name
  // (`SELECT a.id, b.id`), and the request is positional anyway.
  const [deselected, setDeselected] = React.useState<ReadonlySet<number>>(() => new Set());
  const [maxRows, setMaxRows] = React.useState(() => useSettings.getState().settings.maxRows);
  const [collected, setCollected] = React.useState<{
    columns: string[];
    rows: Value[][];
    truncated: boolean;
  } | null>(null);
  const [collecting, setCollecting] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [summary, setSummary] = React.useState<ExportSummary | null>(null);
  const [copied, setCopied] = React.useState(false);

  // A result set handed over already wins; otherwise whatever `collect` fetched.
  const activeColumns = columns.length > 0 ? columns : (collected?.columns ?? []);
  const activeRows = rows ?? collected?.rows ?? [];

  const collect = React.useCallback(
    async (cap: number) => {
      if (!sql) return;
      setCollecting(true);
      setError(null);
      try {
        const result = await ipc.data.collect(
          sessionId,
          sql,
          cap,
          scope.database ?? undefined,
          scope.schema ?? undefined,
        );
        setCollected({
          columns: result.columns.map((column) => column.name),
          rows: result.rows,
          truncated: result.truncated,
        });
      } catch (cause) {
        const message = toErrorPayload(cause).message;
        setError(message);
        toast.error("Could not collect the result set", { description: message });
      } finally {
        setCollecting(false);
      }
    },
    [sessionId, sql, scope.database, scope.schema],
  );

  // Fetch once per open. Re-running on every row-cap keystroke would send a
  // query per character, so the cap is applied by the explicit Refresh button.
  React.useEffect(() => {
    if (rows === undefined && sql) void collect(maxRows);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const chosenIndexes = activeColumns
    .map((_, index) => index)
    .filter((index) => !deselected.has(index));
  const chosenColumns = chosenIndexes.map((index) => activeColumns[index]);
  const chosenRows = activeRows.map((row) =>
    chosenIndexes.map((index) => row[index] ?? NULL_VALUE),
  );

  const needsTable = format === "sql_insert";
  // An empty result set is still worth writing — the header row survives — but
  // a missing destination or table name is not.
  const blocked =
    chosenColumns.length === 0 || path.trim().length === 0 || (needsTable && !table);

  const buildRequest = (): ExportRequest => ({
    format,
    path: path.trim(),
    columns: chosenColumns,
    rows: chosenRows,
    table: table ?? null,
    database: scope.database ?? null,
    schema: scope.schema ?? null,
    dbKind,
    // Always a complete object: the Rust struct only defaults the whole `csv`
    // field, so a partial payload would be rejected outright.
    csv: materialiseCsv(format, csv),
    batchSize,
  });

  const browse = async () => {
    try {
      const picked = await save({
        title: "Export to file",
        defaultPath: path.trim() || suggestedFileName(table, format),
        filters: formatInfo(format).filters,
      });
      if (typeof picked === "string") setPath(picked);
    } catch (cause) {
      toast.error("Could not open the save dialog", {
        description: toErrorPayload(cause).message,
      });
    }
  };

  const run = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await ipc.transfer.exportData(buildRequest());
      setSummary(result);
      toast.success(`Exported ${formatCount(result.rows)} rows`, {
        description: `${formatBytes(result.bytes)} in ${formatDuration(result.elapsedMs)}`,
      });
    } catch (cause) {
      const message = toErrorPayload(cause).message;
      setError(message);
      toast.error("Export failed", { description: message });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (text: string, label: string) => {
    try {
      await ipc.app.copyToClipboard(text);
      if (label === "clipboard") {
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }
      toast.success(`Copied ${label}`);
    } catch (cause) {
      toast.error("Could not copy", { description: toErrorPayload(cause).message });
    }
  };

  const reveal = async () => {
    if (!summary) return;
    try {
      await revealItemInDir(summary.path);
    } catch (cause) {
      // The opener plugin is only present in a packaged app; fall back to
      // copying the path so the user can paste it into a file manager.
      void copy(summary.path, "path");
      toast.error("Could not reveal the file", {
        description: toErrorPayload(cause).message,
      });
    }
  };

  const copyRendered = () =>
    copy(
      renderExport({
        format,
        columns: chosenColumns,
        rows: chosenRows,
        csv: materialiseCsv(format, csv),
        pretty,
        table: table ?? null,
        database: scope.database ?? null,
        schema: scope.schema ?? null,
        dbKind,
        batchSize,
      }),
      "clipboard",
    );

  const footerHint = error
    ? error
    : `${formatCount(chosenRows.length)} rows × ${chosenColumns.length} columns`;

  return (
    <DialogContent size="xl">
      <DialogHeader
        title="Export"
        description={
          table
            ? `Write ${table} to disk as a CSV, JSON or SQL script.`
            : "Write the current result set to disk."
        }
        icon={<Download />}
      />
      <DialogBody className="grid content-start gap-4 lg:grid-cols-[minmax(0,1fr)_248px]">
        <div className="flex min-w-0 flex-col gap-4">
          {summary ? (
            <Section
              title="Export complete"
              action={
                <Button size="xs" variant="ghost" onClick={() => setSummary(null)}>
                  Export again
                </Button>
              }
            >
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                <span>
                  <strong className="font-semibold text-fg">
                    {formatCount(summary.rows)}
                  </strong>{" "}
                  rows
                </span>
                <span>{formatBytes(summary.bytes)}</span>
                <span>{formatDuration(summary.elapsedMs)}</span>
              </div>
              <div className="flex min-w-0 items-center gap-1.5">
                <code className="min-w-0 flex-1 truncate rounded-sm bg-surface px-2 py-1 font-mono text-[11px] text-muted">
                  {summary.path}
                </code>
                <IconButton
                  label="Copy path"
                  onClick={() => void copy(summary.path, "path")}
                >
                  <Copy className="size-3.5" />
                </IconButton>
                <Button size="xs" variant="secondary" onClick={() => void reveal()}>
                  <FolderOpen className="size-3.5" />
                  Reveal in folder
                </Button>
              </div>
            </Section>
          ) : null}

          <Section title="Format" className="gap-3">
            <div className="grid gap-2 sm:grid-cols-2">
              {FORMATS.map((info) => {
                const disabled = info.value === "sql_insert" && !table;
                const selected = info.value === format;
                return (
                  <button
                    key={info.value}
                    type="button"
                    aria-pressed={selected}
                    disabled={disabled}
                    onClick={() => {
                      setFormat(info.value);
                      setPath((current) => rebaseExtension(current, info.value));
                    }}
                    className={[
                      "flex flex-col gap-1 rounded-lg border p-2.5 text-left transition-colors",
                      selected
                        ? "border-accent bg-accent-soft"
                        : "border-border bg-surface hover:bg-hover",
                      disabled ? "cursor-not-allowed opacity-45" : "",
                    ].join(" ")}
                  >
                    <span className="flex items-center gap-2 text-[13px] font-medium text-fg">
                      <span className={selected ? "text-accent" : "text-muted"}>
                        {FORMAT_ICONS[info.value]}
                      </span>
                      {info.label}
                    </span>
                    <span className="text-[11px] leading-snug text-subtle">
                      {disabled
                        ? "Needs a table name — this result set came from a free query."
                        : info.blurb}
                    </span>
                  </button>
                );
              })}
            </div>
          </Section>

          <Section title="Destination">
            <Field
              label="File"
              hint={
                exportDefaultDir
                  ? `Browse… starts in ${exportDefaultDir}`
                  : "Anywhere the app can write to."
              }
            >
              <div className="flex items-center gap-2">
                <Input
                  value={path}
                  spellCheck={false}
                  placeholder={suggestedFileName(table, format)}
                  onChange={(event) => setPath(event.target.value)}
                />
                <Button variant="secondary" onClick={() => void browse()}>
                  <FolderOpen className="size-3.5" />
                  Browse…
                </Button>
              </div>
            </Field>
          </Section>

          {format === "csv" || format === "tsv" ? (
            <CsvOptionsPanel
              format={format}
              options={csv}
              onChange={(patch) => setCsv((current) => ({ ...current, ...patch }))}
              sampleRow={chosenRows[0]}
              sampleColumns={chosenColumns}
            />
          ) : null}

          {format === "json" ? (
            <Section
              title="JSON options"
              description="Files are always written as an indented array of row objects; the toggle below is what “Copy” puts on the clipboard."
            >
              <CheckboxField
                checked={pretty}
                onCheckedChange={setPretty}
                label="Pretty-print"
                hint="Unchecked copies one compact line."
              />
            </Section>
          ) : null}

          {format === "sql_insert" ? (
            <Section
              title="SQL options"
              description={`Statements target ${table ?? "the current table"} using ${dbKind} literal syntax.`}
            >
              <Field label="Rows per INSERT" inline hint="1 writes one statement per row.">
                <NumberField
                  value={batchSize}
                  onChange={setBatchSize}
                  min={1}
                  max={10_000}
                  suffix="rows"
                  aria-label="Rows per INSERT"
                  className="w-32"
                />
              </Field>
            </Section>
          ) : null}

          {rows === undefined && sql ? (
            <Section
              title="Rows"
              description="Collected with the statement that produced this result set."
              action={
                <Button
                  size="xs"
                  variant="ghost"
                  disabled={collecting}
                  onClick={() => void collect(maxRows)}
                >
                  <RefreshCw className="size-3.5" />
                  Refresh
                </Button>
              }
            >
              <div className="flex items-center gap-3">
                <Field label="Row cap" inline className="min-w-0 flex-1">
                  <NumberField
                    value={maxRows}
                    onChange={setMaxRows}
                    min={1}
                    max={5_000_000}
                    suffix="rows"
                    aria-label="Row cap"
                  />
                </Field>
                {collecting ? <Spinner /> : null}
              </div>
              <p className="text-[11px] text-subtle">
                {collecting
                  ? "Collecting rows…"
                  : `${formatCount(activeRows.length)} rows in memory${
                      collected?.truncated ? " (capped by the row limit)" : ""
                    }.`}
              </p>
            </Section>
          ) : null}

          {error ? (
            <p className="rounded-md border border-danger/40 bg-danger-soft px-2.5 py-2 text-[11px] leading-snug text-danger">
              {error}
            </p>
          ) : null}
        </div>

        <Section
          title="Columns"
          className="h-fit"
          action={
            <div className="flex items-center gap-1">
              <Button size="xs" variant="ghost" onClick={() => setDeselected(new Set())}>
                All
              </Button>
              <Button
                size="xs"
                variant="ghost"
                onClick={() =>
                  setDeselected(new Set(activeColumns.map((_, index) => index)))
                }
              >
                None
              </Button>
            </div>
          }
        >
          {activeColumns.length === 0 ? (
            <p className="text-[11px] text-subtle">
              {collecting ? "Collecting columns…" : "No columns to export yet."}
            </p>
          ) : (
            <div className="flex max-h-72 flex-col gap-1.5 overflow-auto scrollbar-thin pr-1">
              {activeColumns.map((name, index) => (
                <div key={`${name}-${index}`} className="flex items-center gap-2">
                  <Checkbox
                    id={`export-column-${index}`}
                    checked={!deselected.has(index)}
                    onCheckedChange={(checked) =>
                      setDeselected((current) => {
                        const next = new Set(current);
                        if (checked === true) next.delete(index);
                        else next.add(index);
                        return next;
                      })
                    }
                  />
                  <label
                    htmlFor={`export-column-${index}`}
                    title={name}
                    className="min-w-0 flex-1 cursor-default truncate font-mono text-[11px] text-fg"
                  >
                    {name}
                  </label>
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-subtle">
            {formatCount(chosenRows.length)} rows × {chosenColumns.length} of{" "}
            {activeColumns.length} columns
          </p>
        </Section>
      </DialogBody>

      <DialogFooter>
        <span
          className={[
            "mr-auto truncate text-[11px]",
            error ? "text-danger" : "text-subtle",
          ].join(" ")}
          title={footerHint}
        >
          {footerHint}
        </span>
        <Button variant="ghost" onClick={() => onOpenChange(false)} disabled={busy}>
          Close
        </Button>
        <Button
          variant="secondary"
          disabled={busy || chosenRows.length === 0}
          onClick={() => void copyRendered()}
        >
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          Copy
        </Button>
        <Button
          variant="primary"
          loading={busy}
          disabled={blocked || collecting}
          onClick={() => void run()}
        >
          Export
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}
