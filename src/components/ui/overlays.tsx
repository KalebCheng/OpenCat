/**
 * Overlay primitives: dialogs, menus, popovers and tooltips.
 *
 * Radix handles focus trapping, keyboard navigation and portal placement; the
 * styling here keeps them consistent with the rest of the desktop chrome.
 */

import * as React from "react";
import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as ContextMenuPrimitive from "@radix-ui/react-context-menu";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import { Check, ChevronRight, X } from "lucide-react";

import { cn } from "@/lib/utils";
import { Button } from "./primitives";

// ---------------------------------------------------------------------------
// Tooltip
// ---------------------------------------------------------------------------

export const TooltipProvider = TooltipPrimitive.Provider;

export function Tooltip({
  children,
  content,
  side = "bottom",
  shortcut,
  delay = 400,
}: {
  children: React.ReactNode;
  content: React.ReactNode;
  side?: "top" | "right" | "bottom" | "left";
  shortcut?: string;
  delay?: number;
}) {
  if (!content) return <>{children}</>;
  return (
    <TooltipPrimitive.Root delayDuration={delay}>
      <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content
          side={side}
          sideOffset={6}
          className={cn(
            "z-50 flex items-center gap-2 rounded-md border border-border bg-raised px-2 py-1",
            "text-[11px] text-fg shadow-popover",
            "animate-scale-in",
          )}
        >
          <span>{content}</span>
          {shortcut ? (
            <kbd className="rounded-xs bg-sunken px-1 font-mono text-[10px] text-muted">
              {shortcut}
            </kbd>
          ) : null}
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

// ---------------------------------------------------------------------------
// Dialog
// ---------------------------------------------------------------------------

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export interface DialogContentProps
  extends React.ComponentPropsWithoutRef<typeof DialogPrimitive.Content> {
  size?: "sm" | "md" | "lg" | "xl" | "full";
  /** Hide the built-in close button (rare). */
  hideClose?: boolean;
}

const DIALOG_SIZES: Record<string, string> = {
  sm: "max-w-sm",
  md: "max-w-lg",
  lg: "max-w-3xl",
  xl: "max-w-5xl",
  full: "h-[92vh] w-[94vw] max-w-none",
};

export const DialogContent = React.forwardRef<
  React.ComponentRef<typeof DialogPrimitive.Content>,
  DialogContentProps
>(function DialogContent({ className, children, size = "md", hideClose, ...props }, ref) {
  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay
        className={cn(
          "fixed inset-0 z-40 bg-black/45 backdrop-blur-[2px]",
          "data-[state=open]:animate-fade-in",
        )}
      />
      <DialogPrimitive.Content
        ref={ref}
        className={cn(
          "fixed left-1/2 top-1/2 z-50 flex max-h-[90vh] w-[92vw] -translate-x-1/2 -translate-y-1/2",
          "flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-popover",
          "data-[state=open]:animate-scale-in",
          DIALOG_SIZES[size],
          className,
        )}
        {...props}
      >
        {children}
        {hideClose ? null : (
          <DialogPrimitive.Close asChild>
            <button
              aria-label="Close"
              className={cn(
                "absolute right-3 top-3 grid size-6 place-content-center rounded-md",
                "text-subtle transition-colors hover:bg-hover hover:text-fg",
              )}
            >
              <X className="size-3.5" />
            </button>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
});

export function DialogHeader({
  title,
  description,
  icon,
  className,
}: {
  title: React.ReactNode;
  description?: React.ReactNode;
  icon?: React.ReactNode;
  className?: string;
}) {
  return (
    <header
      className={cn(
        "flex shrink-0 items-start gap-3 border-b border-border px-4 py-3 pr-10",
        className,
      )}
    >
      {icon ? (
        <div className="mt-0.5 grid size-8 shrink-0 place-content-center rounded-lg bg-accent-soft text-accent [&>svg]:size-4">
          {icon}
        </div>
      ) : null}
      <div className="flex min-w-0 flex-col gap-0.5">
        <DialogPrimitive.Title className="text-sm font-semibold text-fg">
          {title}
        </DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="text-xs leading-relaxed text-muted">
            {description}
          </DialogPrimitive.Description>
        ) : null}
      </div>
    </header>
  );
}

export function DialogBody({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-h-0 flex-1 overflow-auto scrollbar-thin p-4", className)}>
      {children}
    </div>
  );
}

export function DialogFooter({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <footer
      className={cn(
        "flex shrink-0 items-center justify-end gap-2 border-t border-border bg-raised px-4 py-3",
        className,
      )}
    >
      {children}
    </footer>
  );
}

// ---------------------------------------------------------------------------
// Menus
// ---------------------------------------------------------------------------

export const DropdownMenu = DropdownMenuPrimitive.Root;
export const DropdownMenuTrigger = DropdownMenuPrimitive.Trigger;
export const DropdownMenuSub = DropdownMenuPrimitive.Sub;
export const DropdownMenuGroup = DropdownMenuPrimitive.Group;

export const ContextMenu = ContextMenuPrimitive.Root;
export const ContextMenuTrigger = ContextMenuPrimitive.Trigger;
export const ContextMenuSub = ContextMenuPrimitive.Sub;

const MENU_CONTENT_CLASS = cn(
  "z-50 min-w-[11rem] overflow-hidden rounded-lg border border-border bg-raised py-1 shadow-popover",
  "animate-scale-in",
);

const MENU_ITEM_CLASS = cn(
  "relative flex cursor-default select-none items-center gap-2 px-2.5 py-1.5 text-[12px] text-fg outline-none",
  "data-[highlighted]:bg-accent data-[highlighted]:text-accent-fg",
  "data-[disabled]:pointer-events-none data-[disabled]:opacity-45",
  "[&>svg]:size-3.5 [&>svg]:shrink-0",
);

export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Content>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        sideOffset={sideOffset}
        className={cn(MENU_CONTENT_CLASS, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function DropdownMenuItem({
  className,
  danger,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item> & { danger?: boolean }) {
  return (
    <DropdownMenuPrimitive.Item
      className={cn(MENU_ITEM_CLASS, danger && "text-danger", className)}
      {...props}
    />
  );
}

export function DropdownMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <DropdownMenuPrimitive.Label className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-subtle">
      {children}
    </DropdownMenuPrimitive.Label>
  );
}

export function DropdownMenuSeparator() {
  return <DropdownMenuPrimitive.Separator className="my-1 h-px bg-border" />;
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  checked,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.CheckboxItem>) {
  return (
    <DropdownMenuPrimitive.CheckboxItem
      checked={checked}
      className={cn(MENU_ITEM_CLASS, "pl-7", className)}
      {...props}
    >
      <span className="absolute left-2 grid place-content-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <Check className="size-3.5" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.CheckboxItem>
  );
}

export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubTrigger>) {
  return (
    <DropdownMenuPrimitive.SubTrigger
      className={cn(MENU_ITEM_CLASS, "data-[state=open]:bg-hover", className)}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto size-3.5" />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

export function DropdownMenuSubContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.SubContent>) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        className={cn(MENU_CONTENT_CLASS, className)}
        {...props}
      />
    </DropdownMenuPrimitive.Portal>
  );
}

export function ContextMenuContent({
  className,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Content>) {
  return (
    <ContextMenuPrimitive.Portal>
      <ContextMenuPrimitive.Content className={cn(MENU_CONTENT_CLASS, className)} {...props} />
    </ContextMenuPrimitive.Portal>
  );
}

export function ContextMenuItem({
  className,
  danger,
  ...props
}: React.ComponentPropsWithoutRef<typeof ContextMenuPrimitive.Item> & { danger?: boolean }) {
  return (
    <ContextMenuPrimitive.Item
      className={cn(MENU_ITEM_CLASS, danger && "text-danger", className)}
      {...props}
    />
  );
}

export function ContextMenuSeparator() {
  return <ContextMenuPrimitive.Separator className="my-1 h-px bg-border" />;
}

export function ContextMenuLabel({ children }: { children: React.ReactNode }) {
  return (
    <ContextMenuPrimitive.Label className="px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-subtle">
      {children}
    </ContextMenuPrimitive.Label>
  );
}

// ---------------------------------------------------------------------------
// Popover
// ---------------------------------------------------------------------------

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;

export function PopoverContent({
  className,
  align = "start",
  sideOffset = 6,
  ...props
}: React.ComponentPropsWithoutRef<typeof PopoverPrimitive.Content>) {
  return (
    <PopoverPrimitive.Portal>
      <PopoverPrimitive.Content
        align={align}
        sideOffset={sideOffset}
        className={cn(
          "z-50 rounded-lg border border-border bg-raised p-3 shadow-popover",
          "animate-scale-in outline-none",
          className,
        )}
        {...props}
      />
    </PopoverPrimitive.Portal>
  );
}

// ---------------------------------------------------------------------------
// Confirmation
// ---------------------------------------------------------------------------

export interface ConfirmOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: "default" | "danger";
  /** Extra content, e.g. a "do not ask again" checkbox. */
  extra?: React.ReactNode;
}

/**
 * Imperative confirmation dialog.
 *
 * Mount `<ConfirmHost />` once near the app root, then call
 * `await confirm({ ... })` from anywhere. Returns `true` when confirmed.
 */
type ConfirmRequest = ConfirmOptions & { resolve: (value: boolean) => void };

const ConfirmContext = React.createContext<((options: ConfirmOptions) => Promise<boolean>) | null>(
  null,
);

export function ConfirmProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = React.useState<ConfirmRequest | null>(null);

  const confirm = React.useCallback(
    (options: ConfirmOptions) =>
      new Promise<boolean>((resolve) => setRequest({ ...options, resolve })),
    [],
  );

  const settle = (value: boolean) => {
    request?.resolve(value);
    setRequest(null);
  };

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <Dialog open={request !== null} onOpenChange={(open) => !open && settle(false)}>
        <DialogContent size="sm" className="max-w-md">
          <DialogHeader
            title={request?.title ?? ""}
            description={request?.description}
          />
          {request?.extra ? <DialogBody>{request.extra}</DialogBody> : null}
          <DialogFooter>
            <Button onClick={() => settle(false)}>
              {request?.cancelLabel ?? "Cancel"}
            </Button>
            <Button
              variant={request?.tone === "danger" ? "danger" : "primary"}
              onClick={() => settle(true)}
              autoFocus
            >
              {request?.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </ConfirmContext.Provider>
  );
}

/** Prompt for confirmation. Throws when used outside {@link ConfirmProvider}. */
export function useConfirm() {
  const context = React.useContext(ConfirmContext);
  if (!context) {
    throw new Error("useConfirm must be used inside <ConfirmProvider>");
  }
  return context;
}

/** Prompt for a single line of text (used for renames). */
export interface PromptOptions {
  title: React.ReactNode;
  description?: React.ReactNode;
  label?: string;
  initialValue?: string;
  confirmLabel?: string;
  validate?: (value: string) => string | null;
}

type PromptRequest = PromptOptions & {
  resolve: (value: string | null) => void;
};

const PromptContext = React.createContext<
  ((options: PromptOptions) => Promise<string | null>) | null
>(null);

export function PromptProvider({ children }: { children: React.ReactNode }) {
  const [request, setRequest] = React.useState<PromptRequest | null>(null);
  const [value, setValue] = React.useState("");
  const [error, setError] = React.useState<string | null>(null);

  const prompt = React.useCallback(
    (options: PromptOptions) =>
      new Promise<string | null>((resolve) => {
        setValue(options.initialValue ?? "");
        setError(null);
        setRequest({ ...options, resolve });
      }),
    [],
  );

  const settle = (result: string | null) => {
    request?.resolve(result);
    setRequest(null);
  };

  const submit = () => {
    const message = request?.validate?.(value) ?? null;
    if (message) {
      setError(message);
      return;
    }
    settle(value);
  };

  return (
    <PromptContext.Provider value={prompt}>
      {children}
      <Dialog open={request !== null} onOpenChange={(open) => !open && settle(null)}>
        <DialogContent size="sm" className="max-w-md">
          <DialogHeader title={request?.title ?? ""} description={request?.description} />
          <DialogBody className="flex flex-col gap-2">
            {request?.label ? (
              <label className="text-xs font-medium text-muted">{request.label}</label>
            ) : null}
            <input
              autoFocus
              value={value}
              onChange={(event) => {
                setValue(event.target.value);
                setError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter") submit();
              }}
              className={cn(
                "h-8 w-full rounded-md border bg-surface px-2.5 text-[13px] text-fg",
                "focus:outline-none focus:ring-2 focus:ring-accent/25",
                error ? "border-danger" : "border-border focus:border-accent",
              )}
            />
            {error ? <p className="text-[11px] text-danger">{error}</p> : null}
          </DialogBody>
          <DialogFooter>
            <Button onClick={() => settle(null)}>Cancel</Button>
            <Button variant="primary" onClick={submit}>
              {request?.confirmLabel ?? "OK"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </PromptContext.Provider>
  );
}

export function usePrompt() {
  const context = React.useContext(PromptContext);
  if (!context) {
    throw new Error("usePrompt must be used inside <PromptProvider>");
  }
  return context;
}
