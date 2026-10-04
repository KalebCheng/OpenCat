/**
 * Open workspace tabs.
 *
 * A tab is either a SQL editor, a data-grid view of a relation, or a table
 * designer. Tabs carry the session and scope they were opened against so a
 * background refresh never has to guess which server they belong to.
 */

import { create } from "zustand";

import type { ObjectKind, Scope } from "@/lib/types";

export type TabKind = "query" | "table" | "designer";

export interface WorkspaceTab {
  id: string;
  kind: TabKind;
  title: string;
  sessionId: string;
  scope: Scope;
  /** Relation name, for `table` and `designer` tabs. */
  table?: string;
  objectKind?: ObjectKind;
  /** Editor contents, for `query` tabs. */
  sql?: string;
  /** Backing file when the editor was loaded from disk. */
  filePath?: string;
  dirty?: boolean;
  /** Set when the tab failed to initialise. */
  error?: string;
}

export interface OpenTabInput {
  kind: TabKind;
  sessionId: string;
  scope: Scope;
  title?: string;
  table?: string;
  objectKind?: ObjectKind;
  sql?: string;
  filePath?: string;
}

interface TabsState {
  tabs: WorkspaceTab[];
  activeId: string | null;

  open: (input: OpenTabInput) => string;
  /** Focus a tab, creating it when it is not open yet. */
  openOrFocus: (input: OpenTabInput) => string;
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  closeForSession: (sessionId: string) => void;
  closeAll: () => void;
  activate: (id: string) => void;
  update: (id: string, patch: Partial<WorkspaceTab>) => void;
  move: (id: string, delta: number) => void;
  active: () => WorkspaceTab | undefined;
}

let counter = 0;
const nextId = () => `tab-${Date.now().toString(36)}-${(counter += 1)}`;

/** Identity of a tab, used to avoid duplicates. */
function sameTab(tab: WorkspaceTab, input: OpenTabInput): boolean {
  if (tab.kind !== input.kind || tab.sessionId !== input.sessionId) return false;
  if (tab.kind === "query") return false; // every editor tab is its own document
  return (
    tab.table === input.table &&
    (tab.scope.database ?? null) === (input.scope.database ?? null) &&
    (tab.scope.schema ?? null) === (input.scope.schema ?? null)
  );
}

function defaultTitle(input: OpenTabInput): string {
  switch (input.kind) {
    case "query":
      return "Query";
    case "table":
      return input.table ?? "Table";
    case "designer":
      return `${input.table ?? "Table"} (design)`;
  }
}

export const useTabs = create<TabsState>((set, get) => ({
  tabs: [],
  activeId: null,

  open: (input) => {
    const tab: WorkspaceTab = {
      id: nextId(),
      kind: input.kind,
      title: input.title ?? defaultTitle(input),
      sessionId: input.sessionId,
      scope: input.scope,
      table: input.table,
      objectKind: input.objectKind,
      sql: input.sql ?? (input.kind === "query" ? "" : undefined),
      filePath: input.filePath,
      dirty: false,
    };
    set((state) => ({ tabs: [...state.tabs, tab], activeId: tab.id }));
    return tab.id;
  },

  openOrFocus: (input) => {
    const existing = get().tabs.find((tab) => sameTab(tab, input));
    if (existing) {
      set({ activeId: existing.id });
      return existing.id;
    }
    return get().open(input);
  },

  close: (id) => {
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id);
      if (index === -1) return state;
      const tabs = state.tabs.filter((tab) => tab.id !== id);

      let activeId = state.activeId;
      if (activeId === id) {
        // Prefer the tab on the left, matching browser behaviour.
        activeId = tabs[index - 1]?.id ?? tabs[index]?.id ?? null;
      }
      return { tabs, activeId };
    });
  },

  closeOthers: (id) => {
    set((state) => ({
      tabs: state.tabs.filter((tab) => tab.id === id),
      activeId: id,
    }));
  },

  closeForSession: (sessionId) => {
    set((state) => {
      const tabs = state.tabs.filter((tab) => tab.sessionId !== sessionId);
      const activeStillOpen = tabs.some((tab) => tab.id === state.activeId);
      return {
        tabs,
        activeId: activeStillOpen ? state.activeId : (tabs[0]?.id ?? null),
      };
    });
  },

  closeAll: () => set({ tabs: [], activeId: null }),

  activate: (id) => set({ activeId: id }),

  update: (id, patch) =>
    set((state) => ({
      tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, ...patch } : tab)),
    })),

  move: (id, delta) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id);
      const target = index + delta;
      if (index === -1 || target < 0 || target >= state.tabs.length) return state;
      const tabs = [...state.tabs];
      const [moved] = tabs.splice(index, 1);
      tabs.splice(target, 0, moved);
      return { tabs };
    }),

  active: () => get().tabs.find((tab) => tab.id === get().activeId),
}));
