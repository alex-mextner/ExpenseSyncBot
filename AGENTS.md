# Agent instructions

Read `CLAUDE.md` for the repository-wide development rules.

## Tests

- Run the **full test suite with `bun run test`**. This invokes `scripts/test-runner.ts`, which isolates test files in separate processes so `mock.module()` state cannot leak between files. On the shared workstation run it on Runpod — `runpod-run -- bun run test` (CLAUDE.md, "Heavy work runs on Runpod").
- Do **not** use bare `bun test` as the full-suite gate. Running every file in one Bun process can produce cross-file mock pollution and misleading failures.
- For one focused test file, use `bun test <path-to-test>` (or `bun run test:single -- <path>` when appropriate) — locally, one file is the limit.
- For coverage, use `bun run test:coverage` (also on Runpod); coverage intentionally uses Bun's single-process coverage mode and is a different gate from the isolated full suite.
- Before claiming a change is shippable, run the repository's normal type-check/lint plus `bun run test` (via `runpod-run`), and report the exact command and exit status.

When a raw `bun test` result conflicts with `bun run test`, treat the isolated project runner as the authoritative full-suite result and investigate any runner/reporting anomaly separately rather than changing product code to satisfy cross-file mock leakage.
