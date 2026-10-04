/**
 * The generated-SQL panel.
 *
 * This is the designer's safety net: every change is rendered by the backend's
 * own DDL generator (the same one `create_table` / `alter_table` call), so what
 * is shown here is exactly what Apply will run. The user can take the script
 * over, in which case the designer sends the edited statements through
 * `schema.apply` instead of asking the backend to render them again.
 */

import * as React from "react";
import { AlertTriangle, Check, Copy, Pencil, FileCode2, RotateCcw } from "lucide-react";
import { toast } from "sonner";

import type { DdlPlan } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Badge, Button, IconButton, Spinner, Textarea } from "@/components/ui/primitives";

import { Note } from "./ui";

/** Split an edited script back into statements, keeping `;` out of literals. */
export function splitStatements(script: string): string[] {
  return script
    .split(/;\s*(?:\r?\n|$)/)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

/** Join statements the way the code panel shows them. */
function joinStatements(statements: readonly string[]): string {
  return statements.map((statement) => statement.trim().replace(/;\s*$/, "")).join(";\n\n");
}

export interface SqlPreviewProps {
  plan: DdlPlan | null;
  loading: boolean;
  /** Set when the preview call itself failed. */
  error?: string | null;
  /** True while the user is editing the script by hand. */
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  /** Receives the parsed statements whenever the edited script changes. */
  onEditedScriptChange: (statements: string[] | null) => void;
  className?: string;
}

export function SqlPreview({
  plan,
  loading,
  error,
  editing,
  onEditingChange,
  onEditedScriptChange,
  className,
}: SqlPreviewProps) {
  const statements = plan?.statements ?? [];
  const generated = React.useMemo(() => joinStatements(statements), [statements]);
  const [draft, setDraft] = React.useState(generated);
  const [copied, setCopied] = React.useState(false);

  // Follow the freshly generated script unless the user has taken it over.
  React.useEffect(() => {
    if (!editing) setDraft(generated);
  }, [generated, editing]);

  const copy = async () => {
    const text = editing ? draft : generated;
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    } catch {
      toast.error("Could not copy — the clipboard is unavailable");
    }
  };

  const startEditing = () => {
    setDraft(generated);
    onEditedScriptChange(splitStatements(generated));
    onEditingChange(true);
  };

  const stopEditing = () => {
    setDraft(generated);
    onEditedScriptChange(null);
    onEditingChange(false);
  };

  const empty = statements.length === 0 && !loading;

  return (
    <section className={cn("flex min-h-0 flex-col bg-surface", className)}>
      <header className="flex h-9 shrink-0 items-center gap-2 border-b border-border bg-raised px-2">
        <span className="text-muted">
          <FileCode2 className="size-3.5" />
        </span>
        <h2 className="text-xs font-semibold text-fg">SQL preview</h2>
        {loading ? <Spinner className="size-3" /> : null}
        {!loading && statements.length > 0 ? (
          <Badge tone="neutral">
            {statements.length} statement{statements.length === 1 ? "" : "s"}
          </Badge>
        ) : null}
        {plan?.destructive ? <Badge tone="danger">destructive</Badge> : null}
        <span className="flex-1" />
        {editing ? (
          <Button size="xs" variant="ghost" onClick={stopEditing}>
            <RotateCcw className="size-3.5" /> Regenerate
          </Button>
        ) : (
          <Button
            size="xs"
            variant="ghost"
            disabled={statements.length === 0}
            onClick={startEditing}
          >
            <Pencil className="size-3.5" /> Edit
          </Button>
        )}
        <IconButton
          label={copied ? "Copied" : "Copy SQL"}
          disabled={statements.length === 0 && !editing}
          onClick={copy}
        >
          {copied ? <Check className="size-3.5 text-success" /> : <Copy className="size-3.5" />}
        </IconButton>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto scrollbar-thin p-2">
        {error ? (
          <Note tone="danger">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>Preview failed: {error}</span>
          </Note>
        ) : null}

        {plan?.destructive && statements.length > 0 ? (
          <Note tone="danger">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>
              Applying this destroys and re-creates the object, copying the rows across in between.
              Review the statements before continuing.
            </span>
          </Note>
        ) : null}

        {plan?.warnings.map((warning, index) => (
          <Note key={`${index}:${warning}`} tone="warning">
            <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
            <span>{warning}</span>
          </Note>
        ))}

        {empty ? (
          <div className="flex flex-col items-center gap-1 px-4 py-10 text-center">
            <p className="text-[13px] font-medium text-fg">No changes</p>
            <p className="max-w-xs text-xs leading-relaxed text-subtle">
              Edit a column, index or option and the statements the backend would run appear here.
            </p>
          </div>
        ) : editing ? (
          <Textarea
            value={draft}
            spellCheck={false}
            aria-label="Editable SQL script"
            onChange={(event) => {
              setDraft(event.target.value);
              onEditedScriptChange(splitStatements(event.target.value));
            }}
            className="min-h-64 flex-1 resize-none font-mono text-[12px] leading-relaxed"
          />
        ) : (
          <pre className="selectable min-h-0 flex-1 overflow-auto scrollbar-thin whitespace-pre-wrap rounded-md border border-border bg-sunken p-2.5 font-mono text-[12px] leading-relaxed text-fg">
            {generated}
          </pre>
        )}

        {editing ? (
          <p className="shrink-0 text-[11px] text-subtle">
            Apply will run this script as written, parsed into {splitStatements(draft).length}{" "}
            statement{splitStatements(draft).length === 1 ? "" : "s"}.
          </p>
        ) : null}
      </div>
    </section>
  );
}

export default SqlPreview;
