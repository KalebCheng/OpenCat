/**
 * Object-explorer cache.
 *
 * The tree is lazy: nodes load their children the first time they are expanded
 * and are then cached by a stable path key. Refreshing a node drops its subtree
 * so stale objects never linger after DDL.
 */

import { create } from "zustand";

import ipc from "@/lib/ipc";
import {
  type DatabaseInfo,
  type ObjectRef,
  type Scope,
  type ScopeSummary,
  toErrorPayload,
} from "@/lib/types";

export interface ExplorerNode {
  /** Stable identity, e.g. `sess/db/schema`. */
  key: string;
  sessionId: string;
  scope: Scope;
  databases?: DatabaseInfo[];
  schemas?: string[];
  objects?: ObjectRef[];
  routines?: ObjectRef[];
  summary?: ScopeSummary;
  loading: boolean;
  error?: string;
  loadedAt?: number;
}

/** Cache older than this is refreshed in the background when re-expanded. */
export const CACHE_TTL_MS = 60_000;

export function databaseKey(sessionId: string): string {
  return `${sessionId}/databases`;
}

export function schemaKey(sessionId: string, database: string): string {
  return `${sessionId}/${database}/schemas`;
}

export function objectKey(sessionId: string, scope: Scope): string {
  const db = scope.database ?? "";
  const sch = scope.schema ?? "";
  return `${sessionId}/${db}/${sch}/objects`;
}

interface ExplorerState {
  nodes: Record<string, ExplorerNode>;
  expanded: Record<string, boolean>;

  isExpanded: (key: string) => boolean;
  toggle: (key: string) => void;
  expand: (key: string) => void;
  collapse: (key: string) => void;

  databases: (sessionId: string, force?: boolean) => Promise<DatabaseInfo[]>;
  schemas: (sessionId: string, database: string, force?: boolean) => Promise<string[]>;
  objects: (sessionId: string, scope: Scope, force?: boolean) => Promise<ObjectRef[]>;
  routines: (sessionId: string, scope: Scope, force?: boolean) => Promise<ObjectRef[]>;
  summary: (sessionId: string, scope: Scope, force?: boolean) => Promise<ScopeSummary | undefined>;

  /** Drop a node and everything under it. */
  invalidate: (prefix: string) => void;
  reset: () => void;
}

function fresh(node: ExplorerNode | undefined): boolean {
  return !!node?.loadedAt && Date.now() - node.loadedAt < CACHE_TTL_MS;
}

export const useExplorer = create<ExplorerState>((set, get) => {
  /** Shared loader: sets a loading flag, runs `load`, stores the patch. */
  async function load<T>(
    key: string,
    base: Pick<ExplorerNode, "sessionId" | "scope">,
    loader: () => Promise<T>,
    apply: (value: T) => Partial<ExplorerNode>,
  ): Promise<T> {
    set((state) => ({
      nodes: {
        ...state.nodes,
        [key]: {
          ...state.nodes[key],
          key,
          ...base,
          loading: true,
          error: undefined,
        },
      },
    }));
    try {
      const value = await loader();
      set((state) => ({
        nodes: {
          ...state.nodes,
          [key]: {
            ...state.nodes[key],
            key,
            ...base,
            ...apply(value),
            loading: false,
            error: undefined,
            loadedAt: Date.now(),
          },
        },
      }));
      return value;
    } catch (error) {
      const message = toErrorPayload(error).message;
      set((state) => ({
        nodes: {
          ...state.nodes,
          [key]: { ...state.nodes[key], key, ...base, loading: false, error: message },
        },
      }));
      throw error;
    }
  }

  return {
    nodes: {},
    expanded: {},

    isExpanded: (key) => !!get().expanded[key],
    toggle: (key) =>
      set((state) => ({ expanded: { ...state.expanded, [key]: !state.expanded[key] } })),
    expand: (key) => set((state) => ({ expanded: { ...state.expanded, [key]: true } })),
    collapse: (key) => set((state) => ({ expanded: { ...state.expanded, [key]: false } })),

    databases: async (sessionId, force) => {
      const key = databaseKey(sessionId);
      const cached = get().nodes[key];
      if (!force && cached?.databases && fresh(cached)) return cached.databases;
      return load(
        key,
        { sessionId, scope: {} },
        () => ipc.explorer.databases(sessionId),
        (databases) => ({ databases }),
      );
    },

    schemas: async (sessionId, database, force) => {
      const key = schemaKey(sessionId, database);
      const cached = get().nodes[key];
      if (!force && cached?.schemas && fresh(cached)) return cached.schemas;
      return load(
        key,
        { sessionId, scope: { database } },
        () => ipc.explorer.schemas(sessionId, database),
        (schemas) => ({ schemas }),
      );
    },

    objects: async (sessionId, scope, force) => {
      const key = objectKey(sessionId, scope);
      const cached = get().nodes[key];
      if (!force && cached?.objects && fresh(cached)) return cached.objects;
      return load(
        key,
        { sessionId, scope },
        () => ipc.explorer.objects(sessionId, scope),
        (objects) => ({ objects }),
      );
    },

    routines: async (sessionId, scope, force) => {
      const key = `${objectKey(sessionId, scope)}:routines`;
      const cached = get().nodes[key];
      if (!force && cached?.routines && fresh(cached)) return cached.routines;
      return load(
        key,
        { sessionId, scope },
        () => ipc.explorer.routines(sessionId, scope),
        (routines) => ({ routines }),
      );
    },

    summary: async (sessionId, scope, force) => {
      const key = `${objectKey(sessionId, scope)}:summary`;
      const cached = get().nodes[key];
      if (!force && cached?.summary && fresh(cached)) return cached.summary;
      return load(
        key,
        { sessionId, scope },
        () => ipc.explorer.summarise(sessionId, scope),
        (summary) => ({ summary }),
      ).catch(() => undefined);
    },

    invalidate: (prefix) =>
      set((state) => {
        const nodes = Object.fromEntries(
          Object.entries(state.nodes).filter(([key]) => !key.startsWith(prefix)),
        );
        return { nodes };
      }),

    reset: () => set({ nodes: {}, expanded: {} }),
  };
});
