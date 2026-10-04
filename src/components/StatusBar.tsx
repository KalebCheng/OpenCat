import { useEffect, useState } from "react";
import { CircleDot, FolderOpen, HardDrive, Zap } from "lucide-react";

import { StatusDot } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlays";
import ipc from "@/lib/ipc";
import { cn, formatBytes } from "@/lib/utils";
import { useConnections } from "@/store/connections";
import { useTabs } from "@/store/tabs";

/** The bottom strip: connection health, current scope, workspace location. */
export function StatusBar({ sessionCount }: { sessionCount: number }) {
  const sessions = useConnections((state) => state.sessions);
  const profiles = useConnections((state) => state.profiles);
  const tabs = useTabs((state) => state.tabs);
  const activeId = useTabs((state) => state.activeId);
  const [workspace, setWorkspace] = useState<string>("");

  useEffect(() => {
    ipc.app
      .info()
      .then((info) => setWorkspace(info.workspaceDir))
      .catch(() => setWorkspace(""));
  }, []);

  const active = tabs.find((tab) => tab.id === activeId);
  const session = active ? sessions[active.sessionId] : undefined;
  const profile = session
    ? profiles.find((p) => p.id === session.info.profileId)
    : undefined;

  const errorCount = Object.values(sessions).filter((s) => s.status === "error").length;

  return (
    <footer className="flex h-6 shrink-0 items-center gap-3 border-t border-border bg-raised px-3 text-[11px] text-muted">
      <span className="flex items-center gap-1.5">
        <StatusDot
          tone={errorCount > 0 ? "danger" : sessionCount > 0 ? "success" : "neutral"}
          pulse={sessionCount > 0 && errorCount === 0}
        />
        {sessionCount === 0 ? "No connections" : `${sessionCount} open`}
      </span>

      {session ? (
        <>
          <span className="h-3 w-px bg-border" />
          <span className="flex min-w-0 items-center gap-1.5">
            <Zap className="size-3 text-accent" />
            <span className="max-w-[18rem] truncate">
              {session.info.profileName}
              {profile?.database ? ` · ${profile.database}` : ""}
            </span>
          </span>
          {session.latencyMs !== undefined ? (
            <span className="tnum text-subtle">{session.latencyMs.toFixed(0)} ms</span>
          ) : null}
          {session.info.server.version ? (
            <Tooltip content={session.info.server.version}>
              <span className="max-w-[22rem] truncate text-subtle">
                {session.info.server.version}
              </span>
            </Tooltip>
          ) : null}
        </>
      ) : null}

      {active ? (
        <>
          <span className="h-3 w-px bg-border" />
          <span className="flex items-center gap-1.5">
            <CircleDot className="size-3" />
            <span className="max-w-[20rem] truncate">
              {[active.scope.database, active.scope.schema].filter(Boolean).join(" / ") ||
                "default scope"}
              {active.table ? ` · ${active.table}` : ""}
            </span>
          </span>
        </>
      ) : null}

      <span className="flex-1" />

      {tabs.length > 0 ? (
        <span className="text-subtle">
          {tabs.length} tab{tabs.length === 1 ? "" : "s"}
        </span>
      ) : null}

      <Tooltip content={workspace || "workspace directory unknown"}>
        <button
          type="button"
          onClick={() => void ipc.app.revealWorkspace().catch(() => undefined)}
          className={cn(
            "flex max-w-[26rem] items-center gap-1.5 truncate",
            "hover:text-fg",
          )}
        >
          <FolderOpen className="size-3" />
          <span className="truncate">{workspace || "workspace"}</span>
        </button>
      </Tooltip>

      <span className="h-3 w-px bg-border" />
      <Tooltip content="OpenCat stores everything locally; nothing leaves this machine.">
        <span className="flex items-center gap-1 text-subtle">
          <HardDrive className="size-3" />
          local
        </span>
      </Tooltip>
    </footer>
  );
}

/** Exported so other panels can render a byte count consistently. */
export { formatBytes };
