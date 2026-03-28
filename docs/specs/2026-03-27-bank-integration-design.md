# Bank Integration Design

**Date:** 2026-03-27
**Branch:** feature/bank-integration
**Status:** Draft v3

---

## Overview

Integrates ZenPlugins-compatible bank adapters into ExpenseSyncBot via a separate bank-sync microservice. The bot polls bank APIs on a schedule, stores raw transactions, reconciles them with manually recorded expenses, and surfaces discrepancies to users via AI-assisted confirmation flows.

---

## Architecture

### Two-process model

```
┌─────────────────────────────────────────┐    ┌──────────────────────────────┐
│           ExpenseSyncBot (main)         │    │   bank-sync service          │
│                                         │    │                              │
│  /bank command handler                  │    │  ZenPlugin runner            │
│  AI agent (+ bank tools)                │    │  cron scheduler (30 min)     │
│  Confirmation flow (callback handler)   │    │  bank_transactions table     │
│  Edit(AI) flow (reply-based routing)    │    │  merchant normalization agent │
└─────────────────────────────────────────┘    └──────────────────────────────┘
                         │                                    │
                         └──────────────┬─────────────────────┘
                                        │
                                   SQLite (shared DB)
                                        │
                              bank-sync calls Telegram API
                              directly to send notifications
                              (same BOT_TOKEN, send-only)
```

The bank-sync service runs as a **separate PM2 process** (`bank-sync.ts` entry point) and shares the same SQLite database. For notifications, bank-sync **calls the Telegram Bot API directly** (send-only, using the same `BOT_TOKEN`) instead of going through the main bot process. The main bot owns incoming updates (long-polling/webhook); bank-sync only sends. No polling-on-polling.

### Why separate process

- Crash isolation: a bank plugin error or network hang doesn't affect the main bot
- Simpler concurrency: sync service owns its own event loop and scheduling
- No serialization overhead — shared SQLite DB for reads/writes

---

## ZenPlugin Adapter

### Plugin source — git submodule

ZenPlugins repository is added as a **git submodule** at `src/services/bank/ZenPlugins/`:

```bash
git submodule add https://github.com/zenmoney/ZenPlugins.git src/services/bank/ZenPlugins
```

Updating to latest: `git submodule update --remote src/services/bank/ZenPlugins`.

This gives access to all 72+ plugins without manual copying. The submodule is pinned to a specific commit in our repo; updates are explicit and reviewable.

### Runtime API

ZenPlugins (new TypeScript style) export a single function:

```ts
async function scrape(args: {
  preferences: Record<string, string>; // credentials & config per bank
  fromDate: Date;
  toDate: Date;
}): Promise<{ accounts: Account[]; transactions: Transaction[] }>
```

We implement a runtime shim (`src/services/bank/runtime.ts`) that provides the **full ZenMoney API surface**:

1. `fetch` — native in Bun, no shim needed
2. `ZenMoney.getData(key)` / `ZenMoney.saveData(key, value)` — backed by `bank_plugin_state` SQLite table
3. `ZenMoney.getPreferences()` — alias for `getData('preferences')`, used by some older plugins
4. `ZenMoney.addAccount(account)` / `ZenMoney.addTransaction(tx)` — some plugins accumulate via these calls instead of returning from `scrape()`; shim collects them and merges into the final return value
5. `ZenMoney.readLine(prompt)` — legacy interactive prompt; stub that returns `''` and logs a warning (interactive plugins are not supported)
6. `ZenMoney.setResult(data)` — legacy result setter; shim stores the value and uses it if `scrape()` returns undefined
7. `ZenMoney.trustCertificates(certs)` — no-op (Bun handles SSL natively)
8. `ZenMoney.clearData()` — deletes all `bank_plugin_state` rows for this `connection_id`
9. Credentials from `bank_credentials` table passed as `preferences`

**Pre-implementation check:** Before finalising the registry's `fields` model, reverse-engineer TBC and Kaspi plugins against the shim. The `fields: string[]` model covers simple credential sets; plugins requiring OTP or multi-step auth need an extended field type, e.g.:

```ts
type CredentialField =
  | string  // shorthand for { name, type: 'text' }
  | { name: string; type: 'text' | 'password' | 'otp'; prompt?: string }
```

### BANK_REGISTRY

```ts
// src/services/bank/registry.ts
export const BANK_REGISTRY: Record<string, BankPlugin> = {
  tbc:   { name: 'TBC Bank',   plugin: () => import('./ZenPlugins/src/plugins/TBC/index.ts'),   fields: ['username', 'password'] },
  kaspi: { name: 'Kaspi Bank', plugin: () => import('./ZenPlugins/src/plugins/Kaspi/index.ts'), fields: ['phone', 'password'] },
};
```

Each entry declares credential fields needed, used to build the setup wizard. New bank = add one entry.

---

## Database Schema

### SQLite concurrency

Both processes share the same SQLite file in WAL mode (already enabled in `schema.ts`). WAL allows concurrent reads but only one writer at a time. Under burst writes from bank-sync, the main bot can receive `SQLITE_BUSY`. Both processes must set at init:

```sql
PRAGMA busy_timeout = 5000;  -- retry for up to 5s before raising SQLITE_BUSY
```

Bank-sync's sync loop must catch `SQLITE_BUSY` errors, log them, and skip the current tick — not crash.

### New tables

```sql
-- One row per bank per group
CREATE TABLE bank_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  bank_name TEXT NOT NULL,          -- registry key, e.g. "tbc"
  display_name TEXT NOT NULL,       -- "TBC Bank"
  status TEXT NOT NULL DEFAULT 'setup' CHECK(status IN ('setup', 'active', 'disconnected')),
  -- 'setup':        credential wizard in progress; not yet syncing
  -- 'active':       fully configured, sync running
  -- 'disconnected': manually disabled or persistent auth failure
  consecutive_failures INTEGER NOT NULL DEFAULT 0,  -- reset to 0 on successful sync
  last_sync_at TEXT,                -- ISO8601
  last_error TEXT,                  -- last sync error message if any
  panel_message_id INTEGER,         -- Telegram message ID of the /bank status card for this bank
  panel_message_thread_id INTEGER,  -- topic/thread ID of that message (for edit/delete)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(group_id, bank_name)
);
```

**Wizard lifecycle:** The `/bank setup` wizard creates a `bank_connections` row immediately with `status = 'setup'` and populates credentials step-by-step. On wizard completion the status flips to `'active'`. On `/bank отмена` or on timeout (stale `setup` row older than 10 minutes, cleaned up on next `/bank` invocation), the `setup` row and any partial `bank_credentials` row are deleted. The `UNIQUE(group_id, bank_name)` constraint only conflicts if a row already exists with `status = 'active'` or `'disconnected'` — stale `setup` rows are deleted before restarting the wizard.

```sql
-- Encrypted credentials per connection
CREATE TABLE bank_credentials (
  connection_id INTEGER PRIMARY KEY REFERENCES bank_connections(id),
  encrypted_data TEXT NOT NULL      -- AES-256-GCM, same key as Google tokens
);

-- Persistent plugin state (ZenMoney.getData/saveData shim)
CREATE TABLE bank_plugin_state (
  connection_id INTEGER NOT NULL REFERENCES bank_connections(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(connection_id, key)
);

-- Account balances from the most recent scrape
-- Populated from scrape()'s accounts: Account[] return value
CREATE TABLE bank_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES bank_connections(id),
  account_id TEXT NOT NULL,         -- bank's own account identifier
  title TEXT NOT NULL,              -- account name/label from bank
  balance REAL NOT NULL,
  currency TEXT NOT NULL,
  type TEXT,                        -- 'checking' | 'savings' | 'credit' | null if unknown
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(connection_id, account_id)
);

-- Raw transactions from bank
CREATE TABLE bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES bank_connections(id),
  external_id TEXT NOT NULL,        -- bank's own transaction ID
  date TEXT NOT NULL,               -- YYYY-MM-DD
  amount REAL NOT NULL,             -- always stored as absolute value (>= 0)
  sign_type TEXT NOT NULL DEFAULT 'debit' CHECK(sign_type IN ('debit', 'credit', 'reversal')),
  -- 'debit':    money out — standard expense, goes through confirmation flow
  -- 'credit':   money in — income or refund, goes through confirmation flow
  -- 'reversal': cancelled/reversed transaction — auto-skipped, no notification sent
  currency TEXT NOT NULL,
  merchant TEXT,                    -- raw merchant string from bank
  merchant_normalized TEXT,         -- after applying merchant_rules
  mcc INTEGER,                      -- merchant category code if available
  raw_data TEXT NOT NULL,           -- full JSON from bank plugin
  matched_expense_id INTEGER REFERENCES expenses(id),
  telegram_message_id INTEGER,      -- message ID of the sent confirmation card (set after send)
  edit_in_progress INTEGER NOT NULL DEFAULT 0,  -- 1 while user is in "Исправить" flow; persisted across restarts
  status TEXT NOT NULL DEFAULT 'pending' CHECK(status IN ('pending', 'confirmed', 'skipped', 'skipped_reversal')),
  -- 'pending':          awaiting user action
  -- 'confirmed':        expense recorded
  -- 'skipped':          user explicitly skipped via /bank panel
  -- 'skipped_reversal': auto-skipped because sign_type = 'reversal'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(connection_id, external_id)
);

-- Global shared merchant normalization rules
-- Shared across all groups. Privacy note: this is a single-admin/single-owner deployment.
-- For multi-tenant deployment, rules must be scoped per-group.
CREATE TABLE merchant_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL,            -- regexp source, e.g. "GLOVO.*"
  flags TEXT NOT NULL DEFAULT 'i',  -- regexp flags
  replacement TEXT NOT NULL,        -- normalized name, e.g. "Glovo"
  category TEXT,                    -- suggested category, e.g. "food"
  confidence REAL NOT NULL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'pending_review' CHECK(status IN ('pending_review', 'approved', 'rejected')),
  source TEXT NOT NULL DEFAULT 'ai' CHECK(source IN ('ai', 'manual')),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Signals from main bot to bank-sync that a new rule is needed
-- UNIQUE(merchant_raw): prevents duplicate AI calls for the same merchant string
-- appearing across multiple groups. Use INSERT OR IGNORE when inserting.
-- Processed rows (processed = 1) are pruned after 7 days by bank-sync.
CREATE TABLE merchant_rule_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_raw TEXT NOT NULL,
  mcc INTEGER,
  group_id INTEGER REFERENCES groups(id),  -- which group triggered this; used for per-group context
  user_category TEXT,               -- category the user confirmed/edited
  user_comment TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(merchant_raw)
);
```

---

## Polling / Sync Service

### Entry point: `src/services/bank/sync-service.ts`

Runs as separate PM2 process. On startup:
1. Sets `PRAGMA busy_timeout = 5000`
2. Loads all `bank_connections` with `status = 'active'`
3. Schedules polling per connection: interval 30 min, initial delay = `(connection_id % 30)` minutes
   — hash-based stagger ensures even after a PM2 restart all connections don't fire simultaneously
4. On each tick:
   a. Calls `scrape({ preferences, fromDate: lastSyncAt ?? 30daysAgo, toDate: now })`
   b. Upserts accounts into `bank_accounts` (`ON CONFLICT(connection_id, account_id) DO UPDATE SET balance = excluded.balance, updated_at = datetime('now')`)
   c. For each transaction from scrape result:
      - If amount < 0 or plugin marks as reversal → `sign_type = 'reversal'`, store `abs(amount)`, insert with `status = 'skipped_reversal'`, no notification
      - If amount = 0 → skip entirely
      - If plugin marks as income/credit → `sign_type = 'credit'`, store `abs(amount)`, `status = 'pending'`
      - Otherwise → `sign_type = 'debit'`, `status = 'pending'`
   d. Upserts into `bank_transactions` (`ON CONFLICT(connection_id, external_id) DO NOTHING`)
   e. Applies approved `merchant_rules` to set `merchant_normalized` on newly inserted rows
   f. Resets `consecutive_failures = 0`, updates `last_sync_at`
   g. For each new `pending` transaction: calls AI pre-fill, sends confirmation card, stores returned `telegram_message_id` on the row
5. On `SQLITE_BUSY` or network error: increments `consecutive_failures`, updates `last_error`
6. If `consecutive_failures >= 3`: sends error alert to group (see Error Escalation below)

### Error escalation

After 3 consecutive failures, bank-sync sends a Telegram message directly to the group:

```
⚠️ TBC Bank — ошибка синхронизации

Не удаётся подключиться 3 раза подряд.
Последняя ошибка: Invalid credentials

Возможно, изменился пароль или истекла сессия.
/bank tbc — переподключить
```

Escalation fires once per failure streak (not on every subsequent failure). Resets when sync succeeds.

### Notification delivery — direct Telegram calls

bank-sync sends confirmation cards by calling `https://api.telegram.org/bot{BOT_TOKEN}/sendMessage` directly with the group's `telegram_group_id` and `message_thread_id`. The main bot handles all `callback_query` updates (button presses).

Both processes share the same `BOT_TOKEN`. There is no conflict: only one process polls for updates (main bot); bank-sync is send-only.

---

## Merchant Rules & Admin Approval

### Global merchant table

`merchant_rules` is **shared across all groups**. This is intentional for a single-admin deployment where the bot owner manages all groups — one approval benefits all groups simultaneously.

**Privacy boundary:** The admin approval card includes example matches drawn from real transaction strings. This is acceptable when the admin is the owner of all groups. If the deployment ever becomes multi-tenant (different admins per group), merchant rules must be scoped per-group.

Rules produced by the AI agent start with `status = 'pending_review'` and are **not applied** until an admin approves them.

### Merchant normalization AI agent

Lives in bank-sync service (`src/services/bank/merchant-agent.ts`). After each scrape cycle and when a new `merchant_rule_requests` row appears:
1. Collects unmatched `merchant` strings with no approved rule
2. Sends batch to AI with context: existing approved rules, MCC codes, amounts, user-confirmed categories
3. AI returns structured JSON: `[{ pattern, replacement, category, confidence }]`
4. Rules inserted with `status = 'pending_review'`, `source = 'ai'`
5. For each proposed rule, sends an **admin approval card** to `BOT_ADMIN_CHAT_ID`:

```
🔧 Новое правило для мерчанта

Паттерн: GLOVO.*
→ Glovo
🗂 Категория: еда
📊 Уверенность: 87%

Примеры совпадений:
• "GLOVO*ORDER 1234" → "Glovo"
• "GLOVO DELIVERY" → "Glovo"

[✅ Принять] [✏️ Исправить] [❌ Отклонить]
```

Admin approves/rejects via buttons. "Исправить" opens an AI edit flow (same reply-based mechanism as transaction edits). Approved rules immediately apply to existing unmatched transactions.

If `BOT_ADMIN_CHAT_ID` is not set, AI-generated merchant rules are disabled entirely — no rules are created, no cards are sent. Manual rules (source = 'manual') still work. The process must not crash on startup if this var is absent.

---

## Security — Swiss Cheese Model

Multiple independent layers; all must be breached simultaneously to leak data.

**Layer 1 — Repository isolation**: Every `BankTransactionRepository` method requires `group_id` as a mandatory parameter. Queries always include `WHERE bt.connection_id IN (SELECT id FROM bank_connections WHERE group_id = ?)`. No method accepts a bare `transaction_id` without a `group_id`.

**Layer 2 — Connection ownership check**: Before any read or write on a `bank_connection`, verify `connection.group_id === requestingGroupId`. This check is in the repository, not the caller.

**Layer 3 — AI tool isolation**: `get_bank_transactions`, `get_bank_balances`, `find_missing_expenses` tools always scope to `ctx.groupId` (from `AgentContext`). No tool parameter can override the group scope.

**Layer 4 — Credentials never leak**: `bank_credentials` table is never read in any AI tool, never serialized to logs, never included in any response payload. Decryption happens only in bank-sync service, never in main bot.

**Layer 5 — Raw data never in AI context**: `bank_transactions.raw_data` (full bank JSON) is never passed to the AI. Only normalized fields (amount, currency, merchant_normalized, date, category suggestion) are included.

---

## Confirmation Flow

When bank-sync sends a new transaction, AI pre-fills category and comment, then sends the card:

```
💳 TBC Bank — 45.00 GEL
📍 Glovo
🗂 Категория: еда
💬 Комментарий: заказ еды
🏷 MCC: 5812 (Рестораны)

[✅ Принять] [✏️ Исправить]
```

- **Принять**: saves expense with pre-filled data, marks transaction `confirmed`, writes `merchant_rule_requests` row (`INSERT OR IGNORE`) so agent learns from this confirmation
- **Исправить**: sets `edit_in_progress = 1` on the transaction; bot replies to the card: "Ответь на это сообщение и напиши что исправить". User replies to **this specific bot message** using Telegram's reply feature. The reply is routed to edit flow by `message_thread_id` + `reply_to_message_id` — unambiguous even when multiple transactions are pending simultaneously. After edit completes, `edit_in_progress` resets to 0.

No "Пропустить" button: transactions stay `pending` until explicitly confirmed or ignored via `/bank` management panel.

### Large transactions

Amount exceeds `LARGE_TX_THRESHOLD` (configurable, default: group default currency equivalent of 100 EUR). Exchange rate uses the same hardcoded rates from `src/services/currency/converter.ts` — no live rate fetch.

```
⚠️ Крупная транзакция — 1 200.00 GEL
...same card...
```

Sent within ≤30s of sync (next scheduled tick or immediate trigger).

---

## AI Tools for Bank Data

New tools in `TOOL_DEFINITIONS`:

```ts
{
  name: 'get_bank_transactions',
  description: 'Get bank transactions for a period. All results are scoped to this group only.',
  input_schema: {
    properties: {
      period: { type: 'string', description: '"current_month" | "last_month" | "YYYY-MM"' },
      bank_name: { type: 'string', description: 'Filter by bank registry key (e.g. "tbc")' },
      status: { type: 'string', description: '"pending" | "confirmed" | "skipped" | omit for all' },
    }
  }
}

{
  name: 'get_bank_balances',
  description: 'Get current account balances from all connected banks. Returns per-bank and total in group default currency.',
  input_schema: {
    properties: {
      bank_name: { type: 'string', description: 'Optional: filter to specific bank' }
    }
  }
}

{
  name: 'find_missing_expenses',
  description: 'Compare bank transactions vs recorded expenses. Returns unmatched bank transactions that may be missing from the expense log.',
  input_schema: {
    properties: {
      period: { type: 'string', description: '"current_month" | "last_month" | "YYYY-MM"' }
    }
  }
}
```

### `find_missing_expenses` matching algorithm

A bank transaction is considered **matched** if `matched_expense_id IS NOT NULL` (set when the user confirms the transaction). A transaction is considered **potentially missing** if:

- `status = 'pending'` or `status = 'confirmed'`
- `matched_expense_id IS NULL`
- `sign_type = 'debit'` (outgoing only — income is not an expense)

For each such transaction, the tool attempts a fuzzy match against `expenses` in the same period:

1. **Exact match**: same `amount`, same `currency`, `date` within ±2 days → considered matched, `matched_expense_id` is updated
2. **Probable match**: same `amount`, same `currency`, `date` within ±5 days → returned as "probable" with low confidence
3. **No match**: returned as "missing"

Date drift tolerance (±2/±5 days) accounts for bank settlement delays (a card charge at 23:50 posts the next day; some banks settle after 2–3 business days).

The tool returns missing transactions only — matched ones are not included. The AI uses the result to suggest recording the missing expenses.

---

## `/bank` Command

### `/bank` — no connected banks

```
Ни одного банка не подключено.

Выбери банк:
[TBC Bank] [Kaspi] [Raiffeisen] [...]
```

Starts multi-step credential wizard: one message per credential field, state tracked in `bank_connections` (`status = 'setup'`) + `bank_credentials` as they're filled in. Wizard can be cancelled at any step with `/bank отмена`, which deletes the `setup` row.

### `/bank` — banks connected (single bank)

```
🏦 Подключённые банки

TBC Bank · 5 мин назад · ✅
Баланс: 1 240.50 GEL (~620 EUR)

Последние операции:
• 45.00 GEL — Glovo · ✅ записано
• 12.00 GEL — Shell · ⏳ ожидает
• 200.00 GEL — ATM · ✅ записано

[➕ Добавить банк] [⚙️ TBC Bank]
```

"⚙️ TBC Bank" expands inline:

```
[🔄 Синхронизировать] [🔌 Отключить]
```

### `/bank <name>` — specific bank

Not connected → jumps straight to setup wizard for that bank.
Connected → shows status card for that bank with last 3 transactions + manage buttons.

---

## Multi-Bank Summary

When 2+ banks are connected, `/bank` sends **one message per bank** plus a **summary message** — rather than cramming everything into one message (which hits the 4096-char limit with 5+ banks × 3 transactions each).

Message IDs are persisted so the panel can be updated in-place or cleaned up:
- Each bank's message ID is stored in `bank_connections.panel_message_id` / `panel_message_thread_id`
- The summary message ID is stored in a dedicated column `bank_panel_summary_message_id` on the `groups` table (added via migration)

**On `/bank` invocation:**
1. For each existing `panel_message_id` on active connections: call `deleteMessage` (silent if already gone)
2. Delete summary message if `bank_panel_summary_message_id` exists (silent if gone)
3. Send one message per bank (latest balance + last 3 ops + manage buttons), store returned message ID
4. Send summary message:

```
Итого: ~2 300 EUR (TBC: ~620 + Kaspi: ~1 680)
[➕ Добавить банк]
```

**On bank data change** (new transaction confirmed, sync completed): edit the relevant bank's message in-place using `editMessageText` with stored `panel_message_id`. Do not re-send all messages.

`get_bank_balances` AI tool returns the same balance data for use in AI responses (reads from `bank_accounts`, does not send Telegram messages).

---

## Pattern Analytics / /advice Integration

Bank transaction data is incorporated into `spending-analytics.ts` and `/advice` triggers:

- **New analytics source**: `bank_transactions` (confirmed + pending) alongside manual `expenses`
- **New trigger**: daily reconciliation — if `pending` bank transactions exist at end of day, trigger advice suggesting to review them
- **New spending patterns**: day-of-week analysis, recurring charges detection (subscriptions), merchant frequency — based on bank data since it's more complete than manual entries
- **`formatSnapshotForPrompt`** extended to include bank balance per account and recent confirmed bank transactions
- MCC codes used to enrich category suggestions in analytics context

---

## Environment Variables

New variables required by the bank integration:

| Variable | Required | Description |
|----------|----------|-------------|
| `BOT_ADMIN_CHAT_ID` | No | Telegram user ID of the bot admin. Used to send merchant rule approval cards. If absent, AI merchant rule generation is disabled (no crash). Set to your Telegram user ID (visible in bot settings or client). |

`BOT_ADMIN_CHAT_ID` is distinct from `BOT_TOKEN` and group IDs — it's a personal chat ID used for admin-only notifications. There is no existing equivalent in the project.

Add to `.env.example`:
```
# Admin Telegram user ID — for merchant rule approval cards (optional)
# BOT_ADMIN_CHAT_ID=
```

---

## Out of Scope (for this spec)

- Auto-sync confirmed bank transactions to Google Sheets (explicitly excluded)
- Web UI for managing merchant rules
- Multiple simultaneous active edit flows per group — one active edit at a time; if a second "Исправить" is clicked while one is in progress, bot replies "Сначала заверши текущее исправление"
