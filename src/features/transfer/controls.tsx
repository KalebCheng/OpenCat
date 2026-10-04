/**
 * Small building blocks shared by the export dialog and the import wizard.
 *
 * Both dialogs are dense option forms, so they only need the same three things:
 * a titled section, a numeric field that tolerates half-typed input, and a
 * single-character field for the CSV dialect controls.
 */

import * as React from "react";

import { Input, NativeSelect } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/** A titled, bordered group of controls inside a dialog body. */
export function Section({
  title,
  description,
  action,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "flex flex-col gap-2.5 rounded-lg border border-border bg-sunken/40 p-3",
        className,
      )}
    >
      <header className="flex items-center gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-muted">
          {title}
        </h3>
        <div className="flex-1" />
        {action}
      </header>
      {description ? (
        <p className="text-[11px] leading-snug text-subtle">{description}</p>
      ) : null}
      {children}
    </section>
  );
}

/**
 * Numeric input that keeps its own draft while the user types.
 *
 * Committing on every keystroke would fight the user (clearing the box to retype
 * a number would read as 0), so the value is only pushed up once the field is
 * left or Enter is pressed, clamped to `min`/`max`.
 */
export function NumberField({
  value,
  onChange,
  min = 0,
  max,
  suffix,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  suffix?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  const [draft, setDraft] = React.useState(String(value));

  React.useEffect(() => {
    setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const ceiling = max ?? Number.MAX_SAFE_INTEGER;
    const clamped = Math.min(ceiling, Math.max(min, Math.round(parsed)));
    setDraft(String(clamped));
    if (clamped !== value) onChange(clamped);
  };

  return (
    <div className={cn("relative", className)}>
      <Input
        aria-label={ariaLabel}
        value={draft}
        inputMode="numeric"
        disabled={disabled}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
        className={cn(suffix && "pr-14")}
      />
      {suffix ? (
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-subtle">
          {suffix}
        </span>
      ) : null}
    </div>
  );
}

/**
 * A delimiter/quote/escape character.
 *
 * Presets cover everything anyone actually uses; "Other…" reveals a one
 * character input because the Rust side rejects anything that is not a single
 * ASCII character.
 */
export function CharField({
  value,
  onChange,
  presets,
  label,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  presets: { value: string; label: string }[];
  label: string;
  disabled?: boolean;
}) {
  const known = presets.some((preset) => preset.value === value);
  const [custom, setCustom] = React.useState(!known);

  return (
    <div className="flex items-center gap-1.5">
      <NativeSelect
        aria-label={label}
        disabled={disabled}
        value={custom ? "__other__" : value}
        onChange={(event) => {
          if (event.target.value === "__other__") {
            setCustom(true);
            return;
          }
          setCustom(false);
          onChange(event.target.value);
        }}
      >
        {presets.map((preset) => (
          <option key={preset.value} value={preset.value}>
            {preset.label}
          </option>
        ))}
        <option value="__other__">Other…</option>
      </NativeSelect>
      {custom ? (
        <Input
          aria-label={`${label} (custom)`}
          disabled={disabled}
          value={value}
          maxLength={1}
          placeholder="?"
          onChange={(event) => onChange(event.target.value)}
          className="w-14 shrink-0 px-2 text-center"
        />
      ) : null}
    </div>
  );
}
