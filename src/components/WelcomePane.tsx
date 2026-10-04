import { Database, FileCode2, FolderPlus, Plus, Settings, Sparkles } from "lucide-react";

import { Button } from "@/components/ui/primitives";
import { cn, connectionColor, formatTimestamp, initials } from "@/lib/utils";
import { describeConnection, engineLabel, useConnections } from "@/store/connections";
import { useTabs } from "@/store/tabs";

/**
 * The empty state shown when no document is open. It doubles as a launcher:
 * recent connections are one click away.
 */
export function WelcomePane({
  onNewConnection,
  onOpenSettings,
  message,
}: {
  onNewConnection: () => void;
  onOpenSettings: () => void;
  message?: string;
}) {
  const profiles = useConnections((state) => state.profiles);
  const open = useConnections((state) => state.open);
  const sessions = useConnections((state) => state.sessions);
  const openTabs = useTabsOpen();

  const recent = [...profiles]
    .sort((a, b) => (b.updatedAt ?? b.createdAt ?? "").localeCompare(a.updatedAt ?? a.createdAt ?? ""))
    .slice(0, 6);

  return (
    <div className="flex h-full items-center justify-center overflow-auto scrollbar-thin p-8">
      <div className="flex w-full max-w-2xl flex-col gap-8">
        <div className="flex flex-col items-center gap-3 text-center">
          <img src="/logo.png" alt="" className="size-16 rounded-2xl shadow-panel" draggable={false} />
          <div className="flex flex-col gap-1">
            <h1 className="text-lg font-semibold tracking-tight text-fg">
              {message ? "Connection closed" : "Welcome to OpenCat"}
            </h1>
            <p className="max-w-md text-xs leading-relaxed text-muted">
              {message ??
                "A modern database client for SQLite, MySQL/MariaDB and PostgreSQL. Open a connection to browse objects, run queries and edit data."}
            </p>
          </div>

          <div className="mt-1 flex items-center gap-2">
            <Button variant="primary" size="md" onClick={onNewConnection}>
              <Plus className="size-4" />
              New connection
            </Button>
            <Button size="md" onClick={onOpenSettings}>
              <Settings className="size-4" />
              Settings
            </Button>
          </div>
        </div>

        {recent.length > 0 ? (
          <section className="flex flex-col gap-2">
            <div className="flex items-center gap-2 px-1">
              <Sparkles className="size-3.5 text-accent" />
              <h2 className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
                Recent connections
              </h2>
            </div>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {recent.map((profile) => {
                const isOpen = Object.values(sessions).some(
                  (entry) => entry.info.profileId === profile.id,
                );
                return (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={async () => {
                      const info = await open(profile.id);
                      if (info) openTabs(info.sessionId, info.server.currentDatabase ?? null);
                    }}
                    className={cn(
                      "group flex items-center gap-3 rounded-lg border border-border bg-surface p-3 text-left",
                      "transition-colors duration-100 hover:border-accent/40 hover:bg-hover",
                    )}
                  >
                    <span
                      className="grid size-8 shrink-0 place-content-center rounded-md text-[11px] font-semibold text-white"
                      style={{ backgroundColor: connectionColor(profile) }}
                    >
                      {initials(profile.name)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="flex items-center gap-1.5">
                        <span className="truncate text-[13px] font-medium text-fg">
                          {profile.name}
                        </span>
                        {isOpen ? (
                          <span className="size-1.5 shrink-0 rounded-full bg-success" />
                        ) : null}
                      </span>
                      <span className="truncate text-[11px] text-subtle">
                        {engineLabel(profile.kind)} · {describeConnection(profile)}
                      </span>
                      <span className="text-[10px] text-subtle">
                        {formatTimestamp(profile.updatedAt ?? profile.createdAt ?? "")}
                      </span>
                    </span>
                  </button>
                );
              })}
            </div>
          </section>
        ) : (
          <section className="flex flex-col items-center gap-2 rounded-lg border border-dashed border-border p-6 text-center">
            <FolderPlus className="size-6 text-subtle" />
            <p className="text-xs text-muted">
              No saved connections yet. Create one to get started.
            </p>
          </section>
        )}

        <div className="flex items-center justify-center gap-4 text-[10px] text-subtle">
          <span className="flex items-center gap-1">
            <Database className="size-3" /> SQLite
          </span>
          <span className="flex items-center gap-1">
            <Database className="size-3" /> MySQL / MariaDB
          </span>
          <span className="flex items-center gap-1">
            <Database className="size-3" /> PostgreSQL
          </span>
          <span className="flex items-center gap-1">
            <FileCode2 className="size-3" /> SQL editor
          </span>
        </div>
      </div>
    </div>
  );
}

/** Open a query tab for a freshly connected session. */
function useTabsOpen() {
  return (sessionId: string, database: string | null) => {
    useTabs.getState().open({
      kind: "query",
      sessionId,
      scope: { database, schema: null },
    });
  };
}
