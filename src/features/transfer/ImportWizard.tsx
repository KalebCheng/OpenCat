/**
 * Import wizard.
 *
 * Three steps, one request: choose a file and the parsing options, map its
 * columns onto the destination table, then review the shape of the job and run
 * it. The backend parses and inserts in a single call, so everything here is
 * about getting that call right rather than moving data itself.
 */

import * as React from "react";
import { toast } from "sonner";
import { open } from "@tauri-apps/plugin-dialog";
import { Check, FileUp, Upload } from "lucide-react";

import {
  Badge,
  Button,
  Field,
  Input,
  NativeSelect,
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
  type DbKind,
  type ImportMode,
  type ImportOptions,
  type ImportRequest,
  type ImportSummary,
  type ParsedData,
  type Scope,
  type TableSchema,
  type TransferFormat,
  toErrorPayload,
} from "@/lib/types";
import { formatCount, formatDuration } from "@/lib/utils";
import { ImportOptionsPanel } from "./ImportOptionsPanel";
import { ColumnMapper, PreviewTable } from "./MappingTable";
import { NumberField, Section } from "./controls";
import { formatInfo, qualifiedName } from "./formats";

export interface ImportWizardProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  sessionId: string;
  scope: Scope;
  dbKind: DbKind;
  table: string;
  /** Called after a successful import so the grid can refresh. */
  onDone?: () => void;
}

const STEPS = ["Choose file", "Map columns", "Review & run"] as const;

/** Extensions worth offering; the dialog still lets the user pick anything. */
const IMPORT_FILTERS = [
  { name: "Data files", extensions: ["csv", "tsv", "tab", "txt", "json", "ndjson", "sql"] },
  { name: "All files", extensions: ["*"] },
];

const EMPTY_OPTIONS: ImportOptions = {
  format: null,
  hasHeader: true,
  delimiter: ",",
  quote: '"',
  nullLiteral: "",
  emptyAsNull: true,
  skipRows: 0,
  maxRows: 0,
};

export function ImportWizard(props: ImportWizardProps): React.ReactElement {
  const { open, onOpenChange } = props;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {/* Remounted per open so a cancelled import never leaks into the next one. */}
      {open ? <ImportWizardBody {...props} /> : null}
    </Dialog>
  );
}

type BodyProps = Omit<ImportWizardProps, "open">;

function ImportWizardBody({
  onOpenChange,
  sessionId,
  scope,
  dbKind,
  table,
  onDone,
}: BodyProps): React.ReactElement {
  const [step, setStep] = React.useState(0);
  const [path, setPath] = React.useState<string | null>(null);
  const [detected, setDetected] = React.useState<TransferFormat | null>(null);
  const [override, setOverride] = React.useState<TransferFormat | "auto">("auto");
  const [options, setOptions] = React.useState<ImportOptions>(EMPTY_OPTIONS);
  const [schema, setSchema] = React.useState<TableSchema | null>(null);
  const [schemaError, setSchemaError] = React.useState<string | null>(null);
  const [preview, setPreview] = React.useState<ParsedData | null>(null);
  const [mapping, setMapping] = React.useState<(string | null)[]>([]);
  const [mode, setMode] = React.useState<ImportMode>("append");
  const [batchSize, setBatchSize] = React.useState(100);
  const [detecting, setDetecting] = React.useState(false);
  const [previewing, setPreviewing] = React.useState(false);
  const [running, setRunning] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [summary, setSummary] = React.useState<ImportSummary | null>(null);

  const database = scope.database ?? null;
  const schemaName = scope.schema ?? null;

  // The destination's columns drive the mapping selects; if they cannot be read
  // the wizard falls back to the file's own headers so an import is still
  // possible (`target_columns` omitted means "use the file verbatim").
  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const described = await ipc.explorer.describe(sessionId, scope, table, "table");
        if (!cancelled) setSchema(described);
      } catch (cause) {
        if (!cancelled) setSchemaError(toErrorPayload(cause).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // `scope` is rebuilt by the caller, so key the effect on its parts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, database, schemaName, table]);

  const targets = React.useMemo(() => {
    const known = schema?.columns.map((column) => column.name) ?? [];
    return known.length > 0 ? known : (preview?.columns ?? []);
  }, [schema, preview]);

  /** Read the destination's columns; shared by the warm-up effect and the mapper. */
  const loadTargets = React.useCallback(async (): Promise<string[]> => {
    try {
      const described = await ipc.explorer.describe(sessionId, scope, table, "table");
      setSchema(described);
      setSchemaError(null);
      return described.columns.map((column) => column.name);
    } catch (cause) {
      setSchemaError(toErrorPayload(cause).message);
      return [];
    }
    // `scope` is rebuilt by the caller, so key the closure on its parts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, database, schemaName, table]);

  /** What the parser will actually run with: an explicit choice, else detection. */
  const format: TransferFormat | null = override === "auto" ? detected : override;

  const pickFile = async () => {
    try {
      const picked = await open({ multiple: false, directory: false, filters: IMPORT_FILTERS });
      if (typeof picked !== "string") return;
      setPath(picked);
      setPreview(null);
      setSummary(null);
      setError(null);
      setDetecting(true);
      try {
        setDetected(await ipc.transfer.detectFormat(picked));
      } catch (cause) {
        setDetected(null);
        toast.error("Could not identify the file", {
          description: toErrorPayload(cause).message,
        });
      } finally {
        setDetecting(false);
      }
    } catch (cause) {
      toast.error("Could not open the file dialog", {
        description: toErrorPayload(cause).message,
      });
    }
  };

  const prepareMapping = async () => {
    if (!path) return;
    setPreviewing(true);
    setError(null);
    try {
      // Warm the destination's columns first when the background read has not
      // landed yet, so the first mapping is a name match rather than all-skips.
      const known = targets.length > 0 ? targets : await loadTargets();
      const parsed = await ipc.transfer.previewImport(
        path,
        { ...options, format },
        50,
      );
      setPreview(parsed);
      setMapping(autoMap(parsed.columns, known.length > 0 ? known : parsed.columns));
      setStep(1);
    } catch (cause) {
      const message = toErrorPayload(cause).message;
      setError(message);
      toast.error("Could not read the file", { description: message });
    } finally {
      setPreviewing(false);
    }
  };

  const run = async () => {
    if (!path) return;
    setRunning(true);
    setError(null);
    try {
      const request: ImportRequest = {
        sessionId,
        database,
        schema: schemaName,
        table,
        path,
        options: { ...options, format },
        mode,
        // `target_columns` is positional — one entry per file column, in file
        // order — and a `null` entry means "skip this column". The list must
        // always line up with the file, so skipped slots are sent as `null`
        // rather than removed.
        targetColumns: mapping,
        batchSize: Math.max(1, batchSize),
        // `skipRows` is applied while parsing, so there is nothing left to skip
        // at insert time.
        offset: 0,
      };
      const result = await ipc.transfer.importData(request);
      setSummary(result);
      toast.success(`Imported ${formatCount(result.rowsWritten)} rows`, {
        description: `${formatCount(result.statements)} statements in ${formatDuration(
          result.elapsedMs,
        )}`,
      });
      onDone?.();
    } catch (cause) {
      const message = toErrorPayload(cause).message;
      setError(message);
      toast.error("Import failed", { description: message });
    } finally {
      setRunning(false);
    }
  };

  // `totalRows` already excludes the skip window and respects the row limit.
  const totalRows = preview?.totalRows ?? 0;
  const statements =
    totalRows === 0
      ? 0
      : Math.ceil(totalRows / Math.max(1, batchSize)) + (mode === "truncate_first" ? 1 : 0);

  return (
    <DialogContent size="xl">
      <DialogHeader
        title="Import data"
        description={`Read a file into ${qualifiedName(table, scope)}.`}
        icon={<Upload />}
      />
      <DialogBody className="flex flex-col gap-4">
        <Stepper step={step} onSelect={(next) => next < step && setStep(next)} />

        {step === 0 ? (
          <>
            <Section title="Source file">
              <div className="flex items-center gap-2">
                <Input
                  readOnly
                  value={path ?? ""}
                  placeholder="No file chosen"
                  spellCheck={false}
                  className="font-mono text-[11px]"
                />
                <Button variant="secondary" loading={detecting} onClick={() => void pickFile()}>
                  <FileUp className="size-3.5" />
                  Browse…
                </Button>
                {detecting ? <Spinner /> : null}
              </div>
              <Field
                label="Format"
                inline
                hint={
                  detected
                    ? `Detected ${formatInfo(detected).label}; pick another format to override it.`
                    : "Auto uses the file name and a peek at the content."
                }
              >
                <NativeSelect
                  aria-label="File format"
                  value={override}
                  disabled={!path}
                  onChange={(event) =>
                    setOverride(event.target.value as TransferFormat | "auto")
                  }
                >
                  <option value="auto">
                    Auto{detected ? `  (${formatInfo(detected).label})` : ""}
                  </option>
                  <option value="csv">CSV</option>
                  <option value="tsv">TSV</option>
                  <option value="json">JSON</option>
                  <option value="sql_insert">SQL INSERT</option>
                </NativeSelect>
              </Field>
            </Section>
            <ImportOptionsPanel
              options={options}
              onChange={(patch) => setOptions((current) => ({ ...current, ...patch }))}
              format={format ?? detected ?? "csv"}
            />
          </>
        ) : null}

        {step === 1 ? (
          previewing ? (
            <div className="flex items-center gap-2 text-xs text-muted">
              <Spinner />
              Reading the first rows…
            </div>
          ) : preview ? (
            <>
              <ColumnMapper
                fileColumns={preview.columns}
                targets={targets}
                mapping={mapping}
                onChange={(index, target) =>
                  setMapping((current) =>
                    current.map((value, position) => (position === index ? target : value)),
                  )
                }
              />
              {schemaError ? (
                <p className="text-[11px] text-warning">
                  Could not read the table's columns ({schemaError}); file headers are offered
                  as targets instead.
                </p>
              ) : null}
              <Section
                title={`Preview — first ${formatCount(preview.rows.length)} of ${formatCount(
                  preview.totalRows,
                )} rows`}
                description={`Parsed as ${formatInfo(preview.format).label}.`}
              >
                <PreviewTable columns={preview.columns} rows={preview.rows} />
              </Section>
            </>
          ) : (
            <p className="text-xs text-subtle">No preview yet — go back and choose a file.</p>
          )
        ) : null}

        {step === 2 ? (
          <>
            <Section title="Mode">
              <div className="flex items-center gap-1.5">
                <ModeButton
                  selected={mode === "append"}
                  onClick={() => setMode("append")}
                  label="Append"
                  hint="Add the rows to what is already there."
                />
                <ModeButton
                  selected={mode === "truncate_first"}
                  onClick={() => setMode("truncate_first")}
                  label="Truncate first"
                  hint={truncateStatement(table, dbKind)}
                />
              </div>
              <Field label="Rows per INSERT" inline hint="Larger batches mean fewer statements.">
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

            <Section title="Summary">
              <p className="text-[13px] text-fg">
                <strong className="font-semibold">{formatCount(totalRows)}</strong> rows →{" "}
                <code className="rounded-xs bg-surface px-1 py-px font-mono text-[11px]">
                  {qualifiedName(table, scope)}
                </code>
                , <strong className="font-semibold">{formatCount(statements)}</strong>{" "}
                statements
              </p>
              <ul className="flex flex-col gap-0.5 text-[11px] text-subtle">
                <li>
                  {mapping.filter((target) => target !== null).length} of {mapping.length} file
                  columns mapped.
                </li>
                <li>
                  Parsed as {preview ? formatInfo(preview.format).label : "…"}
                  {options.skipRows > 0 ? `, skipping ${formatCount(options.skipRows)} rows` : ""}
                  {options.maxRows > 0 ? `, limited to ${formatCount(options.maxRows)} rows` : ""}
                  .
                </li>
                <li>
                  NULL literal{" "}
                  {options.nullLiteral ? <code>{options.nullLiteral}</code> : "(empty field)"}
                  {options.emptyAsNull ? ", empty fields read as NULL" : ""}.
                </li>
              </ul>
              {mapping.some((target) => target === null) ? (
                <p className="text-[11px] leading-snug text-warning">
                  Skipped columns are dropped from the mapping. The importer expects one
                  target per file column, so map every column if the run reports a
                  mapping-size mismatch.
                </p>
              ) : null}
            </Section>

            {summary ? (
              <Section
                title="Import complete"
                action={<Badge tone="success">Done</Badge>}
              >
                <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted">
                  <span>
                    <strong className="font-semibold text-fg">
                      {formatCount(summary.rowsRead)}
                    </strong>{" "}
                    rows read
                  </span>
                  <span>
                    <strong className="font-semibold text-fg">
                      {formatCount(summary.rowsWritten)}
                    </strong>{" "}
                    written
                  </span>
                  <span>{formatCount(summary.statements)} statements</span>
                  <span>{formatDuration(summary.elapsedMs)}</span>
                </div>
                {summary.warnings.length > 0 ? (
                  <ul className="flex flex-col gap-0.5 text-[11px] text-warning">
                    {summary.warnings.map((warning) => (
                      <li key={warning}>{warning}</li>
                    ))}
                  </ul>
                ) : null}
              </Section>
            ) : null}
          </>
        ) : null}

        {error ? (
          <p className="rounded-md border border-danger/40 bg-danger-soft px-2.5 py-2 text-[11px] leading-snug text-danger">
            {error}
          </p>
        ) : null}
      </DialogBody>

      <DialogFooter>
        <span className="mr-auto truncate text-[11px] text-subtle">
          {path ?? "No file chosen"}
        </span>
        {step > 0 && !summary ? (
          <Button variant="ghost" onClick={() => setStep(step - 1)} disabled={running}>
            Back
          </Button>
        ) : null}
        {step < 2 ? (
          <Button
            variant="primary"
            loading={previewing}
            disabled={!path || summary !== null}
            onClick={() => (step === 0 ? void prepareMapping() : setStep(2))}
          >
            {step === 0 ? "Map columns" : "Review & run"}
          </Button>
        ) : summary ? (
          <Button variant="primary" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        ) : (
          <Button variant="primary" loading={running} onClick={() => void run()}>
            <Check className="size-3.5" />
            Run import
          </Button>
        )}
      </DialogFooter>
    </DialogContent>
  );
}

/**
 * Default the column mapping.
 *
 * A file column whose header matches a target column case-insensitively wins;
 * everything left over is matched positionally against the targets nobody has
 * claimed yet, and a file column with no target left starts out skipped. The
 * positional pass runs strictly after the name pass so renaming one header in
 * the file cannot cascade a shift through every column behind it.
 */
function autoMap(fileColumns: string[], targets: string[]): (string | null)[] {
  const claimed = new Set<string>();
  const mapping: (string | null)[] = fileColumns.map(() => null);

  fileColumns.forEach((name, index) => {
    const needle = name.trim().toLowerCase();
    const match = targets.find(
      (target) => target.toLowerCase() === needle && !claimed.has(target),
    );
    if (match) {
      mapping[index] = match;
      claimed.add(match);
    }
  });

  fileColumns.forEach((_, index) => {
    if (mapping[index] !== null) return;
    const next = targets.find((target) => !claimed.has(target));
    if (next) {
      mapping[index] = next;
      claimed.add(next);
    }
  });

  return mapping;
}

/** The statement "Truncate first" will run, matching the engine's own syntax. */
function truncateStatement(table: string, dbKind: DbKind): string {
  return dbKind === "sqlite" ? `DELETE FROM ${table}` : `TRUNCATE TABLE ${table}`;
}

function Stepper({
  step,
  onSelect,
}: {
  step: number;
  onSelect: (step: number) => void;
}): React.ReactElement {
  return (
    <ol className="flex items-center gap-2">
      {STEPS.map((label, index) => {
        const done = index < step;
        const current = index === step;
        return (
          <li key={label} className="flex min-w-0 items-center gap-2">
            <button
              type="button"
              disabled={!done}
              onClick={() => onSelect(index)}
              className={[
                "flex min-w-0 items-center gap-2 rounded-md px-2 py-1 text-[11px] transition-colors",
                current ? "bg-accent-soft text-accent" : "text-muted",
                done ? "hover:bg-hover" : "",
              ].join(" ")}
            >
              <span
                className={[
                  "grid size-4 shrink-0 place-content-center rounded-full text-[10px] font-semibold",
                  current
                    ? "bg-accent text-accent-fg"
                    : done
                      ? "bg-success text-white"
                      : "bg-sunken text-subtle",
                ].join(" ")}
              >
                {done ? <Check className="size-2.5" /> : index + 1}
              </span>
              <span className="truncate font-medium">{label}</span>
            </button>
            {index < STEPS.length - 1 ? (
              <span aria-hidden className="h-px w-6 shrink-0 bg-border" />
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}

function ModeButton({
  selected,
  onClick,
  label,
  hint,
}: {
  selected: boolean;
  onClick: () => void;
  label: string;
  hint: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={[
        "flex min-w-0 flex-1 flex-col gap-0.5 rounded-lg border p-2.5 text-left transition-colors",
        selected ? "border-accent bg-accent-soft" : "border-border bg-surface hover:bg-hover",
      ].join(" ")}
    >
      <span className="text-[13px] font-medium text-fg">{label}</span>
      <span className="truncate font-mono text-[10px] text-subtle">{hint}</span>
    </button>
  );
}
