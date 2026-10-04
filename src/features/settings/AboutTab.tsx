/**
 * The About tab: what this build is, what it can talk to, and where it keeps
 * its files.
 *
 * `app_info` is fetched when the tab is first shown rather than by the dialog,
 * because the workspace directory can change between runs of the app and the
 * value is only ever displayed here.
 */

import * as React from "react";
import { toast } from "sonner";
import { Copy, FolderOpen } from "lucide-react";

import { Badge, Button, IconButton, Spinner } from "@/components/ui/primitives";
import ipc from "@/lib/ipc";
import { type AppInfo, toErrorPayload } from "@/lib/types";
import { SettingRow, SettingsGroup } from "./controls";

export function AboutTab(): React.ReactElement {
  const [info, setInfo] = React.useState<AppInfo | null>(null);
  const [error, setError] = React.useState<string | null>(null);

  React.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const value = await ipc.app.info();
        if (!cancelled) setInfo(value);
      } catch (cause) {
        if (!cancelled) setError(toErrorPayload(cause).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const copyWorkspace = async (path: string) => {
    try {
      await ipc.app.copyToClipboard(path);
      toast.success("Workspace path copied");
    } catch (cause) {
      toast.error("Could not copy the path", {
        description: toErrorPayload(cause).message,
      });
    }
  };

  const revealWorkspace = async () => {
    try {
      await ipc.app.revealWorkspace();
    } catch (cause) {
      toast.error("Could not open the workspace", {
        description: toErrorPayload(cause).message,
      });
    }
  };

  if (error) {
    return (
      <p className="rounded-md border border-danger/40 bg-danger-soft px-2.5 py-2 text-[11px] text-danger">
        Could not read the application info: {error}
      </p>
    );
  }

  if (!info) {
    return (
      <div className="flex items-center gap-2 text-xs text-muted">
        <Spinner />
        Reading application info…
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center gap-3">
        <div className="flex min-w-0 flex-col gap-0.5">
          <div className="flex items-center gap-2">
            <h3 className="text-sm font-semibold text-fg">{info.name}</h3>
            <Badge tone="accent">v{info.version}</Badge>
          </div>
          <p className="text-[11px] text-subtle">
            {info.platform} · {info.arch}
          </p>
        </div>
      </div>

      <SettingsGroup
        title="Engines"
        description="Drivers compiled into this build."
      >
        {info.engines.map((engine) => (
          <SettingRow
            key={engine.kind}
            label={engine.name}
            hint={
              engine.fileBased
                ? "File based — no server required."
                : engine.defaultPort
                  ? `Default port ${engine.defaultPort}.`
                  : "Network database."
            }
          >
            <Badge>{engine.kind}</Badge>
          </SettingRow>
        ))}
      </SettingsGroup>

      <SettingsGroup
        title="Workspace"
        description="Where OpenCat keeps settings, history and exported files."
      >
        <SettingRow label="Directory" stacked>
          <div className="flex min-w-0 items-center gap-1.5">
            <code className="min-w-0 flex-1 truncate rounded-sm bg-sunken px-2 py-1 font-mono text-[11px] text-muted">
              {info.workspaceDir}
            </code>
            <IconButton
              label="Copy workspace path"
              onClick={() => void copyWorkspace(info.workspaceDir)}
            >
              <Copy className="size-3.5" />
            </IconButton>
            <Button size="sm" variant="secondary" onClick={() => void revealWorkspace()}>
              <FolderOpen className="size-3.5" />
              Reveal workspace
            </Button>
          </div>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}
