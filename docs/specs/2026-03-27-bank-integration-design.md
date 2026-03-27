# Bank Integration Design

**Date:** 2026-03-27
**Branch:** feature/bank-integration
**Status:** Draft v2

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

We implement a thin runtime shim (`src/services/bank/runtime.ts`) that:
1. Provides `fetch` — native in Bun, no shim needed
2. Implements `ZenMoney.getData` / `ZenMoney.saveData` legacy API backed by `bank_plugin_state` SQLite table
3. Passes credentials from `bank_credentials` table as `preferences`

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

### New tables

```sql
-- One row per bank per group
CREATE TABLE bank_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  bank_name TEXT NOT NULL,          -- registry key, e.g. "tbc"
  display_name TEXT NOT NULL,       -- "TBC Bank"
  is_active INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,                -- ISO8601
  last_error TEXT,                  -- last sync error message if any
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(group_id, bank_name)
);

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

-- Raw transactions from bank
CREATE TABLE bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES bank_connections(id),
  external_id TEXT NOT NULL,        -- bank's own transaction ID
  date TEXT NOT NULL,               -- YYYY-MM-DD
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  merchant TEXT,                    -- raw merchant string from bank
  merchant_normalized TEXT,         -- after applying merchant_rules
  mcc INTEGER,                      -- merchant category code if available
  raw_data TEXT NOT NULL,           -- full JSON from bank plugin
  matched_expense_id INTEGER REFERENCES expenses(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | skipped
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(connection_id, external_id)
);

-- Global shared merchant normalization rules
CREATE TABLE merchant_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL,            -- regexp source, e.g. "GLOVO.*"
  flags TEXT NOT NULL DEFAULT 'i',  -- regexp flags
  replacement TEXT NOT NULL,        -- normalized name, e.g. "Glovo"
  category TEXT,                    -- suggested category, e.g. "food"
  confidence REAL NOT NULL DEFAULT 1.0,
  status TEXT NOT NULL DEFAULT 'pending_review',  -- pending_review | approved | rejected
  source TEXT NOT NULL DEFAULT 'ai',              -- 'ai' | 'manual'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Signals from main bot to bank-sync that a new rule is needed
CREATE TABLE merchant_rule_requests (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  merchant_raw TEXT NOT NULL,
  mcc INTEGER,
  user_category TEXT,               -- category the user confirmed/edited
  user_comment TEXT,
  processed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## Polling / Sync Service

### Entry point: `src/services/bank/sync-service.ts`

Runs as separate PM2 process. On startup:
1. Loads all active `bank_connections`
2. Schedules polling per connection (default: every 30 min, staggered starts to avoid bursts)
3. On each tick:
   a. Calls `scrape({ preferences, fromDate: lastSyncAt ?? 30daysAgo, toDate: now })`
   b. Upserts into `bank_transactions` (`ON CONFLICT(connection_id, external_id) DO NOTHING`)
   c. Applies `merchant_rules` (approved only) to set `merchant_normalized`
   d. Updates `last_sync_at` / `last_error`
   e. For each new `pending` transaction: calls AI pre-fill, then sends confirmation card to group **via Telegram API directly**

### Notification delivery — direct Telegram calls

bank-sync sends confirmation cards by calling `https://api.telegram.org/bot{BOT_TOKEN}/sendMessage` directly with the group's `telegram_group_id` and `message_thread_id`. The main bot handles all callback_query updates (button presses).

Both processes share the same `BOT_TOKEN`. There is no conflict: only one process polls for updates (main bot); bank-sync is send-only.

---

## Merchant Rules & Admin Approval

### Global merchant table

`merchant_rules` is **shared across all groups**. Rules produced by the AI agent start with `status = 'pending_review'` and are **not applied** until an admin approves them.

### Merchant normalization AI agent

Lives in bank-sync service (`src/services/bank/merchant-agent.ts`). After each scrape cycle and when a new `merchant_rule_requests` row appears:
1. Collects unmatched `merchant` strings with no approved rule
2. Sends batch to AI with context: existing approved rules, MCC codes, amounts, user-confirmed categories
3. AI returns structured JSON: `[{ pattern, replacement, category, confidence }]`
4. Rules inserted with `status = 'pending_review'`, `source = 'ai'`
5. For each proposed rule, sends an **admin approval card** to `BOT_ADMIN_CHAT_ID` (env var):

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

- **Принять**: saves expense with pre-filled data, marks transaction `confirmed`, writes `merchant_rule_requests` row so agent learns from this confirmation
- **Исправить**: bot replies to the card: "Ответь на это сообщение и напиши что исправить". User replies to **this specific bot message** using Telegram's reply feature. The reply is routed to edit flow by `message_thread_id` + `reply_to_message_id` — unambiguous even when multiple transactions are pending simultaneously.

No "Пропустить" button: transactions stay `pending` until explicitly confirmed or ignored via `/bank` management panel.

### Large transactions

Amount exceeds `LARGE_TX_THRESHOLD` (configurable, default: group default currency equivalent of 100 EUR):

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

---

## `/bank` Command

### `/bank` — no connected banks

```
Ни одного банка не подключено.

Выбери банк:
[TBC Bank] [Kaspi] [Raiffeisen] [...]
```

Starts multi-step credential wizard: one message per credential field, state tracked in `bank_connections` + `bank_credentials` as they're filled in.

### `/bank` — banks connected

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

`/bank` with multiple banks connected shows each bank's card (last 3 ops each) plus a combined total row:

```
Итого: ~2 300 EUR (TBC: ~620 + Kaspi: ~1 680)
```

`get_bank_balances` AI tool returns the same data for use in AI responses.

---

## Pattern Analytics / /advice Integration

Bank transaction data is incorporated into `spending-analytics.ts` and `/advice` triggers:

- **New analytics source**: `bank_transactions` (confirmed + pending) alongside manual `expenses`
- **New trigger**: daily reconciliation — if `pending` bank transactions exist at end of day, trigger advice suggesting to review them
- **New spending patterns**: day-of-week analysis, recurring charges detection (subscriptions), merchant frequency — based on bank data since it's more complete than manual entries
- **`formatSnapshotForPrompt`** extended to include bank balance per account and recent confirmed bank transactions
- MCC codes used to enrich category suggestions in analytics context

---

## Out of Scope (for this spec)

- Auto-sync confirmed bank transactions to Google Sheets (explicitly excluded)
- Web UI for managing merchant rules
- Multiple simultaneous active edit flows per group — one active edit at a time; if a second "Исправить" is clicked while one is in progress, bot replies "Сначала заверши текущее исправление"
