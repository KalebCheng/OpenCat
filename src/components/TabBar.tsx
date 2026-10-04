import { FileCode2, Plus, Table2, Wrench, X } from "lucide-react";

import { IconButton } from "@/components/ui/primitives";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
  Tooltip,
} from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import { useConnections } from "@/store/connections";
import { useTabs, type TabKind, type WorkspaceTab } from "@/store/tabs";

const TAB_ICONS: Record<TabKind, typeof FileCode2> = {
  query: FileCode2,
  table: Table2,
  designer: Wrench,
};

/**
 * The document strip. Tabs are drag-free (mouse reordering across a horizontal
 * strip adds little on a desktop client) but support Ctrl+Tab and a context
 * menu for bulk closing.
 */
export function TabBar() {
  const tabs = useTabs((state) => state.tabs);
  const activeId = useTabs((state) => state.activeId);
  const activate = useTabs((state) => state.activate);
  const close = useTabs((state) => state.close);
  const closeOthers = useTabs((state) => state.closeOthers);
  const closeAll = useTabs((state) => state.closeAll);

  return (
    <div className="flex h-9 shrink-0 items-stretch border-b border-border bg-raised">
      <div className="flex min-w-0 flex-1 items-stretch overflow-x-auto scrollbar-thin">
        {tabs.map((tab) => (
          <TabStrip
            key={tab.id}
            tab={tab}
            active={tab.id === activeId}
            onActivate={() => activate(tab.id)}
            onClose={() => close(tab.id)}
            onCloseOthers={() => closeOthers(tab.id)}
            onCloseAll={closeAll}
          />
        ))}
      </div>

      <div className="flex items-center gap-1 border-l border-border px-1.5">
        <Tooltip content="New query tab" shortcut="Ctrl+T">
          <IconButton
            label="New query tab"
            size="icon-sm"
            variant="ghost"
            onClick={() => {
              const last = tabs[tabs.length - 1];
              if (!last) return;
              useTabs.getState().open({
                kind: "query",
                sessionId: last.sessionId,
                scope: last.scope,
              });
            }}
          >
            <Plus className="size-3.5" />
          </IconButton>
        </Tooltip>
        {tabs.length > 0 ? (
          <Tooltip content="Close all tabs">
            <IconButton
              label="Close all tabs"
              size="icon-sm"
              variant="ghost"
              onClick={closeAll}
            >
              <X className="size-3.5" />
            </IconButton>
          </Tooltip>
        ) : null}
      </div>
    </div>
  );
}

function TabStrip({
  tab,
  active,
  onActivate,
  onClose,
  onCloseOthers,
  onCloseAll,
}: {
  tab: WorkspaceTab;
  active: boolean;
  onActivate: () => void;
  onClose: () => void;
  onCloseOthers: () => void;
  onCloseAll: () => void;
}) {
  const session = useConnections((state) => state.sessions[tab.sessionId]);
  const Icon = TAB_ICONS[tab.kind];

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <button
          type="button"
          onMouseDown={(event) => {
            // Middle click closes, like a browser.
            if (event.button === 1) {
              event.preventDefault();
              onClose();
            }
          }}
          onClick={onActivate}
          title={`${tab.title} — ${session?.info.profileName ?? "disconnected"}`}
          className={cn(
            "group relative flex min-w-[7rem] max-w-[15rem] shrink-0 items-center gap-2 border-r border-border px-3 text-left",
            "transition-colors duration-100",
            active
              ? "bg-canvas text-fg"
              : "bg-raised text-muted hover:bg-hover hover:text-fg",
          )}
        >
          {active ? (
            <span className="absolute inset-x-0 top-0 h-0.5 bg-accent" aria-hidden />
          ) : null}
          <Icon
            className={cn("size-3.5 shrink-0", active ? "text-accent" : "text-subtle")}
          />
          <span className="min-w-0 flex-1 truncate text-xs">
            {tab.title}
            {tab.dirty ? <span className="ml-1 text-accent">•</span> : null}
          </span>
          <span
            role="button"
            tabIndex={-1}
            aria-label={`Close ${tab.title}`}
            onClick={(event) => {
              event.stopPropagation();
              onClose();
            }}
            className={cn(
              "grid size-4 shrink-0 place-content-center rounded-xs opacity-0 transition-opacity",
              "hover:bg-active group-hover:opacity-100",
              active && "opacity-70",
            )}
          >
            <X className="size-3" />
          </span>
        </button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onClose}>Close</ContextMenuItem>
        <ContextMenuItem onSelect={onCloseOthers}>Close others</ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem onSelect={onCloseAll}>Close all</ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
