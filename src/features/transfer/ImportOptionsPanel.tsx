/**
 * The parser controls shown in step 1 of the import wizard.
 *
 * These map one-to-one onto {@link ImportOptions}; the format select that sits
 * above them is owned by the wizard because it also drives auto-detection.
 */

import * as React from "react";

import {
  CheckboxField,
  Field,
  Input,
} from "@/components/ui/primitives";
import type { ImportOptions, TransferFormat } from "@/lib/types";
import { CharField, NumberField, Section } from "./controls";
import { DELIMITER_PRESETS, QUOTE_PRESETS } from "./formats";

export interface ImportOptionsPanelProps {
  options: ImportOptions;
  onChange: (patch: Partial<ImportOptions>) => void;
  /** The format the parser will use, so the hints can be format specific. */
  format: TransferFormat;
}

export function ImportOptionsPanel({
  options,
  onChange,
  format,
}: ImportOptionsPanelProps): React.ReactElement {
  const delimited = format === "csv" || format === "tsv";
  const notes =
    format === "json"
      ? "JSON files are read as an array of row objects; the CSV knobs below only shape the delimiter used for SQL dumps."
      : format === "sql_insert"
        ? "SQL files are parsed for INSERT statements; the header and delimiter settings are ignored."
        : "Leave empty fields as NULL to match what the exporter writes.";

  return (
    <Section title="Parsing" description={notes}>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Delimiter" inline>
          <CharField
            label="Delimiter"
            disabled={!delimited}
            value={options.delimiter}
            presets={DELIMITER_PRESETS}
            onChange={(value) => onChange({ delimiter: value })}
          />
        </Field>
        <Field label="Quote" inline>
          <CharField
            label="Quote character"
            disabled={!delimited}
            value={options.quote}
            presets={QUOTE_PRESETS}
            onChange={(value) => onChange({ quote: value })}
          />
        </Field>
        <Field label="NULL literal" inline hint="Text that means SQL NULL.">
          <Input
            aria-label="NULL literal"
            disabled={!delimited}
            value={options.nullLiteral}
            placeholder="(empty field)"
            onChange={(event) => onChange({ nullLiteral: event.target.value })}
          />
        </Field>
        <Field label="Skip rows" inline hint="Leading lines to drop.">
          <NumberField
            value={options.skipRows}
            onChange={(value) => onChange({ skipRows: value })}
            min={0}
            max={1_000_000}
            suffix="rows"
            aria-label="Skip rows"
          />
        </Field>
        <Field label="Row limit" inline hint="0 imports every row.">
          <NumberField
            value={options.maxRows}
            onChange={(value) => onChange({ maxRows: value })}
            min={0}
            max={100_000_000}
            suffix="rows"
            aria-label="Row limit"
          />
        </Field>
      </div>

      <div className="grid gap-2 sm:grid-cols-2">
        <CheckboxField
          checked={options.hasHeader}
          onCheckedChange={(checked) => onChange({ hasHeader: checked })}
          label="First row is a header"
          hint="Header names feed the column matching in the next step."
          disabled={format === "json"}
        />
        <CheckboxField
          checked={options.emptyAsNull}
          onCheckedChange={(checked) => onChange({ emptyAsNull: checked })}
          label="Empty means NULL"
          hint="Unchecked reads an empty field as an empty string."
        />
      </div>
    </Section>
  );
}
