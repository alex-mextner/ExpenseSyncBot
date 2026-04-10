# AI Unified Streaming — Implementation Plan

**Goal:** Replace the dual `completion.ts` + `streaming.ts` setup with a single unified streaming API backed by three provider chains (SMART / FAST / OCR). Stream progress for every AI-backed user-visible action. Add tool-based validation for OCR output (sum-of-items must match total, items must be sensible).

**Status:** branch `worktree-ai-unified-streaming`

---

## Architecture

**One module:** `src/services/ai/streaming.ts` exposes `aiStreamRound(options, callbacks?)`. Callbacks are optional — UI-facing callers pass `{onTextDelta, onToolCallStart}`, backend callers omit them and collect the full result at the end.

**Three chains** selected via `options.chain: 'smart' | 'fast' | 'ocr'`:

| Chain | Providers | Use |
|---|---|---|
| `SMART_CHAIN` | z.ai `AI_MODEL` → Gemini `GEMINI_MODEL` → HF `HF_MODEL` | Heavy reasoning: agent, ai-extractor (receipt parsing), dev-agent, codex-integration, advice, receipt-summarizer, **OCR post-validation (correctness > speed)** |
| `FAST_CHAIN` | z.ai `AI_FAST_MODEL` → Gemini `GEMINI_FAST_MODEL` → HF `HF_FAST_MODEL` | Cheap backend: response validator, bank prefill, merchant-agent |
| `OCR_CHAIN` | Gemini `GEMINI_VISION_MODEL` → HF `HF_VISION_MODEL` | Vision only: receipt OCR (raw image → text). Z.ai has no vision endpoint here, chain is two-slot |

**Why three chains, not two:**
- calbot's plan only has smart + fast because it has no OCR/vision needs.
- We do OCR, so a dedicated vision chain is natural. It has different models (Gemini `2.5-flash` → Qwen2.5-VL-72B) and different semantics (pure image→text, no tool calling in OCR step itself).
- Post-OCR validation (sum checking, sanity) is a separate agent round that uses `FAST_CHAIN` with tool calling — not the OCR chain.

**Client module:** `src/services/ai/clients.ts` with three lazy-initialized `OpenAI` instances (z.ai, HF, Gemini). No hardcoded URLs — everything from env. Single source of truth for all chains to consume.

**Streaming everywhere:** every user-visible AI call shows progress. Not just `"AI думает..."` — the actual text deltas render into the Telegram message as they arrive (same pattern as current `agent.ts` + `TelegramStreamWriter`). Backend-only calls (validator, prefill, merchant-agent) collect silently.

**z.ai coding endpoint quirk (from calbot plan):** the coding endpoint returns `content: ''` and populates `reasoning_content` for pure text responses with no tool calls. If a provider returns 200 OK with empty text AND no tool calls, treat as provider failure → fall through to next in chain.

---

## Chain defaults (env)

Same models as calbot for text chains. OCR keeps current Gemini Flash + Qwen-VL.

```env
# z.ai (primary provider)
ANTHROPIC_API_KEY=<z.ai key>           # kept as legacy name, it's the z.ai key
AI_BASE_URL=https://api.z.ai/api/coding/paas/v4   # coding endpoint per calbot
AI_MODEL=glm-5.1
AI_FAST_MODEL=glm-4.5-flash

# HuggingFace
HF_TOKEN=<hf token>
HF_BASE_URL=https://router.huggingface.co/v1
HF_MODEL=Qwen/Qwen3-235B-A22B
HF_FAST_MODEL=meta-llama/Llama-3.3-70B-Instruct
HF_VISION_MODEL=Qwen/Qwen2.5-VL-72B-Instruct

# Google Gemini
GEMINI_API_KEY=<gemini key>
GEMINI_BASE_URL=https://generativelanguage.googleapis.com/v1beta/openai/
GEMINI_MODEL=gemini-2.5-pro
GEMINI_FAST_MODEL=gemini-2.5-flash
GEMINI_VISION_MODEL=gemini-2.5-flash
```

All 12 AI env vars are **required** — no hardcoded defaults, no silent fallback to placeholders.

Keys for HF and Gemini are taken from calbot's `.env` (same accounts). z.ai key kept as the one currently in ExpenseSyncBot (`28eec97dee5f...` / glm account).

---

## File plan

| Action | Path | What changes |
|---|---|---|
| Create | `src/services/ai/clients.ts` | Three lazy OpenAI SDK clients (z.ai, HF, Gemini) |
| Rewrite | `src/services/ai/streaming.ts` | `aiStreamRound()` with 3 chains, per-chain provider slots, fallback + retry logic, empty-response quirk handling |
| Delete | `src/services/ai/completion.ts` | Replaced by streaming.ts |
| Modify | `src/services/ai/agent.ts` | Call `aiStreamRound({chain:'smart'})`, validator always-on via fast chain |
| Modify | `src/services/ai/response-validator.ts` | `aiStreamRound({chain:'fast'})`, drop `_apiKey` param |
| Modify | `src/services/ai/tools.ts` | Already OpenAI format — no changes |
| Modify | `src/services/bank/prefill.ts` | Fast chain |
| Modify | `src/services/bank/merchant-agent.ts` | Fast chain |
| Modify | `src/services/receipt/ocr-extractor.ts` | Use `aiStreamRound({chain:'ocr'})`, keep image data URL pattern |
| Create | `src/services/receipt/ocr-validator.ts` | Tool-calling agent that validates extracted items (sum check, sanity) |
| Modify | `src/services/receipt/ai-extractor.ts` | Smart chain + streaming progress callback into receipt scan UI |
| Modify | `src/services/receipt/photo-processor.ts` | Wire ocr-validator after ai-extractor; retry on validation failure |
| Modify | `src/services/receipt/receipt-summarizer.ts` | Smart chain + streaming |
| Modify | `src/services/dev-pipeline/dev-agent.ts` | Smart chain, keep existing writer |
| Modify | `src/services/dev-pipeline/codex-integration.ts` | Smart chain |
| Modify | `src/bot/commands/ask.ts` | Smart chain + streaming into advice message |
| Modify | `src/config/env.ts` | Add 4 new required vars: `AI_FAST_MODEL` (already), `HF_FAST_MODEL`, `GEMINI_FAST_MODEL`, `GEMINI_VISION_MODEL` |
| Modify | `.env`, `.env.example` | Add all new vars, update AI_BASE_URL to coding endpoint |
| Create | `scripts/verify-ai-chains.ts` | Smoke-test every slot of every chain; report which work |

Plus test updates for anything that mocks `aiComplete` today — they all need to mock `aiStreamRound` instead.

---

## Task breakdown

### Task 1: env config — add remaining required vars
- Add `HF_FAST_MODEL`, `GEMINI_FAST_MODEL`, `GEMINI_VISION_MODEL` to `EnvConfig` interface and `validateEnv()` (all required)
- `AI_BASE_URL` → `https://api.z.ai/api/coding/paas/v4` (switch to coding endpoint to match calbot)
- Update `.env` with values (HF token + Gemini key from calbot, z.ai key stays)
- Update `.env.example` with documentation

### Task 2: create `clients.ts`
Three lazy-initialized OpenAI clients. No side effects on import. All read from `env`.

### Task 3: rewrite `streaming.ts`
- `aiStreamRound(options, callbacks?)` — single entry point
- `StreamRoundOptions`: `messages`, `maxTokens`, `temperature?`, `tools?`, `chain: 'smart' | 'fast' | 'ocr'`, `signal?`
- `StreamCallbacks`: optional `onTextDelta`, `onToolCallStart`
- `StreamRoundResult`: `text`, `toolCalls`, `finishReason`, `assistantMessage`, `providerUsed`
- Three `ProviderSlot[]` builders — lazy, re-read env per call so tests can override (or wrap in memoized factory)
- Fallback rules (from calbot plan):
  - 5xx / timeout / 429 → try next
  - balance exhausted → alert admin, try next
  - text already streamed → propagate (can't splice)
  - empty response (coding endpoint quirk) → try next
  - 4xx non-429 → propagate
- `isRetryableError`, `getBackoffDelay` exported for tests
- Write unit test: error helper predicates (don't hit real API in unit tests)

### Task 4: migrate `agent.ts`
- Replace `aiStreamRound` import (same name, different module path internally) → already uses `aiStreamRound` from `./streaming`, just update signature
- Pass `chain: 'smart'` explicitly
- Validator block: always run when `toolCallNames.length === 0 && TOOL_DEFINITIONS.length > 0` — drop the commented conditional
- Validator receives no `_apiKey` (calbot pattern)
- Update `agent.test.ts` mocks

### Task 5: migrate fast-chain callers
- `response-validator.ts`: `aiStreamRound({chain:'fast'})`, drop `_apiKey` param, update call site in agent.ts
- `bank/prefill.ts`: `aiStreamRound({chain:'fast'})`
- `bank/merchant-agent.ts`: `aiStreamRound({chain:'fast'})`
- Update each test file's mocks

### Task 6: migrate smart-chain text callers with progress streaming
Each of these currently calls `aiComplete()` and waits for the full response. Rewrite to call `aiStreamRound({chain:'smart'}, {onTextDelta})` and accumulate text into a status message:

- **`ai-extractor.ts`** — called from photo-processor. Add a `ProgressWriter` abstraction that accepts an optional `TelegramStreamWriter` (or equivalent) and pipes `onTextDelta` into it. Streaming shows "AI читает чек..." + live text as the JSON builds.
- **`receipt-summarizer.ts`** — similar. User sees "AI исправляет..." + live edits.
- **`ask.ts`** (daily advice) — long-form financial advice is perfect for streaming. Direct wire to `TelegramStreamWriter`.
- **`dev-agent.ts`** — already shows statuses, pipe text deltas through to its existing status message.
- **`codex-integration.ts`** — runs in dev pipeline, may not have UI; backend-only call is fine here.

All use `chain: 'smart'`.

### Task 7: OCR pipeline with tool-based validation

Two-step flow:

**Step 1 — OCR** (`ocr-extractor.ts`):
- Use `aiStreamRound({chain:'ocr'})` with image data URL in message content
- Extract raw text from receipt image
- Simple prompt: "Extract ALL text as it appears"
- Output: raw text string

**Step 2 — AI extraction** (`ai-extractor.ts`):
- Use `aiStreamRound({chain:'smart'})` with streaming progress
- Parse raw text into `AIExtractionResult` (items + currency)
- Existing logic, just swap the backend and add streaming

**Step 3 — validation** (`ocr-validator.ts`, NEW):
- Input: `AIExtractionResult` + raw OCR text
- Uses `aiStreamRound({chain:'smart', tools: [...]})` with **mandatory tool calling** — smart chain because OCR correctness matters more than latency:
  - `calculate_sum({items: number[]})` — adds up item totals, returns sum
  - `check_total({sum, claimed_total, currency})` — compares sum vs claimed total, returns `{match: boolean, diff: number}`
  - `sanity_check_items({items: Array<{name, price, quantity}>})` — flags suspicious items (negative prices, prompt leaks, absurd quantities)
- Prompt forces the validator to call `calculate_sum` before approving. Approving without calling the tool → auto-reject (enforced on our side by inspecting `toolCalls`).
- Returns `ValidationResult`: `{approved: true} | {approved: false, reason: string, fixHints?: string[]}`

**Step 4 — retry** (`photo-processor.ts`):
- On validation failure, feed `fixHints` back into `ai-extractor.ts` with a retry prompt
- Max 2 retries; after that, surface to user with the best guess and a warning message

**Why tool calling is mandatory here:** LLMs are notoriously bad at arithmetic. Asking "does 123.45 + 678.90 = 802.35?" in text mode gives random answers. Forcing the model to call a real `calculate_sum` tool ensures the sum is computed deterministically, and the model's job becomes "notice that 802.35 ≠ 850.00 and reject" instead of "do arithmetic in your head".

Tool definitions live alongside validator in `ocr-validator.ts`. Tool executor is inline (pure functions, no DB access).

### Task 8: delete `completion.ts`
After all callers migrated and tests green. `grep -r "aiComplete\|from.*completion" src/` must return empty.

### Task 9: verification script (`scripts/verify-ai-chains.ts`)

Standalone script, run via `bun run scripts/verify-ai-chains.ts`. Tests every slot of every chain with a tiny smoke test and reports a table:

```
CHAIN    PROVIDER               MODEL                            STATUS      ms
-----    --------               -----                            ------      --
smart    z.ai (glm-5.1)         glm-5.1                          OK          874
smart    Gemini (2.5-pro)       gemini-2.5-pro                   OK          1204
smart    HF (Qwen3-235B)        Qwen/Qwen3-235B-A22B             OK          2001
fast     z.ai (glm-4.5-flash)   glm-4.5-flash                    OK          312
fast     Gemini (2.5-flash)     gemini-2.5-flash                 OK          402
fast     HF (Llama-3.3-70B)     meta-llama/Llama-3.3-70B-Instruct OK         980
ocr      Gemini (2.5-flash)     gemini-2.5-flash                 OK (vision) 1150
ocr      HF (Qwen2.5-VL-72B)    Qwen/Qwen2.5-VL-72B-Instruct     OK (vision) 3211
```

For text chains: send `"Reply with exactly: OK"`, expect response containing `OK`.
For OCR chain: send a tiny embedded test image (small receipt PNG inlined as base64 in the script) and expect any non-empty text.

Exit code 0 if all pass, non-zero otherwise. Suitable for CI gating later, but first use is local verification after the migration.

### Task 10: run everything
- `bun run type-check`
- `bun run lint`
- `bun run test` (all 1930+ tests)
- `bun run scripts/verify-ai-chains.ts`
- `bunx knip` (unused exports after deleting completion.ts)
- Fix whatever's broken

### Task 11: cleanup + commit strategy
- Atomic commits per task
- Final commit: merge or PR to main at end of worktree
- Never push to main from worktree; finish in worktree first

---

## Out of scope for this plan

- Consolidating `agent.ts` retry loop into `aiStreamRound` (it has its own `runWithRetry` wrapper for AbortController + tool execution) — keep as-is
- `polling-handoff` and deploy flow — unrelated
- Vision for anything other than OCR (e.g. future "send me a photo of a budget" feature) — not a current need
- Test coverage for OCR validation tool executor (pure functions — trivial to add later)
- Removing `@anthropic-ai/sdk` dep — already removed (we don't import it anywhere)

---

## Risks

1. **Streaming in ai-extractor may break JSON parsing.** The current code collects full response then `JSON.parse()`. With streaming, it's tempting to parse incrementally — **don't**. Collect deltas into a buffer, parse once at the end. Progress UI shows raw text as it arrives; parsing is still atomic.

2. **OCR validator retry can loop forever if the receipt is genuinely ambiguous.** Hard cap at 2 retries. After that, surface to user with a warning: "Проверь суммы, AI не смог их сверить". Don't silently fail.

3. **z.ai coding endpoint quirk** — the `content: ''` case needs explicit detection, otherwise the validator will think the model "approved" an empty response. Handle in `streamingSlot` (throw), not at the caller.

4. **HF vision model cost/latency** — Qwen2.5-VL-72B is big and slow. Fallback-only role; primary is Gemini Flash. Add a soft timeout of 30s specifically for the OCR chain so we don't wait 2 minutes if HF hangs.

5. **Tool-based OCR validation ≠ 100% accuracy** — the validator only checks what it's told to check (sum + sanity). It won't catch semantic errors like "milk" labeled as "fuel". That's still the user's job via the confirmation card. We're improving arithmetic accuracy, not replacing human review.

---

## Order of execution

```
1. env config              [independent]
2. clients.ts              [needs 1]
3. streaming.ts             [needs 2]
4. agent.ts                 [needs 3]
5. fast-chain callers       [needs 3, parallel with 4]
6. smart-chain callers      [needs 3, parallel with 4]
7. OCR pipeline              [needs 3, 5 (validator uses fast chain)]
8. delete completion.ts      [needs 4, 5, 6, 7]
9. verification script       [needs 3]
10. full verification        [needs 8]
11. commit + finish worktree [last]
```

Steps 4/5/6 can run in parallel — they're all independent callers being swapped to the new API.
