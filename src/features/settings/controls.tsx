/**
 * Controls shared by the settings tabs.
 *
 * The dialog is a list of label/control pairs, so the only real invention here
 * is {@link SettingRow}; the numeric and text fields exist to keep the tabs from
 * repeating the same commit-on-blur logic five times over.
 */

import * as React from "react";

import { Input } from "@/components/ui/primitives";
import { cn } from "@/lib/utils";

/** A titled group of settings. */
export function SettingsGroup({
  title,
  description,
  children,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("flex flex-col gap-1", className)}>
      <header className="flex flex-col gap-0.5 pb-1">
        <h3 className="text-xs font-semibold text-fg">{title}</h3>
        {description ? (
          <p className="text-[11px] leading-snug text-subtle">{description}</p>
        ) : null}
      </header>
      <div className="flex flex-col divide-y divide-border">{children}</div>
    </section>
  );
}

/** One setting: label and hint on the left, the control on the right. */
export function SettingRow({
  label,
  hint,
  children,
  stacked,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  /** Put the control on its own line (wide controls, previews). */
  stacked?: boolean;
}) {
  return (
    <div
      className={cn(
        "flex gap-3 py-2.5",
        stacked ? "flex-col" : "items-center justify-between",
      )}
    >
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="text-[13px] text-fg">{label}</span>
        {hint ? (
          <span className="text-[11px] leading-snug text-subtle">{hint}</span>
        ) : null}
      </div>
      <div className={cn("min-w-0 shrink-0", stacked && "w-full")}>{children}</div>
    </div>
  );
}

/** A small segmented button group, used for the theme and other 2–3 way choices. */
export function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T;
  options: { value: T; label: React.ReactNode; icon?: React.ReactNode }[];
  onChange: (value: T) => void;
}) {
  return (
    <div
      role="group"
      className="inline-flex items-center gap-0.5 rounded-md border border-border bg-sunken p-0.5"
    >
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-sm px-2.5 py-1 text-xs transition-colors",
            option.value === value
              ? "bg-surface text-fg shadow-xs"
              : "text-muted hover:text-fg",
          )}
        >
          {option.icon}
          {option.label}
        </button>
      ))}
    </div>
  );
}

/**
 * Numeric setting input.
 *
 * Keeps a draft while typing and only commits on blur or Enter, so clearing the
 * box to retype a number does not momentarily store `0`.
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
        className={cn(suffix && "pr-12")}
      />
      {suffix ? (
        <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[11px] text-subtle">
          {suffix}
        </span>
      ) : null}
    </div>
  );
}

/** Text setting input with a monospace option for font stacks and formats. */
export function TextField({
  value,
  onChange,
  placeholder,
  mono,
  disabled,
  className,
  "aria-label": ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  mono?: boolean;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}) {
  return (
    <Input
      aria-label={ariaLabel}
      value={value}
      placeholder={placeholder}
      spellCheck={false}
      disabled={disabled}
      onChange={(event) => onChange(event.target.value)}
      className={cn(mono && "font-mono text-[11px]", className)}
    />
  );
}
