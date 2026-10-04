/**
 * Saved connection profiles and the live sessions opened from them.
 *
 * The backend owns the sockets; this store owns only what the UI needs to know
 * about them, and mirrors every mutation so the sidebar never has to refetch.
 */

import { create } from "zustand";

import ipc from "@/lib/ipc";
import {
  type ConnectionProfile,
  type DbKind,
  type ServerInfo,
  type SessionInfo,
  blankProfile,
  toErrorPayload,
} from "@/lib/types";

export type SessionStatus = "opening" | "open" | "error";

export interface SessionEntry {
  info: SessionInfo;
  status: SessionStatus;
  error?: string;
  /** Round-trip latency of the last ping, in milliseconds. */
  latencyMs?: number;
}

interface ConnectionsState {
  profiles: ConnectionProfile[];
  sessions: Record<string, SessionEntry>;
  /** `profileId` values with an `open_connection` call in flight. */
  opening: Record<string, true>;
  loaded: boolean;
  error: string | null;

  load: () => Promise<void>;
  save: (profile: ConnectionProfile) => Promise<ConnectionProfile>;
  remove: (id: string) => Promise<void>;
  duplicate: (id: string, name?: string) => Promise<ConnectionProfile>;
  open: (profileId: string, database?: string) => Promise<SessionInfo | null>;
  close: (sessionId: string) => Promise<void>;
  closeProfile: (profileId: string) => Promise<void>;
  ping: (sessionId: string) => Promise<void>;

  /** Existing session for a profile, if one is open. */
  sessionForProfile: (profileId: string) => SessionEntry | undefined;
  byId: (id: string) => ConnectionProfile | undefined;
}

export const useConnections = create<ConnectionsState>((set, get) => ({
  profiles: [],
  sessions: {},
  opening: {},
  loaded: false,
  error: null,

  load: async () => {
    try {
      const [profiles, sessions] = await Promise.all([
        ipc.connections.list(),
        ipc.connections.sessions(),
      ]);
      const map: Record<string, SessionEntry> = {};
      for (const info of sessions) {
        map[info.sessionId] = { info, status: "open" };
      }
      set({ profiles, sessions: map, loaded: true, error: null });
    } catch (error) {
      set({ loaded: true, error: toErrorPayload(error).message });
    }
  },

  save: async (profile) => {
    const stored = await ipc.connections.save(profile);
    set((state) => {
      const index = state.profiles.findIndex((p) => p.id === stored.id);
      const profiles =
        index === -1
          ? [...state.profiles, stored]
          : state.profiles.map((p) => (p.id === stored.id ? stored : p));
      return { profiles };
    });
    return stored;
  },

  remove: async (id) => {
    await ipc.connections.remove(id);
    set((state) => ({
      profiles: state.profiles.filter((p) => p.id !== id),
      sessions: Object.fromEntries(
        Object.entries(state.sessions).filter(([, entry]) => entry.info.profileId !== id),
      ),
    }));
  },

  duplicate: async (id, name) => {
    const copy = await ipc.connections.duplicate(id, name);
    set((state) => ({ profiles: [...state.profiles, copy] }));
    return copy;
  },

  open: async (profileId, database) => {
    // Reuse an open session instead of stacking connections to the same server.
    const existing = get().sessionForProfile(profileId);
    if (existing && existing.status === "open") {
      return existing.info;
    }

    set((state) => ({ opening: { ...state.opening, [profileId]: true } }));
    try {
      const info = await ipc.connections.open(profileId, database);
      set((state) => ({
        sessions: { ...state.sessions, [info.sessionId]: { info, status: "open" } },
        error: null,
      }));
      return info;
    } catch (error) {
      const payload = toErrorPayload(error);
      set({ error: payload.message });
      return null;
    } finally {
      set((state) => {
        const next = { ...state.opening };
        delete next[profileId];
        return { opening: next };
      });
    }
  },

  close: async (sessionId) => {
    try {
      await ipc.connections.close(sessionId);
    } finally {
      set((state) => {
        const sessions = { ...state.sessions };
        delete sessions[sessionId];
        return { sessions };
      });
    }
  },

  closeProfile: async (profileId) => {
    const entry = get().sessionForProfile(profileId);
    if (entry) await get().close(entry.info.sessionId);
  },

  ping: async (sessionId) => {
    try {
      const latencyMs = await ipc.connections.ping(sessionId);
      set((state) => {
        const entry = state.sessions[sessionId];
        if (!entry) return state;
        return {
          sessions: { ...state.sessions, [sessionId]: { ...entry, latencyMs, status: "open" } },
        };
      });
    } catch (error) {
      set((state) => {
        const entry = state.sessions[sessionId];
        if (!entry) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: { ...entry, status: "error", error: toErrorPayload(error).message },
          },
        };
      });
    }
  },

  sessionForProfile: (profileId) =>
    Object.values(get().sessions).find((entry) => entry.info.profileId === profileId),

  byId: (id) => get().profiles.find((p) => p.id === id),
}));

// -- helpers used by dialogs -------------------------------------------------

/** A brand new profile pre-filled for the given engine. */
export function newProfile(kind: DbKind): ConnectionProfile {
  const profile = blankProfile(kind);
  profile.name = defaultNameFor(kind);
  return profile;
}

function defaultNameFor(kind: DbKind): string {
  switch (kind) {
    case "sqlite":
      return "New SQLite Database";
    case "mysql":
      return "New MySQL Connection";
    case "postgres":
      return "New PostgreSQL Connection";
  }
}

/** Human summary shown under a connection in the sidebar. */
export function describeConnection(profile: ConnectionProfile): string {
  if (profile.kind === "sqlite") {
    return profile.file ?? "no file selected";
  }
  const user = profile.username ? `${profile.username}@` : "";
  const db = profile.database ? `/${profile.database}` : "";
  return `${user}${profile.host}:${profile.port}${db}`;
}

/** Short engine label for badges. */
export function engineLabel(kind: DbKind): string {
  return kind === "sqlite" ? "SQLite" : kind === "mysql" ? "MySQL" : "PostgreSQL";
}

/** Merge a probe result into a readable one-liner. */
export function serverSummary(info: ServerInfo): string {
  const parts = [info.version];
  if (info.currentUser) parts.push(`user ${info.currentUser}`);
  if (info.currentDatabase) parts.push(`db ${info.currentDatabase}`);
  return parts.filter(Boolean).join(" · ");
}
