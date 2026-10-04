/**
 * Low-level presentation primitives.
 *
 * These are deliberately unstyled-by-default building blocks: a compact desktop
 * density, token-driven colours and no layout opinions. Feature components
 * compose them rather than redefining buttons and inputs.
 */

import * as React from "react";
import * as CheckboxPrimitive from "@radix-ui/react-checkbox";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as LabelPrimitive from "@radix-ui/react-label";
import { Slot } from "@radix-ui/react-slot";
import { Check, Loader2, Minus } from "lucide-react";

import { cn } from "@/lib/utils";

// ---------------------------------------------------------------------------
// Button
// ---------------------------------------------------------------------------

export type ButtonVariant =
  | "primary"
  | "secondary"
  | "ghost"
  | "subtle"
  | "danger"
  | "outline";
export type ButtonSize = "xs" | "sm" | "md" | "lg" | "icon" | "icon-sm";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary:
    "bg-accent text-accent-fg hover:bg-accent-hover shadow-xs disabled:bg-accent/50",
  secondary:
    "bg-raised text-fg border border-border hover:bg-hover hover:border-border-strong",
  outline:
    "bg-transparent text-fg border border-border hover:bg-hover",
  ghost: "bg-transparent text-fg hover:bg-hover",
  subtle: "bg-sunken text-fg hover:bg-hover",
  danger: "bg-danger text-white hover:brightness-110",
};

const BUTTON_SIZES: Record<ButtonSize, string> = {
  xs: "h-6 px-2 text-[11px] gap-1 rounded-xs",
  sm: "h-7 px-2.5 text-xs gap-1.5 rounded-sm",
  md: "h-8 px-3 text-[13px] gap-1.5 rounded-md",
  lg: "h-10 px-4 text-sm gap-2 rounded-md",
  icon: "h-8 w-8 rounded-md",
  "icon-sm": "h-7 w-7 rounded-sm",
};

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  /** Render the single child instead of a `<button>`. */
  asChild?: boolean;
  loading?: boolean;
}

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  function Button(
    {
      className,
      variant = "secondary",
      size = "sm",
      asChild = false,
      loading = false,
      disabled,
      children,
      ...props
    },
    ref,
  ) {
    const Component = asChild ? Slot : "button";
    return (
      <Component
        ref={ref}
        disabled={disabled || loading}
        className={cn(
          "inline-flex select-none items-center justify-center whitespace-nowrap font-medium",
          "transition-colors duration-100",
          "disabled:pointer-events-none disabled:opacity-50",
          BUTTON_VARIANTS[variant],
          BUTTON_SIZES[size],
          className,
        )}
        {...props}
      >
        {loading ? (
          <>
            <Loader2 className="size-3.5 animate-spin-slow" />
            {children}
          </>
        ) : (
          children
        )}
      </Component>
    );
  },
);

/** Square icon-only button with an accessible label. */
export interface IconButtonProps extends ButtonProps {
  label: string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  function IconButton({ label, size = "icon-sm", variant = "ghost", ...props }, ref) {
    return (
      <Button
        ref={ref}
        aria-label={label}
        title={label}
        size={size}
        variant={variant}
        {...props}
      />
    );
  },
);

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export const Input = React.forwardRef<
  HTMLInputElement,
  React.InputHTMLAttributes<HTMLInputElement>
>(function Input({ className, ...props }, ref) {
  return (
    <input
      ref={ref}
      className={cn(
        "h-8 w-full rounded-md border border-border bg-surface px-2.5 text-[13px] text-fg",
        "placeholder:text-subtle",
        "transition-[border-color,box-shadow] duration-100",
        "focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25",
        "disabled:cursor-not-allowed disabled:bg-sunken disabled:text-muted",
        className,
      )}
      {...props}
    />
  );
});

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(function Textarea({ className, ...props }, ref) {
  return (
    <textarea
      ref={ref}
      className={cn(
        "w-full rounded-md border border-border bg-surface px-2.5 py-1.5 text-[13px] text-fg",
        "placeholder:text-subtle",
        "focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25",
        "disabled:cursor-not-allowed disabled:bg-sunken",
        "scrollbar-thin resize-none",
        className,
      )}
      {...props}
    />
  );
});

/** A native select styled to match {@link Input}. */
export const NativeSelect = React.forwardRef<
  HTMLSelectElement,
  React.SelectHTMLAttributes<HTMLSelectElement>
>(function NativeSelect({ className, children, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        "h-8 w-full appearance-none rounded-md border border-border bg-surface px-2.5 pr-7 text-[13px] text-fg",
        "focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/25",
        "disabled:cursor-not-allowed disabled:bg-sunken",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
});

export const Label = React.forwardRef<
  React.ComponentRef<typeof LabelPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof LabelPrimitive.Root>
>(function Label({ className, ...props }, ref) {
  return (
    <LabelPrimitive.Root
      ref={ref}
      className={cn("text-xs font-medium text-muted", className)}
      {...props}
    />
  );
});

export interface FieldProps {
  label?: React.ReactNode;
  hint?: React.ReactNode;
  error?: React.ReactNode;
  required?: boolean;
  className?: string;
  children: React.ReactNode;
  /** Put the control on the same row as the label (dense forms). */
  inline?: boolean;
}

/** Label + control + hint/error, the standard form row. */
export function Field({
  label,
  hint,
  error,
  required,
  className,
  children,
  inline = false,
}: FieldProps) {
  return (
    <div
      className={cn(
        inline ? "flex items-center gap-3" : "flex flex-col gap-1.5",
        className,
      )}
    >
      {label ? (
        <Label className={cn(inline && "w-32 shrink-0 text-right", "flex items-center gap-1")}>
          {label}
          {required ? <span className="text-danger">*</span> : null}
        </Label>
      ) : null}
      <div className={cn(inline ? "flex-1" : "contents")}>{children}</div>
      {hint && !error ? (
        <p className="text-[11px] leading-snug text-subtle">{hint}</p>
      ) : null}
      {error ? (
        <p className="text-[11px] leading-snug text-danger">{error}</p>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Checkbox & switch
// ---------------------------------------------------------------------------

export const Checkbox = React.forwardRef<
  React.ComponentRef<typeof CheckboxPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof CheckboxPrimitive.Root>
>(function Checkbox({ className, ...props }, ref) {
  return (
    <CheckboxPrimitive.Root
      ref={ref}
      className={cn(
        "grid size-4 shrink-0 place-content-center rounded-xs border border-border-strong bg-surface",
        "transition-colors duration-100",
        "hover:border-accent",
        "data-[state=checked]:border-accent data-[state=checked]:bg-accent data-[state=checked]:text-accent-fg",
        "data-[state=indeterminate]:border-accent data-[state=indeterminate]:bg-accent data-[state=indeterminate]:text-accent-fg",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator className="grid place-content-center">
        {props.checked === "indeterminate" ? (
          <Minus className="size-3" strokeWidth={3} />
        ) : (
          <Check className="size-3" strokeWidth={3} />
        )}
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  );
});

export const Switch = React.forwardRef<
  React.ComponentRef<typeof SwitchPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitive.Root>
>(function Switch({ className, ...props }, ref) {
  return (
    <SwitchPrimitive.Root
      ref={ref}
      className={cn(
        "peer inline-flex h-[18px] w-8 shrink-0 cursor-pointer items-center rounded-full border border-transparent",
        "transition-colors duration-150",
        "data-[state=unchecked]:bg-border-strong data-[state=checked]:bg-accent",
        "disabled:cursor-not-allowed disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        className={cn(
          "pointer-events-none block size-3.5 rounded-full bg-white shadow-sm",
          "transition-transform duration-150",
          "data-[state=unchecked]:translate-x-[2px] data-[state=checked]:translate-x-[15px]",
        )}
      />
    </SwitchPrimitive.Root>
  );
});

/** Checkbox plus an inline label, the common shape in option panels. */
export function CheckboxField({
  checked,
  onCheckedChange,
  label,
  hint,
  disabled,
  className,
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: React.ReactNode;
  hint?: React.ReactNode;
  disabled?: boolean;
  className?: string;
}) {
  const id = React.useId();
  return (
    <div className={cn("flex items-start gap-2", className)}>
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        className="mt-0.5"
      />
      <div className="flex min-w-0 flex-col gap-0.5">
        <label htmlFor={id} className="cursor-default text-[13px] leading-tight text-fg">
          {label}
        </label>
        {hint ? <span className="text-[11px] leading-snug text-subtle">{hint}</span> : null}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Display bits
// ---------------------------------------------------------------------------

export function Spinner({ className }: { className?: string }) {
  return <Loader2 className={cn("size-4 animate-spin-slow text-muted", className)} />;
}

export type BadgeTone = "neutral" | "accent" | "success" | "warning" | "danger" | "info";

const BADGE_TONES: Record<BadgeTone, string> = {
  neutral: "bg-sunken text-muted border-border",
  accent: "bg-accent-soft text-accent border-accent/30",
  success: "bg-success-soft text-success border-success/30",
  warning: "bg-warning-soft text-warning border-warning/30",
  danger: "bg-danger-soft text-danger border-danger/30",
  info: "bg-info-soft text-info border-info/30",
};

export function Badge({
  children,
  tone = "neutral",
  className,
}: {
  children: React.ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border px-1.5 py-px text-[10px] font-medium uppercase tracking-wide",
        BADGE_TONES[tone],
        className,
      )}
    >
      {children}
    </span>
  );
}

export function Separator({
  orientation = "horizontal",
  className,
}: {
  orientation?: "horizontal" | "vertical";
  className?: string;
}) {
  return (
    <div
      role="separator"
      className={cn(
        "shrink-0 bg-border",
        orientation === "horizontal" ? "h-px w-full" : "h-full w-px",
        className,
      )}
    />
  );
}

export function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="rounded-xs border border-border bg-sunken px-1 py-px font-mono text-[10px] text-muted">
      {children}
    </kbd>
  );
}

/** Centered placeholder for empty panels and failed loads. */
export function EmptyState({
  icon,
  title,
  description,
  action,
  className,
}: {
  icon?: React.ReactNode;
  title: React.ReactNode;
  description?: React.ReactNode;
  action?: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-full flex-col items-center justify-center gap-3 px-6 py-10 text-center",
        className,
      )}
    >
      {icon ? <div className="text-subtle/70 [&>svg]:size-9">{icon}</div> : null}
      <div className="flex flex-col gap-1">
        <p className="text-[13px] font-medium text-fg">{title}</p>
        {description ? (
          <p className="max-w-sm text-xs leading-relaxed text-subtle">{description}</p>
        ) : null}
      </div>
      {action}
    </div>
  );
}

/** A titled surface used by the side panels and the detail area. */
export function Panel({
  title,
  actions,
  children,
  className,
  bodyClassName,
  icon,
}: {
  title?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  bodyClassName?: string;
  icon?: React.ReactNode;
}) {
  return (
    <section
      className={cn(
        "flex min-h-0 flex-col overflow-hidden rounded-lg border border-border bg-surface",
        className,
      )}
    >
      {title ? (
        <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-raised px-3">
          {icon ? <span className="text-muted [&>svg]:size-3.5">{icon}</span> : null}
          <h2 className="min-w-0 flex-1 truncate text-xs font-semibold text-fg">{title}</h2>
          {actions ? <div className="flex items-center gap-1">{actions}</div> : null}
        </header>
      ) : null}
      <div className={cn("min-h-0 flex-1 overflow-auto scrollbar-thin", bodyClassName)}>
        {children}
      </div>
    </section>
  );
}

/** Horizontal toolbar strip used above grids and editors. */
export function Toolbar({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div
      className={cn(
        "flex h-9 shrink-0 items-center gap-1 border-b border-border bg-raised px-2",
        className,
      )}
    >
      {children}
    </div>
  );
}

/** A dot used to indicate connection state. */
export function StatusDot({
  tone = "neutral",
  pulse = false,
  className,
}: {
  tone?: "neutral" | "success" | "warning" | "danger" | "accent";
  pulse?: boolean;
  className?: string;
}) {
  const tones: Record<string, string> = {
    neutral: "bg-subtle",
    success: "bg-success",
    warning: "bg-warning",
    danger: "bg-danger",
    accent: "bg-accent",
  };
  return (
    <span className={cn("relative inline-flex size-2 shrink-0", className)}>
      {pulse ? (
        <span
          className={cn(
            "absolute inset-0 animate-ping rounded-full opacity-60",
            tones[tone],
          )}
        />
      ) : null}
      <span className={cn("relative size-2 rounded-full", tones[tone])} />
    </span>
  );
}

/** A right-aligned hint row inside the toolbar. */
export function ToolbarSpacer() {
  return <div className="flex-1" />;
}
