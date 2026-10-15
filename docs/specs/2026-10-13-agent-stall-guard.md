# Agent stall guard: soft budget, stall detection, nudge and mid-run handoff

Date: 2026-10-13. Ticket: HYP-1716. Status: phase 0 implemented on `feat/agent-stall-guard`; phases 1–3 are a roadmap.

## 1. Problem

The agent loop (`src/services/ai/agent.ts`) stopped after a hard cap of 10 tool rounds. On 2026-10-12 the smart-chain head (Groq `openai/gpt-oss-120b`, one tool call per round) spent three of Lena's runs in a row on one `calculate` per round and never answered. The prod chat log (`logs/chats/-1003207640556/2026-10-12_11-51-56.log`) shows the three failing runs:

| run | tool rounds (A, B, … = distinct `calculate` arguments) |
|---|---|
| 11:53 | `get_expenses`, A, B, C, D, E, F, G, H, I |
| 11:55 | `get_expenses`, A, A, A, A, B, C, B, D, E |
| 11:58 | `get_expenses`, A, B, B, B, C, B, X, D, E |

PR #158 added the forced final round (tools declared, `tool_choice: 'none'`), so a capped run now answers from what it gathered. Still, a hard cap either cuts a healthy long run or lets a stuck model burn the whole budget, and nothing switches to a model that would answer.

Healthy baseline: all 174 runs in the prod chat logs (2026-09…2026-10-12, hashed features only, extracted in memory) have at most 6 tool rounds; the only runs with more are the three above.

## 2. Plan of record (option C, by phases)

- **Phase 0 (this spec, no ML):** a soft budget with safety caps, deterministic stall rules, nudge → handoff to the next provider → forced final round, and per-round trajectory logging as the dataset for phases 1–2.
- **Phase 1 — data (Runpod, never odroid):** real threads from `agent_trajectories` + `logs/chats`; outcome labels from the run outcome and the follow-up gap; synthetic failures injected into healthy threads at a known step (repeat, A/B alternation, one-at-a-time `calculate`, dropped final answer); a sandbox agent (in-memory DB, fake sheet) run on generated questions through Groq 20b/120b, GLM, Claude, Qwen. Contested labels by an offline LLM annotator. Target 3–5k threads; the hold-out set is real threads only.
- **Phase 2 — training:** classes `continue | nudge | handoff | finalize` (the same typed decision as phase 0). B: gradient boosting over the phase-0 features (in-process TS, <1 ms). A: LoRA Kev-0.8B or Laya-multilingual fine-tune on Runpod. Compared on the real failures, including the 2026-10-12 runs.
- **Phase 3 — rollout:** shadow mode first (the classifier only logs its decision next to the rules' decision); switch on when hold-out accuracy ≥ 95 % and false alarms on healthy runs ≤ 2 %. A joins as a second tier only if it beats B on the cases B is unsure about.

## 3. Phase 0 behaviour

### 3.1 Budget

| constant | value | why |
|---|---|---|
| `MAX_TOOL_ROUNDS` | 40 | crash guard only; healthy prod max is 6 tool rounds, a 15-item bulk add on a one-call-per-round model needs 15 |
| `RUN_DEADLINE_MS` | 240 000 | the AbortController deadline of one run (all rounds and retries), was 180 000 |
| `FINAL_ROUND_RESERVE_MS` | 45 000 | equals `PER_PROVIDER_TIMEOUT_MS` (streaming.ts): tool rounds only get the time up to 195 s — the guard finalizes a round that ends past it, and a round still running at 195 s is cut (its own abort signal) — so the forced final round still gets one full provider attempt before the hard abort |

Nothing else assumes the old 180 s: per-provider timeouts stay 45 s, the Telegram typing interval runs for as long as the writer lives, and edits have no time limit. Tool calls of a round are not started once 195 s have passed (they get a "Not run: no time left" tool message; a started tool is never aborted, so writes stay whole — `executeTool` takes no signal). The validator re-run shares the run deadline: its abort timer gets the time left since the run started, not a fresh 240 s.

### 3.2 Records

After every round that ran tools the agent records:

```
RoundRecord { round, provider, elapsedMs, calls: ToolCallRecord[] }
ToolCallRecord { tool, argsHash, resultHash, isError }
```

`argsHash` hashes the canonical JSON of the arguments, `resultHash` the tool message content (without the "already made" marker), both with `Bun.hash` and a random per-run seed: equal within a run, meaningless across runs, so the stored features cannot be matched back to amounts.

### 3.3 Signals (`src/services/ai/stall-guard.ts`, pure)

Evaluated after each tool round over the current *segment* — the rounds since the last nudge or handoff, so a model that was just told (or a model that just took over) starts clean. Each signal fires on the latest round:

| signal | rule | value | justification |
|---|---|---|---|
| `repeated_call` | a call with the same tool, args and result occurs this many times in the segment | 3 | the second identical read already gets the "already made" marker (#158); the third means the model ignored it. Same args with a *different* result (re-reading budgets after `set_budget`) is not a repeat. 11:55 fires on round 4, 11:58 on round 5 |
| `cheap_tool_streak` | trailing rounds made only of `calculate` calls | 4 | one-at-a-time conversion is the 2026-10-12 failure; the longest `calculate`-only streak in the 171 healthy prod runs is 3 (one run; 3 runs have 2, 23 have 1). 11:53 fires on round 5. Write tools never count: a bulk `add_expense` per round is legitimate work |
| `error_streak` | trailing rounds where every call failed | 3 | two failures can be a typo and a fix; a third means the model is not reading the error |
| `alternation` | the last 4 round signatures are X, Y, X, Y with X ≠ Y | 4 | OpenHands' A/B loop; signatures include the result, so get/set pairs on changing data never match |
| `no_new_info` | trailing rounds whose every result was already seen earlier in the run | 3 | three rounds that add nothing new to the context |

A round signature is its sorted `tool|args|result` call keys. Rounds with parallel calls count once.

### 3.4 Decision ladder

`StallGuard.next(round, canHandoff)` returns:

1. `finalize: round_cap` at 40 tool rounds; `finalize: time_budget` once `elapsedMs ≥ RUN_DEADLINE_MS − FINAL_ROUND_RESERVE_MS`.
2. No signal → `continue`.
3. First signal of the run → `nudge` (once per run).
4. Later signals → `handoff` while fewer than 2 handoffs happened and another provider is left; otherwise `finalize` with the signal as reason.

Replayed incidents: 11:53 nudge after round 5, handoff after round 9; 11:55 nudge after 4, handoff after 8; 11:58 nudge after 5, handoff after 9. All 171 healthy prod runs: `continue` on every round.

### 3.5 Agent actions

- **nudge:** push a `[SYSTEM]` user message: stop repeating, answer if the results above suffice, else change approach (one `get_expenses` with `summary_only` + `currency`, or one `calculate` with the whole expression).
- **handoff:** the provider that answered the stalled round is excluded for the rest of the run (`aiStreamRound({ excludeProviders })`, filtered before the breaker ordering, so the next provider is whatever the health-ordered smart chain puts first). The history — every tool call and result so far — stays; a `[SYSTEM]` message tells the new model the previous one got stuck and the results are real. The work log gets `🔄 Передаю задачу <provider>…` (`TelegramStreamWriter.addWorkLogNote`). `canHandoff` is false when no other provider is left (`nextProvider('smart', excluded)` is null).
- **finalize:** the existing forced final round (#158), also with the excluded providers skipped. Such a run never ends in silence — the flag is run-level, so a validator re-run after a forced answer cannot turn it into silence either.

### 3.6 Trajectory logging (migration `052_create_agent_trajectories`)

`agent_trajectories` — one row per `run()`: `group_id` (FK, cascade), `started_at`/`finished_at` (epoch ms), `outcome` (`answered | no_answer | silent | error`), `error_kind`, `is_mention`, `tool_rounds`, `tool_calls`, `nudges`, `handoffs`, `providers` (JSON array in first-use order), `answer_provider`, `finalize_reason`, `follow_up_after_ms`.

`agent_trajectory_rounds` — one row per tool round: `trajectory_id` (FK, cascade), `round`, `provider`, `elapsed_ms`, `calls` (JSON `ToolCallRecord[]`), `decision`, `reason` (signal or finalize reason).

`follow_up_after_ms`: when the next agent run in the same group starts within 5 minutes of a run's end, the previous row gets the gap (the cheap stand-in for "ты завис?"; the text is not stored). No message text, tool arguments or results are stored. A logging failure is logged and never reaches the user.

## 4. Non-goals (phase 0)

- No learned model, no Runpod calls in the loop, nothing heavier than hashing on odroid.
- No deterministic answer verifier (recompute totals from tool results) — candidate for phase 1 labels.
- No retention job for the new tables (rows are ~100 bytes; revisit when phase 1 exports the data).
