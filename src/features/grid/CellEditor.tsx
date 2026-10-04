/**
 * The in-place cell editor.
 *
 * It owns only the *text* of a value. Turning that text back into a tagged
 * `Value` belongs to the grid, which also has the row keys and the original
 * value needed to build a `CellChange`.
 */

import * as React from "react";

import type { ColumnMeta, Value } from "@/lib/types";
import { cn } from "@/lib/utils";

import { editorText } from "./gridModel";

/** Where the cursor should land once the commit has been sent. */
export type EditMove = "down" | "up" | "next" | "prev";

export interface CellEditorCommit {
  text: string;
  move: EditMove | null;
  /** True when the user asked for SQL NULL (`Ctrl+0`) rather than an empty string. */
  asNull: boolean;
}

export interface CellEditorProps {
  column: ColumnMeta;
  value: Value | null | undefined;
  /** The keystroke that started the edit, when it was not a double click. */
  seed?: string;
  /** Rows near the bottom of the viewport open their multi-line editor upwards. */
  openAbove?: boolean;
  onCommit: (commit: CellEditorCommit) => void;
  onCancel: () => void;
}

/**
 * Long, structured or multi-line values get a textarea. A 26px row cannot grow
 * to fit one, so it floats over its neighbours instead.
 */
function wantsTextarea(column: ColumnMeta, text: string): boolean {
  if (column.logicalType === "json" || column.logicalType === "array") return true;
  return text.length > 80 || text.includes("\n");
}

export function CellEditor({
  column,
  value,
  seed,
  openAbove = false,
  onCommit,
  onCancel,
}: CellEditorProps): React.ReactElement {
  const initial = seed ?? editorText(value);
  const [text, setText] = React.useState(initial);
  const multiline = React.useMemo(() => wantsTextarea(column, initial), [column, initial]);
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const areaRef = React.useRef<HTMLTextAreaElement | null>(null);
  /** Guards the single settle path: blur must not fire after Enter or Escape. */
  const settled = React.useRef(false);

  // The grid keys this component by cell, so it mounts once per edit and never
  // has to re-focus when a refresh happens underneath it.
  React.useEffect(() => {
    const element = inputRef.current ?? areaRef.current;
    if (!element) return;
    element.focus();
    if (seed !== undefined) {
      // Typing over a cell replaces it; the caret belongs after the seed.
      element.setSelectionRange(element.value.length, element.value.length);
    } else {
      element.select();
    }
  }, [seed]);

  const settle = (commit: CellEditorCommit) => {
    if (settled.current) return;
    settled.current = true;
    onCommit(commit);
  };

  const cancel = () => {
    if (settled.current) return;
    settled.current = true;
    onCancel();
  };

  const handleKeyDown = (
    event: React.KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancel();
      return;
    }
    if ((event.ctrlKey || event.metaKey) && event.key === "0") {
      event.preventDefault();
      settle({ text: "", move: null, asNull: true });
      return;
    }
    // A textarea keeps Enter for newlines; everything else commits with it.
    if (event.key === "Enter" && (!multiline || event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      settle({
        text,
        move: event.shiftKey && !multiline ? "up" : "down",
        asNull: false,
      });
      return;
    }
    if (event.key === "Tab") {
      event.preventDefault();
      settle({ text, move: event.shiftKey ? "prev" : "next", asNull: false });
    }
  };

  const handleChange = (
    event: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    setText(event.target.value);
  };

  if (!multiline) {
    return (
      <input
        ref={inputRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => settle({ text, move: null, asNull: false })}
        spellCheck={false}
        autoComplete="off"
        aria-label={`Edit ${column.name}`}
        className={cn(
          "absolute inset-0 z-30 h-full w-full rounded-none border border-accent",
          "bg-surface px-1.5 text-[12px] text-fg outline-none",
          column.logicalType === "json" || column.logicalType === "array"
            ? "font-mono"
            : null,
        )}
      />
    );
  }

  return (
    <div
      className={cn(
        "absolute left-0 z-40 w-[min(30rem,70vw)] rounded-md border border-accent",
        "bg-raised p-1 shadow-popover",
        openAbove ? "bottom-full mb-px" : "top-full mt-px",
      )}
    >
      <textarea
        ref={areaRef}
        value={text}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
        onBlur={() => settle({ text, move: null, asNull: false })}
        rows={6}
        spellCheck={false}
        autoComplete="off"
        aria-label={`Edit ${column.name}`}
        className="block h-24 w-full resize-y bg-transparent font-mono text-[12px] text-fg outline-none scrollbar-thin"
      />
      <p className="px-0.5 pt-1 text-[10px] text-subtle">
        Ctrl+Enter saves · Esc cancels · Ctrl+0 sets NULL
      </p>
    </div>
  );
}
