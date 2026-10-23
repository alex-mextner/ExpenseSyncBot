# ExpenseSyncBot Project Guide

## Project Overview

ExpenseSyncBot is a Telegram bot for tracking expenses and syncing them to Google Sheets. It supports multi-currency expenses, AI-powered expense analysis, category detection, and budget management.

**Tech Stack:** Bun runtime, GramIO (Telegram), SQLite (bun:sqlite), googleapis, Anthropic Claude SDK (AI agent with tool calling), node-cron, marked, pino (logging), Biome (linting), Lefthook (git hooks)

## Common Commands

### Development

```bash
# Run in development mode (with auto-reload)
bun run dev

# Run in production mode
bun run start

# Type checking
bun run type-check
# or directly:
tsc --noEmit

# Linting
bun run lint          # check
bun run lint:fix      # auto-fix
bun run format        # format with Biome

# Install git hooks (one-time, after clone)
node_modules/.bin/lefthook install --force
```

### Heavy work runs on Runpod

This workstation is shared by many agent sessions, the review queue and the owner's own
desktop; a full suite here starves all of them (it froze the machine twice on 2026-10-10).
**Rule: locally, a single test file at most; the full suite and coverage go to a Runpod
pod** via the shared `runpod-offload` skill (`skill://runpod-offload`; script
`~/.agents/skills/runpod-offload/runpod-run`, on PATH as `runpod-run`).

Heavy here: `bun run test` (the isolated runner over every test file), `bun run
test:coverage`.

```bash
runpod-run -- bun run test                  # full suite on a 4-vCPU CPU pod ($0.16/h), pod deleted when done
runpod-run --ttl 30 -- bun run test:coverage   # coverage, keeping the pod 30 idle minutes between runs
bun test src/<area>/<one>.test.ts           # local: one file, that's the limit
```

The pre-push hook (`lefthook.yml`) runs the same `runpod-run --ttl 30 -- bun run test`
(`~/.agents/skills/runpod-offload/runpod-run` by absolute path, else `runpod-run` on PATH; machines
with neither run it locally). The
sync copies every tracked and untracked-but-not-ignored file in the checkout to the pod:
keep secrets (only `.env`, `.env.development.local`, `.env.test.local` and `.env.production.local` are ignored; a stray `.env.staging.local`, `tokens.local`, downloaded credential, …) out of
the checkout or git-ignored before offloading — tests need no credentials.

`runpod-run --dry-run -- …` prints the plan and price. `runpod-run --status` lists every pod
on the account; bare `runpod-run --stop` terminates only this repo's pods, `runpod-run --stop
all` every pod created under this hostname — leave none behind.

### Deployment

**Auto-deploy via GitHub Actions** on every push to `main`. The pipeline runs typecheck → lint → tests → deploy on the self-hosted runner on the home server (odroid) → PM2 reload. If tests fail, deploy is blocked.

**NEVER manually `git pull` and restart on the server.** Use `git push` and let CI handle it. Manual deploys bypass test gates and can conflict with the CI pipeline.

```bash
# Monitor deploy status
gh run list --limit 5
gh run view <run-id> --log-failed

# PM2 commands (on server, for diagnostics only)
/var/www/.bun/bin/pm2 list
/var/www/.bun/bin/pm2 logs expensesyncbot
```

**Stage is one shared slot** (`stage-bot.yml`): every same-repo human PR event (open, push, reopen) redeploys it with that PR's head commit. Bot-authored PRs never touch stage; on a human PR, bot-triggered events other than `closed` are skipped: after a Renovate/Dependabot push, stage keeps your previous commit until the next human event, which then deploys the current head, bot commits included. Closing or merging *any* eligible PR — by a human or a bot — switches stage back to `main` without checking who owns it; a prod deploy restarts stage on the new `main` only when stage already ran `main`. Runs are serialized only per PR, so the last deploy to *finish* owns stage — opening, pushing or closing a PR takes stage from whoever was QA-ing. Push a branch without a PR when you don't want stage. Stacked PRs (base = another PR branch) deploy their head, which carries the whole stack — use that to QA two changes together.

### Database

Database is SQLite at `./data/expenses.db`. Migrations run automatically on startup via [src/database/schema.ts](src/database/schema.ts).

```bash
# Access database directly
sqlite3 ./data/expenses.db
# Inside sqlite3: .tables, .schema users, SELECT * FROM users;
```

## Architecture

### Application Flow

```plain
index.ts (entry point)
├── src/database/ (initializes on import)
├── src/web/ (HTTP server: OAuth callback, Mini App API, SSE)
├── src/services/bank/sync-service.ts (bank sync cron every 30 min)
├── src/services/receipt/photo-processor.ts (receipt photo background worker)
├── src/bot/cron.ts (scheduled tasks: exchange rates, budget tab cloning)
├── src/services/broadcast.ts (scheduled news broadcasts)
└── src/bot/ (Telegram bot)
```

### Key Architectural Patterns

#### 1. Repository Pattern for Data Access

All database operations go through repositories in `src/database/repositories/`:

- `group.repository.ts` - Group (chat) management
- `user.repository.ts` - User accounts and auth tokens
- `expense.repository.ts` - Expense records
- `expense-items.repository.ts` - Receipt line items per expense
- `category.repository.ts` - Expense categories
- `pending-expense.repository.ts` - Expenses awaiting confirmation
- `budget.repository.ts` - Budget tracking
- `chat-message.repository.ts` - AI conversation history
- `bank-connections.repository.ts` - Bank plugin connections (ZenPlugins)
- `bank-accounts.repository.ts` - Bank accounts from sync
- `bank-transactions.repository.ts` - Bank transactions from sync
- `bank-credentials.repository.ts` - Encrypted bank credentials
- `merchant-rules.repository.ts` - Merchant name → category mapping rules
- `photo-queue.repository.ts` - Receipt photo processing queue
- `receipt-items.repository.ts` - Parsed receipt line items
- `advice-log.repository.ts` - AI daily advice history
- `group-spreadsheet.repository.ts` - Group → spreadsheet mappings
- `sync-snapshot.repository.ts` - Sync state snapshots
- `recurring-pattern.repository.ts` - Detected recurring expense patterns
- `dev-task.repository.ts` - Dev pipeline task tracking
- `agent-trajectory.repository.ts` - Per-run and per-tool-round agent features (stall-classifier dataset, no message text)
- `ai-usage-events.repository.ts` - Append-only AI usage: one row per provider attempt (`ai_usage_events`), nullable token counts, no text or ids; 180-day retention

Access via singleton: `database.users`, `database.expenses`, `database.bankConnections`, etc.

#### 2. Google OAuth Flow

1. User sends `/connect` in Telegram
2. Bot generates OAuth URL and sends to user
3. User authorizes in browser
4. Google redirects to `http://localhost:3000/callback` (or production URL)
5. OAuth server exchanges code for tokens
6. Refresh token is encrypted and stored in database
7. Bot creates Google Sheet with formulas

**Key files:**

- [src/services/google/oauth.ts](src/services/google/oauth.ts) - OAuth client, token encryption/decryption
- [src/services/google/sheets.ts](src/services/google/sheets.ts) - Google Sheets API operations
- [src/web/oauth-callback.ts](src/web/oauth-callback.ts) - HTTP server for OAuth callback
- [src/web/miniapp-api.ts](src/web/miniapp-api.ts) - Mini App REST API endpoints
- [src/web/sse-emitter.ts](src/web/sse-emitter.ts) - Server-Sent Events for real-time updates

#### 3. Expense Parsing & Multi-Currency Support

The bot parses expense messages in multiple formats (see README.md for examples).

**Currency detection:** `src/services/currency/parser.ts` handles:

- Currency symbol before/after amount: `$100`, `100€`, `₽500`
- Currency codes: `100 EUR`, `1900 RSD`
- Single letter aliases: `100е` (EUR), `100д` (USD) - Russian keyboard shortcuts
- Space-separated amounts: `1 900 RSD`

**Exchange rates:** `src/services/currency/converter.ts` - exchange rates auto-updated via cron (`src/bot/cron.ts`)

**Category extraction:** First word after amount+currency is category, rest is comment.

**Expense recording:** All expense writes (manual, receipt, bank) go through [src/services/expense-recorder.ts](src/services/expense-recorder.ts) — single entry point for writing to Google Sheets + local DB. Higher-level saving logic (confirmation flow, formatting) in [src/bot/services/expense-saver.ts](src/bot/services/expense-saver.ts). Budget sync with sheets in [src/bot/services/budget-sync.ts](src/bot/services/budget-sync.ts).

#### 4. AI Agent (Anthropic Claude)

Bot has a full AI agent with tool calling, accessible by mentioning `@ExpenseSyncBot` in groups.

**Architecture:** `src/services/ai/`

- [agent.ts](src/services/ai/agent.ts) - `ExpenseBotAgent` — Anthropic Claude agent with tool calling loop. Streams text to Telegram, executes tools, manages conversation. Only final text responses saved to chat history.
- [tools.ts](src/services/ai/tools.ts) - Tool definitions (get expenses, budgets, stats, bank balances, etc.)
- [tool-executor.ts](src/services/ai/tool-executor.ts) - Executes AI tool calls against the database
- [telegram-stream.ts](src/services/ai/telegram-stream.ts) - Streams AI responses to Telegram in real-time via message editing
- [response-validator.ts](src/services/ai/response-validator.ts) - Validates AI output (no markdown, no hallucinated links)
- [debug-logger.ts](src/services/ai/debug-logger.ts) - Full request/response logging to `logs/chats/`

**Features:**

- Stores conversation history per group in `chat_messages` table
- Context includes: recent chat history, all expenses, all budgets, categories, bank balances
- Uses custom system prompt defined per-group in `/prompt` command
- Daily advice feature (`/advice`) with scheduling via `src/services/analytics/advice-triggers.ts`

**Agent loop rules** ([agent.ts](src/services/ai/agent.ts), [telegram-stream.ts](src/services/ai/telegram-stream.ts)):

- A model without parallel tool use makes one tool call per round, so multi-step questions take many rounds. Prefer tools that answer in one call: `get_expenses` with `summary_only: true` + `currency` returns per-category and grand totals already converted.
- There is no fixed round cap: the stall guard ([stall-guard.ts](src/services/ai/stall-guard.ts), spec `docs/specs/2026-10-13-agent-stall-guard.md`) judges every tool round. Signals: the same call+result 3×, 4 `calculate`-only rounds in a row, 3 all-error rounds, A/B alternation, 3 rounds with nothing new. First signal → a `[SYSTEM]` nudge; later ones → handoff: the provider that answered the stalled round is excluded for the rest of the run (`aiStreamRound({ excludeProviders })`, retries and the forced round included), the next one of the health-ordered smart chain continues with the whole history, and the work log shows `🔄 Передаю задачу <provider>…`. After 2 handoffs, or with no provider left, the run must answer. Safety caps: 40 tool rounds; answer once only 45 s (one provider timeout) are left of the 240 s run deadline. Thresholds were checked against the 2026-10-12 runs and the 171 healthy prod runs (zero false alarms) — re-check against `agent_trajectories` before changing them.
- A nudge does not reset the guard's streaks: a round right after it that keeps the same pattern hands off at once (stage QA of PR #170: a post-nudge `calculate` had counted as a fresh start). Nudge, handoff note and forced final prompt all carry the partial-data rule: never present a sum of part of the data as the total.
- `get_expenses` detail pages always state `Showing a–b of N expenses (page p of P)`, `Total for all N expenses: …` (the authoritative total, also in the group currency when another one was requested) and, while pages remain, a `More pages` line with the exact next call. Models summed page 1 of 8 as the month total before this (stage QA of PR #170).
- When the stall guard ends the tool rounds, one forced final round runs with the tools still declared and `toolChoice: 'none'` (accepted by z.ai and Claude in the 2026-10-12 live check; dropping the tools made Claude refuse to sum, since rule 7 sends all arithmetic to `calculate`). Tool calls returned anyway are ignored. A mention, a run with a write tool, or a forced run never ends silently.
- Empty or tools-only replies are never shipped (`TelegramStreamWriter.finalize`): silence is allowed only for non-mention chatter with no write tool and no forced answer — a blank/`...`/`[SKIP]` answer if no tools ran, only the bare `[SKIP]` marker after read-only tools; otherwise the user sees the no-answer message. The work log is always rendered as a collapsed `<blockquote expandable>` at the TOP of the reply.
- Every `run()` writes one `agent_trajectories` row and one `agent_trajectory_rounds` row per tool round (dataset for the learned stall classifier, phases 1–3 of the spec): tool names, per-run-seeded arg/result hashes, providers, timings, decisions, outcome, and the gap to the group's next question if under 5 min. Never store message text, tool arguments or results there.
- Every provider **attempt** of `aiStreamRound` writes one `ai_usage_events` row (migration 053; [usage-recorder.ts](src/services/ai/usage-recorder.ts)): `at`, `provider` (`zai`/`claude`/`hf`/`openrouter`; rows written before Groq was dropped carry `groq` and still render), `model`, `chain` (`smart`/`fast`/`ocr`), `purpose` (required `purpose` option of `aiStreamRound`: `agent`, `agent_final`, `agent_batch`, `advice`, `validator`, `advice_validator`, `prefill`, `merchant`, `receipt_parse`, `receipt_summary`, `ocr`, `dev_agent`, `code_review`, `replay`, `probe`), `outcome` (`ok`/`error`/`skipped`), `error_class` + `http_status` for errors (`timeout`, `rate_limit`, `quota`, `auth`, `server`, `empty`, `aborted`, `bad_request`, `other`, derived from the SDK error's status/code/name — never its body), `duration_ms`, token counts and a per-round `request_id` that links a failed attempt to the fallback that answered. Token columns are **NULL when the provider did not report usage — never 0** (a reported 0 stays 0); every request carries `stream_options: { include_usage: true }`, and a provider that answers 400 to it is remembered and retried at once without it (one attempt, one row, tokens unknown). `skipped` rows are the slots a stall handoff excluded (`excludeProviders`); a slot whose key is absent is not in the chain and leaves no row. The insert runs on a later event-loop turn: a storage failure is `logger.warn`-ed and never reaches the answer. No prompts, completions, user ids or chat ids are stored. A daily cron (03:30 UTC, plus once at startup) prunes rows older than 180 days.

**Configuration:** All providers go through the OpenAI SDK with a fallback chain in [streaming.ts](src/services/ai/streaming.ts): smart = z.ai GLM → Claude Sonnet → HF; fast (validators, bank prefill, merchant agent) = z.ai GLM fast → Claude Haiku → HF; OCR = Claude (`CLAUDE_VISION_MODEL`, default Sonnet) → HF vision (fixed order, not configurable). The Claude slot is skipped when its key is absent — without `CLAUDE_API_TOKEN` OCR runs HF-only.

**Provider order is configuration, not code**: `AI_SMART_CHAIN` and `AI_FAST_CHAIN` list provider ids (zai, claude, hf, openrouter); default for both is z.ai → Claude → HF (`openrouter` is in no default order — it runs only when the operator names it); providers without key/model are skipped. The ids come from `PROVIDER_IDS` in [provider-ids.ts](src/services/ai/provider-ids.ts) (a leaf module, shared with `config/env.ts`). The skip is logged, an unknown name is ignored with a warning, an order naming nothing configured falls back to the default order. The order is the same as in HyperCalendarBot. The circuit breaker ([provider-breaker.ts](src/services/ai/provider-breaker.ts)) only moves a *demoted* provider to the back, everything else keeps the configured order: a z.ai that answers 429 (quota/rate limit) or 402 (no credits) is demoted at once (Retry-After / quota reset time, else 5 min; 402 for an hour), so the next rounds start with Claude instead of paying z.ai's failed call again; the demoted z.ai is still tried last, and one clean answer lifts the demotion. A z.ai that merely hangs is not demoted (an abort is no evidence): each such round spends the 45 s per-provider timeout before Claude is tried. Risk: HF Router answered 402 (no credits) on 2026-10-12 and z.ai's quota ran out in HyperCalendarBot on 2026-09-24, so Claude is the de-facto primary when z.ai is depleted — keep its `max_tokens`/thinking handling intact. Sonnet is the OCR default because on degraded receipt photos Haiku produced a wrong yet sum-verified receipt while Sonnet refused (2026-10-12, clean fixtures: equal accuracy, Haiku ~25% faster). Request budget fields come from `chatRequestParams()`, which delegates to `claudeRequestParams()` for Claude slots (also used by `scripts/verify-ai-chains.ts`): never `temperature` (400 on Claude 5.x); Sonnet/Opus keep thinking on at the model's own level (the OpenAI-compat endpoint ignores `reasoning_effort`, so none is sent) and get `CLAUDE_THINKING_RESERVE_TOKENS` (8192) added to `max_tokens`, because thinking spends the same budget as the answer (without the reserve Sonnet truncated a 200-token prefill answer in 3/6 calls); Haiku runs with `thinking: {type: 'disabled'}` — at small budgets it otherwise streams zero text. The OpenAI-compat endpoint rejects explicit adaptive thinking. After changing `CLAUDE_MODEL`/`CLAUDE_FAST_MODEL`/`CLAUDE_VISION_MODEL`, run `scripts/verify-ai-chains.ts` (plus `scripts/run-receipt-snapshots.ts` for the vision model); to validate a provider change on real traffic, run `scripts/replay-ai-logs.ts` against `logs/chats` and a DB copy.

**Model presets** ([model-presets.ts](src/services/ai/model-presets.ts), stage B2; same ids and fields as HyperCalendarBot): `MODEL_PRESETS` (`deepseek41-flash`, `glm53-flash-low`, `glm53-low`, `haiku`) = per-provider model ids (`models`), measured `effort`/`temperature`/`maxOutputTokens`, list price (`priceUsdPerMTok` with `asOf` date and the `via` provider it is valid for; `null` = unknown, never 0), candidate `roles`, and `qualification` (`null` until a run passed `QUALIFICATION_GATE`: ≥95% own-role and 100% on the labelled history). `isQualifiedFor(preset, role)` is the only gate role routing may use. `EXCLUDED_MODEL_PATTERNS` (gpt-oss, Groq's qwen3.8-27b) are enforced in every text chain, legacy included: a slot whose model matches is skipped with a warning, so a retired model cannot come back through an env var. Legacy chains are otherwise untouched.

**Role routing** (stage B3, [role-routing.ts](src/services/ai/role-routing.ts); same env names as HyperCalendarBot; inert by default): `AI_ROUTING=legacy|roles` (default `legacy`, anything else stops startup). In `roles` mode an agent round runs on the chain of its role — `executor` for ordinary tool rounds, `repair` from the stall guard's nudge/handoff on (the forced final answer included), `planner` is parsed and resolvable but ESB has no planner round yet — taken from `AI_EXECUTOR_CHAIN` / `AI_REPAIR_CHAIN` / `AI_PLANNER_CHAIN`: comma-separated `provider` (that provider's own smart model; fast model for the planner) or `provider:preset` (a [model-presets.ts](src/services/ai/model-presets.ts) preset routed over that provider, with its effort/temperature/ceiling; `reasoning_effort` only on OpenRouter). `AI_ROUTING_USER_IDS` (≤100 comma-separated positive Telegram ids) turns it into a canary: only those users. A preset loads only when `isQualifiedFor(preset, role)`; an unqualified, keyless or excluded entry is skipped with a logged error, and a role chain with nothing loadable runs the legacy smart chain. Only the smart chain takes a role (validators, prefill, merchant, OCR never do). Rollback = `AI_ROUTING=legacy` (every caller, no deploy). `AgentContext.telegramUserId` is the canary key. Deadline, breaker, usage rows and the stall-guard handoff are the same machinery as for the legacy chain.

HF Router is the last fallback in every text chain and the only OCR fallback, and it runs on prepaid credits: on 2026-10-12 it returned HTTP 402 "no remaining credits", so a chain whose earlier slots fail has nothing left. A 402 demotes that provider in the breaker for an hour (like an exhausted quota: it moves to the back of the chain, is still tried there, and a clean answer after a top-up lifts the demotion). Check every slot with `bun run scripts/verify-ai-chains.ts` (per-provider status table, exit 1 if a chain has no working provider) before trusting a chain.

Read the usage with `bun scripts/report-ai-usage.ts [--days N] [--json] [--db PATH]` (read-only; per `provider:model`: attempts, ok, errors by class, skipped, success rate, p50/p95 of ok attempts, tokens with a count of ok calls that reported none, last ok / last error, plus one verdict per provider — `no traffic` is stated explicitly, so Claude's zero is visible) or, as the admin (`BOT_ADMIN_CHAT_ID`), with `/ai_stats [days]` in Telegram (the reply goes to the admin's own chat; everyone else gets no reply). `bun scripts/verify-claude-usage.ts` (key in the environment, temp DB) sends three tiny requests through the bot's own code path with every other provider out of the chain and checks that each left an `ok` row for `claude` with tokens.

#### 5. State Management for User Flows

Bot uses callback queries (inline keyboards) and message handlers to manage multi-step flows:

- **OAuth setup:** currency selection → additional currencies → spreadsheet creation
- **New category confirmation:** detect new category → ask user to confirm/skip → save
- **Budget management:** create/view/edit budgets via inline keyboards

**Key files:**

- [src/bot/keyboards.ts](src/bot/keyboards.ts) - Inline keyboard builders
- [src/bot/handlers/callback.handler.ts](src/bot/handlers/callback.handler.ts) - Button click handlers
- [src/bot/handlers/message.handler.ts](src/bot/handlers/message.handler.ts) - Text message handlers

#### 6. Bank Integration (ZenPlugins)

Automatic bank sync via ZenMoney plugin ecosystem. Syncs accounts and transactions from connected banks every 30 minutes.

**Architecture:** `src/services/bank/`

- [registry.ts](src/services/bank/registry.ts) - Auto-discovers banks from `ZenPlugins/` subdirectories by reading `preferences.xml`. No manual registration needed.
- [runtime.ts](src/services/bank/runtime.ts) - `ZenMoneyShim` — provides the `globalThis.ZenMoney` interface that plugins expect. Backed by `bank_plugin_state` SQLite table for persistent state.
- [sync-service.ts](src/services/bank/sync-service.ts) - Main sync loop (cron every 30 min). Upserts accounts/transactions, sends confirmation cards to Telegram. Has per-connection mutex to prevent overlapping syncs. Max 3 consecutive failures before disabling.
- [otp-manager.ts](src/services/bank/otp-manager.ts) - Handles OTP/readLine requests during sync. When a plugin calls `ZenMoney.readLine()`, execution pauses until user sends the code in Telegram. State in SQLite for cross-process sharing.
- [otp-hints.ts](src/services/bank/otp-hints.ts) - Human-readable hints for OTP input prompts
- [panel-builder.ts](src/services/bank/panel-builder.ts) - Builds bank status panel text and inline keyboard
- [prefill.ts](src/services/bank/prefill.ts) - AI pre-fill: batch-suggests category for bank transactions before showing confirmation card (Anthropic API, up to 10 tx per call)
- [merchant-agent.ts](src/services/bank/merchant-agent.ts) - AI merchant normalization agent: batch-processes unmatched merchant strings into `pending_review` rules. Admin-only (`BOT_ADMIN_CHAT_ID`).
- [mcc-labels.ts](src/services/bank/mcc-labels.ts) - Human-readable labels for MCC codes
- [transaction-summary.ts](src/services/bank/transaction-summary.ts) - Builds summary text for old/missed transactions

**Flow:** `/bank` command → setup wizard (select bank → enter credentials → OTP if needed) → `sync-service` runs every 30 min → new transactions shown as confirmation cards → user confirms → expense saved.

**Key tables:** `bank_connections`, `bank_accounts`, `bank_transactions`, `bank_credentials`, `bank_plugin_state`, `merchant_rules`

#### 7. Receipt Processing

Photo-based receipt recognition: QR scanning, OCR, and AI extraction.

**Architecture:** `src/services/receipt/`

- [photo-processor.ts](src/services/receipt/photo-processor.ts) - Background worker that dequeues photos from `photo_queue`, runs QR scan + OCR + AI extraction, sends parsed results as confirmation cards
- [qr-scanner.ts](src/services/receipt/qr-scanner.ts) - QR code scanning from receipt images
- [ocr-extractor.ts](src/services/receipt/ocr-extractor.ts) - OCR text extraction from images; the photo goes to the vision model in the request as a base64 data URL — no public image URL, so OCR never depends on Caddy/the tunnel serving a file (#164)
- [ai-extractor.ts](src/services/receipt/ai-extractor.ts) - AI-powered extraction of structured expense data from receipt text
- [receipt-summarizer.ts](src/services/receipt/receipt-summarizer.ts) - Summarizes parsed receipt data
- [receipt-fetcher.ts](src/services/receipt/receipt-fetcher.ts) - Fetches receipt data from URLs
- [link-analyzer.ts](src/services/receipt/link-analyzer.ts) - Analyzes links in messages for receipt URLs
- [url-validator.ts](src/services/receipt/url-validator.ts) - Validates and sanitizes URLs

**Flow:** User sends photo → `photo.handler.ts` queues it → `photo-processor` picks up → QR scan → OCR → AI extraction → confirmation card with parsed items.

#### 8. Spending Analytics

Financial analytics engine used by AI agent tools and `/stats`.

**Architecture:** `src/services/analytics/`

- [spending-analytics.ts](src/services/analytics/spending-analytics.ts) - Computes financial snapshots: trends, anomalies, budget burn rates, day-of-week patterns, category projections
- [formatters.ts](src/services/analytics/formatters.ts) - Formats analytics data for AI context and display
- [recurring-detector.ts](src/services/analytics/recurring-detector.ts) - Detects recurring expense patterns (subscriptions, regular payments) from history
- [recurring-matcher.ts](src/services/analytics/recurring-matcher.ts) - Matches new expenses against known recurring patterns
- [advice-triggers.ts](src/services/analytics/advice-triggers.ts) - Scheduling and triggers for AI daily advice

#### 9. Render Service

Server-side rendering of complex data as images (for Telegram messages where text formatting is insufficient).

- [src/services/render/md-table-html.ts](src/services/render/md-table-html.ts) - Generates styled HTML from markdown tables for screenshot rendering
- [src/services/render/table-renderer.ts](src/services/render/table-renderer.ts) - Table rendering orchestration

#### 10. Mini App

Telegram Mini App for expense input with receipt scanning. Located in `miniapp/` — separate Vite + React app.

- Configured via BotFather `MenuButton`
- Served via Caddy reverse proxy
- Uses Telegram SDK for native features (QR scanning, theme)

## Key Implementation Details

### Adding New Currency

1. Add aliases to `CURRENCY_ALIASES` in [src/config/constants.ts](src/config/constants.ts)
2. Add code to `SUPPORTED_CURRENCIES` array
3. Add symbol to `CURRENCY_SYMBOLS` map
4. Add exchange rate in [src/services/currency/converter.ts](src/services/currency/converter.ts)

### Google Sheets Structure

Created in [src/services/google/sheets.ts](src/services/google/sheets.ts):createSpreadsheet()

**Columns:**

- Date
- Category
- Comment
- Dynamic currency columns (based on user's enabled_currencies)
- EUR (calc) - calculated column with exchange rate formulas

**Important:** When adding expenses, find correct column by matching currency code in headers (row 1).

### Token Security

Google refresh tokens are encrypted using `ENCRYPTION_KEY` from env:

- Encryption: [src/services/google/oauth.ts](src/services/google/oauth.ts):encryptToken()
- Decryption: [src/services/google/oauth.ts](src/services/google/oauth.ts):decryptToken()
- Algorithm: AES-256-GCM

### Database Migrations

Migrations in [src/database/schema.ts](src/database/schema.ts) run on startup:

- Tracks applied migrations in `migrations` table
- Each migration has `name` and `up()` function
- **Never modify deployed migrations** - always add new ones
- Groups support was added in migration 007, users were migrated to groups

### Bot Commands

Defined in [src/bot/index.ts](src/bot/index.ts):

- `/start` - Welcome & setup status
- `/connect` - OAuth & initial setup
- `/disconnect` - Disconnect from Google Sheets
- `/reconnect` - Refresh OAuth (also audits + auto-recreates any spreadsheets the bot has lost access to, e.g. after a scope downgrade or if the sheet was trashed)
- `/repair` - Audit every year spreadsheet and recreate any that are 404/403. Manual entry point for users who didn't trigger /reconnect (e.g. deleted sheet by hand). No OAuth flow.
- `/spreadsheet` - View spreadsheet URL
- `/stats` - Expense statistics
- `/sum` (alias: `/total`) - Sum expenses by filters
- `/sync` - Manual sync to sheets (subcommand: `/sync rollback` restores the latest snapshot if recent sync lost data)
- `/budget` - Manage budgets
- `/categories` - List categories
- `/settings` - View settings
- `/bank` - Bank connection setup wizard, status panel, confirmation flow
- `/scan` - Receipt scanning (photo/link)
- `/advice` - Get AI daily advice (groups only)
- `/prompt` - Manage AI system prompt (groups only)
- `/topic` - Topic management
- `/push` - Push expenses
- `/feedback` - Send feedback to admin
- `/help` - Help text
- `/ping` - Health check
- `/dev` - Dev pipeline management
- `/ai_stats [days]` - Admin-only (sender = `BOT_ADMIN_CHAT_ID`, fails closed and silent for everyone else) AI usage report; not in `BOT_COMMANDS` / `/help`

### Group-Only Mode

Bot works **only in groups** (group / supergroup). Personal chat redirects user to their group with a link button.

- All commands check `isGroup` and reply with "работает только в группах" otherwise
- One spreadsheet per group, shared between all members
- `message.handler.ts` in private chat tries to find user's group and sends a link

Check chat type: `ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup'`

## Important Patterns & Conventions

### Budget Operations — BudgetManager

All budget writes go through `BudgetManager` ([src/services/budget-manager.ts](src/services/budget-manager.ts)). `database.budgets` is read-only at the type level — write methods are inaccessible. Write access via `_budgetWriter()` (internal, underscore-prefixed).

| Method | Direction | Sheets sync? |
|--------|-----------|-------------|
| `set()` | User/AI → DB → Sheets | Yes |
| `delete()` | User/AI → DB → Sheets (zeros out) | Yes |
| `importFromSheet()` | Sheets → DB | No |
| `deleteLocal()` | Sheets → DB (removal) | No |

### Error Handling

- Display user-friendly errors in Telegram
- Log detailed errors to console
- Use try-catch in all async command handlers
- OAuth errors should prompt `/reconnect`

### Date Formatting

Uses `date-fns` library. Spreadsheet dates are in `DD.MM.YYYY` format (European).

### Currency Formatting

Uses `formatAmount(amount, currency)` from `src/services/currency/converter.ts`.
For amounts ≥ 1 million, it outputs suffix form: `1.5 млн RSD`, `2 млрд RUB`.

**Never use `.toFixed()` for user-facing amounts.** Always use `formatAmount()` — it handles large numbers (млн/млрд) and consistent decimal formatting. Raw `.toFixed()` is only acceptable inside `formatAmount` itself or for non-currency values.

### Russian Numeral Declension

**Every user-facing `${count} <noun>` must use `pluralize()` from `src/utils/pluralize.ts`.**

```ts
import { pluralize } from '../../utils/pluralize';

// pluralize(n, one, few, many)
`${count} ${pluralize(count, 'расход', 'расхода', 'расходов')}`
`${count} ${pluralize(count, 'транзакция', 'транзакции', 'транзакций')}`
`${count} ${pluralize(count, 'карточка', 'карточки', 'карточек')}`
`${count} ${pluralize(count, 'бюджет', 'бюджета', 'бюджетов')}`
`${count} ${pluralize(count, 'категория', 'категории', 'категорий')}`
`${count} ${pluralize(count, 'запись', 'записи', 'записей')}`
```

Hardcoding a single form like `${n} расходов` is wrong for n=1 ("1 расходов") and n=3 ("3 расходов"). No exceptions.

### EUR vs Default Currency — Critical Rules

**EUR is the internal calculation currency only.** It is used for:
- `eur_amount` field on every expense (cross-currency normalization)
- Analytics calculations in `spending-analytics.ts`
- AI context strings in `formatters.ts` and `tool-executor.ts`
- Logs

**Never display EUR to the user unless `group.default_currency === 'EUR'`.**

Every group has `default_currency: CurrencyCode` — use it for all user-facing aggregate amounts.

#### Display rules by context

| What | Display currency |
|------|-----------------|
| Aggregate totals (`/sum`, `/stats`) | `group.default_currency` |
| Budget spent / limit | `budget.currency` (user set this explicitly) |
| Per-currency breakdown (`/stats`) | own currency (by definition) |
| Receipt total | `summary.currency` (from receipt) |
| AI financial context (`formatters.ts`) | `group.default_currency` |
| AI tool results (`tool-executor.ts`) | `group.default_currency` for aggregates; original currency for individual expenses |
| Logs | EUR (internal) |

#### Pattern: aggregate total → default currency

```ts
const display = convertCurrency(eurTotal, 'EUR', group.default_currency);
formatAmount(display, group.default_currency)
```

#### Pattern: budget progress → budget currency

```ts
// spending is always stored as EUR — convert to budget's currency before comparing
const spentInCurrency = convertCurrency(spentEur, 'EUR', budget.currency as CurrencyCode);
const percentage = budget.limit_amount > 0
  ? Math.round((spentInCurrency / budget.limit_amount) * 100)
  : 0;
// display
`${formatAmount(spentInCurrency, budget.currency)} / ${formatAmount(budget.limit_amount, budget.currency)} (${percentage}%)`
```

### Sending Messages — `sendMessage` only

**The ONLY way to send messages is `sendMessage` from [src/services/bank/telegram-sender.ts](src/services/bank/telegram-sender.ts).**

Banned alternatives:
- **`ctx.send()`** — in `CallbackQueryContext` it sends to private chat, not group. Silent bug.
- **`bot.api.sendMessage()`** — bypasses `AsyncLocalStorage` context, loses `message_thread_id` injection. Messages go to General instead of the topic.

```ts
import { sendMessage } from '../../services/bank/telegram-sender';

// In any handler (command, message, callback):
await sendMessage('Hello');
await sendMessage('With keyboard', { reply_markup: keyboard });
const msg = await sendMessage('Get ID');
// msg?.message_id — returns TelegramMessage | null (null on error)
```

`sendMessage` always sets `parse_mode: 'HTML'`. No need to pass it explicitly.

**`ctx.editText` and `ctx.answerCallbackQuery` are fine** — they operate on the callback message, not a new send.

### Sending to Admin — `sendDirect`

For admin notifications (feedback, merchant rules) — use `sendDirect(chatId, text, options?)` from telegram-sender. No context needed, sends to a specific personal chat.

### Topic-Aware Messaging

Bot uses `AsyncLocalStorage` ([src/utils/chat-context.ts](src/utils/chat-context.ts)) + GramIO `preRequest` hook ([src/bot/topic-middleware.ts](src/bot/topic-middleware.ts)) to automatically inject `message_thread_id` into all outgoing API calls.

**Two contexts, one mechanism:**

| Context | Who sets it | How |
|---------|------------|-----|
| Handlers (commands, messages, callbacks) | `topic-middleware` | Automatically from incoming update |
| Background workers (sync, cron, photo-processor, oauth) | Developer | `withChatContext(chatId, threadId, fn)` |

```ts
import { sendMessage, editMessageText, withChatContext } from './telegram-sender';

// Background worker — set context once, all calls inside use it:
const threadId = conn.panel_message_thread_id ?? group.active_topic_id;
await withChatContext(group.telegram_group_id, threadId, async () => {
  await sendMessage(text);
  await sendMessage(cardText, { reply_markup: keyboard });
  await editMessageText(messageId, statusText);
});
```

**Rules:**
- **Never pass `message_thread_id` manually** — the preRequest hook handles it from context
- **Never use `bot.api.sendMessage` directly** — use `sendMessage` which reads context automatically
- **Never send to General** when the group has `active_topic_id` — user won't see it
- **Never send to personal chats from workers** — all worker messages go to `group.telegram_group_id`

### Testing

Tests run via isolated parallel runner (`scripts/test-runner.ts`): `bun run test`. See Development Philosophy > Testing section for full rules.

## Environment Variables

All `process.env.*` reads go through `src/config/env.ts` and are accessed via the config object.
Never read `process.env.*` directly in feature code, bot handlers, or services.
Optional features that depend on an env var must deactivate gracefully when the var is absent — never throw at startup.

Required in `.env` (see [.env.example](.env.example)):

- `BOT_TOKEN` - from @BotFather
- `BOT_USERNAME` - bot username without @ (default: `ExpenseSyncBot`)
- `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` - from Google Cloud Console
- `GOOGLE_REDIRECT_URI` - OAuth callback URL
- `OAUTH_SERVER_PORT` - default 3000
- `DATABASE_PATH` - SQLite database path
- `ENCRYPTION_KEY` - 32-byte hex (generate: `openssl rand -hex 32`)
- `NODE_ENV` - development/production
- `ANTHROPIC_API_KEY` - historical name: actually the z.ai GLM key; `AI_BASE_URL`, `AI_MODEL`, `AI_FAST_MODEL` - z.ai endpoint and models
- `AI_SMART_CHAIN`, `AI_FAST_CHAIN` - optional comma-separated provider order (ids `zai`, `claude`, `hf`, `openrouter`); default `zai,claude,hf`. Groq is no longer a provider (gpt-oss answered poorly and no replacement model was chosen); `GROQ_*` variables are ignored — ESB has no other Groq use, unlike HyperCalendarBot where `GROQ_API_KEY` still means Whisper transcription
- `HF_TOKEN`, `HF_BASE_URL`, `HF_MODEL`, `HF_FAST_MODEL`, `HF_VISION_MODEL` - HuggingFace Router, last text fallback and OCR vision fallback
- `CLAUDE_API_TOKEN` - optional Anthropic key (Claude slot right after z.ai, OCR primary; absent → Claude slots skipped, OCR HF-only); `CLAUDE_MODEL` (default `claude-sonnet-5-5`), `CLAUDE_FAST_MODEL` (default `claude-haiku-5-5`), `CLAUDE_VISION_MODEL` (receipt OCR, default `claude-sonnet-5-5`), `CLAUDE_BASE_URL` (default OpenAI-compat `https://api.anthropic.com/v1/`)
- `OPENROUTER_API_KEY`, `OPENROUTER_BASE_URL` (default `https://openrouter.ai/api/v1`), `OPENROUTER_MODEL`, `OPENROUTER_FAST_MODEL` - optional OpenRouter provider (id `openrouter`; same names as HyperCalendarBot); no default models — named in a chain order it still needs key and model, else it is skipped. Probed 2026-10-23: `deepseek/deepseek-v4.1-flash`, `z-ai/glm-5.3-flash`, `z-ai/glm-5.3`, `anthropic/claude-haiku-5.5` exist and accept an assistant tool-call turn with `content: null` (no `""` workaround needed)
- `BOT_ADMIN_CHAT_ID` - admin Telegram chat ID (for merchant-agent notifications, feedback forwarding)

## Production Deployment

- **Server:** home server odroidn2 (Odroid N2, Armbian, aarch64), user `www-data`. SSH: `root@odroidn2` (Tailscale; LAN address is dynamic DHCP)
- **Ingress:** Cloudflare Tunnel `odroid-home` (cloudflared on odroid) → origin Caddy for `finbot.mextner.com`, `finbot-app.mextner.com`, `finbot-stage.mextner.com`, `finbot-stage-app.mextner.com`.
- **Process Manager:** PM2 (`expensesyncbot`, `bank-sync`, `expensesyncbot-stage`), `TZ=UTC`
- **Reverse Proxy:** Caddy on odroid, plain HTTP origin; config is the repo `Caddyfile` (symlinked to `/etc/caddy/Caddyfile`)
- **Auto-deploy:** GitHub Actions on push to main; `deploy` job runs on the self-hosted runner `odroid`. Never bypass with manual deploys.
- **Logs:** PM2 logs at `/var/www/ExpenseSyncBot/logs/`

See [DEPLOY.md](DEPLOY.md) for complete deployment guide.

### Диагностика на сервере

При любой жалобе на поведение бота — **сначала смотри логи**, не гадай:

```bash
# Последние 100 строк (out + error вместе):
ssh root@odroidn2 'su - www-data -c "pm2 logs expensesyncbot --lines 100 --nostream"'

# Только ошибки:
ssh root@odroidn2 'tail -100 /var/www/ExpenseSyncBot/logs/error.log'

# Состояние процессов:
ssh root@odroidn2 'su - www-data -c "pm2 list"'
```

AI-статистика по провайдерам (read-only, дёшево): `ssh root@odroidn2 'su - www-data -c "cd /var/www/ExpenseSyncBot && bun scripts/report-ai-usage.ts --days 7"'` (`DATABASE_PATH` берётся из окружения, иначе `./data/expenses.db`; на проде БД лежит в `/var/www/ExpenseSyncBot/data/expenses.db`).

**Никаких тяжёлых проверок на odroid.** У odroidn2 ~1 GB свободной RAM, а 2 GB swap уже заняты: 2026-10-12 агент запустил там бенчмарк ONNX-эмбеддингов (модель 118 MB) — нехватка памяти и перезагрузка сервера с прод-ботом. Не загружай модели, не гоняй бенчмарки и браузерные проверки на odroid — меряй на Runpod (`runpod-run`). Любая проверка на самом устройстве — только в окне, согласованном с владельцем.

### AI chat logs

`logs/chats/` на сервере содержит подробные логи общения бота через ИИ с пользователями —
полные запросы, ответы, tool calls. Смотри при отладке неожиданного поведения ИИ.

## Common Gotchas

1. **Bun auto-loads .env** - don't use dotenv package
2. **SQLite foreign keys** - enabled via PRAGMA, ensure referential integrity
3. **Google Sheets column indexing** - 1-based, not 0-based
4. **Currency symbols** - use constants from config, don't hardcode
5. **Telegram message IDs** - unique per chat, not global
6. **OAuth tokens** - always encrypted in database, never log plaintext
7. **Group migration** - old users have group_id=NULL, handle gracefully
8. **AI context size** - limit expense history to recent (e.g., 100000 items) to avoid token limits
9. **PM2 on server** - use full path `/var/www/.bun/bin/pm2`, not just `pm2`
10. **Topic middleware** - never pass `message_thread_id` manually in handler context, middleware does it. Background workers must pass it explicitly.
11. **`.claude/settings.local.json` is tracked in git** - this is intentional. The file contains project-specific permission rules shared across all contributors. Do not add it to `.gitignore`.
12. **Never use `ctx.send()`** — in CallbackQueryContext it sends to private chat, not group. Always use `sendMessage()` from `src/services/bank/telegram-sender.ts`. See "Sending Messages" section above.
13. **Never manually deploy** — `git push` triggers auto-deploy via GitHub Actions. Manual `git pull && pm2 restart` on the server bypasses test gates and can conflict with CI. If CI tests fail, fix the tests instead of bypassing.
14. **Several agent sessions may work on the servers at once** (odroid, the DO droplet). Before treating a missing config or a stopped/started process as a bug, ask, or read only the one session transcript that touched that host (`~/.omp/agent/sessions/`; don't trawl unrelated sessions — they can hold secrets) — e.g. the DO Caddy block for ExpenseSyncBot was removed on purpose during the move to Cloudflare Tunnel. Never restore it blindly.
15. **Odroid logs used to live in RAM** (armbian-ramlog on zram) and vanished on a hard hang. It is now disabled and journald is `Storage=persistent`; keep it that way so `journalctl -b -1` works after a crash. Bot data lives on the WD500 HDD, not the SD card (DEPLOY.md, "Storage").
16. **After an odroid reboot pm2 resurrects its saved dump** — a stale dump once left stage crash-looping (6934 restarts). #159 (on `main`) makes stage starts run `pm2 save` and `--exp-backoff-restart-delay`; branches cut before it lack both — rebase before touching `stage-bot.yml`, and keep both.

## When Modifying Code

- **Adding commands:** Register in [src/bot/index.ts](src/bot/index.ts), create handler in `src/bot/commands/`
- **Database changes:** Add migration in [src/database/schema.ts](src/database/schema.ts), never modify existing migrations
- **New repositories:** Add to [src/database/index.ts](src/database/index.ts) and create in `src/database/repositories/`
- **Google Sheets changes:** Test locally first, ensure backward compatibility with existing sheets
- **AI changes:** Agent logic in `src/services/ai/`, tool definitions in `tools.ts`, tool execution in `tool-executor.ts`. System prompt per group stored in DB (`/prompt` command).
- **Bank plugin changes:** Add ZenPlugins subdirectory, `registry.ts` auto-discovers it. Bank flow in `src/services/bank/`, command handler in `src/bot/commands/bank.ts`.
- **Receipt processing changes:** Pipeline in `src/services/receipt/`, photo handler in `src/bot/handlers/photo.handler.ts`

---

## Development Philosophy

> Generic engineering discipline — foundational rules, naming, comment hygiene, and
> systematic debugging — is now provisioned as the universal agent-skills layer (via
> `rig`, see `rig.yaml`). Those skills (`smallest-change`, `naming`, `comment-hygiene`,
> `systematic-debugging`, `yagni-kiss-dry`, `dead-code-investigation`, etc.) load
> automatically in any harness. This section keeps only the rules that carry
> **project-specific** detail (the TS/casting rules, this repo's test harness, and the
> knip/codex version-control flow); the purely generic restatements were removed to
> avoid a stale duplicate of the universal layer.

### Writing Code

- Make the SMALLEST reasonable changes to achieve the desired outcome.
- STRONGLY prefer simple, clean, maintainable solutions over clever or complex ones. Readability and maintainability are PRIMARY CONCERNS.
- WORK HARD to reduce code duplication, even if the refactoring takes extra effort.
- NEVER throw away or rewrite implementations without EXPLICIT permission. If considering this, STOP and ask first.
- MATCH the style and formatting of surrounding code, even if it differs from standard style guides. Consistency within a file trumps external standards.
- Fix broken things immediately when you find them. Don't ask permission to fix bugs.
- **Comments hygiene**: when refactoring, verify no useful comments were accidentally deleted.
  Check: `git diff | grep "^-.*\/\/"`. Never silently drop comments.
- **Dependency versions always use `^`** (e.g. `"gramio": "^0.4.11"`). Never pin exact versions.
- **No `any`/`as any`/`Function`** — proper typing only.
- **`as unknown as T` and `as unknown` are banned except as absolute last resort.** Before using either:
  1. Try proper typing, generics, overloads, conditional types — go to any complexity.
  2. If the problem is in a third-party library (gramio, @huggingface/inference, etc.) — fix the library: clone it, patch the types, verify locally, save the patch, open a PR upstream. Do NOT work around bad library types with casts.
  3. Only if all else fails AND the cast is truly unavoidable (e.g. a runtime value that TypeScript structurally cannot express) — use `as unknown as T` with an explicit comment explaining WHY there is no alternative.
  Skipping this process hides real bugs. Type casts are bug laundering.
  **Exception — tests:** `as unknown as T` is allowed in test files for accessing private/protected members and for stubbing bot/SDK objects that have no public test-friendly interface. No comment required for these cases.
- **`Record<string, unknown>` is banned.** It's almost always a broken construct — an escape hatch that loses type information. Use a proper typed interface instead. `Record<string, unknown>` is the `any` of objects. Same goes for `Record<string, any>`, `object`, `{}` used as "some object".
- No commented-out code. No template literals without variables. `Number.parseInt`. `T[]` not `Array<T>`.
- **Unused parameters**: remove entirely (parameter + argument at call sites), don't prefix with `_`.
- **Always handle `.catch()`** on fire-and-forget promises — at minimum log the error. Silent promise rejections hide bugs.
- **Security checks fail-closed**: when a guard function is injected/optional, the absent-function default is `false` (deny), never `true` (allow).
- **Multi-step DB operations are atomic**: SELECT followed by UPDATE on the same rows must be wrapped in a transaction. Without it, concurrent writes can corrupt data.

> Naming, code-comment hygiene, and systematic-debugging guidance previously inlined here
> are covered by the universal `naming`, `comment-hygiene`, and `systematic-debugging`
> skills. One project-specific rule retained: **all code files MUST start with a brief
> 1-2 line header comment explaining what the file does** (see `file-header-comments`).

### Testing

- **Always write tests**: new functionality must include unit tests; bug fixes must include regression tests that reproduce the bug before the fix.
- **TDD workflow** (mandatory for new features and bugfixes):
  1. Write a failing test that validates the desired behavior
  2. Run the test — confirm it fails for the RIGHT reason (not a syntax error or wrong import)
  3. Write ONLY enough code to make the test pass
  4. Run the test — confirm it passes
  5. Refactor while keeping tests green
- **Exception: reviewed code without tests** — if implementation was already reviewed and approved but tests were skipped, do NOT delete the code. Write comprehensive tests against the existing implementation instead. If tests reveal bugs, fix the code.
- **Tests must exercise production code**: never reimplement logic in tests.
- NEVER delete a failing test. Investigate and fix the root cause.
- **Changing tests to match code is a red flag**: always analyze WHY.
- **Every commit must have tests**: no committing code without corresponding test coverage. Tests are NOT a "separate task" — they are part of the same unit of work as the code they cover. Never defer tests to a follow-up.
- **Regression tests for every bugfix**: reproduce the exact bug scenario in a test BEFORE fixing.
- **Maintain ~80% test coverage**: run `bun run test:coverage` regularly (on Runpod — § Heavy work runs on Runpod). New files must have corresponding test files.
- **Commit atomically and often**: after each logical unit of work (feature, bugfix, refactor), commit immediately. Don't accumulate 30+ changed files.
- **`mock.module()` is safe** — each test file runs in its own process via `scripts/test-runner.ts`. Use `mock.module()` freely for mocking dependencies. Use `spyOn` when you need to assert call counts or arguments on a real implementation.
- **Database in tests uses `:memory:`** — `initDatabase()` detects `NODE_ENV=test` and uses in-memory SQLite instead of file-based `./data/expenses.db`. This prevents `SQLITE_BUSY_RECOVERY` errors when 14 parallel test processes compete for the same database file. Never change this to file-based in tests.
- **Always run tests via `bun run test`** (isolated runner, on Runpod — § Heavy work runs on Runpod), not `bun test` directly — the latter runs all files in one process and mock.module leaks between files. Use `bun test <file>` only for running a single file.
- **Coverage**: run `bun run test:coverage` — uses single-process `bun test --coverage` (coverage requires single process). Isolated runner does not collect coverage.
- **Test logging discipline**: every test that exercises code with logging MUST mock the logger:
  - Error-path tests: mock logger AND assert expected error/warn calls (`expect(logMock.error).toHaveBeenCalled()`)
  - Happy-path tests: mock logger AND assert NO unexpected error/warn calls (`expect(logMock.error).not.toHaveBeenCalled()`)
  - Use `createMockLogger()` from `src/test-utils/mocks/logger.ts` + `mock.module` on `../../utils/logger`
  - `NODE_ENV=test` silences pino globally (prevents stdout pollution), but tests must STILL verify log behavior, not just suppress it
  - Test output must be pristine — zero noise from pino, zero warnings from third-party libs
- NEVER write tests that "test" mocked behavior instead of real logic
- **No real network/DNS/external calls in tests.** Tests must run offline, in CI, in sandboxes — anywhere. Mock ALL external dependencies:
  - **DNS**: `spyOn(dns.promises, 'resolve4').mockResolvedValue([...])` — never call real DNS
  - **HTTP/fetch**: mock via `spyOn` or inject a fake, never hit real endpoints
  - **External APIs** (Telegram, Google, HuggingFace, Anthropic): always mock, never depend on API availability
  - **Browser/Playwright**: use dependency injection (`getBrowserFn` pattern), pass fake browser in tests
  - If a test hangs or times out, the root cause is almost always a missing mock — fix the mock, not the timeout
- **NEVER ignore test/system output** — logs and messages often contain CRITICAL information.
  Read test output, don't just check pass/fail. Warnings in logs point to real bugs.
- Test output MUST BE PRISTINE TO PASS

### Version Control

- NEVER use `git add -A` without checking `git status` first
- Commit frequently throughout development, even if high-level tasks are not yet done
- NEVER skip, evade, or disable a pre-commit hook
- **NEVER use `git add -A`** without checking `git status` first.
- **Worktree workflow**: when working in a worktree, **NEVER push directly to main** (`git push origin branch:main`). Accumulate all commits in the worktree branch, then merge or create a PR at the end. Pushing each commit to main produces noisy history and bypasses review. Never `cd` into the main repo from a worktree — it has the user's in-progress changes.
- **Deferred findings**: when skipping a review finding (out of scope, pre-existing), create a GitHub
  issue for it. Don't silently drop known issues.
- **Before every commit** (3-stage review, mandatory even if the user just says "commit"):
  1. Run `bunx knip` — fix unused exports, dependencies, and files.
  2. Self-review your own changes.
  3. Run `codex exec review --uncommitted` — address any issues it finds.

## MCP Tools

Use these MCP servers proactively whenever they can help:

- **serena** — semantic code navigation and editing. Use instead of grep/read for finding symbols, understanding relationships between functions/classes, and making precise symbol-level edits. Prefer `find_symbol`, `get_symbols_overview`, `find_referencing_symbols` over reading entire files.
- **context7** — up-to-date library documentation. Use when working with any external library (GramIO, Anthropic SDK, Bun APIs, googleapis, etc.) to get current docs and examples instead of guessing from memory.
- **mcp__playwright** — browser automation for testing. Use when verifying OAuth flows, web UI, or any HTTP endpoints. Also useful for checking the bot's behavior end-to-end.

## Documentation

- Specs: `docs/specs/YYYY-MM-DD-<topic>.md` — design documents and feature specifications
- Plans: `docs/plans/YYYY-MM-DD-<topic>.md` — implementation plans with task breakdowns

**Plans and specs MUST be committed and pushed** — they are part of the codebase, not ephemeral scratch files. After saving a plan or spec, `git add docs/` and commit it on the feature branch. Never leave them untracked.

**OVERRIDE:** Skills that default to `docs/superpowers/plans/` or similar paths MUST use `docs/plans/` and `docs/specs/` instead. No `superpowers/` subdirectory.

## Logging

Use **pino** for all logging. Import via `createLogger` from `src/utils/logger.ts`:

```ts
import { createLogger } from '../../utils/logger.ts';
const logger = createLogger('my-module');
```

- Pass errors as `{ err: error }`, never as `{ error: String(error) }` or `{ error: err.message }`.
- `String(error)` and `.message` lose the stack trace and are not acceptable.
- For structured data: `logger.info({ data }, 'label')` — NOT `logger.info('label:', data)`.
- For simple messages: `logger.info('message')` or template literal `logger.info(\`msg ${var}\`)`.

## Linting

**Biome** for linting and formatting. Config in `biome.jsonc`.

- `bun run lint` — check, `bun run lint:fix` — auto-fix, `bun run format` — format.
- Run `biome` directly (from `node_modules/.bin`), not via `bunx biome`.
- **Zero warnings policy**: lint warnings are NOT acceptable. Fix before committing.
- `noConsole` rule is `warn` — use `logger.*` instead of `console.*` in all production code.

## Git Hooks (Lefthook)

`lefthook.yml` configures pre-commit and pre-push hooks:
- **pre-commit**: typecheck + biome lint on staged files
- **pre-push**: full test suite — on a Runpod pod where `runpod-run` is installed (the shared
  workstation; § Heavy work runs on Runpod), locally elsewhere

Install hooks after clone: `node_modules/.bin/lefthook install --force`

## Backward Compatibility

When renaming variables, constants, config keys, or any other interface:
- **Ask immediately**: is backward compatibility needed, or can we migrate everything and remove the old names?
- **Default recommendation**: full migration — no aliases, no legacy shims. Aliases are technical debt.
- **Exceptions** worth keeping old names: public API with external consumers, stable library interface, or explicit user decision.
- If migration is feasible (internal code, DB rows can be updated, tests can be rewritten), propose full migration as the primary option. Final call is the programmer's.

## Bot Identity

- **Bot username:** `@ExpenseSyncBot` (set via `BOT_USERNAME` env var, default `'ExpenseSyncBot'`)
- All user-facing messages that mention the bot must use `@${env.BOT_USERNAME}` — never hardcode `@бот` or any placeholder.

## Tone of Voice (bot messages)

All user-facing bot messages must follow these rules:

- Address the user as **"ты"** (informal singular), never "вы", never "пользователь".
- Speak directly to the person: "Ты уже подключил таблицу", not "The user has connected a spreadsheet".

## Session Wrap-Up

**MANDATORY after EVERY completed task — no exceptions, no skipping in rapid iterations.**

After each task (push, fix, review-and-fix, deploy — any unit of work), answer these two questions out loud before responding to the next message:

1. **Всё ли сделано из того, что просили?** — go through the original request point by point. Did any sub-task get quietly skipped?
2. **Есть ли что улучшить, исправить или убрать?** — name specific things, not vague hints. Open issues? Known limitations introduced? Stale comments or dead code noticed?

Also scan the conversation history for items explicitly deferred, noted as "pending", or silently dropped mid-discussion. Surface them as concrete suggestions.

**At the end of each session**, document any new hard-won lessons in the relevant section of this file. If lessons don't fit an existing section, add a new one. This is mandatory — knowledge that lives only in chat history is lost.

## Working with Third-Party Submodules

### No Imports from Submodule Paths in Parent Code

**Never import from `./ZenPlugins/...`** or any other submodule path in parent project code (`src/`). Submodules are not checked out in CI (`submodules: false` in deploy.yml), so such imports break typecheck and block deploys.

- Types needed from ZenPlugins are maintained locally in `src/services/bank/zenmoney-types.ts`.
- If a new type is needed, copy it to the local file — don't add a submodule import.

### Before Writing Any Code

Always read existing files in the target submodule first — especially existing tests and utility files — to understand its style conventions. Writing code without checking leads to a full rewrite.

Checklist before touching a third-party submodule:
1. Look at 2-3 existing test files to understand the test style
2. Note: semicolons? TypeScript annotations in tests? `import from` or globals? Mock patterns?
3. Check how the submodule installs deps (npm vs bun — some deps fail with bun)

### Test Placement

Tests for code inside a submodule belong **inside the submodule directory**, not in the parent project. Placing them in the parent pulls the submodule's `.ts` files into the parent's strict tsconfig, causing cascading type errors from pre-existing issues in third-party code.

### Biome Exclusion

Third-party submodules must be excluded from `biome.jsonc`. Biome v2+ syntax: use `!path/to/submodule` (no trailing `/**`).

### Submodule Fork Workflow

When the upstream repo is read-only (e.g. `zenmoney/ZenPlugins`):
1. Fork the repo to your own account (`alex-mextner/ZenPlugins`)
2. **Branch from upstream master** — `git checkout -b fix/foo origin/master` — never from fork master
3. Cherry-pick or commit the fix onto that branch
4. Verify: `git log origin/master..fix/foo --oneline` — must show ONLY your commit(s), nothing else
5. Push branch to fork: `git push fork fix/foo`
6. Update `.gitmodules` to point to the fork URL; on the server: `git submodule update --remote`
7. **Open a draft PR from the fork branch to upstream `zenmoney/ZenPlugins`** — NOT within the fork itself. Always draft until explicitly ready to merge upstream.

**Critical**: `gh pr create --repo zenmoney/ZenPlugins --head alex-mextner:<branch> --draft`
- PRs go to **upstream** `zenmoney/ZenPlugins`, never to `alex-mextner/ZenPlugins` (that's your fork)
- Branch must be from **upstream master** — fork master may have commits not yet in upstream, which would pollute the PR

**After every commit in the submodule**: push the branch to the fork immediately — `git -C src/services/bank/ZenPlugins push fork <branch>`. Don't leave local-only commits in submodules.

### develop Branch — Bot's Running State

The bot always runs from a `develop` branch in the fork, not from any individual PR branch. `develop` aggregates all open (not-yet-merged) fixes so the bot gets them all at once.

**Workflow:**

1. When you create a fix branch (`fix/foo`) and push it to the fork, cherry-pick its commits onto `develop` too:
   ```bash
   git -C src/services/bank/ZenPlugins checkout develop
   git -C src/services/bank/ZenPlugins cherry-pick <commit-sha>
   git -C src/services/bank/ZenPlugins push fork develop
   ```

2. Point the bot submodule at `develop`:
   ```bash
   # .gitmodules branch = develop
   git -C src/services/bank/ZenPlugins checkout develop
   cd /path/to/ExpenseSyncBot && git add src/services/bank/ZenPlugins && git commit -m "chore(bank): pin ZenPlugins to develop"
   ```

3. When a PR merges upstream, rebase `develop` on fresh upstream master — git will drop the cherry-picked commit automatically (same patch):
   ```bash
   git -C src/services/bank/ZenPlugins fetch origin
   git -C src/services/bank/ZenPlugins checkout develop
   git -C src/services/bank/ZenPlugins rebase origin/master
   git -C src/services/bank/ZenPlugins push fork develop --force-with-lease
   ```
   Then update the submodule pointer in the bot repo.

**Rule**: `develop` must always be rebased on upstream `origin/master`, never on `fork/master`. Fork master may diverge.

### Review Before Opening a ZenPlugins PR

Before `gh pr create --repo zenmoney/ZenPlugins`, run both reviews:

**1. `/ultrareview` or `/review`** — in-session review pass on the branch changes.

**2. Codex diff review:**

```bash
git -C src/services/bank/ZenPlugins diff origin/master...<fix-branch> > /tmp/zenplugins-pr.diff
codex exec "Review this ZenPlugins PR diff for style compliance and correctness. Check: no trailing semicolons (ASI style), no bun:test imports, proper error types (TemporaryError/InvalidLoginOrPasswordError), test scope (guard tests only), no extra features. Report issues with file:line." < /tmp/zenplugins-pr.diff
```

Address every issue before opening the PR. When codex flags something that contradicts primary-source evidence (jadx decompilation, live traffic capture), document why the finding is a false positive in the PR description — don't blindly revert correct fixes.

### CLI Demonstration Before Considering a Plugin Fix Done

After fixing a bank plugin, run it end-to-end with real credentials using the CLI runner:

```bash
bun scripts/zen-run.ts <plugin-name> --env-prefix ZEN_TEST [--from YYYY-MM-DD]
```

`--env-prefix ZEN_TEST` maps env vars automatically: `ZEN_TEST_PHONE` → `phone`, `ZEN_TEST_PASSWORD` → `password`, etc. Credentials stay in `.env`, never appear in the command. Individual flags (`--phone`, `--password`) override env vars if provided alongside `--env-prefix`.

The run must complete without errors and return at least 1 account. A fix is not done until this passes — test credentials for kapitalbank-uz / apelsin-uz are in `.env` as `ZEN_TEST_*`.

**Important:** The Bash tool runs with closed stdin — `readline` / OTP prompts fail immediately. Bank plugins that require OTP on first run cannot be demonstrated from the Bash tool. **Do not attempt to run them yourself.** Instead, tell the user:

> "Запусти в строке ввода: `! bun scripts/zen-run.ts <plugin> --env-prefix ZEN_TEST`
> Когда придёт SMS — введи код в промпт `[OTP]`. Лог сохранится в `logs/zen-run/`."

The `!` prefix runs the command in the user's interactive terminal where stdin is a real TTY. Never spam the script — each run sends a real SMS. The API rate-limits after ~3 requests per minute (`otp_already_requested`).

### ZenPlugins-Specific Conventions

- **No trailing semicolons** (ASI style)
- **Leading `;` guard** before `(expression)` when previous line has no `;`
- **No `import from 'bun:test'`** — use Jest/bun globals (`describe`, `it`, `expect`, etc.) directly
- **Mock pattern**: `global.fetch = async (url, init?) => new Response(...)` — real `Response`, not a cast
- **Install deps**: `npm install --ignore-scripts` (bun fails on some git-sourced deps like `pdf-extraction`)
- **Run `ts-standard <files>`** before committing to verify linting on changed files
- **Braces on `if`-guards**: match the FILE's existing style, not the linter's minimum. `.ts` files use multi-line `{\n  ...\n}`; `.js` files use inline `{ continue }` — match whichever is in that file.
- **Type casts in tests**: use the actual type, not `never[]`. ❌ `null as unknown as never[]` ✅ `null as unknown as CardProductV2[]`
- **Test scope**: guard tests test the guard only — don't add cases that test pre-existing behavior (e.g. "empty array returns []" when empty was always handled).
- **Test placement**: check the existing `__tests__/` structure before creating new directories.

### One PR per Bank Plugin

Fixes in different bank plugins (tbc-ge, priorbank, etc.) must be in **separate PRs** — even if the bug pattern is identical. Each bank is an independent concern, reviewable and revertable independently. Stacked PRs are fine (PR B targets PR A's branch as base).

## UX Conventions

### N+2 Truncation Rule

When showing a truncated list with "и ещё N..." at the bottom, N must be ≥ 3. Showing "и ещё 1" or "и ещё 2" is pointless — just show those items instead. So either show all items, or truncate such that the hidden count is ≥ 3.

Example with max 10 visible items:
- ≤ 12 items → show all (because 1–2 more is wasteful)
- 13+ items → show 10, then "и ещё 3..."

Formula: `if (total - maxVisible < 3) showAll; else truncate;`

## Telegram Bot API Limits

### Message length
- `sendMessage` / `editMessageText`: **4 096 chars**
- Caption (photo, document, video, etc.): **1 024 chars** (4 096 for Telegram Premium users)
- Quote in reply: **1 024 chars**
- `answerCallbackQuery` alert: **200 chars**

When text may exceed 4 096 chars, split into multiple messages.
Never send a caption > 1 024 — it silently fails for non-Premium users.

### Rate limits
- **~1 msg/sec per chat** — safe burst rate for a single user/group
- **~30 msg/sec globally** across all chats (official FAQ)
- **20 msg/min per group/channel**
- Exceeding any limit → HTTP **429** with `retry_after` (seconds). A 429 **blocks all API calls**, not just sendMessage — implement global backoff, not per-method.

### Inline keyboard
- Max **8 buttons per row**
- Max **100 buttons total**
- Total `reply_markup` JSON: **10 KB** — easy to exceed with 100 buttons with long labels
- `callback_data` per button: **64 bytes** (UTF-8). Exceeding → `400 BUTTON_DATA_INVALID`. Store state server-side, pass a short key.
  - **Cyrillic is 2 bytes per char** — a 20-char Russian category name = 40 bytes, plus prefix easily exceeds 64. Always use numeric IDs (DB primary keys) in `callback_data`, never raw user-supplied strings. If a human-readable value is unavoidable, truncate at byte boundaries (see `fitCallbackData` in `keyboards.ts`).

### Commands
- Command name: **1–32 chars** (lowercase a-z, 0-9, `_`)
- Command description: **256 chars**
- Max commands registered: **100**
- `/start` deep-link payload: **64 bytes**

### File size
- Upload to Telegram: **50 MB**
- Download via `getFile`: **20 MB**
- Album (`sendMediaGroup`): **2–10 items**

### Formatting entities
- Max **100 entities per message** — don't generate unbounded lists of bold/italic/code spans.
- `parse_mode` and explicit `entities` are mutually exclusive.

### Message editing
- Editable for **48 hours** after sending (channels: no limit).
- Can't edit messages sent by other bots or users.

