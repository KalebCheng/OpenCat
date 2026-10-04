/**
 * A thin React wrapper around CodeMirror 6.
 *
 * CodeMirror owns the document; React only pushes whole-document replacements in
 * (for "open file", formatting, snippet insertion) and reads text out on demand.
 * Trying to make it a controlled component would fight the editor's own history.
 */

import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import {
  EditorView,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers as lineNumbersExtension,
  rectangularSelection,
} from "@codemirror/view";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  redo,
  undo,
} from "@codemirror/commands";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import {
  HighlightStyle,
  bracketMatching,
  indentOnInput,
  indentUnit,
  syntaxHighlighting,
} from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import { MySQL, PostgreSQL, SQLite, sql as sqlLanguage } from "@codemirror/lang-sql";
import { tags } from "@lezer/highlight";

import type { DbKind } from "@/lib/types";

/** Token colours, mapped onto the app's design tokens. */
const highlightStyle = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--accent)", fontWeight: "600" },
  { tag: [tags.string, tags.special(tags.string)], color: "var(--success)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--warning)" },
  { tag: [tags.comment, tags.lineComment, tags.blockComment], color: "var(--fg-subtle)", fontStyle: "italic" },
  { tag: [tags.operator, tags.punctuation], color: "var(--fg-muted)" },
  { tag: [tags.typeName, tags.className], color: "var(--info)" },
  { tag: [tags.variableName, tags.propertyName], color: "var(--fg)" },
  { tag: tags.function(tags.variableName), color: "var(--info)" },
  { tag: tags.invalid, color: "var(--danger)", textDecoration: "underline wavy" },
]);

/** Editor chrome, driven by the same CSS variables as the rest of the UI. */
const editorTheme = EditorView.theme({
  "&": {
    backgroundColor: "var(--surface)",
    color: "var(--fg)",
    fontFamily: "var(--editor-font-family, var(--font-mono))",
    fontSize: "var(--editor-font-size, 13px)",
    height: "100%",
  },
  ".cm-scroller": {
    fontFamily: "inherit",
    lineHeight: "1.6",
    overflow: "auto",
  },
  ".cm-content": { padding: "8px 0", caretColor: "var(--accent)" },
  ".cm-gutters": {
    backgroundColor: "var(--surface)",
    color: "var(--fg-subtle)",
    border: "none",
    borderRight: "1px solid var(--border)",
    paddingRight: "4px",
  },
  ".cm-activeLineGutter": { backgroundColor: "var(--surface-hover)", color: "var(--fg-muted)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, var(--accent) 5%, transparent)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)", borderLeftWidth: "2px" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "color-mix(in srgb, var(--accent) 28%, transparent)",
  },
  ".cm-selectionMatch": { backgroundColor: "color-mix(in srgb, var(--accent) 18%, transparent)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "color-mix(in srgb, var(--accent) 24%, transparent)",
    outline: "1px solid var(--accent)",
  },
  ".cm-tooltip": {
    backgroundColor: "var(--surface-raised)",
    border: "1px solid var(--border)",
    borderRadius: "8px",
    boxShadow: "var(--shadow-popover)",
    color: "var(--fg)",
    overflow: "hidden",
  },
  ".cm-tooltip.cm-tooltip-autocomplete > ul": {
    fontFamily: "var(--font-mono)",
    fontSize: "12px",
    maxHeight: "16rem",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "var(--accent)",
    color: "var(--accent-fg)",
  },
  ".cm-completionLabel": { flex: "1" },
  ".cm-completionDetail": { color: "var(--fg-subtle)", fontStyle: "normal", marginLeft: "8px" },
  ".cm-panels": {
    backgroundColor: "var(--surface-raised)",
    borderTop: "1px solid var(--border)",
    color: "var(--fg)",
  },
  ".cm-searchMatch": {
    backgroundColor: "color-mix(in srgb, var(--warning) 35%, transparent)",
    outline: "1px solid var(--warning)",
  },
  ".cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "color-mix(in srgb, var(--accent) 40%, transparent)",
  },
  ".cm-foldPlaceholder": {
    backgroundColor: "var(--surface-sunken)",
    border: "none",
    color: "var(--fg-muted)",
  },
});

/** Pick the CodeMirror dialect that matches the connected engine. */
function dialectFor(kind: DbKind) {
  switch (kind) {
    case "mysql":
      return MySQL;
    case "postgres":
      return PostgreSQL;
    case "sqlite":
      return SQLite;
  }
}

export interface SqlCodeMirrorProps {
  value: string;
  onChange?: (value: string) => void;
  /** Schema names offered as completions. */
  tables?: string[];
  dbKind: DbKind;
  readOnly?: boolean;
  wordWrap?: boolean;
  lineNumbers?: boolean;
  tabSize?: number;
  /** Extra key bindings, e.g. Ctrl+Enter to run. */
  onRun?: () => void;
  onRunSelection?: () => void;
  className?: string;
  /** Focus the editor when it mounts. */
  autoFocus?: boolean;
}

export interface SqlEditorHandle {
  view: () => EditorView | null;
  text: () => string;
  selectionText: () => string;
  setText: (text: string, keepHistory?: boolean) => void;
  focus: () => void;
  /** Replace the current selection (used by snippet insertion). */
  insert: (text: string) => void;
}

export function SqlCodeMirror({
  value,
  onChange,
  tables,
  dbKind,
  readOnly = false,
  wordWrap = false,
  lineNumbers = true,
  tabSize = 2,
  onRun,
  onRunSelection,
  className,
  autoFocus = false,
}: SqlCodeMirrorProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  // Compartments let us reconfigure without recreating the document.
  const wrapCompartment = useRef(new Compartment());
  const readOnlyCompartment = useRef(new Compartment());
  const gutterCompartment = useRef(new Compartment());
  const tabCompartment = useRef(new Compartment());
  const dialectCompartment = useRef(new Compartment());

  // Keep the latest callbacks without rebuilding the editor.
  const callbacks = useRef({ onChange, onRun, onRunSelection });
  callbacks.current = { onChange, onRun, onRunSelection };

  // -- create once ---------------------------------------------------------
  useEffect(() => {
    if (!hostRef.current) return;

    const state = EditorState.create({
      doc: value,
      extensions: [
        gutterCompartment.current.of(lineNumbers ? lineNumbersExtension() : []),
        highlightActiveLine(),
        highlightActiveLineGutter(),
        history(),
        drawSelection(),
        dropCursor(),
        rectangularSelection(),
        indentOnInput(),
        bracketMatching(),
        closeBrackets(),
        autocompletion({ activateOnTyping: true, closeOnBlur: false }),
        highlightSelectionMatches(),
        syntaxHighlighting(highlightStyle),
        editorTheme,
        indentUnit.of(" ".repeat(tabSize)),
        tabCompartment.current.of([]),
        wrapCompartment.current.of([]),
        readOnlyCompartment.current.of(
          readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
        ),
        dialectCompartment.current.of(
          sqlLanguage({ dialect: dialectFor(dbKind), upperCaseKeywords: true, schema: tables ? Object.fromEntries(tables.map((name) => [name, []])) : undefined }),
        ),
        keymap.of([
          {
            key: "Mod-Enter",
            preventDefault: true,
            run: () => {
              callbacks.current.onRun?.();
              return true;
            },
          },
          {
            key: "Mod-Shift-Enter",
            preventDefault: true,
            run: () => {
              callbacks.current.onRunSelection?.();
              return true;
            },
          },
          { key: "Mod-z", run: undo, preventDefault: true },
          { key: "Mod-y", run: redo, preventDefault: true },
          { key: "Mod-Shift-z", run: redo, preventDefault: true },
          indentWithTab,
          ...closeBracketsKeymap,
          ...defaultKeymap,
          ...searchKeymap,
          ...historyKeymap,
          ...completionKeymap,
        ]),
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            callbacks.current.onChange?.(update.state.doc.toString());
          }
        }),
      ],
    });

    const view = new EditorView({ state, parent: hostRef.current });
    viewRef.current = view;
    if (autoFocus) view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // Intentionally created once; everything configurable goes through a
    // compartment below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // -- reconfigure ---------------------------------------------------------
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const current = view.state.doc.toString();
    if (current !== value) {
      view.dispatch({
        changes: { from: 0, to: current.length, insert: value },
      });
    }
  }, [value]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: readOnlyCompartment.current.reconfigure(
        readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : [],
      ),
    });
  }, [readOnly]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: wrapCompartment.current.reconfigure(
        wordWrap ? EditorView.lineWrapping : [],
      ),
    });
  }, [wordWrap]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: gutterCompartment.current.reconfigure(
        lineNumbers ? lineNumbersExtension() : [],
      ),
    });
  }, [lineNumbers]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: tabCompartment.current.reconfigure(indentUnit.of(" ".repeat(tabSize))),
    });
  }, [tabSize]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: dialectCompartment.current.reconfigure(
        sqlLanguage({
          dialect: dialectFor(dbKind),
          upperCaseKeywords: true,
          schema: tables ? Object.fromEntries(tables.map((name) => [name, []])) : undefined,
        }),
      ),
    });
  }, [dbKind, tables]);

  return <div ref={hostRef} className={className} />;
}
