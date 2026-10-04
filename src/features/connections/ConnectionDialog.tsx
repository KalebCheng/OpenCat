/**
 * The connection manager.
 *
 * Two panes, like the tool it replaces: the saved connections on the left, the
 * editor for the selected one on the right. Everything is a draft until "Save",
 * so a half-typed host can never corrupt the workspace.
 */

import { useEffect, useMemo, useState } from "react";
import { open as openFileDialog } from "@tauri-apps/plugin-dialog";
import {
  Copy,
  Database,
  FilePlus2,
  FolderOpen,
  KeyRound,
  Plug,
  Plus,
  Save,
  Server,
  ShieldCheck,
  Trash2,
  Waypoints,
} from "lucide-react";
import { toast } from "sonner";

import {
  Badge,
  Button,
  CheckboxField,
  Field,
  IconButton,
  Input,
  NativeSelect,
} from "@/components/ui/primitives";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogFooter,
  DialogHeader,
  Tooltip,
  useConfirm,
} from "@/components/ui/overlays";
import ipc from "@/lib/ipc";
import {
  type AppInfo,
  type ConnectionProfile,
  type DbKind,
  type EngineInfo,
  type SslMode,
  blankProfile,
  defaultPort,
  toErrorPayload,
} from "@/lib/types";
import { CONNECTION_COLORS, cn, connectionColor, initials } from "@/lib/utils";
import { describeConnection, useConnections } from "@/store/connections";
import { useTabs } from "@/store/tabs";

type EditorTab = "general" | "security" | "advanced";

export interface ConnectionDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Preselect this profile when the dialog opens. */
  profileId?: string;
}

export function ConnectionDialog({ open, onOpenChange, profileId }: ConnectionDialogProps) {
  const profiles = useConnections((state) => state.profiles);
  const confirm = useConfirm();
  const [selectedId, setSelectedId] = useState<string | null>(profileId ?? null);
  const [draft, setDraft] = useState<ConnectionProfile | null>(null);
  const [tab, setTab] = useState<EditorTab>("general");
  const [engines, setEngines] = useState<EngineInfo[]>([]);
  const [testing, setTesting] = useState(false);
  const [saving, setSaving] = useState(false);
  const [testResult, setTestResult] = useState<{ ok: boolean; message: string } | null>(null);

  // Load the engine catalogue once so the "new connection" menu is data-driven.
  useEffect(() => {
    ipc.app
      .info()
      .then((info: AppInfo) => setEngines(info.engines))
      .catch(() => setEngines([]));
  }, []);

  // Reset to a sensible selection each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setTestResult(null);
    setTab("general");
    const initial = profileId ?? profiles[0]?.id ?? null;
    setSelectedId(initial);
    const profile = profiles.find((p) => p.id === initial);
    setDraft(profile ? { ...profile } : null);
  }, [open, profileId, profiles]);

  const isNew = useMemo(
    () => !!draft && !profiles.some((p) => p.id === draft.id),
    [draft, profiles],
  );

  const patch = (changes: Partial<ConnectionProfile>) => {
    setDraft((current) => (current ? { ...current, ...changes } : current));
    setTestResult(null);
  };

  const patchSsh = (changes: Partial<ConnectionProfile["ssh"]>) => {
    setDraft((current) =>
      current ? { ...current, ssh: { ...current.ssh, ...changes } } : current,
    );
    setTestResult(null);
  };

  const startNew = (kind: DbKind) => {
    const profile = blankProfile(kind);
    profile.name = defaultName(kind);
    setDraft(profile);
    setSelectedId(profile.id);
    setTestResult(null);
    setTab("general");
  };

  const save = async (): Promise<ConnectionProfile | null> => {
    if (!draft) return null;
    if (!draft.name.trim()) {
      toast.error("Give the connection a name first");
      return null;
    }
    setSaving(true);
    try {
      const stored = await useConnections.getState().save(draft);
      setDraft({ ...stored });
      setSelectedId(stored.id);
      toast.success(`Saved “${stored.name}”`);
      return stored;
    } catch (error) {
      toast.error(toErrorPayload(error).message);
      return null;
    } finally {
      setSaving(false);
    }
  };

  const connect = async () => {
    const stored = await save();
    if (!stored) return;
    const info = await useConnections.getState().open(stored.id);
    if (!info) {
      const message = useConnections.getState().error ?? "could not connect";
      setTestResult({ ok: false, message });
      toast.error(message);
      return;
    }
    useTabs.getState().open({
      kind: "query",
      sessionId: info.sessionId,
      scope: { database: info.server.currentDatabase ?? null, schema: null },
    });
    onOpenChange(false);
  };

  const test = async () => {
    if (!draft) return;
    setTesting(true);
    setTestResult(null);
    try {
      const server = await ipc.connections.validate(draft);
      setTestResult({
        ok: true,
        message: `Connected — ${server.version}${server.currentUser ? ` as ${server.currentUser}` : ""}`,
      });
    } catch (error) {
      setTestResult({ ok: false, message: toErrorPayload(error).message });
    } finally {
      setTesting(false);
    }
  };

  const remove = async () => {
    if (!draft || isNew) return;
    const ok = await confirm({
      title: `Delete “${draft.name}”?`,
      description: "The saved profile and its stored password will be removed.",
      confirmLabel: "Delete",
      tone: "danger",
    });
    if (!ok) return;
    await useConnections.getState().remove(draft.id);
    const next = useConnections.getState().profiles[0] ?? null;
    setSelectedId(next?.id ?? null);
    setDraft(next ? { ...next } : null);
    toast.success("Connection deleted");
  };

  const duplicate = async () => {
    if (!draft || isNew) return;
    const copy = await useConnections.getState().duplicate(draft.id);
    setSelectedId(copy.id);
    setDraft({ ...copy });
    toast.success(`Duplicated as “${copy.name}”`);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="xl" className="h-[38rem] max-h-[90vh]">
        <DialogHeader
          icon={<Database />}
          title="Connections"
          description="Saved profiles are stored in your OpenCat workspace and never leave this machine."
        />

        <div className="flex min-h-0 flex-1">
          {/* -- saved list ------------------------------------------------- */}
          <div className="flex w-60 shrink-0 flex-col border-r border-border bg-sunken">
            <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-2">
              <span className="text-[10px] font-semibold uppercase tracking-wide text-subtle">
                Saved
              </span>
              <div className="flex-1" />
              <NewConnectionMenu engines={engines} onPick={startNew} />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto scrollbar-thin p-1">
              {profiles.length === 0 ? (
                <p className="px-2 py-6 text-center text-[11px] leading-relaxed text-subtle">
                  No saved connections. Use “New” to add one.
                </p>
              ) : (
                profiles.map((profile) => (
                  <button
                    key={profile.id}
                    type="button"
                    onClick={() => {
                      setSelectedId(profile.id);
                      setDraft({ ...profile });
                      setTestResult(null);
                    }}
                    className={cn(
                      "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left",
                      selectedId === profile.id
                        ? "bg-accent-soft text-fg"
                        : "hover:bg-hover",
                    )}
                  >
                    <span
                      className="grid size-6 shrink-0 place-content-center rounded text-[10px] font-bold text-white"
                      style={{ backgroundColor: connectionColor(profile) }}
                    >
                      {initials(profile.name)}
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-[12px] font-medium">{profile.name}</span>
                      <span className="truncate text-[10px] text-subtle">
                        {describeConnection(profile)}
                      </span>
                    </span>
                  </button>
                ))
              )}
            </div>
          </div>

          {/* -- editor ------------------------------------------------------ */}
          {draft ? (
            <div className="flex min-w-0 flex-1 flex-col">
              <div className="flex h-9 shrink-0 items-center gap-1 border-b border-border px-3">
                {(["general", "security", "advanced"] as EditorTab[]).map((id) => (
                  <button
                    key={id}
                    type="button"
                    onClick={() => setTab(id)}
                    className={cn(
                      "rounded-md px-2.5 py-1 text-[12px] capitalize transition-colors",
                      tab === id
                        ? "bg-accent-soft text-accent"
                        : "text-muted hover:bg-hover hover:text-fg",
                    )}
                  >
                    {id}
                  </button>
                ))}
                <div className="flex-1" />
                {!isNew ? (
                  <>
                    <Tooltip content="Duplicate">
                      <IconButton label="Duplicate" variant="ghost" onClick={duplicate}>
                        <Copy className="size-3.5" />
                      </IconButton>
                    </Tooltip>
                    <Tooltip content="Delete">
                      <IconButton label="Delete" variant="ghost" onClick={remove}>
                        <Trash2 className="size-3.5 text-danger" />
                      </IconButton>
                    </Tooltip>
                  </>
                ) : null}
              </div>

              <DialogBody className="flex flex-col gap-4">
                {tab === "general" ? (
                  <GeneralTab draft={draft} engines={engines} patch={patch} />
                ) : null}
                {tab === "security" ? (
                  <SecurityTab draft={draft} patch={patch} patchSsh={patchSsh} />
                ) : null}
                {tab === "advanced" ? <AdvancedTab draft={draft} patch={patch} /> : null}
              </DialogBody>

              {testResult ? (
                <div
                  className={cn(
                    "mx-4 mb-2 flex items-start gap-2 rounded-md border px-3 py-2 text-[11px] leading-snug",
                    testResult.ok
                      ? "border-success/30 bg-success-soft text-success"
                      : "border-danger/30 bg-danger-soft text-danger",
                  )}
                >
                  <ShieldCheck className="mt-px size-3.5 shrink-0" />
                  <span className="selectable break-words">{testResult.message}</span>
                </div>
              ) : null}

              <DialogFooter>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Cancel
                </Button>
                <Button onClick={test} loading={testing}>
                  <Waypoints className="size-3.5" />
                  Test connection
                </Button>
                <Button onClick={save} loading={saving}>
                  <Save className="size-3.5" />
                  Save
                </Button>
                <Button variant="primary" onClick={connect}>
                  <Plug className="size-3.5" />
                  Save &amp; connect
                </Button>
              </DialogFooter>
            </div>
          ) : (
            <div className="flex flex-1 flex-col items-center justify-center gap-3 text-center">
              <Server className="size-8 text-subtle" />
              <p className="text-xs text-muted">
                Select a saved connection, or create a new one.
              </p>
              <NewConnectionMenu engines={engines} onPick={startNew} asButton />
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

function GeneralTab({
  draft,
  engines,
  patch,
}: {
  draft: ConnectionProfile;
  engines: EngineInfo[];
  patch: (changes: Partial<ConnectionProfile>) => void;
}) {
  const fileBased = draft.kind === "sqlite";

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <Field label="Connection name" required>
          <Input
            value={draft.name}
            autoFocus
            placeholder="Production PostgreSQL"
            onChange={(event) => patch({ name: event.target.value })}
          />
        </Field>
        <Field label="Database type">
          <NativeSelect
            value={draft.kind}
            onChange={(event) => {
              const kind = event.target.value as DbKind;
              patch({ kind, port: defaultPort(kind) ?? 0 });
            }}
          >
            {(engines.length > 0
              ? engines
              : [
                  { kind: "sqlite" as DbKind, name: "SQLite" },
                  { kind: "mysql" as DbKind, name: "MySQL / MariaDB" },
                  { kind: "postgres" as DbKind, name: "PostgreSQL" },
                ]
            ).map((engine) => (
              <option key={engine.kind} value={engine.kind}>
                {engine.name}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>

      {fileBased ? (
        <Field label="Database file" required hint="Pick an existing .db/.sqlite file, or create a new one.">
          <div className="flex gap-2">
            <Input
              value={draft.file ?? ""}
              placeholder="C:\\data\\app.db"
              onChange={(event) => patch({ file: event.target.value })}
            />
            <Button
              onClick={async () => {
                const picked = await openFileDialog({
                  multiple: false,
                  directory: false,
                  filters: [{ name: "SQLite database", extensions: ["db", "sqlite", "sqlite3", "db3"] }],
                });
                if (typeof picked === "string") patch({ file: picked });
              }}
            >
              <FolderOpen className="size-3.5" />
              Browse
            </Button>
            <Button
              onClick={async () => {
                const picked = await openFileDialog({
                  multiple: false,
                  directory: true,
                  title: "Choose a folder for the new database",
                });
                if (typeof picked === "string") {
                  const name = `${draft.name.replace(/[^\w.-]+/g, "_") || "database"}.db`;
                  const separator = picked.includes("\\") ? "\\" : "/";
                  patch({
                    file: `${picked}${separator}${name}`,
                    params: { ...draft.params, create: "true" },
                  });
                  toast.info("The file will be created when you connect.");
                }
              }}
            >
              <FilePlus2 className="size-3.5" />
              Create
            </Button>
          </div>
        </Field>
      ) : (
        <>
          <div className="grid grid-cols-[1fr_7rem] gap-4">
            <Field label="Host" required>
              <Input
                value={draft.host}
                placeholder="127.0.0.1"
                onChange={(event) => patch({ host: event.target.value })}
              />
            </Field>
            <Field label="Port" required>
              <Input
                type="number"
                value={draft.port}
                onChange={(event) => patch({ port: Number(event.target.value) || 0 })}
              />
            </Field>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <Field label="Username">
              <Input
                value={draft.username}
                autoComplete="off"
                onChange={(event) => patch({ username: event.target.value })}
              />
            </Field>
            <Field label="Password">
              <Input
                type="password"
                value={draft.password}
                autoComplete="new-password"
                placeholder="••••••"
                onChange={(event) => patch({ password: event.target.value })}
              />
            </Field>
          </div>

          <Field
            label="Database"
            hint={
              draft.kind === "postgres"
                ? "Leave blank to connect to “postgres” and browse every database."
                : "Leave blank to browse every schema after connecting."
            }
          >
            <Input
              value={draft.database ?? ""}
              onChange={(event) => patch({ database: event.target.value || null })}
            />
          </Field>
        </>
      )}

      <Field label="Accent colour">
        <div className="flex flex-wrap items-center gap-1.5">
          {CONNECTION_COLORS.map((color) => (
            <button
              key={color}
              type="button"
              aria-label={`Use ${color}`}
              onClick={() => patch({ color })}
              style={{ backgroundColor: color }}
              className={cn(
                "size-6 rounded-md transition-transform",
                (draft.color ?? connectionColor(draft)) === color
                  ? "ring-2 ring-accent ring-offset-2 ring-offset-surface"
                  : "hover:scale-110",
              )}
            />
          ))}
          <button
            type="button"
            onClick={() => patch({ color: null })}
            className="ml-1 text-[11px] text-muted hover:text-fg"
          >
            Auto
          </button>
        </div>
      </Field>
    </div>
  );
}

function SecurityTab({
  draft,
  patch,
  patchSsh,
}: {
  draft: ConnectionProfile;
  patch: (changes: Partial<ConnectionProfile>) => void;
  patchSsh: (changes: Partial<ConnectionProfile["ssh"]>) => void;
}) {
  const supportsSsl = draft.kind !== "sqlite";

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3">
        <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">
          <ShieldCheck className="size-3.5" />
          TLS
        </h3>
        {supportsSsl ? (
          <Field label="SSL mode">
            <NativeSelect
              value={draft.sslMode}
              onChange={(event) => patch({ sslMode: event.target.value as SslMode })}
            >
              <option value="disable">Disable — plaintext</option>
              <option value="prefer">Prefer — upgrade when the server allows it</option>
              <option value="require">Require — fail if TLS is unavailable</option>
              <option value="verifyca">Verify CA</option>
              <option value="verifyfull">Verify full (CA + hostname)</option>
            </NativeSelect>
          </Field>
        ) : (
          <p className="text-[11px] text-subtle">
            SQLite is a local file; TLS does not apply.
          </p>
        )}
      </section>

      <section className="flex flex-col gap-3 border-t border-border pt-4">
        <div className="flex items-center justify-between">
          <h3 className="flex items-center gap-1.5 text-[11px] font-semibold uppercase tracking-wide text-subtle">
            <Waypoints className="size-3.5" />
            SSH tunnel
          </h3>
          <CheckboxField
            checked={draft.ssh.enabled}
            onCheckedChange={(enabled) => patchSsh({ enabled })}
            label="Route through a jump host"
          />
        </div>

        {draft.ssh.enabled ? (
          <div className="flex flex-col gap-3 rounded-lg border border-border bg-sunken p-3">
            <div className="grid grid-cols-[1fr_7rem] gap-3">
              <Field label="SSH host">
                <Input
                  value={draft.ssh.host}
                  placeholder="bastion.example.com"
                  onChange={(event) => patchSsh({ host: event.target.value })}
                />
              </Field>
              <Field label="Port">
                <Input
                  type="number"
                  value={draft.ssh.port}
                  onChange={(event) => patchSsh({ port: Number(event.target.value) || 22 })}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field label="SSH username">
                <Input
                  value={draft.ssh.username}
                  onChange={(event) => patchSsh({ username: event.target.value })}
                />
              </Field>
              <Field label="SSH password">
                <Input
                  type="password"
                  value={draft.ssh.password}
                  autoComplete="new-password"
                  onChange={(event) => patchSsh({ password: event.target.value })}
                />
              </Field>
            </div>
            <Field
              label="Private key"
              hint="Optional. When set, the key is preferred over the password."
            >
              <div className="flex gap-2">
                <Input
                  value={draft.ssh.privateKeyPath ?? ""}
                  placeholder="C:\\Users\\me\\.ssh\\id_ed25519"
                  onChange={(event) =>
                    patchSsh({ privateKeyPath: event.target.value || null })
                  }
                />
                <Button
                  onClick={async () => {
                    const picked = await openFileDialog({ multiple: false, directory: false });
                    if (typeof picked === "string") patchSsh({ privateKeyPath: picked });
                  }}
                >
                  <KeyRound className="size-3.5" />
                  Browse
                </Button>
              </div>
            </Field>
          </div>
        ) : (
          <p className="text-[11px] leading-relaxed text-subtle">
            Use a tunnel when the database is only reachable from a bastion host.
          </p>
        )}
      </section>
    </div>
  );
}

function AdvancedTab({
  draft,
  patch,
}: {
  draft: ConnectionProfile;
  patch: (changes: Partial<ConnectionProfile>) => void;
}) {
  const [paramKey, setParamKey] = useState("");
  const [paramValue, setParamValue] = useState("");

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-4">
        <Field label="Rows per page" hint="Data grid page size for this connection.">
          <Input
            type="number"
            value={draft.pageSize}
            onChange={(event) => patch({ pageSize: Number(event.target.value) || 500 })}
          />
        </Field>
        <Field label="Max rows" hint="Hard cap for ad-hoc queries.">
          <Input
            type="number"
            value={draft.maxRows}
            onChange={(event) => patch({ maxRows: Number(event.target.value) || 50_000 })}
          />
        </Field>
        <Field label="Timeout (s)">
          <Input
            type="number"
            value={draft.connectTimeoutSecs}
            onChange={(event) =>
              patch({ connectTimeoutSecs: Number(event.target.value) || 15 })
            }
          />
        </Field>
      </div>

      <CheckboxField
        checked={draft.readOnly}
        onCheckedChange={(readOnly) => patch({ readOnly })}
        label="Read-only connection"
        hint="Refuses INSERT/UPDATE/DELETE/DDL from both the editor and the data grid."
      />

      {draft.kind === "sqlite" ? (
        <CheckboxField
          checked={draft.params.create === "true"}
          onCheckedChange={(create) =>
            patch({
              params: { ...draft.params, create: create ? "true" : "false" },
            })
          }
          label="Create the database file if it is missing"
        />
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="text-[11px] font-semibold uppercase tracking-wide text-subtle">
          Extra connection parameters
        </h3>
        <p className="text-[11px] leading-relaxed text-subtle">
          Appended to the connection string. For example <code>charset=utf8mb4</code> on MySQL, or{" "}
          <code>search_path=app</code> on PostgreSQL.
        </p>

        {Object.keys(draft.params).filter((key) => key !== "create").length > 0 ? (
          <ul className="flex flex-col gap-1">
            {Object.entries(draft.params)
              .filter(([key]) => key !== "create")
              .map(([key, value]) => (
                <li
                  key={key}
                  className="flex items-center gap-2 rounded-md border border-border bg-sunken px-2 py-1 text-[11px]"
                >
                  <span className="font-mono text-fg">{key}</span>
                  <span className="text-subtle">=</span>
                  <span className="min-w-0 flex-1 truncate font-mono text-muted selectable">
                    {value}
                  </span>
                  <IconButton
                    label={`Remove ${key}`}
                    size="icon-sm"
                    variant="ghost"
                    className="size-5"
                    onClick={() => {
                      const next = { ...draft.params };
                      delete next[key];
                      patch({ params: next });
                    }}
                  >
                    <Trash2 className="size-3" />
                  </IconButton>
                </li>
              ))}
          </ul>
        ) : (
          <p className="text-[11px] text-subtle">None set.</p>
        )}

        <div className="flex gap-2">
          <Input
            value={paramKey}
            placeholder="key"
            className="h-7 font-mono text-[11px]"
            onChange={(event) => setParamKey(event.target.value)}
          />
          <Input
            value={paramValue}
            placeholder="value"
            className="h-7 font-mono text-[11px]"
            onChange={(event) => setParamValue(event.target.value)}
          />
          <Button
            className="h-7"
            disabled={!paramKey.trim()}
            onClick={() => {
              patch({ params: { ...draft.params, [paramKey.trim()]: paramValue } });
              setParamKey("");
              setParamValue("");
            }}
          >
            <Plus className="size-3.5" />
            Add
          </Button>
        </div>
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New-connection menu
// ---------------------------------------------------------------------------

function NewConnectionMenu({
  engines,
  onPick,
  asButton,
}: {
  engines: EngineInfo[];
  onPick: (kind: DbKind) => void;
  asButton?: boolean;
}) {
  const [openMenu, setOpenMenu] = useState(false);
  const list =
    engines.length > 0
      ? engines
      : ([
          { kind: "sqlite", name: "SQLite", defaultPort: null, fileBased: true },
          { kind: "mysql", name: "MySQL / MariaDB", defaultPort: 3306, fileBased: false },
          { kind: "postgres", name: "PostgreSQL", defaultPort: 5432, fileBased: false },
        ] as EngineInfo[]);

  return (
    <div className="relative">
      {asButton ? (
        <Button variant="primary" onClick={() => setOpenMenu((value) => !value)}>
          <Plus className="size-3.5" />
          New connection
        </Button>
      ) : (
        <Tooltip content="New connection">
          <IconButton
            label="New connection"
            size="icon-sm"
            variant="ghost"
            onClick={() => setOpenMenu((value) => !value)}
          >
            <Plus className="size-3.5" />
          </IconButton>
        </Tooltip>
      )}

      {openMenu ? (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpenMenu(false)} />
          <div className="absolute right-0 top-full z-50 mt-1 w-56 overflow-hidden rounded-lg border border-border bg-raised py-1 shadow-popover">
            {list.map((engine) => (
              <button
                key={engine.kind}
                type="button"
                onClick={() => {
                  setOpenMenu(false);
                  onPick(engine.kind);
                }}
                className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] hover:bg-accent hover:text-accent-fg"
              >
                <Database className="size-3.5" />
                <span className="flex-1">{engine.name}</span>
                {engine.defaultPort ? (
                  <span className="text-[10px] opacity-70 tnum">{engine.defaultPort}</span>
                ) : (
                  <Badge tone="neutral">file</Badge>
                )}
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}

function defaultName(kind: DbKind): string {
  switch (kind) {
    case "sqlite":
      return "New SQLite Database";
    case "mysql":
      return "New MySQL Connection";
    case "postgres":
      return "New PostgreSQL Connection";
  }
}
