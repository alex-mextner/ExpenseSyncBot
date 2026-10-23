# AI usage events — durable per-provider usage (Refs #187)

## Problem

Nothing durable shows which provider served which call. The only traces are pino lines
(`[AI_STREAM] Trying <chain> → <slot>`, `<slot> failed: …`) and `agent_trajectories` rows (provider + elapsed,
agent runs only): no tokens, no per-call model, no error class, no OCR or fast-chain coverage. Claude is a
fallback slot, so it gets no traffic while Groq is healthy, and prod data cannot show that: 2026-10-13..22 had
Groq plus 2 z.ai calls and nothing else.

## Design

- **Table** `ai_usage_events` (migration 053, append-only): one row per provider *attempt* of `aiStreamRound` —
  `at` (epoch ms UTC), `provider` (slot key `groq|zai|claude|hf`), `model`, `chain`, `purpose`, `outcome`
  (`ok|error|skipped`), `error_class` + `http_status` (error rows only, enforced by a CHECK), `duration_ms`,
  `prompt/completion/reasoning/cached_tokens`, `request_id`. Indexes `(at)` and `(provider, at)`. No prompts,
  completions, user ids, chat ids or credentials.
- **NULL is unknown.** A token column is NULL when the provider did not report it; a reported 0 stays 0. Reports
  sum only rows with a value and count unknown `ok` rows separately.
- **Recorder at the choke point.** `aiStreamRound`'s provider loop records every attempt: `ok` with the tokens of the
  stream's final usage chunk; `error` with a class from the SDK error's status/code/name (never its body) and any
  tokens the provider billed before failing (an empty z.ai answer still bills); `skipped` for slots a stall handoff
  excluded. Slots without a key are not in the chain and leave no row. One `request_id` per round links a failed
  attempt to the fallback that answered. `purpose` is a required option, so no call is unlabeled.
- **Usage from the stream.** Every request carries `stream_options: { include_usage: true }`; a 400 naming the
  option makes the endpoint remembered and the same attempt retried without it (one attempt, one row).
- **Fire-and-forget.** `recordAiUsage` returns at once; the insert runs on a later event-loop turn. A failure is
  `logger.warn({ err })`-ed and dropped; no extra provider call, no await in the answer path.
- **Retention.** 180 days, pruned at startup and daily 03:30 UTC from `src/bot/cron.ts` (the existing scheduler).
- **Error classes.** `quota` = 402, or a 400/429 whose text says quota/credit/balance/billing/usage limit/limit
  exhausted/will reset (z.ai answered 429 "Weekly/Monthly Limit Exhausted. Your limit will reset at …" on
  2026-10-23); `rate_limit` = other 429; `auth` = 401/403; `bad_request` = other 4xx; `server` = 5xx and
  status-less connection failures; `timeout` = the slot's own 45 s timer or an SDK timeout; `aborted` = the
  caller's deadline; `empty` = 200 with no text and no tool call; `other` = the rest.
- **Report.** Pure `aggregateUsage` (`src/services/ai/usage-report.ts`), CLI `scripts/report-ai-usage.ts`
  (`--days`, `--json`, read-only), admin-only `/ai_stats [days]` (sender must be `BOT_ADMIN_CHAT_ID`, fails closed and
  silent, answer goes to the admin's own chat). One verdict per provider; a provider with no rows says
  `no traffic` so Claude's zero is visible.
- **Live check** `scripts/verify-claude-usage.ts`: text (smart), fast and OCR requests with every other provider
  out of the chain, then reads back the rows the bot's own recorder wrote.

## Out of scope

Backfill from logs; cost in money (needs a price table per model); a per-request trace; a Mini App view.

## Rollout

Migration 053 only adds a table (rollback-compatible: older code ignores it). Deploy through the normal
push-to-main pipeline; the report shows data from the first provider call after the restart.
