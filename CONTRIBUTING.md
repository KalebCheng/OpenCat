# Contributing to OpenCat

Thanks for taking the time to contribute. This document covers everything you
need to get a change from your machine into the repository.

---

## Table of contents

- [Getting set up](#getting-set-up)
- [Repository layout](#repository-layout)
- [Code style](#code-style)
- [Writing comments](#writing-comments)
- [Tests](#tests)
- [Commit messages](#commit-messages)
- [Pull requests](#pull-requests)
- [Releases](#releases)

---

## Getting set up

```bash
git clone https://github.com/KalebCheng/OpenCat.git
cd OpenCat
pnpm install
pnpm app:dev
```

`pnpm app:dev` starts Vite on port 1420 and runs `cargo run` for the desktop
shell, with hot reload on both sides.

Before opening a pull request, make sure the same checks CI runs pass locally:

```bash
cargo fmt --all -- --check
cargo clippy --all-targets --all-features -- -D warnings
cargo test --all
pnpm typecheck
pnpm build
```

### Prerequisites

| Component | Version |
|---|---|
| Node.js | ≥ 20 |
| pnpm | ≥ 9 |
| Rust | ≥ 1.80 (stable) |

Linux also needs `libwebkit2gtk-4.1-dev`, `libgtk-3-dev`,
`libayatana-appindicator3-dev`, `librsvg2-dev` and `patchelf`. See the
[README](README.md#building-from-source) for the Windows GNU-toolchain variant.

---

## Repository layout

```
crates/opencat-core      Engine-agnostic model, values, SQL helpers, persistence
crates/opencat-driver    The Driver trait and one implementation per engine
src-tauri                Desktop shell: state, plugins and the IPC command surface
src                      React frontend
  lib/                   types.ts (mirrors the Rust model) and ipc.ts
  store/                 zustand stores
  components/ui/         Design system primitives
  features/              One directory per feature area
tools                    Icon and sample-database generators
```

See the [README](README.md#architecture) for how the layers fit together and why.

---

## Code style

### Rust

`rustfmt.toml` is the source of truth — run `cargo fmt --all` before committing.
Only stable rustfmt options are configured, so formatting is identical on stable
and in CI.

`cargo clippy -- -D warnings` is enforced. If you genuinely need to suppress a
lint, use a scoped `#[allow(...)]` with a comment explaining why; a blanket
allow on a module will be questioned in review.

A few conventions worth knowing:

- **Errors** are `CoreError` in the library crates and `CmdError` at the command
  boundary. Never `unwrap()` on anything derived from user input or the network.
- **Public items get doc comments.** Intra-doc links are checked in CI
  (`RUSTDOCFLAGS=-D warnings`), so a stale `[`link`]` will fail the build.
- **The driver layer must stay engine-agnostic above the `Driver` trait.** If you
  find yourself matching on `DbKind` in `src-tauri`, the logic probably belongs
  in `opencat-driver`.
- **SQL is built from escaped literals, not bound parameters** for row edits —
  see the README for why. Use `opencat_core::sql::escape_literal` rather than
  writing your own quoting.
- Prefer small, focused functions. When a function grows past seven parameters,
  it usually wants a struct (see `common::PageQuery`).

### TypeScript / React

- `tsc --noEmit` runs in `strict` mode with `noUnusedLocals` and
  `noUnusedParameters`. Unused imports fail the build.
- **No `any`.** If a type is genuinely unknown, use `unknown` and narrow it.
- **Components never call `invoke` directly.** Everything goes through
  `src/lib/ipc.ts`, which normalises failures into `ErrorPayload`.
- **`src/lib/types.ts` mirrors the Rust model.** If you change a serialized Rust
  field, change its TypeScript counterpart in the same commit.
- Styling uses the design tokens in `src/styles/globals.css`
  (`bg-surface`, `text-muted`, …). Avoid raw hex values so both themes keep
  working.
- Keep feature code inside its own `src/features/<area>/` directory, and import
  the UI primitives rather than redefining buttons and inputs.

### Formatting configuration

`.editorconfig` covers editors that read it. `.gitattributes` normalises every
text file to LF so Windows checkouts do not produce line-ending churn that shows
up as a spurious diff against `cargo fmt --check`.

---

## Writing comments

Comments explain **why**, not **what**. The code already says what it does.

Good:

```rust
// Non-NULL values use a plain `=`, which keeps the predicate index-friendly:
// `IS NOT DISTINCT FROM` is a barrier to index scans on PostgreSQL.
```

Not useful:

```rust
// Increment the counter.
counter += 1;
```

Guidelines:

- **English**, in a measured, factual voice. No exclamation marks, no jokes at
  the reader's expense.
- Document the *decision* behind anything surprising: a workaround, a spec
  quirk, a performance tradeoff, a deliberately duplicated branch.
- Module-level `//!` docs should say what the module is for and what a reader
  needs to know before changing it.
- When you work around a dependency bug, name the dependency and the version.
- Do not leave commented-out code. Git remembers it.

---

## Tests

- Every bug fix gets a regression test.
- Pure logic (SQL generation, statement splitting, type mapping, CSV parsing)
  belongs in unit tests next to the code.
- Anything that touches the database end to end belongs in
  `crates/opencat-driver/tests/end_to_end.rs`, which runs against a real SQLite
  file in a temporary directory.
- MySQL and PostgreSQL behaviour is covered by unit tests over the generated
  SQL, because CI does not run those servers. If you add a query that cannot be
  covered that way, say so in the pull request.

Run everything with:

```bash
cargo test --all
```

The sample database `examples/demo.db` is asserted against by the test suite. If
you change `tools/make_demo_db.py`, regenerate it and commit the result:

```bash
python tools/make_demo_db.py
```

---

## Commit messages

[Conventional Commits](https://www.conventionalcommits.org/), with an optional
scope naming the area:

```
feat(driver): add SQLite rowid fallback for keyless tables
fix(ui): keep the grid header aligned when the viewport is narrow
docs: document the WebView2 profile fallback
refactor(core): replace the manual Default impls with derives
test(driver): cover the no-op MySQL alter case
chore(ci): cache the Rust build across bundle jobs
```

Types in use: `feat`, `fix`, `docs`, `refactor`, `test`, `chore`, `perf`,
`build`, `ci`.

Guidelines:

- Imperative mood, lower case, no trailing period.
- One logical change per commit.
- Explain the *reason* in the body when it is not obvious from the diff — the
  diff shows what changed, the body should say why.

---

## Pull requests

1. Branch from `main`.
2. Keep the change focused; unrelated cleanups belong in their own PR.
3. Make sure the checks in [Getting set up](#getting-set-up) pass.
4. Fill in the pull request template — in particular, say how you verified the
   change. "It compiles" is not verification.
5. If the change affects the UI, include a screenshot or a short recording.

CI runs on every pull request: formatting, clippy with `-D warnings`, the full
test suite, `rustdoc` with warnings denied, and a frontend type check and build.

---

## Releases

Releases are driven by tags.

```bash
# bump the version in Cargo.toml, src-tauri/tauri.conf.json and package.json
git commit -am "chore(release): v0.2.0"
git tag v0.2.0
git push origin main --tags
```

The `Release` workflow then builds installers for Windows, macOS (universal) and
Linux, and attaches them to a **draft** GitHub Release. Review the draft and
publish it when you are happy.

Pushing to `main` without a tag runs the `Bundle` workflow instead, which
produces the same installers as downloadable workflow artifacts without creating
a release.

macOS and Windows bundles are unsigned unless the signing secrets listed in
`.github/workflows/release.yml` are configured.
