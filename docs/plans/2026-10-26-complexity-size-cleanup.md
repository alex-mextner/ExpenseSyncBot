# Complexity and file-size cleanup (2026-10-26)

## Thresholds
- Per function: cognitive complexity <= 15, cyclomatic <= 20 (moznion/cccc).
- Per text file: <= 1200 lines OK, > 1200 warning, > 2400 error. `*.json` exempt.

## Scope
- Tracked + untracked-nonignored files (`git ls-files -co --exclude-standard`).
- Excluded: submodule `src/services/bank/ZenPlugins`, node_modules, build output, binaries, gitignored files.
- Included: source, tests, docs, `miniapp/`, `scripts/`.
- cccc languages: ts, tsx, js, jsx, mjs, cjs, mts, cts. Nested functions/arrows are separate functions.

## Tool
- cccc 1.8.4 (official `x86_64-unknown-linux-musl` release asset; `gh release verify-asset` passed).
- Archive sha256 `64b3084e05cf2f75d4af57268a2b898526c04be7bc31d0a36708081b13a64f97`;
  binary sha256 `e09bc0ec6e9b8e55a57188b0137fdb38a11bba3cc115be8f6ef28df7f4a1d578`.

## Baseline command
```
git ls-files -co --exclude-standard | grep -E '\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$' \
  | grep -v '^src/services/bank/ZenPlugins' > files.txt   # 410 files
xargs -a files.txt cccc --no-config --max-cognitive 15 --max-cyclomatic 20 > baseline.json
```
Exit code 123 (limits exceeded). 0 parse errors.

## Baseline numbers (HEAD 70ae8d4 + docs split already in progress)
- 410 files, 11506 functions analyzed.
- 115 functions over limits in 56 files: 69 cognitive-only, 1 cyclomatic-only, 45 both.
- Worst: `runQualitativeBacktest` (cog 256), `runBacktest` (173), `handleMiniAppRequest` (145/94),
  `runAgentLoop` (131), `handleCallbackQuery` (106/119).
- Oversized text files: at HEAD 23 (3 > 2400: bank-integration.md 3840, tool-executor.test.ts 2891,
  agent.test.ts 2753; sheets.test.ts is 2401 by `wc -l`, also error). The `.jpg` fixture is binary, out of scope.
  Counting a final line without trailing newline changes nothing.
- Worktree at measurement time: 19 (docs/ plan splits already applied for 4 files).

Artifacts (scratch): `/tmp/cccc-finance/{baseline.json,baseline-findings.md,baseline-oversized.md}`.

## Work grouping (by file ownership)
1. scripts/ (backtest-forecast, backtest-qualitative, replay-ai-logs, test-ocr-pipeline)
2. src/bot/ (handlers, commands, cron, services)
3. src/services/ai/ (agent, streaming, tool-executor, telegram-stream, stats, usage-report, reasoning-leak) + their oversized tests
4. src/services/analytics/ (incl. ta/)
5. src/services/google/ (sheets.ts and sheets.test.ts split, budget-migration, spreadsheet-repair)
6. src/services/{bank,currency,receipt,dev-pipeline}, src/web, src/utils, src/tooling, miniapp/
7. src/database/schema.ts size split; docs/ oversized plans/specs

## Final results
- Base HEAD: 70ae8d4.
- cccc (final run): exit 0, 520 files, 13382 functions, 0 findings, parse errors 0, thresholds 15/20. Baseline was 115 findings in 56 files, plus 7 python findings in `scripts/*.py` found in the all-language rerun; all fixed.
- Oversized text files (>1200 lines): 23 -> 0 (none >2400).
- Server gates: `bun install` 0, type-check 0, lint 0 (471 files), `bun run test` exit 0 with 231 files / 5233 tests (baseline 185 / 4398).
- The rig lint check is not usable yet (exit 2, invalid choice), so cccc was run directly.
- Scratch: `~/scratch/esb-cccc-final4-20261026T205532Z`; report: `/home/ultra/.local/state/rig-cccc-20261026/finance-final-verify4.md`.
