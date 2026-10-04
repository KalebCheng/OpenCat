/**
 * Settings dialog.
 *
 * Five tabs, no save button: every control writes through
 * `useSettings.getState().update` and the store applies the change (theme class,
 * font variables) before it persists, so the window shows the result at once.
 */

import * as React from "react";
import { toast } from "sonner";
import { Monitor, Moon, Settings2, Sun } from "lucide-react";

import { Button, Switch } from "@/components/ui/primitives";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  useConfirm,
} from "@/components/ui/overlays";
import ipc from "@/lib/ipc";
import { type AppSettings, toErrorPayload } from "@/lib/types";
import { cn } from "@/lib/utils";
import { useSettings } from "@/store/settings";
import { AboutTab } from "./AboutTab";
import { ACCENTS, accentColor, applyAccent } from "./accent";
import { NumberField, Segmented, SettingRow, SettingsGroup, TextField } from "./controls";

export interface SettingsDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const TABS = [
  { id: "appearance", label: "Appearance" },
  { id: "editor", label: "Editor" },
  { id: "data", label: "Data & Grid" },
  { id: "history", label: "History" },
  { id: "about", label: "About" },
] as const;

type TabId = (typeof TABS)[number]["id"];

export function SettingsDialog({ open, onOpenChange }: SettingsDialogProps): React.ReactElement {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      {open ? <SettingsDialogBody onOpenChange={onOpenChange} /> : null}
    </Dialog>
  );
}

function SettingsDialogBody({
  onOpenChange,
}: {
  onOpenChange: (open: boolean) => void;
}): React.ReactElement {
  const settings = useSettings((state) => state.settings);
  const confirm = useConfirm();
  const [tab, setTab] = React.useState<TabId>("appearance");

  const update = React.useCallback((patch: Partial<AppSettings>) => {
    void useSettings.getState().update(patch);
  }, []);

  // The store takes care of the theme class and the font variables; the accent
  // palette is applied here, including on open, so a reload re-asserts whatever
  // was persisted.
  React.useEffect(() => {
    applyAccent(settings.accent);
  }, [settings.accent]);

  const reset = async () => {
    const confirmed = await confirm({
      title: "Reset settings to defaults?",
      description:
        "Theme, fonts, grid sizes and history limits all go back to their factory values. Saved connections and queries are untouched.",
      confirmLabel: "Reset",
      tone: "danger",
    });
    if (!confirmed) return;
    await useSettings.getState().reset();
    toast.success("Settings reset to defaults");
  };

  const clearHistory = async () => {
    const confirmed = await confirm({
      title: "Clear query history?",
      description:
        "Every recorded statement for every connection is deleted. Saved queries and snippets are kept.",
      confirmLabel: "Clear history",
      tone: "danger",
    });
    if (!confirmed) return;
    try {
      await ipc.history.clear();
      toast.success("Query history cleared");
    } catch (cause) {
      toast.error("Could not clear the history", {
        description: toErrorPayload(cause).message,
      });
    }
  };

  const panel = (() => {
    switch (tab) {
      case "appearance":
        return <AppearanceTab settings={settings} update={update} />;
      case "editor":
        return <EditorTab settings={settings} update={update} />;
      case "data":
        return <DataTab settings={settings} update={update} />;
      case "history":
        return (
          <HistoryTab settings={settings} update={update} onClear={() => void clearHistory()} />
        );
      case "about":
        return <AboutTab />;
    }
  })();

  return (
    <DialogContent size="lg">
      <DialogHeader
        title="Settings"
        description="Applied immediately — there is nothing to save."
        icon={<Settings2 />}
      />
      <DialogBody className="flex gap-0 p-0">
        <nav className="flex w-44 shrink-0 flex-col gap-0.5 border-r border-border bg-raised p-2">
          {TABS.map((item) => (
            <button
              key={item.id}
              type="button"
              aria-current={item.id === tab}
              onClick={() => setTab(item.id)}
              className={cn(
                "rounded-md px-2.5 py-1.5 text-left text-[13px] transition-colors",
                item.id === tab
                  ? "bg-accent-soft font-medium text-accent"
                  : "text-muted hover:bg-hover hover:text-fg",
              )}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="min-h-0 min-w-0 flex-1 overflow-auto scrollbar-thin p-4">{panel}</div>
      </DialogBody>
      <DialogFooter>
        <Button variant="ghost" className="mr-auto" onClick={() => void reset()}>
          Reset to defaults
        </Button>
        <Button variant="primary" onClick={() => onOpenChange(false)}>
          Close
        </Button>
      </DialogFooter>
    </DialogContent>
  );
}

interface PanelProps {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
}

function AppearanceTab({ settings, update }: PanelProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-5">
      <SettingsGroup title="Theme" description="System follows the operating system setting.">
        <SettingRow label="Appearance">
          <Segmented
            value={settings.theme}
            onChange={(theme) => update({ theme })}
            options={[
              { value: "system", label: "System", icon: <Monitor className="size-3.5" /> },
              { value: "light", label: "Light", icon: <Sun className="size-3.5" /> },
              { value: "dark", label: "Dark", icon: <Moon className="size-3.5" /> },
            ]}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Accent" description="Buttons, selections and focus rings.">
        <SettingRow label="Colour" stacked>
          <div className="flex flex-wrap gap-1.5">
            {ACCENTS.map((swatch) => (
              <button
                key={swatch.id}
                type="button"
                title={swatch.label}
                aria-label={swatch.label}
                aria-pressed={settings.accent === swatch.id}
                onClick={() => update({ accent: swatch.id })}
                style={{ backgroundColor: accentColor(swatch.id) }}
                className={cn(
                  "size-7 rounded-full border-2 transition-transform",
                  settings.accent === swatch.id
                    ? "scale-105 border-fg"
                    : "border-transparent hover:scale-105",
                )}
              />
            ))}
          </div>
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Interface" description="Fonts used by the chrome, not the editor.">
        <SettingRow label="Font family" hint="Leave empty for the built-in stack.">
          <TextField
            aria-label="Interface font family"
            value={settings.uiFontFamily}
            placeholder="Inter, system-ui, sans-serif"
            onChange={(uiFontFamily) => update({ uiFontFamily })}
            className="w-72"
          />
        </SettingRow>
        <SettingRow label="Font size">
          <NumberField
            aria-label="Interface font size"
            value={settings.uiFontSize}
            min={9}
            max={24}
            suffix="px"
            onChange={(uiFontSize) => update({ uiFontSize })}
            className="w-28"
          />
        </SettingRow>
        <SettingRow label="Preview" stacked>
          <div
            className="flex flex-col gap-0.5 rounded-lg border border-border bg-surface p-3"
            style={{
              fontFamily: settings.uiFontFamily || undefined,
              fontSize: settings.uiFontSize,
            }}
          >
            <p className="font-medium text-fg">Orders — 12,480 rows</p>
            <p className="text-muted">SELECT * FROM orders WHERE total &gt; 100;</p>
          </div>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}

function EditorTab({ settings, update }: PanelProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-5">
      <SettingsGroup title="Typography">
        <SettingRow label="Font family">
          <TextField
            aria-label="Editor font family"
            mono
            value={settings.editorFontFamily}
            placeholder="JetBrains Mono, monospace"
            onChange={(editorFontFamily) => update({ editorFontFamily })}
            className="w-72"
          />
        </SettingRow>
        <SettingRow label="Font size">
          <NumberField
            aria-label="Editor font size"
            value={settings.editorFontSize}
            min={9}
            max={28}
            suffix="px"
            onChange={(editorFontSize) => update({ editorFontSize })}
            className="w-28"
          />
        </SettingRow>
        <SettingRow label="Tab size" hint="Spaces inserted for one indent.">
          <NumberField
            aria-label="Tab size"
            value={settings.editorTabSize}
            min={1}
            max={8}
            suffix="sp"
            onChange={(editorTabSize) => update({ editorTabSize })}
            className="w-28"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Behaviour">
        <SettingRow label="Word wrap">
          <Switch
            aria-label="Word wrap"
            checked={settings.editorWordWrap}
            onCheckedChange={(editorWordWrap) => update({ editorWordWrap })}
          />
        </SettingRow>
        <SettingRow label="Line numbers">
          <Switch
            aria-label="Line numbers"
            checked={settings.editorLineNumbers}
            onCheckedChange={(editorLineNumbers) => update({ editorLineNumbers })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Preview">
        <SettingRow label="Sample" stacked>
          <pre
            className="overflow-hidden rounded-lg border border-border bg-surface p-3 leading-relaxed text-fg"
            style={{
              fontFamily: settings.editorFontFamily || undefined,
              fontSize: settings.editorFontSize,
              tabSize: settings.editorTabSize,
            }}
          >
            <code>{`SELECT id, name\nFROM customers\nWHERE active = TRUE;`}</code>
          </pre>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}

function DataTab({ settings, update }: PanelProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-5">
      <SettingsGroup title="Paging" description="How much of a table the grid asks for.">
        <SettingRow label="Default page size" hint="Rows fetched per page.">
          <NumberField
            aria-label="Default page size"
            value={settings.defaultPageSize}
            min={10}
            max={100_000}
            suffix="rows"
            onChange={(defaultPageSize) => update({ defaultPageSize })}
            className="w-32"
          />
        </SettingRow>
        <SettingRow label="Maximum rows" hint="Cap for collecting a result set in one go.">
          <NumberField
            aria-label="Maximum rows"
            value={settings.maxRows}
            min={100}
            max={10_000_000}
            suffix="rows"
            onChange={(maxRows) => update({ maxRows })}
            className="w-32"
          />
        </SettingRow>
        <SettingRow label="Truncate cell characters" hint="0 shows the full value.">
          <NumberField
            aria-label="Truncate cell characters"
            value={settings.truncateCellChars}
            min={0}
            max={10_000}
            suffix="chars"
            onChange={(truncateCellChars) => update({ truncateCellChars })}
            className="w-32"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Editing">
        <SettingRow label="Auto-commit" hint="Commit each edit as it is made.">
          <Switch
            aria-label="Auto-commit"
            checked={settings.autoCommit}
            onCheckedChange={(autoCommit) => update({ autoCommit })}
          />
        </SettingRow>
        <SettingRow label="Confirm destructive actions" hint="Drops, truncates and deletes.">
          <Switch
            aria-label="Confirm destructive actions"
            checked={settings.confirmDestructive}
            onCheckedChange={(confirmDestructive) => update({ confirmDestructive })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Explorer">
        <SettingRow label="Show system databases">
          <Switch
            aria-label="Show system databases"
            checked={settings.showSystemDatabases}
            onCheckedChange={(showSystemDatabases) => update({ showSystemDatabases })}
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup title="Display">
        <SettingRow label="NULL display text" hint="Shown for a NULL cell.">
          <TextField
            aria-label="NULL display text"
            value={settings.nullDisplay}
            placeholder="(NULL)"
            onChange={(nullDisplay) => update({ nullDisplay })}
            className="w-48"
          />
        </SettingRow>
        <SettingRow
          label="Date format"
          hint="strftime-style tokens, e.g. %Y-%m-%d %H:%M:%S."
        >
          <TextField
            aria-label="Date format"
            mono
            value={settings.dateFormat}
            placeholder="%Y-%m-%d %H:%M:%S"
            onChange={(dateFormat) => update({ dateFormat })}
            className="w-56"
          />
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}

function HistoryTab({
  settings,
  update,
  onClear,
}: PanelProps & { onClear: () => void }): React.ReactElement {
  return (
    <div className="flex flex-col gap-5">
      <SettingsGroup title="Recording" description="Statements run by the editor and the grid.">
        <SettingRow label="Save query history">
          <Switch
            aria-label="Save query history"
            checked={settings.saveQueryHistory}
            onCheckedChange={(saveQueryHistory) => update({ saveQueryHistory })}
          />
        </SettingRow>
        <SettingRow label="History limit" hint="Oldest entries are dropped past this.">
          <NumberField
            aria-label="History limit"
            value={settings.historyLimit}
            min={0}
            max={1_000_000}
            suffix="entries"
            disabled={!settings.saveQueryHistory}
            onChange={(historyLimit) => update({ historyLimit })}
            className="w-32"
          />
        </SettingRow>
      </SettingsGroup>

      <SettingsGroup
        title="Cleanup"
        description="Deleting history cannot be undone."
      >
        <SettingRow label="Clear history">
          <Button variant="danger" onClick={onClear}>
            Clear history
          </Button>
        </SettingRow>
      </SettingsGroup>
    </div>
  );
}
