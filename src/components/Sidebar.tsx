/**
 * The left rail: saved connections, their live sessions and the object trees.
 */

import { useMemo, useState } from "react";
import {
  ChevronDown,
  Database,
  MoreHorizontal,
  Plug,
  PlugZap,
  Plus,
  RefreshCw,
  Search,
  Settings,
  Trash2,
  Unplug,
  Wrench,
} from "lucide-react";
import { toast } from "sonner";

import { ObjectTree } from "@/components/ObjectTree";
import { Badge, Button, IconButton, Input, StatusDot } from "@/components/ui/primitives";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  Tooltip,
  useConfirm,
} from "@/components/ui/overlays";
import ipc from "@/lib/ipc";
import type { ConnectionProfile } from "@/lib/types";
import { toErrorPayload } from "@/lib/types";
import { cn, connectionColor, initials } from "@/lib/utils";
import {
  describeConnection,
  engineLabel,
  serverSummary,
  useConnections,
} from "@/store/connections";
import { databaseKey, useExplorer } from "@/store/explorer";
import { useTabs } from "@/store/tabs";

export function Sidebar({
  onNewConnection,
  onOpenSettings,
}: {
  onNewConnection: () => void;
  onOpenSettings: () => void;
}) {
  const [filter, setFilter] = useState("");
  const profiles = useConnections((state) => state.profiles);
  const sessions = useConnections((state) => state.sessions);

  const { connected, disconnected } = useMemo(() => {
    const needle = filter.trim().toLowerCase();
    const matching = profiles.filter(
      (profile) =>
        !needle ||
        profile.name.toLowerCase().includes(needle) ||
        describeConnection(profile).toLowerCase().includes(needle),
    );
    const openIds = new Set(Object.values(sessions).map((entry) => entry.info.profileId));
    return {
      connected: matching.filter((profile) => openIds.has(profile.id)),
      disconnected: matching.filter((profile) => !openIds.has(profile.id)),
    };
  }, [profiles, filter, sessions]);

  return (
    <aside className="flex h-full min-h-0 flex-col border-r border-border bg-surface">
      <header className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
        <span className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">
          <Database className="size-3.5" />
          Explorer
        </span>
        <div className="flex-1" />
        <Tooltip content="New connection" shortcut="Ctrl+Shift+N">
          <IconButton label="New connection" size="icon-sm" variant="ghost" onClick={onNewConnection}>
            <Plus className="size-3.5" />
          </IconButton>
        </Tooltip>
        <Tooltip content="Settings">
          <IconButton label="Settings" size="icon-sm" variant="ghost" onClick={onOpenSettings}>
            <Settings className="size-3.5" />
          </IconButton>
        </Tooltip>
      </header>

      <div className="shrink-0 border-b border-border p-2">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-subtle" />
          <Input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter connections and objects"
            className="h-7 pl-7 text-xs"
          />
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin">
        {profiles.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-8 text-center">
            <Plug className="size-6 text-subtle" />
            <p className="text-[11px] leading-relaxed text-muted">
              No saved connections yet.
            </p>
            <Button variant="primary" size="sm" onClick={onNewConnection}>
              <Plus className="size-3.5" />
              New connection
            </Button>
          </div>
        ) : (
          <>
            {connected.length > 0 ? (
              <Section title="Connected" count={connected.length}>
                {connected.map((profile) => (
                  <ConnectedNode key={profile.id} profile={profile} filter={filter} />
                ))}
              </Section>
            ) : null}

            {disconnected.length > 0 ? (
              <Section title="Saved" count={disconnected.length}>
                {disconnected.map((profile) => (
                  <SavedNode key={profile.id} profile={profile} />
                ))}
              </Section>
            ) : null}

            {connected.length === 0 && disconnected.length === 0 ? (
              <p className="px-3 py-6 text-center text-[11px] text-subtle">
                Nothing matches “{filter}”.
              </p>
            ) : null}
          </>
        )}
      </div>
    </aside>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section className="py-1">
      <header className="flex items-center gap-1.5 px-3 py-1">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">
          {title}
        </span>
        <span className="text-[10px] text-subtle tnum">{count}</span>
      </header>
      {children}
    </section>
  );
}

/** A profile with a live session: shows the object tree underneath. */
function ConnectedNode({ profile, filter }: { profile: ConnectionProfile; filter: string }) {
  const session = useConnections((state) =>
    Object.values(state.sessions).find((entry) => entry.info.profileId === profile.id),
  );
  const closeProfile = useConnections((state) => state.closeProfile);
  const [expanded, setExpanded] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const newQuery = useTabs((state) => state.open);

  if (!session) return null;

  const sessionId = session.info.sessionId;
  const healthy = session.status === "open";

  return (
    <div className="flex flex-col">
      <div
        className={cn(
          "group flex h-7 items-center gap-1.5 px-2",
          "hover:bg-hover",
        )}
      >
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="grid size-4 shrink-0 place-content-center rounded-xs text-subtle hover:bg-active hover:text-fg"
          aria-label={expanded ? "Collapse" : "Expand"}
        >
          <ChevronDown
            className={cn("size-3 transition-transform duration-100", !expanded && "-rotate-90")}
          />
        </button>

        <span
          className="grid size-5 shrink-0 place-content-center rounded text-[9px] font-bold text-white"
          style={{ backgroundColor: connectionColor(profile) }}
        >
          {initials(profile.name)}
        </span>

        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex min-w-0 flex-1 flex-col items-start text-left"
          title={serverSummary(session.info.server)}
        >
          <span className="flex w-full items-center gap-1.5">
            <span className="truncate text-[12px] font-medium text-fg">{profile.name}</span>
            <StatusDot tone={healthy ? "success" : "danger"} />
          </span>
          <span className="w-full truncate text-[10px] text-subtle">
            {engineLabel(profile.kind)} · {session.info.server.currentDatabase ?? describeConnection(profile)}
          </span>
        </button>

        <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
          <Tooltip content="Refresh">
            <IconButton
              label="Refresh"
              size="icon-sm"
              variant="ghost"
              className="size-5"
              loading={refreshing}
              onClick={async () => {
                setRefreshing(true);
                useExplorer.getState().invalidate(databaseKey(sessionId));
                try {
                  await useExplorer.getState().databases(sessionId, true);
                } catch (error) {
                  toast.error(toErrorPayload(error).message);
                } finally {
                  setRefreshing(false);
                }
              }}
            >
              <RefreshCw className="size-3" />
            </IconButton>
          </Tooltip>
          <Tooltip content="Disconnect">
            <IconButton
              label="Disconnect"
              size="icon-sm"
              variant="ghost"
              className="size-5"
              onClick={() => void closeProfile(profile.id)}
            >
              <Unplug className="size-3" />
            </IconButton>
          </Tooltip>
        </div>
      </div>

      {expanded ? (
        <div className="pb-1">
          <ObjectTree sessionId={sessionId} dbKind={session.info.kind} filter={filter} />
          <button
            type="button"
            onClick={() =>
              newQuery({
                kind: "query",
                sessionId,
                scope: { database: session.info.server.currentDatabase ?? null, schema: null },
              })
            }
            className="mx-2 mt-1 flex items-center gap-1.5 rounded-sm px-2 py-1 text-[11px] text-muted hover:bg-hover hover:text-fg"
          >
            <Plus className="size-3" />
            New query
          </button>
        </div>
      ) : null}
    </div>
  );
}

/** A saved profile that is not currently connected. */
function SavedNode({ profile }: { profile: ConnectionProfile }) {
  const open = useConnections((state) => state.open);
  const remove = useConnections((state) => state.remove);
  const [busy, setBusy] = useState(false);
  const confirm = useConfirm();

  const connect = async () => {
    setBusy(true);
    try {
      const info = await open(profile.id);
      if (!info) {
        const message = useConnections.getState().error ?? "could not connect";
        toast.error(message);
        return;
      }
      const sessionId = info.sessionId;
      useTabs.getState().open({
        kind: "query",
        sessionId,
        scope: { database: info.server.currentDatabase ?? null, schema: null },
      });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="group flex h-7 items-center gap-1.5 px-2 hover:bg-hover">
      <span className="w-4 shrink-0" />
      <span
        className="grid size-5 shrink-0 place-content-center rounded text-[9px] font-bold text-white opacity-70"
        style={{ backgroundColor: connectionColor(profile) }}
      >
        {initials(profile.name)}
      </span>

      <button
        type="button"
        onDoubleClick={connect}
        onClick={connect}
        disabled={busy}
        className="flex min-w-0 flex-1 flex-col items-start text-left disabled:opacity-60"
        title={`${engineLabel(profile.kind)} · ${describeConnection(profile)}`}
      >
        <span className="w-full truncate text-[12px] text-fg">{profile.name}</span>
        <span className="w-full truncate text-[10px] text-subtle">
          {engineLabel(profile.kind)} · {describeConnection(profile)}
        </span>
      </button>

      {profile.readOnly ? <Badge tone="warning">RO</Badge> : null}

      <div className="flex shrink-0 items-center opacity-0 transition-opacity group-hover:opacity-100 focus-within:opacity-100">
        <Tooltip content="Connect">
          <IconButton
            label="Connect"
            size="icon-sm"
            variant="ghost"
            className="size-5"
            loading={busy}
            onClick={connect}
          >
            <PlugZap className="size-3" />
          </IconButton>
        </Tooltip>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <IconButton label="Connection actions" size="icon-sm" variant="ghost" className="size-5">
              <MoreHorizontal className="size-3" />
            </IconButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start">
            <DropdownMenuLabel>{profile.name}</DropdownMenuLabel>
            <DropdownMenuItem onSelect={connect}>
              <Plug /> Connect
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={async () => {
                try {
                  const server = await ipc.connections.validate(profile);
                  toast.success(`Reachable — ${serverSummary(server)}`);
                } catch (error) {
                  toast.error(toErrorPayload(error).message);
                }
              }}
            >
              <Wrench /> Test connection
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              danger
              onSelect={async () => {
                const ok = await confirm({
                  title: `Delete ${profile.name}?`,
                  description: "The saved profile and its stored password will be removed.",
                  confirmLabel: "Delete",
                  tone: "danger",
                });
                if (ok) {
                  await remove(profile.id);
                  toast.success("Connection deleted");
                }
              }}
            >
              <Trash2 /> Delete
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
