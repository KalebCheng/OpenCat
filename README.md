# OpenCat

**A modern, cross-platform database client — a Navicat-style GUI for SQLite, MySQL/MariaDB and PostgreSQL.**

Rust backend · React + TypeScript frontend · native desktop app via Tauri v2.

[![CI](https://github.com/KalebCheng/OpenCat/actions/workflows/ci.yml/badge.svg)](https://github.com/KalebCheng/OpenCat/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue.svg)](LICENSE)
[![Rust](https://img.shields.io/badge/rust-1.80%2B-orange.svg)](https://www.rust-lang.org)
[![Tauri](https://img.shields.io/badge/tauri-v2-24C8DB.svg)](https://tauri.app)
[![Platforms](https://img.shields.io/badge/platform-Windows%20%7C%20macOS%20%7C%20Linux-lightgrey.svg)](#building-from-source)

**English** · [简体中文](README.zh-CN.md)

---

## Table of contents

- [Features](#features)
- [Supported engines](#supported-engines)
- [Layout](#layout)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [Quick start](#quick-start)
- [Building from source](#building-from-source)
- [Project structure](#project-structure)
- [Architecture](#architecture)
- [Data and security](#data-and-security)
- [Testing](#testing)
- [Troubleshooting](#troubleshooting)
- [Known limitations](#known-limitations)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Features

### Connection management
- Save any number of connections, optionally grouped and colour-coded so
  production is never one careless click away from staging
- **Test connection** and **Save & connect** are separate actions — verify before
  you persist
- TLS modes: `disable` / `prefer` / `require` / `verify-ca` / `verify-full`
- SSH jump-host settings (host, key, passphrase) are modelled and encrypted at
  rest — see [Known limitations](#known-limitations)
- Per-connection **read-only** flag, enforced in the driver *and* reflected in the
  UI by hiding every write affordance
- Page size, row cap, connect timeout and extra DSN parameters per connection

### Object explorer
- Lazy tree: database → schema → tables/views → columns, indexes, foreign keys,
  triggers
- Row counts, comments, composite index column order, FK targets and referential
  actions
- Right-click: open data, design, generate `SELECT`, copy name, show `CREATE`,
  rename, truncate, drop
- 60-second cache with explicit refresh; DDL invalidates the affected subtree
  automatically

### SQL editor
- CodeMirror 6 with syntax highlighting, bracket matching and completion that
  knows the current schema's tables
- Multi-statement scripts, split on semicolons — comments and string literals
  containing `;` are handled correctly, as are PostgreSQL `$tag$ … $tag$` bodies
- **One result tab per statement**, so a script shows all of its output
- `Ctrl+Enter` runs everything, `Ctrl+Shift+Enter` runs only the selection
- `EXPLAIN` / `EXPLAIN ANALYZE` / `EXPLAIN QUERY PLAN`, chosen per dialect
- Message panel with per-statement timing, affected rows, `last_insert_id` and
  server notices
- Database / schema switcher (`USE` on MySQL, `SET search_path` on PostgreSQL),
  open and save `.sql` files

### Data grid
- Virtualised — 100k rows scroll without stutter
- Paging, multi-column sorting (Shift-click to append), per-column filters plus a
  raw `WHERE` box
- **Editable**: double-click a cell, or just start typing. Every update carries
  the previous value as a lost-update guard
- Insert / delete / duplicate rows; auto-increment keys are detected and skipped
  so the server assigns the new key
- Hex viewer for binary values, pretty-printer for JSON
- NULL renders as dimmed italic, numbers are right-aligned with tabular figures
- Without a primary key: SQLite falls back to `rowid`; MySQL and PostgreSQL
  detect a unique NOT NULL index; otherwise the grid says exactly why it is
  read-only instead of failing silently

### Table designer
- Visual editing of columns, indexes and foreign keys, including renames — the
  original name is tracked so the generated diff is correct
- **Live SQL preview** of every pending change; copy it or hand-edit it before
  running
- Red warning plus a second confirmation when a plan is destructive
- SQLite cannot alter a column type in place, so the designer emits the official
  rebuild recipe (create → copy → drop → rename) wrapped in a transaction

### Import / export
- Export to **CSV, TSV, JSON or SQL INSERT**
- Full CSV dialect control: delimiter, quote, escape, line ending, NULL literal,
  empty-as-NULL, UTF-8 BOM
- SQL export can include the `CREATE TABLE` script and batch rows into multi-row
  `INSERT`s
- Three-step import wizard: choose file → map columns → review and run
- Format auto-detection from the extension plus content sniffing that skips
  leading SQL comments
- Column mapping supports **skipping** file columns
- JSON import accepts a top-level array or an object containing one array field

### Everything else
- Query history (searchable, clearable, individually deletable) and saved snippets
- Light/dark following the OS, or pinned manually; selectable accent colour
- Settings apply immediately and persist
- Configurable UI and editor fonts, sizes, tab width and word wrap

---

## Supported engines

| Engine | Status | Notes |
|---|---|---|
| **SQLite** | Full | File-based. `rowid` fallback makes keyless tables editable; WAL mode |
| **MySQL / MariaDB** | Full | Introspected via `information_schema`; DDL from `SHOW CREATE TABLE` |
| **PostgreSQL** | Full | Introspected via `pg_catalog`; DDL generated from the introspected schema |

All three implement the same `Driver` trait and share one type-decoding layer, so
the connection manager, object tree, data grid and import/export code are
engine-agnostic.

---

## Layout

```
┌──────────────────────────────────────────────────────────────┐
│ Title bar · new connection · new query · status · settings    │
├───────────────┬──────────────────────────────────────────────┤
│               │ Tabs: query / table data / table design       │
│  Object       ├──────────────────────────────────────────────┤
│  explorer     │ Toolbar: run · run selection · stop · explain │
│  ├ connected  ├──────────────────────────────────────────────┤
│  │  └ tree    │ SQL editor (CodeMirror 6)                    │
│  └ saved      ├──────────────────────────────────────────────┤
│               │ Result grid / message log (draggable split)  │
├───────────────┴──────────────────────────────────────────────┤
│ Status · connections · latency · scope · workspace directory  │
└──────────────────────────────────────────────────────────────┘
```

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl+Enter` | Run the whole editor |
| `Ctrl+Shift+Enter` | Run the selection only |
| `Ctrl+N` | New query tab |
| `Ctrl+T` | New query tab |
| `Ctrl+W` | Close the current tab |
| `Ctrl+Tab` / `Ctrl+Shift+Tab` | Cycle tabs |
| `Ctrl+Shift+N` | New connection |
| `Ctrl+,` | Settings |

In the data grid: arrow keys move, `Shift`+arrows extend a rectangular
selection, `Ctrl+A` selects all, `Ctrl+C` copies as TSV (pastes straight into a
spreadsheet), `Ctrl+0` sets a cell to SQL `NULL`.

---

## Quick start

### Download a prebuilt installer

Grab the bundle for your platform from
[Releases](https://github.com/KalebCheng/OpenCat/releases):

| Platform | File |
|---|---|
| Windows | `.msi` (Windows Installer) or `.exe` (NSIS setup) |
| macOS | `.dmg` (universal — Apple silicon and Intel) |
| Linux | `.AppImage` (portable), `.deb` (Debian/Ubuntu) or `.rpm` (Fedora/RHEL) |

If you would rather not wait for a tagged release, every push to `main` builds the
same installers through the `Bundle` workflow; download them from that run's
**Artifacts** section.

### Try it against the bundled sample

`examples/demo.db` ships with a small but realistic commerce schema — 120
customers, 15 products, 400 orders, 996 order lines, a view, and deliberately
awkward values (NULLs, long text, embedded JSON, binary columns).

1. Start OpenCat
2. **New connection** → type `SQLite` → **Browse** → pick `examples/demo.db` →
   **Save & connect**
3. Expand the tree, double-click a table to browse it, right-click → **Design** to
   change its structure

### Connect to your own server

Pick the engine in the connection dialog, fill in host, port, user and password,
press **Test connection**, then **Save & connect**.

---

## Building from source

### Prerequisites

| Component | Version | Notes |
|---|---|---|
| Node.js | ≥ 20 | Frontend build |
| pnpm | ≥ 9 | Package manager |
| Rust | ≥ 1.80 | Backend (stable) |
| Platform deps | — | See below |

**Platform dependencies**

- **Windows** — either the MSVC toolchain
  (`Microsoft.VisualStudio.Component.VC.Tools.x86.x64`) or a GNU toolchain (see
  [Windows without MSVC](#windows-without-msvc))
- **macOS** — Xcode Command Line Tools
- **Linux** — `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
  `libayatana-appindicator3-dev`, `librsvg2-dev`

### Build

```bash
pnpm install
pnpm app:build          # production bundle, output under src-tauri/target/release/
pnpm app:dev            # development with hot reload
```

Individual steps:

```bash
pnpm build              # frontend only
pnpm typecheck          # tsc --noEmit
pnpm icons              # regenerate the icon set (needs Python + Pillow)
cargo test              # backend test suite
cargo clippy --all-targets
```

### Windows without MSVC

If you would rather not install several gigabytes of Visual Studio, the GNU
toolchain works fine:

1. Install the GNU Rust toolchain:
   ```powershell
   rustup toolchain install stable-x86_64-pc-windows-gnu
   rustup default stable-x86_64-pc-windows-gnu
   ```
2. Install a MinGW-w64 distribution — [w64devkit](https://github.com/skeeto/w64devkit/releases)
   is a single self-extracting archive (~60 MB). Extract it somewhere like
   `C:\tools\w64devkit`.
3. Point Cargo at it, in `~/.cargo/config.toml`:
   ```toml
   [target.x86_64-pc-windows-gnu]
   linker = "C:\\tools\\w64devkit\\bin\\gcc.exe"
   ar     = "C:\\tools\\w64devkit\\bin\\ar.exe"
   ```
4. Put `C:\tools\w64devkit\bin` **and** `%USERPROFILE%\.cargo\bin` on your `PATH`.
   The second one is what `pnpm app:dev` needs to find `cargo` at all.

WebView2 ships with Windows 10/11, so there is nothing else to install.

---

## Project structure

```
OpenCat/
├── crates/
│   ├── opencat-core/          # Engine-agnostic domain model
│   │   └── src/
│   │       ├── model.rs       # ConnectionProfile / TableSchema / QueryResult / TablePlan …
│   │       ├── value.rs       # Tagged cell values
│   │       ├── sql.rs         # Statement splitting, identifier quoting, read-only detection
│   │       ├── workspace.rs   # Atomic JSON persistence
│   │       ├── secrets.rs     # AES-256-GCM encryption of stored passwords
│   │       └── settings.rs    # Settings, history, snippets
│   └── opencat-driver/        # One implementation per engine
│       └── src/
│           ├── traits.rs      # The Driver trait every engine implements
│           ├── common.rs      # Type mapping, literal rendering, paged SQL
│           ├── edit.rs        # Row-level INSERT/UPDATE/DELETE generation
│           ├── ddl.rs         # DDL generation for the designer (incl. SQLite rebuild)
│           ├── transfer.rs    # CSV / JSON / SQL import and export
│           ├── sqlite.rs      #
│           ├── mysql.rs       #
│           └── postgres.rs    #
├── src-tauri/                 # Desktop shell
│   └── src/
│       ├── lib.rs             # Startup, plugins, window creation
│       ├── state.rs           # Workspace + live session registry
│       ├── error.rs           # Serializable command errors
│       └── commands/          # The whole IPC surface, grouped by purpose
├── src/                       # React frontend
│   ├── lib/                   # types.ts (mirror of the Rust model), ipc.ts (sole backend entry point)
│   ├── store/                 # zustand: settings / connections / tabs / explorer
│   ├── components/            # Shell and primitives
│   │   ├── ui/                # Design system: primitives + overlays
│   │   ├── Sidebar.tsx        # Connection list, hosts the object tree
│   │   ├── ObjectTree.tsx     # Lazy object tree
│   │   └── TabBar.tsx · StatusBar.tsx · TitleBar.tsx · WelcomePane.tsx
│   ├── features/
│   │   ├── connections/       # Connection manager
│   │   ├── editor/            # SQL editor + result grid
│   │   ├── grid/              # Editable data grid
│   │   ├── designer/          # Table designer
│   │   ├── transfer/          # Import / export
│   │   └── settings/          # Settings dialog
│   └── styles/globals.css     # Design tokens, light and dark
├── tools/
│   ├── make_icons.py          # Generates the icon set
│   └── make_demo_db.py        # Generates examples/demo.db
├── examples/demo.db           # Sample SQLite database
└── assets/logo.png            # Icon source
```

---

## Architecture

### Layers

```
┌─────────────────────────────────────────────────┐
│ React frontend                                   │
│   zustand stores ←→ ipc.ts (the only backend door)│
└────────────────────┬────────────────────────────┘
                     │ Tauri IPC — the types are the contract
┌────────────────────▼────────────────────────────┐
│ src-tauri — command layer                        │
│   argument validation, session lookup, scope      │
│   switching, history recording                    │
└────────────────────┬────────────────────────────┘
┌────────────────────▼────────────────────────────┐
│ opencat-driver — the Driver trait                │
│   three implementations, one interface            │
└────────────────────┬────────────────────────────┘
┌────────────────────▼────────────────────────────┐
│ opencat-core — engine-agnostic model and helpers  │
└─────────────────────────────────────────────────┘
```

### Design decisions worth knowing

**The frontend only talks to the backend through `src/lib/ipc.ts`.** Every Tauri
command has a typed wrapper, so components never spell command names as strings.
Every failure is normalised to `ErrorPayload { code, message, detail }`, which is
what lets the UI choose between a toast and a modal.

**Cell values are tagged, not stringified.** The driver layer never coerces a
database value into `String` — that would throw away the information the grid
needs to right-align numbers, hex-dump binary data and, most importantly, write an
edit back with the correct SQL literal. Every cell travels as a `Value` enum
(`{"t":"int","v":42}`) and the frontend narrows it as a discriminated union.

**Row edits are built as literals, not bound parameters.** Bound parameters are
usually safer, but here the *client* assembles the statement, and engines infer
parameter types very differently — PostgreSQL's extended protocol is especially
unforgiving about binding `text` into a `date` slot. A correctly escaped literal
is unambiguous everywhere, which is why every desktop database client does it.
String escaping lives in one place: `opencat_core::sql::escape_literal`.

**Updates guard against lost updates.** The `WHERE` clause carries not just the
primary key but the *previous value* of every changed column. If someone else
modified the row in the meantime the statement affects zero rows instead of
silently overwriting. Non-NULL values use a plain `=`, which keeps the predicate
index-friendly — PostgreSQL's `IS NOT DISTINCT FROM` would prevent an index scan.

**A session pool holds exactly one connection.** A desktop client is one logical
session against one server. A single connection makes `USE` and `SET search_path`
behave predictably; with a pool, the next statement can land on a different
connection and the scope silently reverts.

**Persistence is temp-file plus rename.** Settings, connections and history are
diffable JSON; writes land in a `.tmp` file and are atomically renamed, so a
crash can never leave half a file behind.

**DDL is previewed before it runs.** The designer hands a `TablePlan` to pure
functions that render the statements, so what the user reviews is exactly what
executes. SQLite changes that it cannot express in place expand into the official
rebuild procedure and are flagged `destructive`.

---

## Data and security

- **Passwords are never stored in plaintext.** They are encrypted with
  AES-256-GCM under a per-installation `master.key` (mode `0600` where the
  platform supports it). The algorithm and a version prefix live in the format,
  so it can be rotated later.
- **Passwords are never sent to the frontend.** The backend substitutes a mask
  and restores the stored secret when a masked value comes back, so the UI never
  holds a plaintext credential.
- **Everything is local.** No telemetry, no cloud sync, no account. Data is
  written to the platform app-data directory — the status bar opens it for you so
  it is easy to back up.
- **Read-only connections** are refused at the driver layer, and the grid does
  not render any edit affordance.
- **Server-side timeouts** are applied on connect (`statement_timeout` on
  PostgreSQL, `max_execution_time` on MySQL), so a runaway query is stopped by the
  server even if the client is killed.

> `master.key` is protected by filesystem permissions rather than an OS keychain.
> An attacker who can already read your user profile can read the key too. That
> matches the threat model of comparable tools; moving to Windows Credential
> Manager / macOS Keychain is on the roadmap.

---

## Testing

```bash
cargo test                      # whole backend
cargo test -p opencat-driver    # driver only
pnpm typecheck                  # frontend type check
pnpm build                      # frontend production build
pnpm app:build                  # full desktop bundle
```

Current status:

| Check | Result |
|---|---|
| `cargo test` — `opencat-core` | 16 passed |
| `cargo test` — `opencat-driver` unit tests | 70 passed |
| `cargo test` — end-to-end SQLite lifecycle | 4 passed |
| `cargo test` — SQLite smoke test | 1 passed |
| `cargo check -p opencat` | clean, no warnings |
| `cargo build -p opencat --features custom-protocol` | produces `opencat.exe` |
| `pnpm exec tsc --noEmit` | 0 errors |
| `pnpm exec vite build` | succeeds |

The end-to-end suite
(`crates/opencat-driver/tests/end_to_end.rs`) really does walk the whole path:
create table → introspect → typed inserts → paged read → update by primary key →
a stale guard is rejected → count → search → export to CSV/JSON/SQL → parse the
CSV back → batch `INSERT` → rename → truncate → drop → read-only session refuses
writes → open the bundled `examples/demo.db` and validate its shape.

---

## Troubleshooting

### `pnpm app:dev` fails with `failed to run 'cargo metadata' … program not found`

`cargo` is not on your `PATH`. Add `%USERPROFILE%\.cargo\bin` (Windows) or
`~/.cargo/bin` and open a **new** terminal — an editor's integrated terminal keeps
the environment it was started with, so a new tab is not enough. To refresh the
current session without restarting:

```powershell
$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')
```

### The app exits immediately with `Failed to setup app: Access denied (os error 5)`

WebView2 keeps a browser profile on disk and Tauri writes it to
`app_local_data_dir()`. If that location is not writable, startup aborts before
any OpenCat code runs.

OpenCat handles this: on start it probes `%LOCALAPPDATA%`, `%APPDATA%`,
`%USERPROFILE%`, `%TEMP%` and finally the project directory, and points WebView2
at the first one that accepts a write. The rejected candidates are printed at
startup as information, not as errors. To choose a location yourself:

```powershell
$env:WEBVIEW2_USER_DATA_FOLDER = "D:\opencat\webview2"
```

If OpenCat had to fall back to the project directory, your connections and
settings live in `<project>/.opencat-data/` (already gitignored). Do not run
`git clean -fdx`, and remember that deleting the project deletes them.

### The app builds but the window never appears

Check the process is alive (`Get-Process opencat`) and that no other instance is
holding the WebView2 profile. WebView2 requires the profile directory to be
exclusive per running instance.

---

## Known limitations

- **SSH tunnelling is configured but not connected.** Jump host, key and
  passphrase are modelled, encrypted and carried through the session, but the
  port-forward is not implemented yet — ticking the box does not open a tunnel.
- **No visual query plan.** `EXPLAIN` returns the engine's text output; there is
  no plan tree.
- **No ER diagram and no database-to-database transfer.**
- **A few PostgreSQL types** (`money`, custom domains, geometry) degrade to a
  `<TYPE>` placeholder instead of a structured value. Common types, arrays
  included, render properly.
- **MariaDB does not support `max_execution_time`**; the session guard fails
  silently and the client-side timeout applies instead.
- **The table designer does not handle partitioned or inherited tables.**
- **Views** can only have their name changed in the designer; replace the
  definition from the SQL editor.

---

## Roadmap

1. **SSH tunnelling** — local port forwarding with `russh`, wiring up the settings
   that already exist
2. **Query plan visualisation** — render `EXPLAIN` output as a node tree
3. **Data transfer** — database-to-database and table-to-table migration
4. **ER diagrams** — automatic layout from foreign keys
5. **OS keychain** — replace `master.key` with the platform credential store
6. **More engines** — SQL Server, Oracle, Redis
7. **Internationalisation** — an i18n framework and a fully localised UI

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for the development workflow, code style
and commit conventions. Issues and pull requests are welcome.

```bash
pnpm install
pnpm app:dev
cargo test && pnpm typecheck
```

---

## License

Apache License 2.0 — see [LICENSE](LICENSE).

The icon and the sample database are covered by the same licence.
