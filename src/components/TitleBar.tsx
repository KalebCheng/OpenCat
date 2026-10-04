import { useEffect, useState } from "react";
import {
  Command,
  Database,
  FileText,
  HelpCircle,
  Loader2,
  Play,
  Plus,
  Settings,
  Sparkles,
  Table2,
} from "lucide-react";

import { Button, IconButton } from "@/components/ui/primitives";
import { Tooltip } from "@/components/ui/overlays";
import ipc from "@/lib/ipc";
import type { AppInfo } from "@/lib/types";
import { useConnections } from "@/store/connections";
import { useTabs } from "@/store/tabs";

/**
 * The strip above the workspace: product mark on the left, the actions a user
 * reaches for most often, and the app version on the right.
 */
export function TitleBar({
  onNewConnection,
  onOpenSettings,
}: {
  onNewConnection: () => void;
  onOpenSettings: () => void;
}) {
  const [info, setInfo] = useState<AppInfo | null>(null);
  const sessions = useConnections((state) => state.sessions);
  const open = useTabs((state) => state.open);

  useEffect(() => {
    ipc.app.info().then(setInfo).catch(() => setInfo(null));
  }, []);

  const firstSession = Object.values(sessions)[0];

  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border bg-raised px-3">
      <div className="flex items-center gap-2">
        <img src="/logo.png" alt="" className="size-6 rounded-md" draggable={false} />
        <div className="flex flex-col leading-none">
          <span className="text-[13px] font-semibold tracking-tight text-fg">OpenCat</span>
          <span className="text-[10px] text-subtle">
            {info ? `v${info.version}` : "database client"}
          </span>
        </div>
      </div>

      <div className="mx-2 h-5 w-px bg-border" />

      <Tooltip content="New connection" shortcut="Ctrl+Shift+N">
        <Button variant="ghost" size="sm" onClick={onNewConnection}>
          <Plus className="size-3.5" />
          Connection
        </Button>
      </Tooltip>

      <Tooltip content="New query tab" shortcut="Ctrl+N">
        <Button
          variant="ghost"
          size="sm"
          disabled={!firstSession}
          onClick={() => {
            if (!firstSession) return;
            open({
              kind: "query",
              sessionId: firstSession.info.sessionId,
              scope: {
                database: firstSession.info.server.currentDatabase ?? null,
                schema: null,
              },
            });
          }}
        >
          <FileText className="size-3.5" />
          Query
        </Button>
      </Tooltip>

      <Tooltip content="Open a table">
        <Button
          variant="ghost"
          size="sm"
          disabled={!firstSession}
          onClick={() => {
            if (!firstSession) return;
            open({
              kind: "table",
              sessionId: firstSession.info.sessionId,
              scope: { database: firstSession.info.server.currentDatabase ?? null },
              table: undefined,
            });
          }}
        >
          <Table2 className="size-3.5" />
          Table
        </Button>
      </Tooltip>

      <div className="flex-1" />

      {Object.keys(sessions).length > 0 ? (
        <span className="mr-1 flex items-center gap-1.5 text-[11px] text-muted">
          <Database className="size-3.5 text-success" />
          {Object.keys(sessions).length} connected
        </span>
      ) : (
        <span className="mr-1 flex items-center gap-1.5 text-[11px] text-subtle">
          <Loader2 className="size-3.5" />
          no connections
        </span>
      )}

      <Tooltip content="Keyboard shortcuts">
        <IconButton label="Keyboard shortcuts" variant="ghost">
          <Command className="size-4" />
        </IconButton>
      </Tooltip>
      <Tooltip content="Documentation">
        <IconButton
          label="Documentation"
          variant="ghost"
          onClick={() => {
            void ipc.app.revealWorkspace().catch(() => undefined);
          }}
        >
          <HelpCircle className="size-4" />
        </IconButton>
      </Tooltip>
      <Tooltip content="Settings" shortcut="Ctrl+,">
        <IconButton label="Settings" variant="ghost" onClick={onOpenSettings}>
          <Settings className="size-4" />
        </IconButton>
      </Tooltip>
      <span className="ml-1 hidden items-center gap-1 text-[10px] text-subtle xl:flex">
        <Sparkles className="size-3" />
        {info?.platform ?? ""}
      </span>
    </header>
  );
}

/** A tiny SQL bolt used by the query tab icon. */
export function QueryGlyph() {
  return <Play className="size-3.5" />;
}
