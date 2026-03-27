# Bank Integration Design

**Date:** 2026-03-27
**Branch:** feature/bank-integration
**Status:** Draft

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
│  AI agent (+ bank tools)                │◄──►│  cron scheduler              │
│  Confirmation flow (callback handler)   │    │  bank_transactions table     │
│  Edit(AI) router (message handler)      │    │  merchant_rules table        │
│  Notification poller (60s)              │    │  merchant normalization agent │
└─────────────────────────────────────────┘    └──────────────────────────────┘
                         │                                    │
                         └──────────────┬─────────────────────┘
                                        │
                                   SQLite (shared DB)
```

The bank-sync service runs as a **separate PM2 process** (`bank-sync.ts` entry point) and shares the same SQLite database. Communication is entirely through the DB — no HTTP between processes. The main bot reads bank data on demand; the sync service writes it in the background.

### Why separate process

- Crash isolation: a bank plugin error or network hang doesn't affect the main bot
- Simpler concurrency: sync service owns its own event loop and scheduling
- Same SQLite DB, so no serialization overhead or message queue needed

---

## ZenPlugin Adapter

### Runtime API implementation

ZenPlugins (new TypeScript style) export a single function:

```ts
async function scrape(args: {
  preferences: Record<string, string>; // credentials & config per bank
  fromDate: Date;
  toDate: Date;
}): Promise<{ accounts: Account[]; transactions: Transaction[] }>
```

We implement a thin runtime shim that:
1. Provides `fetch` (native in Bun — no shim needed)
2. Provides persistent key-value store per plugin instance (`ZenMoney.getData` / `ZenMoney.saveData` legacy API) backed by a `bank_plugin_state` SQLite table
3. Passes credentials from `bank_credentials` table as `preferences`

Plugins are **vendored** into `src/services/bank/plugins/<name>/` — copied from ZenPlugins repo, TypeScript as-is. Adding a new bank = copy the plugin folder + register in `BANK_REGISTRY`.

### BANK_REGISTRY

```ts
// src/services/bank/registry.ts
export const BANK_REGISTRY: Record<string, BankPlugin> = {
  tbc:   { name: 'TBC Bank',   plugin: () => import('./plugins/tbc/index.ts'),   fields: ['username', 'password'] },
  kaspi: { name: 'Kaspi Bank', plugin: () => import('./plugins/kaspi/index.ts'), fields: ['phone', 'password'] },
  // ...
};
```

Each entry declares what credential fields the plugin needs, used to build the setup wizard.

---

## Database Schema

### New tables

```sql
-- One row per bank per group
CREATE TABLE bank_connections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  bank_name TEXT NOT NULL,          -- registry key, e.g. "tbc"
  display_name TEXT NOT NULL,        -- "TBC Bank"
  is_active INTEGER NOT NULL DEFAULT 1,
  last_sync_at TEXT,                 -- ISO8601
  last_error TEXT,                   -- last sync error message if any
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(group_id, bank_name)
);

-- Encrypted credentials per connection
CREATE TABLE bank_credentials (
  connection_id INTEGER PRIMARY KEY REFERENCES bank_connections(id),
  encrypted_data TEXT NOT NULL       -- AES-256-GCM, same key as Google tokens
);

-- Persistent plugin state (replaces ZenMoney.getData/saveData)
CREATE TABLE bank_plugin_state (
  connection_id INTEGER NOT NULL REFERENCES bank_connections(id),
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  PRIMARY KEY(connection_id, key)
);

-- Raw transactions from bank (source of truth for reconciliation)
CREATE TABLE bank_transactions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  connection_id INTEGER NOT NULL REFERENCES bank_connections(id),
  external_id TEXT NOT NULL,         -- bank's own transaction ID
  date TEXT NOT NULL,                -- YYYY-MM-DD
  amount REAL NOT NULL,
  currency TEXT NOT NULL,
  merchant TEXT,                     -- raw merchant string from bank
  merchant_normalized TEXT,          -- after applying merchant_rules
  mcc INTEGER,                       -- merchant category code if provided
  raw_data TEXT NOT NULL,            -- full JSON from bank plugin
  matched_expense_id INTEGER REFERENCES expenses(id),
  status TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | ignored
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(connection_id, external_id)
);

-- Shared regexp rules for merchant normalization (all groups contribute)
CREATE TABLE merchant_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern TEXT NOT NULL,             -- regexp source
  flags TEXT NOT NULL DEFAULT 'i',   -- regexp flags
  replacement TEXT NOT NULL,         -- replacement string (may use capture groups)
  category TEXT,                     -- suggested category if matched
  confidence REAL NOT NULL DEFAULT 1.0,
  source TEXT NOT NULL DEFAULT 'ai', -- 'ai' | 'manual'
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

---

## Polling / Sync Service

### Entry point: `src/services/bank/sync-service.ts`

Runs as separate PM2 process. On startup:
1. Loads all active `bank_connections`
2. Schedules a polling loop per connection (default: every 30 min, staggered to avoid simultaneous requests)
3. On each tick: calls `scrape({ preferences, fromDate: lastSyncAt ?? 30daysAgo, toDate: now })`
4. Upserts results into `bank_transactions` (ON CONFLICT IGNORE on `external_id`)
5. Updates `last_sync_at` and `last_error`
6. Writes a notification record to `bank_notifications` table (picked up by main bot)

### Notification delivery

```sql
CREATE TABLE bank_notifications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  type TEXT NOT NULL,  -- 'new_transactions' | 'sync_error'
  payload TEXT NOT NULL,  -- JSON
  delivered INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Main bot polls this table every 60s (lightweight SELECT) and delivers pending notifications to Telegram.

---

## Merchant Rules & AI Agent

### Merchant correction table

`merchant_rules` is a **shared, global table** — not per-group. All groups contribute to and benefit from it.

Each rule is a (pattern, replacement, category) tuple:
- `pattern`: regexp, e.g. `"glovo.*"` or `"NETFLIX\\.COM"`
- `replacement`: normalized name, e.g. `"Glovo"`
- `category`: suggested expense category, e.g. `"food"`

### Merchant normalization AI agent

A **separate background agent** (`src/services/bank/merchant-agent.ts`) runs after each sync cycle and after each user-confirmed transaction. It:
1. Collects all `merchant` strings that have no match in `merchant_rules`
2. Sends them in batch to AI (Claude) with context: existing rules, MCC codes, known patterns
3. AI returns new rules in structured JSON
4. Rules are inserted into `merchant_rules` with `source = 'ai'`, `confidence < 1.0`
5. High-confidence rules (≥ 0.9) are applied immediately; low-confidence ones wait for manual review

The merchant normalization agent lives in the **bank-sync service**, not the main bot. It writes rules to `merchant_rules` table; the main bot reads them on demand. The agent is triggered by the sync service after each scrape cycle and also when a new rule is needed (signaled via a `merchant_rule_requests` table row written by the main bot after user confirms a transaction).

---

## Confirmation Flow (Idea 2 / 9)

When new bank transactions arrive, for each unmatched `pending` transaction:

1. **AI pre-fill**: call AI with merchant_normalized, amount, currency, MCC → get `{ category, comment, confidence }`
2. **Send confirmation card** to group:
   ```
   💳 TBC Bank — 45.00 GEL
   📍 Glovo (доставка еды)
   🗂 Категория: food
   💬 Комментарий: заказ еды

   [✅ Принять] [✏️ Edit (AI)] [🚫 Игнор]
   ```
3. **Accept**: saves expense with pre-filled data, marks transaction as `confirmed`
4. **Edit (AI)**: bot writes a `bank_pending_edits` row linking `(group_id, bank_transaction_id)`, then sends "Напиши как исправить — я обновлю категорию и комментарий". The next text message from any group member is routed by `message.handler.ts` to the bank edit flow if a pending edit exists for that group. AI receives the original transaction + user's correction, returns updated `{ category, comment }`, bot re-sends the confirmation card.
5. **Ignore**: marks transaction as `ignored`, won't appear again

For **large transactions** (configurable threshold, default: 100 in group's default currency):
- Notification is immediate (next delivery cycle, ≤60s)
- Card is identical but with a `⚠️ Крупная транзакция` header

---

## AI Tools for Bank Data

New tools added to `TOOL_DEFINITIONS`:

```ts
{
  name: 'get_bank_transactions',
  description: 'Get raw bank transactions for a period. Use to compare with recorded expenses or find unrecorded spending.',
  // params: period, bank_name, status
}

{
  name: 'get_bank_balances',
  description: 'Get current account balances from all connected banks.',
  // params: bank_name (optional filter)
}

{
  name: 'find_missing_expenses',
  description: 'Compare bank transactions vs recorded expenses for a period. Returns unmatched bank transactions (potential missing expenses).',
  // params: period
}
```

---

## `/bank` Command

### `/bank` — no connected banks

Starts interactive wizard:
```
Ни одного банка не подключено.

Выбери банк:
[TBC Bank] [Kaspi] [Raiffeisen] [Другой...]
```

Each bank button triggers a multi-step credential input flow (one field per message, using GramIO scenes or conversation state).

### `/bank` — banks connected

```
🏦 Подключённые банки

TBC Bank · последняя синхр. 5 мин назад · ✅
  Баланс: 1 240.50 GEL | Транзакций сегодня: 3

[➕ Добавить банк] [⚙️ TBC Bank ▼]

⚙️ TBC Bank:
[🔄 Синхронизировать] [🔌 Отключить]
```

### `/bank <name>` — specific bank

If not connected: jumps straight to that bank's setup wizard.
If connected: shows status + management panel for that bank only + last 5 transactions summary.

---

## Multi-Bank Summary (Idea 13)

Available via `/bank` summary card and `get_bank_balances` AI tool:
- Total balance across all accounts, converted to group default currency
- Per-bank breakdown with local currency + equivalent
- Money flow: income vs spending this month per bank

---

## Security

- Bank credentials encrypted with same `ENCRYPTION_KEY` used for Google OAuth tokens (AES-256-GCM)
- Credentials never logged (same conventions as Google refresh tokens)
- Plugin code runs in same process trust level as rest of bot — no sandbox. Only trusted, audited plugins from ZenPlugins repo are vendored.
- `bank_credentials` table never returned in any AI tool response

---

## Out of Scope (for this spec)

- Auto-sync to Google Sheets on bank import (explicitly excluded)
- Pattern analytics / /advice integration (separate task, uses bank data once available)
- MCC-based auto-categorization without confirmation (all confirmation required per user request)
- Web UI for managing merchant rules
- Manual review UI for low-confidence AI-generated rules (confidence < 0.9) — rules are stored but not applied until a future admin tool is built
- Deduplication logic for bank_pending_edits when multiple transactions are pending simultaneously (first one wins)
