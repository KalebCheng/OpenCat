/**
 * Small designer-local controls.
 *
 * The column type is free text — the server round-trips whatever the engine
 * calls it — but it needs suggestions, so it gets a lightweight combobox on top
 * of {@link Input}. The rest are the dense form rows shared by the tabs.
 */

import * as React from "react";
import { Check, ChevronDown } from "lucide-react";

import { cn } from "@/lib/utils";
import { IconButton, Input } from "@/components/ui/primitives";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";

import { suggestTypes, type TypeSuggestion } from "./types";
import type { DbKind } from "@/lib/types";

// ---------------------------------------------------------------------------
// Type combobox
// ---------------------------------------------------------------------------

export interface TypeComboboxProps {
  value: string;
  /** Receives the typed or picked type. The second argument is the suggestion. */
  onChange: (value: string, suggestion?: TypeSuggestion) => void;
  kind: DbKind;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  "aria-label"?: string;
}

/**
 * Free-text type entry with per-dialect suggestions.
 *
 * The text is never normalised: typing `INT` stays `INT` even though the
 * suggestion list says `INTEGER`, because the server reported `INT` and a
 * gratuitous rewrite would show up as a diff.
 */
export function TypeCombobox({
  value,
  onChange,
  kind,
  placeholder,
  disabled,
  className,
  "aria-label": ariaLabel,
}: TypeComboboxProps) {
  const [open, setOpen] = React.useState(false);
  const [highlight, setHighlight] = React.useState(0);
  const options = React.useMemo(() => suggestTypes(kind, value), [kind, value]);

  // Keep the highlight inside the list as the filter shrinks it.
  const active = options.length === 0 ? -1 : Math.min(highlight, options.length - 1);

  const choose = (suggestion: TypeSuggestion) => {
    onChange(suggestion.value, suggestion);
    setOpen(false);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault();
        setOpen(true);
        setHighlight((current) => Math.min(current + 1, options.length - 1));
        break;
      case "ArrowUp":
        event.preventDefault();
        setHighlight((current) => Math.max(current - 1, 0));
        break;
      case "Enter":
        if (open && active >= 0) {
          event.preventDefault();
          choose(options[active]);
        }
        break;
      case "Escape":
        setOpen(false);
        break;
      case "Tab":
        setOpen(false);
        break;
      default:
        setOpen(true);
        break;
    }
  };

  return (
    <div className={cn("relative min-w-0", className)}>
      <Input
        value={value}
        disabled={disabled}
        aria-label={ariaLabel}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        onChange={(event) => {
          onChange(event.target.value);
          setOpen(true);
        }}
        onKeyDown={onKeyDown}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        className="pr-7 font-mono text-[12px]"
      />
      <IconButton
        label="Show type suggestions"
        tabIndex={-1}
        disabled={disabled}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => setOpen((current) => !current)}
        className="absolute right-0.5 top-0.5 size-7 text-subtle"
      >
        <ChevronDown className="size-3.5" />
      </IconButton>

      <Popover open={open && options.length > 0} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          {/* The input above is the real trigger; this anchor only positions. */}
          <span className="pointer-events-none absolute inset-x-0 bottom-0 h-0 w-0" />
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={2}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onCloseAutoFocus={(event) => event.preventDefault()}
          className="z-[60] max-h-64 w-64 overflow-auto scrollbar-thin p-1"
        >
          {options.map((option, index) => (
            <button
              key={option.value}
              type="button"
              // The input keeps focus so the user can carry on typing.
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => choose(option)}
              onMouseEnter={() => setHighlight(index)}
              className={cn(
                "flex w-full items-center gap-2 rounded-sm px-2 py-1 text-left",
                index === active ? "bg-accent text-accent-fg" : "text-fg hover:bg-hover",
              )}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-[12px]">
                {option.value}
              </span>
              <span
                className={cn(
                  "shrink-0 text-[10px]",
                  index === active ? "text-accent-fg/80" : "text-subtle",
                )}
              >
                {option.label}
              </span>
            </button>
          ))}
        </PopoverContent>
      </Popover>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Form rows
// ---------------------------------------------------------------------------

/** Label on the left, control on the right — the dense form row. */
export function Row({
  label,
  hint,
  children,
  className,
}: {
  label: React.ReactNode;
  hint?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("flex items-start gap-3", className)}>
      <div className="w-28 shrink-0 pt-1.5 text-right">
        <span className="text-xs font-medium text-muted">{label}</span>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        {children}
        {hint ? <p className="text-[11px] leading-snug text-subtle">{hint}</p> : null}
      </div>
    </div>
  );
}

/** A checkbox list used to pick a set of columns in order. */
export function ColumnPicker({
  columns,
  selected,
  onToggle,
  emptyLabel = "No columns",
  className,
}: {
  columns: readonly string[];
  selected: readonly string[];
  onToggle: (column: string, checked: boolean) => void;
  emptyLabel?: string;
  className?: string;
}) {
  if (columns.length === 0) {
    return <p className="text-[11px] text-subtle">{emptyLabel}</p>;
  }
  return (
    <div
      className={cn(
        "flex max-h-32 flex-wrap gap-1 overflow-auto scrollbar-thin rounded-md border border-border bg-surface p-1.5",
        className,
      )}
    >
      {columns.map((column) => {
        const checked = selected.includes(column);
        return (
          <button
            key={column}
            type="button"
            aria-pressed={checked}
            onClick={() => onToggle(column, !checked)}
            className={cn(
              "inline-flex items-center gap-1 rounded-sm border px-1.5 py-0.5 font-mono text-[11px]",
              checked
                ? "border-accent/40 bg-accent-soft text-accent"
                : "border-border bg-raised text-muted hover:bg-hover hover:text-fg",
            )}
          >
            {checked ? <Check className="size-3" /> : null}
            {column}
          </button>
        );
      })}
    </div>
  );
}

/** A short inline note used for dropped rows and read-only warnings. */
export function Note({
  tone = "neutral",
  children,
  className,
}: {
  tone?: "neutral" | "warning" | "danger";
  children: React.ReactNode;
  className?: string;
}) {
  const tones = {
    neutral: "bg-sunken text-muted border-border",
    warning: "bg-warning-soft text-warning border-warning/30",
    danger: "bg-danger-soft text-danger border-danger/30",
  } as const;
  return (
    <div
      className={cn(
        "flex items-start gap-2 rounded-md border px-2.5 py-1.5 text-[11px] leading-snug",
        tones[tone],
        className,
      )}
    >
      {children}
    </div>
  );
}
