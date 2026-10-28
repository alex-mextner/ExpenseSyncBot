# Agent Stall Guard (phase 0) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the hard 10-round agent cap with a soft budget (40 rounds / 240 s), deterministic stall rules that nudge, hand the run to the next smart-chain provider and finally force an answer, and log every run's per-round features for phases 1–2.

**Architecture:** A pure `StallGuard` (src/services/ai/stall-guard.ts) consumes one `RoundRecord` per tool round and returns a typed decision. `ExpenseBotAgent.runAgentLoop` acts on it: nudge message, provider exclusion via a new `aiStreamRound` option, work-log note, or the existing forced final round. `run()` writes one `agent_trajectories` row plus its rounds through a new repository.

**Tech Stack:** Bun, TypeScript, bun:sqlite, bun:test, OpenAI SDK chain in streaming.ts.

**Spec:** docs/specs/2026-10-13-agent-stall-guard.md

## Global Constraints

- Ticket ref in every commit: `Refs HYP-1716`.
- `MAX_TOOL_ROUNDS = 40`, `RUN_DEADLINE_MS = 240_000`, `FINAL_ROUND_RESERVE_MS = 45_000`, `REPEATED_CALL_LIMIT = 3`, `CHEAP_TOOL_STREAK_LIMIT = 4`, `ERROR_STREAK_LIMIT = 3`, `ALTERNATION_ROUNDS = 4`, `STALE_ROUND_STREAK_LIMIT = 3`, `MAX_HANDOFFS = 2`, cheap tools = `calculate` only.
- Work-log line exactly `🔄 Передаю задачу <provider>…` (provider = slot name, e.g. `z.ai (glm-5.1)`).
- No message text, tool arguments or tool results in the DB — only tool names, per-run-seeded hashes, provider names, timings, decisions.
- No `any`, no `Record<string, unknown>`; logger mocked and asserted in every test; one test file at a time locally, full suite only via `server-run -- bun run test`.
- New migration only (`052_create_agent_trajectories`); never edit earlier ones.
- File header comment on every new file.

## Review Focus

- A healthy bulk write (15 × `add_expense`, one per round) must never be nudged — owned by Task 1 (`healthy bulk add` test).
- Re-reading the same data after a write (`get_budgets` → `set_budget` → `get_budgets` …) must not count as a repeat or alternation — Task 1 (`bulk budget` test).
- A chain with a single provider left must finalize instead of handing off into an empty chain — Task 1 (`canHandoff false` test) and Task 5 (agent test with `nextProvider` → null).
- A trajectory write failure (FK error, locked DB) must not change the answer the user gets — Task 5 (`recording failure` test asserts the answer and `logger.error`).
- A retried attempt (runWithRetry) keeps the excluded providers and the guard state — Task 5 (`retry keeps exclusion` test).

---

### Task 1: Pure stall detector

**Files:**
- Create: `src/services/ai/stall-guard.ts`
- Test: `src/services/ai/stall-guard.test.ts`

**Interfaces:**
- Produces:
  - constants listed in Global Constraints (exported), `CHEAP_TOOLS: ReadonlySet<string>`
  - `interface ToolCallRecord { tool: string; argsHash: string; resultHash: string; isError: boolean }`
  - `interface RoundRecord { round: number; provider: string; elapsedMs: number; calls: ToolCallRecord[] }`
  - `type StallSignal = 'repeated_call' | 'cheap_tool_streak' | 'error_streak' | 'alternation' | 'no_new_info'`
  - `type FinalizeReason = 'round_cap' | 'time_budget' | StallSignal`
  - `type StallDecision = { action: 'continue' } | { action: 'nudge' | 'handoff'; signal: StallSignal } | { action: 'finalize'; reason: FinalizeReason }`
  - `function detectStall(rounds: readonly RoundRecord[], segmentStart: number): StallSignal | null`
  - `class StallGuard { next(round: RoundRecord, canHandoff: boolean): StallDecision; get entries(): readonly GuardEntry[]; get nudges(): number; get handoffs(): number }` with `interface GuardEntry extends RoundRecord { decision: StallDecision }`
  - `function hashFeature(text: string, seed: number): string`

- [ ] **Step 1: Write the failing tests** — per signal (`repeated_call` fires on the 3rd identical call+result, not on same args with a new result; `cheap_tool_streak` fires on the 4th calculate-only round and not after a non-calculate round breaks it; `error_streak` on 3 all-error rounds; `alternation` on X,Y,X,Y; `no_new_info` on 3 stale rounds); ladder (first signal → nudge, next → handoff, after 2 handoffs → finalize with the signal; `canHandoff=false` → finalize); caps (`round_cap` at round 40, `time_budget` at 195 000 ms); segment reset after nudge/handoff; replays of the three 2026-10-12 runs (spec §1) asserting nudge/handoff rounds 5/9, 4/8, 5/9; healthy: a 6-tool mixed run, 15 × add_expense, get/set budget interleave, 5 pages of get_expenses → all `continue`; `hashFeature` equal for equal text+seed, different across seeds.
- [ ] **Step 2: Run** `bun test src/services/ai/stall-guard.test.ts` — expect FAIL: cannot find module `./stall-guard`.
- [ ] **Step 3: Implement** the module. Round signature = sorted `tool|argsHash|resultHash` keys joined by `;`. Seen-results set covers every earlier round of the run plus earlier calls of the same round. Caps are checked before signals.
- [ ] **Step 4: Run** the same command — expect PASS.
- [ ] **Step 5: Commit** `feat(ai): pure stall detector for agent tool rounds` (Refs HYP-1716).

### Task 2: Provider exclusion in the chain

**Files:**
- Modify: `src/services/ai/streaming.ts` (StreamRoundOptions, aiStreamRound chain build)
- Test: `src/services/ai/streaming.test.ts`

**Interfaces:**
- Produces: `StreamRoundOptions.excludeProviders?: readonly string[]` (slot names = `StreamRoundResult.providerUsed`); `function nextProvider(chain: ChainName, exclude: readonly string[]): string | null` — first slot of the health-ordered chain without the excluded ones.

- [ ] **Step 1: Failing tests** — `chainModels('smart', ['Groq (groq-smart)'])` returns `['test-model', 'claude-smart', 'hf-test']`; `nextProvider('smart', [])` is `Groq (groq-smart)`; with Groq excluded it is `z.ai (test-model)`; all excluded → `null`; a demoted z.ai makes `nextProvider` skip to Claude (breaker order reused).
- [ ] **Step 2: Run** `bun test src/services/ai/streaming.test.ts` — FAIL (`nextProvider` is not a function / Groq still called).
- [ ] **Step 3: Implement** one private `availableSlots(chain, exclude, now)` = `orderByHealth(buildChain(chain).filter(...), now)` used by both.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ai): let a round skip named providers of the chain` (Refs HYP-1716).

### Task 3: Work-log note

**Files:**
- Modify: `src/services/ai/telegram-stream.ts`
- Test: `src/services/ai/telegram-stream.test.ts`

**Interfaces:**
- Produces: `TelegramStreamWriter.addWorkLogNote(note: string): Promise<void>` — appends a display-safe (neutralized HTML) line to the work log and force-flushes.

- [ ] **Step 1: Failing test** — after a tool step and `addWorkLogNote('🔄 Передаю задачу z.ai (glm)…')`, the finalized message's blockquote contains the note line after the ✅ step; `<b>` in a note is shown escaped.
- [ ] **Step 2: Run** `bun test src/services/ai/telegram-stream.test.ts` — FAIL (not a function).
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(ai): work log can show a note line` (Refs HYP-1716).

### Task 4: Trajectory table and repository

**Files:**
- Modify: `src/database/schema.ts` (migration `052_create_agent_trajectories`), `src/database/index.ts` (`agentTrajectories`), `src/database/types.ts`
- Create: `src/database/repositories/agent-trajectory.repository.ts`
- Test: `src/database/repositories/agent-trajectory.repository.test.ts`

**Interfaces:**
- Consumes: `ToolCallRecord`, `StallDecision['action']` (type-only) from Task 1.
- Produces:
  - `type AgentRunOutcome = 'answered' | 'no_answer' | 'silent' | 'error'`
  - `interface CreateAgentTrajectoryData { groupId; startedAt; finishedAt; outcome; errorKind: string | null; isMention: boolean; toolCalls: number; nudges: number; handoffs: number; providers: string[]; answerProvider: string | null; finalizeReason: string | null; rounds: AgentTrajectoryRoundData[] }`
  - `interface AgentTrajectoryRoundData { round; provider; elapsedMs; calls: ToolCallRecord[]; decision: StallDecision['action']; reason: string | null }`
  - `AgentTrajectoryRepository.create(data): number` (one transaction), `markFollowUp(groupId: number, now: number): void` (sets `follow_up_after_ms` on the group's latest row finished within 5 min that has none)
  - `database.agentTrajectories`

- [ ] **Step 1: Failing tests** — create stores run + rounds (calls JSON round-trips), `tool_rounds` = rounds length; deleting the group cascades; outcome CHECK rejects an unknown value; markFollowUp sets the gap for a run finished 2 min ago, leaves one finished 6 min ago, never overwrites, ignores other groups.
- [ ] **Step 2: Run** `bun test src/database/repositories/agent-trajectory.repository.test.ts` — FAIL (module missing).
- [ ] **Step 3: Implement** migration + repository + registration.
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Commit** `feat(db): agent trajectory tables for stall-classifier data` (Refs HYP-1716).

### Task 5: Agent integration

**Files:**
- Modify: `src/services/ai/agent.ts`, `src/services/ai/agent.test.ts`

**Interfaces:**
- Consumes: Tasks 1–4.
- Produces: `protected now(): number` test seam on `ExpenseBotAgent`.

- [ ] **Step 1: Failing tests** (streaming mock gains `nextProvider`; a group row with id 1 is inserted for FK):
  - one-at-a-time calculate run: nudge message after round 4 (`[SYSTEM]`, no tool_choice change), handoff after round 8 with `excludeProviders` containing the stalled provider in every later call (including the forced final round), work log edit contains `🔄 Передаю задачу`, second handoff after round 12, finalize after round 16 (forced round, `toolChoice: 'none'`), answer returned;
  - `nextProvider` → null: the second signal finalizes instead of handing off;
  - 40-round cap with distinct non-stalling tool rounds → forced final at 41st call;
  - time budget: `now()` past 195 s → forced final round; deadline timer registered with 240 000 ms;
  - trajectory row written with outcome `answered`/`no_answer`/`silent`/`error`, round rows with decisions; no question text in any column;
  - follow-up: a second run within 5 min sets `follow_up_after_ms` on the first row;
  - recording failure (spy `create` throws) → answer unchanged, `logger.error` called;
  - retry keeps exclusion: a 5xx after a handoff retries with the same `excludeProviders`.
  - Existing tests that assumed the 10-round cap are updated to the new ladder (they used one-at-a-time calculate/add_expense loops).
- [ ] **Step 2: Run** `bun test src/services/ai/agent.test.ts` — FAIL on the new expectations.
- [ ] **Step 3: Implement** — `AGENT_TIMEOUT_MS` → `RUN_DEADLINE_MS`; per-run state (guard, excluded providers, seed, providers used, finalize reason, started-at) reset in `run()`; records built from the same content pushed as tool messages; nudge/handoff prompts as module constants; `recordTrajectory()` called on every exit path inside try/catch.
- [ ] **Step 4: Run** — PASS; also `bun run type-check`, `bun run lint`.
- [ ] **Step 5: Commit** `feat(ai): soft budget with stall nudge, handoff and trajectory logging` (Refs HYP-1716).

### Task 6: Docs and full verification

**Files:**
- Modify: `CLAUDE.md` (agent loop rules, repository list)

- [ ] **Step 1:** Update the agent-loop bullet (40 rounds / 240 s, stall ladder, handoff line) and add `agent-trajectory.repository.ts` to the repository list.
- [ ] **Step 2:** `bunx knip`, self-review, `codex exec review --uncommitted`.
- [ ] **Step 3:** `server-run -- bun run test` — all green.
- [ ] **Step 4:** Commit `docs: agent stall guard rules` (Refs HYP-1716), push the branch.
