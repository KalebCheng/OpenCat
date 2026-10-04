<!--
  Thanks for contributing. Keep the sections that apply and delete the rest.
  The "How this was verified" section matters most — please be specific.
-->

## What this changes

<!-- One or two sentences. What behaviour is different after this PR? -->

## Why

<!-- The motivation: a bug report, a limitation you hit, a follow-up to #123. -->

## How this was verified

<!--
  Be concrete. Examples:
    - `cargo test --all` — all 91 tests pass
    - opened examples/demo.db, edited a row in `customers`, confirmed via the SQL editor
    - added `splits_on_dollar_quoted_bodies` to sqlite.rs covering the reported case
  "It compiles" is not verification.
-->

## Type of change

- [ ] Bug fix
- [ ] New feature
- [ ] Refactor (no behaviour change)
- [ ] Documentation
- [ ] Build / CI

## Checklist

- [ ] `cargo fmt --all -- --check` passes
- [ ] `cargo clippy --all-targets --all-features -- -D warnings` passes
- [ ] `cargo test --all` passes
- [ ] `pnpm typecheck` and `pnpm build` pass (if the frontend changed)
- [ ] New behaviour has a test, or the PR explains why it cannot be tested
- [ ] Public Rust items have doc comments and intra-doc links resolve
- [ ] `src/lib/types.ts` was updated alongside any serialized Rust field
- [ ] Screenshots or a recording are attached (for UI changes)

## Related issues

<!-- Closes #123 -->
