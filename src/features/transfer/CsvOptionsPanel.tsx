/**
 * The CSV/TSV dialect panel used by the export dialog.
 *
 * Every control writes straight into a {@link CsvOptions} object; the dialog
 * materialises the object in full before it reaches the backend (see
 * `materialiseCsv`), so nothing here has to think about partial payloads.
 */

import * as React from "react";

import { CheckboxField, Field, Input, NativeSelect } from "@/components/ui/primitives";
import type { CsvOptions, TransferFormat, Value } from "@/lib/types";
import { CharField, Section } from "./controls";
import {
  DELIMITER_PRESETS,
  ESCAPE_PRESETS,
  LINE_ENDINGS,
  QUOTE_PRESETS,
  effectiveDelimiter,
} from "./formats";
import { renderDelimited } from "./render";

export interface CsvOptionsPanelProps {
  format: TransferFormat;
  options: CsvOptions;
  onChange: (patch: Partial<CsvOptions>) => void;
  /** First selected row, rendered as a sample under the controls. */
  sampleRow?: Value[];
  sampleColumns: string[];
}

export function CsvOptionsPanel({
  format,
  options,
  onChange,
  sampleRow,
  sampleColumns,
}: CsvOptionsPanelProps): React.ReactElement {
  const delimiter = effectiveDelimiter(format, options);
  const sample =
    sampleRow && sampleRow.length > 0
      ? renderDelimited({
          format,
          columns: sampleColumns,
          rows: [sampleRow],
          csv: { ...options, delimiter, hasHeader: false, includeBom: false },
          pretty: false,
          dbKind: "sqlite",
          batchSize: 1,
        }).trimEnd()
      : null;

  return (
    <Section
      title={format === "tsv" ? "TSV options" : "CSV options"}
      description={
        format === "tsv"
          ? "Tab separated by default; everything else behaves like CSV."
          : "RFC 4180, with empty fields read as NULL unless you say otherwise."
      }
      className="gap-3"
    >
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Delimiter" inline>
          <CharField
            label="Delimiter"
            value={options.delimiter}
            presets={DELIMITER_PRESETS}
            onChange={(value) => onChange({ delimiter: value })}
          />
        </Field>
        <Field label="Quote" inline>
          <CharField
            label="Quote character"
            value={options.quote}
            presets={QUOTE_PRESETS}
            onChange={(value) => onChange({ quote: value })}
          />
        </Field>
        <Field label="Escape" inline hint="Matching the quote doubles it.">
          <CharField
            label="Escape character"
            value={options.escape}
            presets={ESCAPE_PRESETS}
            onChange={(value) => onChange({ escape: value })}
          />
        </Field>
        <Field label="Line ending" inline>
          <NativeSelect
            aria-label="Line ending"
            value={options.lineEnding}
            onChange={(event) => onChange({ lineEnding: event.target.value })}
          >
            {LINE_ENDINGS.map((ending) => (
              <option key={ending.value} value={ending.value}>
                {ending.label}
              </option>
            ))}
            {LINE_ENDINGS.some((ending) => ending.value === options.lineEnding) ? null : (
              <option value={options.lineEnding}>Custom</option>
            )}
          </NativeSelect>
        </Field>
        <Field label="NULL literal" inline hint="Written for a NULL value.">
          <Input
            aria-label="NULL literal"
            value={options.nullLiteral}
            placeholder="(empty field)"
            onChange={(event) => onChange({ nullLiteral: event.target.value })}
          />
        </Field>
      </div>

      <div className="grid gap-2 sm:grid-cols-3">
        <CheckboxField
          checked={options.hasHeader}
          onCheckedChange={(checked) => onChange({ hasHeader: checked })}
          label="Include header row"
        />
        <CheckboxField
          checked={options.emptyAsNull}
          onCheckedChange={(checked) => onChange({ emptyAsNull: checked })}
          label="Empty means NULL"
        />
        <CheckboxField
          checked={options.includeBom}
          onCheckedChange={(checked) => onChange({ includeBom: checked })}
          label="UTF-8 BOM"
          hint="Helps Excel detect the encoding."
        />
      </div>

      {sample ? (
        <div className="flex min-w-0 flex-col gap-1">
          <span className="text-[11px] font-medium text-muted">Sample row</span>
          <code className="truncate rounded-sm bg-surface px-2 py-1 font-mono text-[11px] text-muted">
            {sample}
          </code>
        </div>
      ) : null}
    </Section>
  );
}
