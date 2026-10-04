/**
 * The OpenCat window: title bar, object explorer, tab strip, status bar.
 *
 * This file owns layout and keyboard shortcuts only. Everything with real
 * behaviour lives in `src/features/*` and is mounted by the active tab.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Toaster } from "sonner";
import { Database } from "lucide-react";

import { ConfirmProvider, PromptProvider, TooltipProvider } from "@/components/ui/overlays";
import { ResizableHandle } from "@/components/ResizableHandle";
import { Sidebar } from "@/components/Sidebar";
import { StatusBar } from "@/components/StatusBar";
import { TabBar } from "@/components/TabBar";
import { TitleBar } from "@/components/TitleBar";
import { WelcomePane } from "@/components/WelcomePane";
import { ConnectionDialog } from "@/features/connections/ConnectionDialog";
import { QueryEditor } from "@/features/editor/QueryEditor";
import { DataGrid } from "@/features/grid";
import { TableDesigner } from "@/features/designer";
import { ExportDialog } from "@/features/transfer";
import { SettingsDialog } from "@/features/settings";
import type { DbKind, Scope } from "@/lib/types";
import { useConnections } from "@/store/connections";
import { objectKey, useExplorer } from "@/store/explorer";
import { applyTheme, useSettings, watchSystemTheme } from "@/store/settings";
import { useTabs, type WorkspaceTab } from "@/store/tabs";

/** Which modal the shell is currently showing, if any. */
type ShellDialog = "connection" | "settings" | null;

/** Everything the export dialog needs to describe the current result set. */
export interface ExportTarget {
  sessionId: string;
  scope: Scope;
  dbKind: DbKind;
  table?: string;
  sql?: string;
  columns: string[];
}

function AppShell() {
  const loadedSettings = useSettings((state) => state.loaded);
  const loadSettings = useSettings((state) => state.load);
  const loadConnections = useConnections((state) => state.load);
  const sessionCount = useConnections((state) => Object.keys(state.sessions).length);

  const tabs = useTabs((state) => state.tabs);
  const activeId = useTabs((state) => state.activeId);
  const activate = useTabs((state) => state.activate);
  const closeTab = useTabs((state) => state.close);

  const [dialog, setDialog] = useState<ShellDialog>(null);
  const [sidebarWidth, setSidebarWidth] = useState(276);
  const [exportTarget, setExportTarget] = useState<ExportTarget | null>(null);

  const activeTab = useMemo(
    () => tabs.find((tab) => tab.id === activeId) ?? tabs[0],
    [tabs, activeId],
  );

  // -- boot -----------------------------------------------------------------
  useEffect(() => {
    void loadSettings();
    void loadConnections();
    return watchSystemTheme();
  }, [loadSettings, loadConnections]);

  // Re-apply the theme once settings arrive, in case the pre-paint script
  // guessed differently (the OS theme may have changed while we were closed).
  useEffect(() => {
    if (loadedSettings) applyTheme(useSettings.getState().settings.theme);
  }, [loadedSettings]);

  const openConnectionDialog = useCallback(() => setDialog("connection"), []);
  const openSettings = useCallback(() => setDialog("settings"), []);

  /** Drop the cached children of a scope so DDL is reflected immediately. */
  const invalidateScope = useCallback((sessionId: string, scope: Scope) => {
    useExplorer.getState().invalidate(objectKey(sessionId, scope));
  }, []);

  // -- keyboard shortcuts ---------------------------------------------------
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;

      switch (event.key.toLowerCase()) {
        case "n":
          event.preventDefault();
          if (event.shiftKey) {
            setDialog("connection");
          } else if (activeTab?.sessionId) {
            useTabs.getState().open({
              kind: "query",
              sessionId: activeTab.sessionId,
              scope: activeTab.scope,
            });
          }
          break;
        case "w":
          if (activeTab) {
            event.preventDefault();
            closeTab(activeTab.id);
          }
          break;
        case "t":
          if (activeTab?.sessionId) {
            event.preventDefault();
            useTabs.getState().open({
              kind: "query",
              sessionId: activeTab.sessionId,
              scope: activeTab.scope,
            });
          }
          break;
        case ",":
          event.preventDefault();
          setDialog("settings");
          break;
        case "tab":
          if (tabs.length > 1) {
            event.preventDefault();
            const index = tabs.findIndex((tab) => tab.id === activeTab?.id);
            const delta = event.shiftKey ? -1 : 1;
            const next = tabs[(index + delta + tabs.length) % tabs.length];
            if (next) activate(next.id);
          }
          break;
        default:
          break;
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [activeTab, tabs, activate, closeTab]);

  // Warn before the window closes while editors hold unsaved text.
  useEffect(() => {
    if (!tabs.some((tab) => tab.kind === "query" && tab.dirty)) return;
    const handler = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [tabs]);

  return (
    <div className="flex h-full flex-col overflow-hidden bg-canvas text-fg">
      <TitleBar onNewConnection={openConnectionDialog} onOpenSettings={openSettings} />

      <div className="flex min-h-0 flex-1">
        <div style={{ width: sidebarWidth }} className="min-w-0 shrink-0">
          <Sidebar
            onNewConnection={openConnectionDialog}
            onOpenSettings={openSettings}
          />
        </div>
        <ResizableHandle
          onResize={(delta) =>
            setSidebarWidth((width) => Math.min(520, Math.max(200, width + delta)))
          }
        />

        <main className="flex min-w-0 flex-1 flex-col">
          <TabBar />
          <div className="min-h-0 flex-1 bg-canvas">
            {activeTab ? (
              <TabContent
                tab={activeTab}
                onExport={setExportTarget}
                onRequestConnection={openConnectionDialog}
                onInvalidate={invalidateScope}
              />
            ) : (
              <WelcomePane
                onNewConnection={openConnectionDialog}
                onOpenSettings={openSettings}
              />
            )}
          </div>
        </main>
      </div>

      <StatusBar sessionCount={sessionCount} />

      <ConnectionDialog
        open={dialog === "connection"}
        onOpenChange={(open) => setDialog(open ? "connection" : null)}
      />
      <SettingsDialog
        open={dialog === "settings"}
        onOpenChange={(open) => setDialog(open ? "settings" : null)}
      />
      {exportTarget ? (
        <ExportDialog
          open
          onOpenChange={(open) => {
            if (!open) setExportTarget(null);
          }}
          sessionId={exportTarget.sessionId}
          scope={exportTarget.scope}
          dbKind={exportTarget.dbKind}
          table={exportTarget.table}
          sql={exportTarget.sql}
          columns={exportTarget.columns}
        />
      ) : null}
    </div>
  );
}

/** Mount the feature component that matches the active tab. */
function TabContent({
  tab,
  onExport,
  onRequestConnection,
  onInvalidate,
}: {
  tab: WorkspaceTab;
  onExport: (target: ExportTarget) => void;
  onRequestConnection: () => void;
  onInvalidate: (sessionId: string, scope: Scope) => void;
}) {
  const session = useConnections((state) => state.sessions[tab.sessionId]);

  if (!tab.sessionId || !session) {
    return (
      <WelcomePane
        onNewConnection={onRequestConnection}
        onOpenSettings={() => undefined}
        message="This tab's connection was closed. Reopen it from the sidebar to continue."
      />
    );
  }

  switch (tab.kind) {
    case "query":
      return (
        <QueryEditor
          tabId={tab.id}
          sessionId={tab.sessionId}
          scope={tab.scope}
          dbKind={session.info.kind}
          initialSql={tab.sql ?? ""}
          filePath={tab.filePath}
          onExport={onExport}
        />
      );
    case "table":
      return (
        <DataGrid
          sessionId={tab.sessionId}
          scope={tab.scope}
          table={tab.table ?? ""}
          objectKind={tab.objectKind}
          onMutated={() => onInvalidate(tab.sessionId, tab.scope)}
        />
      );
    case "designer":
      return (
        <TableDesigner
          sessionId={tab.sessionId}
          scope={tab.scope}
          table={tab.table}
          objectKind={tab.objectKind}
          onApplied={() => onInvalidate(tab.sessionId, tab.scope)}
        />
      );
    default:
      return (
        <WelcomePane onNewConnection={onRequestConnection} onOpenSettings={() => undefined} />
      );
  }
}

export default function App() {
  return (
    <TooltipProvider delayDuration={400}>
      <ConfirmProvider>
        <PromptProvider>
          <AppShell />
          <Toaster
            position="bottom-right"
            closeButton
            toastOptions={{
              classNames: {
                toast:
                  "!bg-raised !text-fg !border !border-border !rounded-lg !shadow-popover !text-[12px]",
                description: "!text-muted",
                actionButton: "!bg-accent !text-accent-fg",
                cancelButton: "!bg-sunken !text-fg",
                error: "!border-danger/40",
                success: "!border-success/40",
              },
            }}
            icons={{ loading: <Database className="size-4 animate-pulse" /> }}
          />
        </PromptProvider>
      </ConfirmProvider>
    </TooltipProvider>
  );
}
