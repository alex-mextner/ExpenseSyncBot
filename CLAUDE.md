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

### Deployment

**Auto-deploy via GitHub Actions** on every push to `main`. The pipeline runs typecheck → lint → tests → SSH deploy → PM2 reload. If tests fail, deploy is blocked.

**NEVER manually SSH to the server to `git pull` and restart.** Use `git push` and let CI handle it. Manual deploys bypass test gates and can conflict with the CI pipeline.

```bash
# Monitor deploy status
gh run list --limit 5
gh run view <run-id> --log-failed

# PM2 commands (on server, for diagnostics only)
/var/www/.bun/bin/pm2 list
/var/www/.bun/bin/pm2 logs expensesyncbot
```

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
├── src/web/ (HTTP server: OAuth callback, Mini App API, SSE, temp images)
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
- [src/web/temp-image.handler.ts](src/web/temp-image.handler.ts) - Temporary image serving (rendered tables)

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

**Configuration:** Uses `ANTHROPIC_API_KEY` and optional `AI_BASE_URL` env vars. Model configured in `agent.ts`.

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
- [ocr-extractor.ts](src/services/receipt/ocr-extractor.ts) - OCR text extraction from images
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

#### 10. Polling Handoff (Blue-Green Deploys)

- [src/utils/polling-handoff.ts](src/utils/polling-handoff.ts) - Coordinates long-polling handoff between old and new instances during deploy. Two alternating ports — the incoming instance signals the running one to stop, then takes over. Prevents Telegram 409 Conflict errors.

#### 11. Mini App

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
- `/reconnect` - Refresh OAuth
- `/spreadsheet` - View spreadsheet URL
- `/stats` - Expense statistics
- `/sum` (alias: `/total`) - Sum expenses by filters
- `/sync` - Manual sync to sheets
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
- `ANTHROPIC_API_KEY` - Anthropic API key (for AI agent)
- `AI_BASE_URL` - optional, custom Anthropic API base URL
- `BOT_ADMIN_CHAT_ID` - admin Telegram chat ID (for merchant-agent notifications, feedback forwarding)

## Production Deployment

- **Server:** Digital Ocean (www-data user)
- **Process Manager:** PM2
- **Reverse Proxy:** Caddy (for HTTPS OAuth callback)
- **Auto-deploy:** GitHub Actions on push to main (test → deploy → PM2 reload). Never bypass with manual SSH.
- **Logs:** PM2 logs at `/var/www/ExpenseSyncBot/logs/`

See [DEPLOY.md](DEPLOY.md) for complete deployment guide.

### Диагностика на сервере

При любой жалобе на поведение бота — **сначала смотри логи**, не гадай:

```bash
# Последние 100 строк (out + error вместе):
ssh www-data@104.248.84.190 'PATH=/var/www/.bun/bin:$PATH pm2 logs expensesyncbot --lines 100 --nostream'

# Только ошибки:
ssh www-data@104.248.84.190 'tail -100 /var/www/ExpenseSyncBot/logs/error.log'

# Состояние процессов:
ssh www-data@104.248.84.190 'PATH=/var/www/.bun/bin:$PATH pm2 list'
```

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

### Foundational Rules

- Doing it right is better than doing it fast. NEVER skip steps or take shortcuts.
- Tedious, systematic work is often the correct solution. Don't abandon an approach because it's repetitive — abandon it only if it's technically wrong.
- ALWAYS STOP and ask for clarification rather than making assumptions.
- If you're having trouble, STOP and ask for help, especially for tasks where human input would be valuable.
- When you disagree with an approach, push back. Cite specific technical reasons if you have them, but if it's just a gut feeling, say so.

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

### Naming

- Names MUST tell what code does, not how it's implemented or its history
- NEVER use implementation details in names (e.g., "ZodValidator", "MCPWrapper", "JSONParser")
- NEVER use temporal/historical context in names (e.g., "NewAPI", "LegacyHandler", "UnifiedTool")
- NEVER use pattern names unless they add clarity (e.g., prefer "Tool" over "ToolFactory")

### Code Comments

- NEVER add comments explaining that something is "improved", "better", "new", "enhanced", or referencing what it used to be
- NEVER add instructional comments: "copy this pattern", "use this instead", "prefer X over Y"
- Comments should explain WHAT the code does or WHY it exists, not how it's better than something else
- NEVER remove code comments unless you can PROVE they are actively false
- NEVER refer to temporal context in comments ("recently refactored", "moved", "new")
- All code files MUST start with a brief 1-2 line comment explaining what the file does

### Systematic Debugging

Follow this framework for ANY technical issue:

1. **Root Cause Investigation** (BEFORE attempting fixes): read error messages carefully, reproduce consistently, check recent changes
2. **Pattern Analysis**: find working examples, compare against references, identify differences
3. **Hypothesis and Testing**: form single hypothesis, make smallest possible change, verify before continuing
4. **Implementation**: NEVER add multiple fixes at once. If first fix doesn't work, STOP and re-analyze rather than adding more fixes

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
- **Maintain ~80% test coverage**: run `bun test --coverage` regularly. New files must have corresponding test files.
- **Commit atomically and often**: after each logical unit of work (feature, bugfix, refactor), commit immediately. Don't accumulate 30+ changed files.
- **`mock.module()` is safe** — each test file runs in its own process via `scripts/test-runner.ts`. Use `mock.module()` freely for mocking dependencies. Use `spyOn` when you need to assert call counts or arguments on a real implementation.
- **Always run tests via `bun run test`** (isolated runner), not `bun test` directly — the latter runs all files in one process and mock.module leaks between files. Use `bun test <file>` only for running a single file.
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
- **pre-push**: full test suite

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
1. Fork the repo to your own account
2. Commit the fix to the fork
3. Update `.gitmodules` to point to the fork URL
4. On the server: `git submodule update --remote` fetches from the fork
5. Open a PR to upstream — when merged, revert `.gitmodules` to the upstream URL

**After every commit in the submodule**: push the branch to the fork immediately — `git -C src/services/bank/ZenPlugins push fork <branch>`. Don't leave local-only commits in submodules.

### ZenPlugins-Specific Conventions

- **No trailing semicolons** (ASI style)
- **Leading `;` guard** before `(expression)` when previous line has no `;`
- **No `import from 'bun:test'`** — use Jest/bun globals (`describe`, `it`, `expect`, etc.) directly
- **Mock pattern**: `global.fetch = async (url, init?) => new Response(...)` — real `Response`, not a cast
- **Install deps**: `npm install --ignore-scripts` (bun fails on some git-sourced deps like `pdf-extraction`)

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

