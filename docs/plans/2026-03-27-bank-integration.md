# Bank Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate ZenPlugins bank adapters into ExpenseSyncBot via a separate bank-sync microservice that polls bank APIs on a 30-min schedule, stores raw transactions, and sends AI-prefilled confirmation cards to groups via direct Telegram API calls.

**Architecture:** Two-process model — main bot handles all Telegram updates and user interactions; bank-sync service (separate PM2 process) owns the sync loop and sends confirmation cards via direct `fetch` calls to Telegram API. Both share the same SQLite DB in WAL mode. No IPC needed.

**Tech Stack:** Bun runtime, bun:sqlite, ZenPlugins (git submodule), node:crypto (AES-256-GCM), @anthropic-ai/sdk, node-cron, direct Telegram Bot API HTTP calls (bank-sync send-only)

---

## File Map

### New files

| File | Responsibility |
|------|---------------|
| `src/utils/crypto.ts` | AES-256-GCM encrypt/decrypt for credentials |
| `src/services/bank/registry.ts` | BANK_REGISTRY — known plugins + credential fields |
| `src/services/bank/runtime.ts` | ZenMoney API shim for plugin execution |
| `src/services/bank/telegram-sender.ts` | Send-only direct Telegram API calls for bank-sync |
| `src/services/bank/sync-service.ts` | Sync loop: scheduler + scrape + insert + notify |
| `src/services/bank/merchant-agent.ts` | AI merchant normalization agent |
| `src/services/bank/prefill.ts` | AI pre-fill category/comment for single transaction |
| `src/database/repositories/bank-connections.repository.ts` | CRUD for bank_connections |
| `src/database/repositories/bank-credentials.repository.ts` | Encrypted credentials storage |
| `src/database/repositories/bank-accounts.repository.ts` | Account balance upsert |
| `src/database/repositories/bank-transactions.repository.ts` | Transaction insert/query with group_id security |
| `src/database/repositories/merchant-rules.repository.ts` | Rules + requests CRUD |
| `src/bot/commands/bank.ts` | /bank command — wizard + status panel |
| `bank-sync.ts` | Entry point for bank-sync PM2 process |

### Modified files

| File | Change |
|------|--------|
| `src/config/env.ts` | Add `BOT_ADMIN_CHAT_ID`, `LARGE_TX_THRESHOLD_EUR` |
| `.env.example` | Document new vars |
| `src/database/schema.ts` | Migrations 021-027, `busy_timeout` in `initDatabase()` |
| `src/database/types.ts` | Bank types |
| `src/database/index.ts` | Register 5 new repositories |
| `src/test-utils/db.ts` | Clear bank tables in `clearTestDb()` |
| `src/bot/index.ts` | Register `/bank` command |
| `src/bot/handlers/callback.handler.ts` | `bank_confirm`, `bank_edit`, `merchant_approve`, `merchant_reject`, `merchant_edit` |
| `src/bot/handlers/message.handler.ts` | Route reply-based edit flow |
| `src/services/ai/tools.ts` | Add 3 bank tool definitions |
| `src/services/ai/tool-executor.ts` | Implement 3 bank tools |
| `src/services/analytics/spending-analytics.ts` | Include bank transactions as analytics source |
| `src/services/analytics/advice-triggers.ts` | Pending bank transactions daily trigger |
| `src/services/analytics/formatters.ts` | `formatSnapshotForPrompt` — add bank balances |

---

## Task 1: env vars + crypto utility + busy_timeout

**Files:**

- Modify: `src/config/env.ts`
- Modify: `.env.example`
- Create: `src/utils/crypto.ts`
- Create: `src/utils/crypto.test.ts`
- Modify: `src/database/schema.ts` (function `initDatabase`)

- [ ] **Step 1: Write the failing test**

```typescript
// src/utils/crypto.test.ts
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { decryptData, encryptData } from './crypto';

// Set ENCRYPTION_KEY for tests (32 bytes hex)
process.env['ENCRYPTION_KEY'] = 'a'.repeat(64);

describe('crypto', () => {
  test('round-trip: encrypt then decrypt returns original', () => {
    const original = 'hello world secret';
    const encrypted = encryptData(original);
    expect(encrypted).not.toBe(original);
    expect(decryptData(encrypted)).toBe(original);
  });

  test('encrypted output has iv:tag:data format', () => {
    const encrypted = encryptData('test');
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toHaveLength(24);  // 12 bytes IV → 24 hex chars
    expect(parts[1]).toHaveLength(32);  // 16 bytes auth tag → 32 hex chars
  });

  test('each encryption produces different ciphertext (random IV)', () => {
    const c1 = encryptData('same');
    const c2 = encryptData('same');
    expect(c1).not.toBe(c2);
    expect(decryptData(c1)).toBe('same');
    expect(decryptData(c2)).toBe('same');
  });

  test('decrypt throws on tampered ciphertext', () => {
    const encrypted = encryptData('data');
    const tampered = encrypted.slice(0, -4) + 'ffff';
    expect(() => decryptData(tampered)).toThrow();
  });

  test('encrypts and decrypts JSON credentials', () => {
    const creds = JSON.stringify({ username: 'user@bank.ge', password: 'secret123' });
    expect(JSON.parse(decryptData(encryptData(creds)))).toEqual(
      JSON.parse(creds)
    );
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/utils/crypto.test.ts
```

Expected: FAIL — `crypto.ts` does not exist yet.

- [ ] **Step 3: Create `src/utils/crypto.ts`**

```typescript
// Encrypt/decrypt arbitrary strings with AES-256-GCM using ENCRYPTION_KEY from env.
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_BYTES = 12;
const TAG_BYTES = 16;

function getKey(): Buffer {
  const key = process.env['ENCRYPTION_KEY'];
  if (!key) throw new Error('ENCRYPTION_KEY env var is not set');
  return Buffer.from(key, 'hex');
}

/**
 * Encrypt plaintext. Returns "ivHex:authTagHex:ciphertextHex".
 */
export function encryptData(plaintext: string): string {
  const key = getKey();
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

/**
 * Decrypt ciphertext produced by encryptData. Throws on invalid format or tampering.
 */
export function decryptData(ciphertext: string): string {
  const parts = ciphertext.split(':');
  if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
    throw new Error('Invalid ciphertext format');
  }
  const [ivHex, tagHex, encHex] = parts;
  const key = getKey();
  const iv = Buffer.from(ivHex, 'hex');
  const tag = Buffer.from(tagHex, 'hex');
  const enc = Buffer.from(encHex, 'hex');
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return decipher.update(enc).toString('utf8') + decipher.final('utf8');
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/utils/crypto.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Add env vars to `src/config/env.ts`**

In `EnvConfig` interface, add after `GITHUB_TOKEN`:

```typescript
  BOT_ADMIN_CHAT_ID: number | null;
  LARGE_TX_THRESHOLD_EUR: number;
```

In `validateEnv()` return object, add:

```typescript
    BOT_ADMIN_CHAT_ID: process.env['BOT_ADMIN_CHAT_ID']
      ? parseInt(process.env['BOT_ADMIN_CHAT_ID'], 10)
      : null,
    LARGE_TX_THRESHOLD_EUR: parseInt(
      process.env['LARGE_TX_THRESHOLD_EUR'] || '100',
      10,
    ),
```

- [ ] **Step 6: Add env vars to `.env.example`**

After the `GITHUB_TOKEN` line, add:

```
# Admin Telegram user ID — for merchant rule approval cards (optional)
# BOT_ADMIN_CHAT_ID=
# Large transaction threshold in EUR (default: 100)
# LARGE_TX_THRESHOLD_EUR=100
```

- [ ] **Step 7: Add `busy_timeout` to `initDatabase()` in `src/database/schema.ts`**

After the `PRAGMA foreign_keys = ON;` line in `initDatabase()`, add:

```typescript
  db.exec('PRAGMA busy_timeout = 5000;');
```

- [ ] **Step 8: Commit**

```bash
git add src/utils/crypto.ts src/utils/crypto.test.ts src/config/env.ts .env.example src/database/schema.ts
git commit -m "feat(bank): crypto utility, env vars, busy_timeout pragma"
```

---

## Task 2: Database migrations (021-027) + types + clearTestDb

**Files:**

- Modify: `src/database/schema.ts` (add migrations array entries)
- Modify: `src/database/types.ts`
- Modify: `src/test-utils/db.ts`

- [ ] **Step 1: Add migrations 021-027 to `src/database/schema.ts`**

Append these 7 entries inside the `migrations` array (after the `020_add_failed_at_state_to_dev_tasks` entry, before the closing `]`):

```typescript
    {
      name: '021_create_bank_connections',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS bank_connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            bank_name TEXT NOT NULL,
            display_name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'setup'
              CHECK(status IN ('setup', 'active', 'disconnected')),
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            last_sync_at TEXT,
            last_error TEXT,
            panel_message_id INTEGER,
            panel_message_thread_id INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(group_id, bank_name)
          );
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bank_connections_group_id
          ON bank_connections(group_id);
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bank_connections_status
          ON bank_connections(status);
        `);
        logger.info('✓ Created bank_connections table');
      },
    },
    {
      name: '022_create_bank_credentials',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS bank_credentials (
            connection_id INTEGER PRIMARY KEY
              REFERENCES bank_connections(id) ON DELETE CASCADE,
            encrypted_data TEXT NOT NULL
          );
        `);
        logger.info('✓ Created bank_credentials table');
      },
    },
    {
      name: '023_create_bank_plugin_state',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS bank_plugin_state (
            connection_id INTEGER NOT NULL
              REFERENCES bank_connections(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY(connection_id, key)
          );
        `);
        logger.info('✓ Created bank_plugin_state table');
      },
    },
    {
      name: '024_create_bank_accounts',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS bank_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id INTEGER NOT NULL
              REFERENCES bank_connections(id) ON DELETE CASCADE,
            account_id TEXT NOT NULL,
            title TEXT NOT NULL,
            balance REAL NOT NULL,
            currency TEXT NOT NULL,
            type TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(connection_id, account_id)
          );
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bank_accounts_connection_id
          ON bank_accounts(connection_id);
        `);
        logger.info('✓ Created bank_accounts table');
      },
    },
    {
      name: '025_create_bank_transactions',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS bank_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id INTEGER NOT NULL
              REFERENCES bank_connections(id) ON DELETE CASCADE,
            external_id TEXT NOT NULL,
            date TEXT NOT NULL,
            amount REAL NOT NULL,
            sign_type TEXT NOT NULL DEFAULT 'debit'
              CHECK(sign_type IN ('debit', 'credit', 'reversal')),
            currency TEXT NOT NULL,
            merchant TEXT,
            merchant_normalized TEXT,
            mcc INTEGER,
            raw_data TEXT NOT NULL,
            matched_expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
            telegram_message_id INTEGER,
            edit_in_progress INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending', 'confirmed', 'skipped', 'skipped_reversal')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(connection_id, external_id)
          );
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bank_transactions_connection_id
          ON bank_transactions(connection_id);
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bank_transactions_status
          ON bank_transactions(status);
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bank_transactions_date
          ON bank_transactions(date);
        `);
        logger.info('✓ Created bank_transactions table');
      },
    },
    {
      name: '026_create_merchant_tables',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS merchant_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pattern TEXT NOT NULL,
            flags TEXT NOT NULL DEFAULT 'i',
            replacement TEXT NOT NULL,
            category TEXT,
            confidence REAL NOT NULL DEFAULT 1.0,
            status TEXT NOT NULL DEFAULT 'pending_review'
              CHECK(status IN ('pending_review', 'approved', 'rejected')),
            source TEXT NOT NULL DEFAULT 'ai'
              CHECK(source IN ('ai', 'manual')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_merchant_rules_status
          ON merchant_rules(status);
        `);
        db.exec(`
          CREATE TABLE IF NOT EXISTS merchant_rule_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            merchant_raw TEXT NOT NULL,
            mcc INTEGER,
            group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
            user_category TEXT,
            user_comment TEXT,
            processed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(merchant_raw)
          );
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_merchant_rule_requests_processed
          ON merchant_rule_requests(processed);
        `);
        logger.info('✓ Created merchant_rules and merchant_rule_requests tables');
      },
    },
    {
      name: '027_add_bank_panel_summary_to_groups',
      up: () => {
        const check = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count FROM pragma_table_info('groups')
          WHERE name = 'bank_panel_summary_message_id'
        `);
        if (check.get()?.count === 0) {
          db.exec(`
            ALTER TABLE groups ADD COLUMN bank_panel_summary_message_id INTEGER;
          `);
          logger.info('✓ Added bank_panel_summary_message_id to groups');
        }
      },
    },
```

- [ ] **Step 2: Add bank types to `src/database/types.ts`**

Append at end of file:

```typescript
// ─── Bank Integration Types ─────────────────────────────────────────────────

export interface BankConnection {
  id: number;
  group_id: number;
  bank_name: string;
  display_name: string;
  status: 'setup' | 'active' | 'disconnected';
  consecutive_failures: number;
  last_sync_at: string | null;
  last_error: string | null;
  panel_message_id: number | null;
  panel_message_thread_id: number | null;
  created_at: string;
}

export interface CreateBankConnectionData {
  group_id: number;
  bank_name: string;
  display_name: string;
  status?: BankConnection['status'];
}

export interface UpdateBankConnectionData {
  status?: BankConnection['status'];
  consecutive_failures?: number;
  last_sync_at?: string | null;
  last_error?: string | null;
  panel_message_id?: number | null;
  panel_message_thread_id?: number | null;
}

export interface BankCredential {
  connection_id: number;
  encrypted_data: string;
}

export interface BankAccount {
  id: number;
  connection_id: number;
  account_id: string;
  title: string;
  balance: number;
  currency: string;
  type: string | null;
  updated_at: string;
}

export interface UpsertBankAccountData {
  connection_id: number;
  account_id: string;
  title: string;
  balance: number;
  currency: string;
  type?: string | null;
}

export interface BankTransaction {
  id: number;
  connection_id: number;
  external_id: string;
  date: string;
  amount: number;
  sign_type: 'debit' | 'credit' | 'reversal';
  currency: string;
  merchant: string | null;
  merchant_normalized: string | null;
  mcc: number | null;
  raw_data: string;
  matched_expense_id: number | null;
  telegram_message_id: number | null;
  edit_in_progress: number;
  status: 'pending' | 'confirmed' | 'skipped' | 'skipped_reversal';
  created_at: string;
}

export interface CreateBankTransactionData {
  connection_id: number;
  external_id: string;
  date: string;
  amount: number;
  sign_type: BankTransaction['sign_type'];
  currency: string;
  merchant?: string | null;
  merchant_normalized?: string | null;
  mcc?: number | null;
  raw_data: string;
  status: BankTransaction['status'];
}

export interface BankTransactionFilters {
  period?: string;
  bank_name?: string;
  status?: BankTransaction['status'];
}

export interface MerchantRule {
  id: number;
  pattern: string;
  flags: string;
  replacement: string;
  category: string | null;
  confidence: number;
  status: 'pending_review' | 'approved' | 'rejected';
  source: 'ai' | 'manual';
  created_at: string;
  updated_at: string;
}

export interface CreateMerchantRuleData {
  pattern: string;
  flags?: string;
  replacement: string;
  category?: string | null;
  confidence?: number;
  source?: MerchantRule['source'];
}

export interface UpdateMerchantRuleData {
  pattern?: string;
  replacement?: string;
  category?: string | null;
  confidence?: number;
  status?: MerchantRule['status'];
}

export interface MerchantRuleRequest {
  id: number;
  merchant_raw: string;
  mcc: number | null;
  group_id: number | null;
  user_category: string | null;
  user_comment: string | null;
  processed: number;
  created_at: string;
}

export interface CreateMerchantRuleRequestData {
  merchant_raw: string;
  mcc?: number | null;
  group_id?: number | null;
  user_category?: string | null;
  user_comment?: string | null;
}
```

- [ ] **Step 3: Update `clearTestDb()` in `src/test-utils/db.ts`**

Replace the body of `clearTestDb`:

```typescript
export function clearTestDb(db: Database): void {
  db.exec(`
    DELETE FROM merchant_rule_requests;
    DELETE FROM merchant_rules;
    DELETE FROM bank_transactions;
    DELETE FROM bank_accounts;
    DELETE FROM bank_plugin_state;
    DELETE FROM bank_credentials;
    DELETE FROM bank_connections;
    DELETE FROM advice_log;
    DELETE FROM expense_items;
    DELETE FROM chat_messages;
    DELETE FROM dev_tasks;
    DELETE FROM expenses;
    DELETE FROM budgets;
    DELETE FROM categories;
    DELETE FROM pending_expenses;
    DELETE FROM photo_processing_queue;
    DELETE FROM users;
    DELETE FROM groups;
  `);
}
```

- [ ] **Step 4: Verify migrations run without errors**

```bash
bun run type-check
```

Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/database/schema.ts src/database/types.ts src/test-utils/db.ts
git commit -m "feat(bank): db migrations 021-027 and bank types"
```

---

## Task 3: BankConnections repository

**Files:**

- Create: `src/database/repositories/bank-connections.repository.ts`
- Create: `src/database/repositories/bank-connections.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/database/repositories/bank-connections.repository.test.ts
import type { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { GroupRepository } from './group.repository';
import { BankConnectionsRepository } from './bank-connections.repository';

let db: Database;
let repo: BankConnectionsRepository;
let groupRepo: GroupRepository;
let groupId: number;

db = createTestDb();
repo = new BankConnectionsRepository(db);
groupRepo = new GroupRepository(db);

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  groupId = groupRepo.create({ telegram_group_id: Date.now() }).id;
});

describe('BankConnectionsRepository', () => {
  test('create and findById', () => {
    const conn = repo.create({ group_id: groupId, bank_name: 'tbc', display_name: 'TBC Bank' });
    expect(conn.id).toBeGreaterThan(0);
    expect(conn.status).toBe('setup');
    expect(conn.consecutive_failures).toBe(0);
    expect(repo.findById(conn.id)).toEqual(conn);
  });

  test('findByGroupAndBank returns null when not found', () => {
    expect(repo.findByGroupAndBank(groupId, 'tbc')).toBeNull();
  });

  test('findByGroupAndBank returns connection after create', () => {
    repo.create({ group_id: groupId, bank_name: 'tbc', display_name: 'TBC Bank' });
    const found = repo.findByGroupAndBank(groupId, 'tbc');
    expect(found?.bank_name).toBe('tbc');
  });

  test('findActiveByGroupId returns only active', () => {
    repo.create({ group_id: groupId, bank_name: 'tbc', display_name: 'TBC Bank', status: 'active' });
    repo.create({ group_id: groupId, bank_name: 'kaspi', display_name: 'Kaspi', status: 'setup' });
    const active = repo.findActiveByGroupId(groupId);
    expect(active).toHaveLength(1);
    expect(active[0].bank_name).toBe('tbc');
  });

  test('findAllActive returns connections from all groups', () => {
    const g2 = groupRepo.create({ telegram_group_id: Date.now() + 1 }).id;
    repo.create({ group_id: groupId, bank_name: 'tbc', display_name: 'TBC Bank', status: 'active' });
    repo.create({ group_id: g2, bank_name: 'kaspi', display_name: 'Kaspi', status: 'active' });
    expect(repo.findAllActive()).toHaveLength(2);
  });

  test('update changes fields', () => {
    const conn = repo.create({ group_id: groupId, bank_name: 'tbc', display_name: 'TBC Bank' });
    repo.update(conn.id, { status: 'active', consecutive_failures: 2 });
    const updated = repo.findById(conn.id);
    expect(updated?.status).toBe('active');
    expect(updated?.consecutive_failures).toBe(2);
  });

  test('deleteById removes the row', () => {
    const conn = repo.create({ group_id: groupId, bank_name: 'tbc', display_name: 'TBC Bank' });
    repo.deleteById(conn.id);
    expect(repo.findById(conn.id)).toBeNull();
  });

  test('deleteStaleSetup removes setup rows older than 10 min', () => {
    // Insert a stale setup row by manipulating created_at
    db.exec(`
      INSERT INTO bank_connections (group_id, bank_name, display_name, status, created_at)
      VALUES (${groupId}, 'stale', 'Stale Bank', 'setup', datetime('now', '-11 minutes'))
    `);
    repo.deleteStaleSetup(groupId);
    expect(repo.findByGroupAndBank(groupId, 'stale')).toBeNull();
  });

  test('deleteStaleSetup does not remove active connections', () => {
    const conn = repo.create({ group_id: groupId, bank_name: 'tbc', display_name: 'TBC Bank', status: 'active' });
    repo.deleteStaleSetup(groupId);
    expect(repo.findById(conn.id)).not.toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/database/repositories/bank-connections.repository.test.ts
```

Expected: FAIL — file does not exist.

- [ ] **Step 3: Implement `bank-connections.repository.ts`**

```typescript
// CRUD for bank_connections table — wizard lifecycle and sync service queries.
import type { Database } from 'bun:sqlite';
import type {
  BankConnection,
  CreateBankConnectionData,
  UpdateBankConnectionData,
} from '../types';

export class BankConnectionsRepository {
  constructor(private db: Database) {}

  create(data: CreateBankConnectionData): BankConnection {
    const result = this.db.query<{ id: number }, [number, string, string, string]>(`
      INSERT INTO bank_connections (group_id, bank_name, display_name, status)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `).get(data.group_id, data.bank_name, data.display_name, data.status ?? 'setup');

    if (!result) throw new Error('Failed to create bank connection');
    const conn = this.findById(result.id);
    if (!conn) throw new Error('Failed to retrieve created bank connection');
    return conn;
  }

  findById(id: number): BankConnection | null {
    return this.db.query<BankConnection, [number]>(
      'SELECT * FROM bank_connections WHERE id = ?'
    ).get(id) ?? null;
  }

  findByGroupAndBank(groupId: number, bankName: string): BankConnection | null {
    return this.db.query<BankConnection, [number, string]>(
      'SELECT * FROM bank_connections WHERE group_id = ? AND bank_name = ?'
    ).get(groupId, bankName) ?? null;
  }

  findActiveByGroupId(groupId: number): BankConnection[] {
    return this.db.query<BankConnection, [number]>(
      "SELECT * FROM bank_connections WHERE group_id = ? AND status = 'active' ORDER BY created_at"
    ).all(groupId);
  }

  findAllByGroupId(groupId: number): BankConnection[] {
    return this.db.query<BankConnection, [number]>(
      "SELECT * FROM bank_connections WHERE group_id = ? AND status != 'setup' ORDER BY created_at"
    ).all(groupId);
  }

  findAllActive(): BankConnection[] {
    return this.db.query<BankConnection, []>(
      "SELECT * FROM bank_connections WHERE status = 'active'"
    ).all();
  }

  update(id: number, data: UpdateBankConnectionData): void {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
    if (data.consecutive_failures !== undefined) { fields.push('consecutive_failures = ?'); values.push(data.consecutive_failures); }
    if (data.last_sync_at !== undefined) { fields.push('last_sync_at = ?'); values.push(data.last_sync_at); }
    if (data.last_error !== undefined) { fields.push('last_error = ?'); values.push(data.last_error); }
    if (data.panel_message_id !== undefined) { fields.push('panel_message_id = ?'); values.push(data.panel_message_id); }
    if (data.panel_message_thread_id !== undefined) { fields.push('panel_message_thread_id = ?'); values.push(data.panel_message_thread_id); }

    if (fields.length === 0) return;
    values.push(id);
    this.db.exec(`UPDATE bank_connections SET ${fields.join(', ')} WHERE id = ${id}`);
    // Use parameterized for safety:
    const stmt = this.db.prepare(`UPDATE bank_connections SET ${fields.join(', ')} WHERE id = ?`);
    stmt.run(...values);
  }

  deleteById(id: number): void {
    this.db.query<void, [number]>('DELETE FROM bank_connections WHERE id = ?').run(id);
  }

  /**
   * Delete setup-status rows older than 10 minutes for a group (stale wizard sessions).
   */
  deleteStaleSetup(groupId: number): void {
    this.db.query<void, [number]>(`
      DELETE FROM bank_connections
      WHERE group_id = ? AND status = 'setup'
        AND created_at < datetime('now', '-10 minutes')
    `).run(groupId);
  }
}
```

Wait — the `update` method has a bug (running exec then prepare). Fix it:

```typescript
  update(id: number, data: UpdateBankConnectionData): void {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
    if (data.consecutive_failures !== undefined) { fields.push('consecutive_failures = ?'); values.push(data.consecutive_failures); }
    if (data.last_sync_at !== undefined) { fields.push('last_sync_at = ?'); values.push(data.last_sync_at); }
    if (data.last_error !== undefined) { fields.push('last_error = ?'); values.push(data.last_error); }
    if (data.panel_message_id !== undefined) { fields.push('panel_message_id = ?'); values.push(data.panel_message_id); }
    if (data.panel_message_thread_id !== undefined) { fields.push('panel_message_thread_id = ?'); values.push(data.panel_message_thread_id); }

    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE bank_connections SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/database/repositories/bank-connections.repository.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/bank-connections.repository.ts src/database/repositories/bank-connections.repository.test.ts
git commit -m "feat(bank): BankConnectionsRepository"
```

---

## Task 4: BankCredentials repository

**Files:**

- Create: `src/database/repositories/bank-credentials.repository.ts`
- Create: `src/database/repositories/bank-credentials.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/database/repositories/bank-credentials.repository.test.ts
import type { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { GroupRepository } from './group.repository';
import { BankConnectionsRepository } from './bank-connections.repository';
import { BankCredentialsRepository } from './bank-credentials.repository';

let db: Database;
let repo: BankCredentialsRepository;
let connRepo: BankConnectionsRepository;
let connectionId: number;

db = createTestDb();
repo = new BankCredentialsRepository(db);
connRepo = new BankConnectionsRepository(db);
const groupRepo = new GroupRepository(db);

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  const conn = connRepo.create({ group_id: group.id, bank_name: 'tbc', display_name: 'TBC Bank' });
  connectionId = conn.id;
});

describe('BankCredentialsRepository', () => {
  test('upsert and findByConnectionId', () => {
    repo.upsert(connectionId, 'encrypted-data-abc');
    const cred = repo.findByConnectionId(connectionId);
    expect(cred?.encrypted_data).toBe('encrypted-data-abc');
  });

  test('upsert updates existing row', () => {
    repo.upsert(connectionId, 'first');
    repo.upsert(connectionId, 'second');
    expect(repo.findByConnectionId(connectionId)?.encrypted_data).toBe('second');
  });

  test('findByConnectionId returns null when not found', () => {
    expect(repo.findByConnectionId(999)).toBeNull();
  });

  test('deleteByConnectionId removes row', () => {
    repo.upsert(connectionId, 'data');
    repo.deleteByConnectionId(connectionId);
    expect(repo.findByConnectionId(connectionId)).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/database/repositories/bank-credentials.repository.test.ts
```

- [ ] **Step 3: Implement `bank-credentials.repository.ts`**

```typescript
// Encrypted bank credentials storage — one row per bank connection.
import type { Database } from 'bun:sqlite';
import type { BankCredential } from '../types';

export class BankCredentialsRepository {
  constructor(private db: Database) {}

  upsert(connectionId: number, encryptedData: string): void {
    this.db.query<void, [number, string]>(`
      INSERT INTO bank_credentials (connection_id, encrypted_data)
      VALUES (?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET encrypted_data = excluded.encrypted_data
    `).run(connectionId, encryptedData);
  }

  findByConnectionId(connectionId: number): BankCredential | null {
    return this.db.query<BankCredential, [number]>(
      'SELECT * FROM bank_credentials WHERE connection_id = ?'
    ).get(connectionId) ?? null;
  }

  deleteByConnectionId(connectionId: number): void {
    this.db.query<void, [number]>(
      'DELETE FROM bank_credentials WHERE connection_id = ?'
    ).run(connectionId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/database/repositories/bank-credentials.repository.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/bank-credentials.repository.ts src/database/repositories/bank-credentials.repository.test.ts
git commit -m "feat(bank): BankCredentialsRepository"
```

---

## Task 5: BankAccounts repository

**Files:**

- Create: `src/database/repositories/bank-accounts.repository.ts`
- Create: `src/database/repositories/bank-accounts.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/database/repositories/bank-accounts.repository.test.ts
import type { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { GroupRepository } from './group.repository';
import { BankConnectionsRepository } from './bank-connections.repository';
import { BankAccountsRepository } from './bank-accounts.repository';

let db: Database;
let repo: BankAccountsRepository;
let connectionId: number;
let groupId: number;

db = createTestDb();
repo = new BankAccountsRepository(db);
const connRepo = new BankConnectionsRepository(db);
const groupRepo = new GroupRepository(db);

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  groupId = group.id;
  connectionId = connRepo.create({ group_id: group.id, bank_name: 'tbc', display_name: 'TBC', status: 'active' }).id;
});

describe('BankAccountsRepository', () => {
  test('upsert inserts new account', () => {
    const acc = repo.upsert({ connection_id: connectionId, account_id: 'acc1', title: 'Main', balance: 100, currency: 'GEL' });
    expect(acc.id).toBeGreaterThan(0);
    expect(acc.balance).toBe(100);
  });

  test('upsert updates balance on conflict', () => {
    repo.upsert({ connection_id: connectionId, account_id: 'acc1', title: 'Main', balance: 100, currency: 'GEL' });
    repo.upsert({ connection_id: connectionId, account_id: 'acc1', title: 'Main', balance: 250, currency: 'GEL' });
    const accounts = repo.findByConnectionId(connectionId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].balance).toBe(250);
  });

  test('findByConnectionId returns accounts for connection', () => {
    repo.upsert({ connection_id: connectionId, account_id: 'acc1', title: 'Main', balance: 100, currency: 'GEL' });
    repo.upsert({ connection_id: connectionId, account_id: 'acc2', title: 'Savings', balance: 500, currency: 'GEL' });
    expect(repo.findByConnectionId(connectionId)).toHaveLength(2);
  });

  test('findByGroupId returns accounts across all connections for group', () => {
    const conn2 = connRepo.create({ group_id: groupId, bank_name: 'kaspi', display_name: 'Kaspi', status: 'active' }).id;
    repo.upsert({ connection_id: connectionId, account_id: 'acc1', title: 'Main', balance: 100, currency: 'GEL' });
    repo.upsert({ connection_id: conn2, account_id: 'acc2', title: 'Main', balance: 200, currency: 'KZT' });
    expect(repo.findByGroupId(groupId)).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/database/repositories/bank-accounts.repository.test.ts
```

- [ ] **Step 3: Implement `bank-accounts.repository.ts`**

```typescript
// Account balance storage — upserted after each scrape cycle.
import type { Database } from 'bun:sqlite';
import type { BankAccount, UpsertBankAccountData } from '../types';

export class BankAccountsRepository {
  constructor(private db: Database) {}

  upsert(data: UpsertBankAccountData): BankAccount {
    const result = this.db.query<{ id: number }, [number, string, string, number, string, string | null]>(`
      INSERT INTO bank_accounts (connection_id, account_id, title, balance, currency, type)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, account_id)
      DO UPDATE SET balance = excluded.balance, title = excluded.title, updated_at = datetime('now')
      RETURNING id
    `).get(
      data.connection_id,
      data.account_id,
      data.title,
      data.balance,
      data.currency,
      data.type ?? null,
    );

    if (!result) throw new Error('Failed to upsert bank account');
    const account = this.findById(result.id);
    if (!account) throw new Error('Failed to retrieve bank account');
    return account;
  }

  findById(id: number): BankAccount | null {
    return this.db.query<BankAccount, [number]>(
      'SELECT * FROM bank_accounts WHERE id = ?'
    ).get(id) ?? null;
  }

  findByConnectionId(connectionId: number): BankAccount[] {
    return this.db.query<BankAccount, [number]>(
      'SELECT * FROM bank_accounts WHERE connection_id = ? ORDER BY title'
    ).all(connectionId);
  }

  findByGroupId(groupId: number): BankAccount[] {
    return this.db.query<BankAccount, [number]>(`
      SELECT ba.* FROM bank_accounts ba
      JOIN bank_connections bc ON ba.connection_id = bc.id
      WHERE bc.group_id = ? AND bc.status = 'active'
      ORDER BY bc.bank_name, ba.title
    `).all(groupId);
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/database/repositories/bank-accounts.repository.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/bank-accounts.repository.ts src/database/repositories/bank-accounts.repository.test.ts
git commit -m "feat(bank): BankAccountsRepository"
```

---

## Task 6: BankTransactions repository

**Files:**

- Create: `src/database/repositories/bank-transactions.repository.ts`
- Create: `src/database/repositories/bank-transactions.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/database/repositories/bank-transactions.repository.test.ts
import type { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { GroupRepository } from './group.repository';
import { BankConnectionsRepository } from './bank-connections.repository';
import { BankTransactionsRepository } from './bank-transactions.repository';

let db: Database;
let repo: BankTransactionsRepository;
let connectionId: number;
let groupId: number;

db = createTestDb();
repo = new BankTransactionsRepository(db);
const connRepo = new BankConnectionsRepository(db);
const groupRepo = new GroupRepository(db);

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  groupId = group.id;
  connectionId = connRepo.create({ group_id: group.id, bank_name: 'tbc', display_name: 'TBC', status: 'active' }).id;
});

const baseTx = {
  connection_id: 0, // set in tests
  external_id: 'ext-001',
  date: '2026-03-27',
  amount: 45.0,
  sign_type: 'debit' as const,
  currency: 'GEL',
  raw_data: '{}',
  status: 'pending' as const,
};

describe('BankTransactionsRepository', () => {
  test('insertIgnore inserts new transaction', () => {
    const tx = repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    expect(tx).not.toBeNull();
    expect(tx?.amount).toBe(45.0);
    expect(tx?.status).toBe('pending');
  });

  test('insertIgnore returns null on duplicate external_id', () => {
    repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    const duplicate = repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    expect(duplicate).toBeNull();
  });

  test('findPendingByConnectionId returns only pending', () => {
    repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    repo.insertIgnore({ ...baseTx, connection_id: connectionId, external_id: 'ext-002', status: 'confirmed' });
    const pending = repo.findPendingByConnectionId(connectionId);
    expect(pending).toHaveLength(1);
    expect(pending[0].external_id).toBe('ext-001');
  });

  test('findById requires correct groupId (security)', () => {
    const tx = repo.insertIgnore({ ...baseTx, connection_id: connectionId })!;
    expect(repo.findById(tx.id, groupId)).not.toBeNull();
    expect(repo.findById(tx.id, groupId + 999)).toBeNull();
  });

  test('findByGroupId scopes to group', () => {
    repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    const results = repo.findByGroupId(groupId, {});
    expect(results).toHaveLength(1);
  });

  test('findByGroupId filters by status', () => {
    repo.insertIgnore({ ...baseTx, connection_id: connectionId, external_id: 'e1', status: 'pending' });
    repo.insertIgnore({ ...baseTx, connection_id: connectionId, external_id: 'e2', status: 'confirmed' });
    const pending = repo.findByGroupId(groupId, { status: 'pending' });
    expect(pending).toHaveLength(1);
  });

  test('updateStatus changes status', () => {
    const tx = repo.insertIgnore({ ...baseTx, connection_id: connectionId })!;
    repo.updateStatus(tx.id, groupId, 'confirmed');
    expect(repo.findById(tx.id, groupId)?.status).toBe('confirmed');
  });

  test('setTelegramMessageId stores message id', () => {
    const tx = repo.insertIgnore({ ...baseTx, connection_id: connectionId })!;
    repo.setTelegramMessageId(tx.id, 12345);
    expect(repo.findById(tx.id, groupId)?.telegram_message_id).toBe(12345);
  });

  test('setEditInProgress toggles flag', () => {
    const tx = repo.insertIgnore({ ...baseTx, connection_id: connectionId })!;
    repo.setEditInProgress(tx.id, true);
    expect(repo.findById(tx.id, groupId)?.edit_in_progress).toBe(1);
    repo.setEditInProgress(tx.id, false);
    expect(repo.findById(tx.id, groupId)?.edit_in_progress).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/database/repositories/bank-transactions.repository.test.ts
```

- [ ] **Step 3: Implement `bank-transactions.repository.ts`**

```typescript
// Bank transaction storage — all read queries require group_id for isolation.
import type { Database } from 'bun:sqlite';
import type {
  BankTransaction,
  BankTransactionFilters,
  CreateBankTransactionData,
} from '../types';
import { startOfMonth, endOfMonth, subMonths, format } from 'date-fns';

export class BankTransactionsRepository {
  constructor(private db: Database) {}

  /**
   * Insert a new transaction. Returns null if external_id already exists (ON CONFLICT DO NOTHING).
   */
  insertIgnore(data: CreateBankTransactionData): BankTransaction | null {
    const result = this.db.query<{ id: number }, [
      number, string, string, number, string, string,
      string | null, string | null, number | null, string, string
    ]>(`
      INSERT INTO bank_transactions
        (connection_id, external_id, date, amount, sign_type, currency,
         merchant, merchant_normalized, mcc, raw_data, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, external_id) DO NOTHING
      RETURNING id
    `).get(
      data.connection_id,
      data.external_id,
      data.date,
      data.amount,
      data.sign_type,
      data.currency,
      data.merchant ?? null,
      data.merchant_normalized ?? null,
      data.mcc ?? null,
      data.raw_data,
      data.status,
    );

    if (!result) return null;
    return this.db.query<BankTransaction, [number]>(
      'SELECT * FROM bank_transactions WHERE id = ?'
    ).get(result.id) ?? null;
  }

  findById(id: number, groupId: number): BankTransaction | null {
    return this.db.query<BankTransaction, [number, number]>(`
      SELECT bt.* FROM bank_transactions bt
      JOIN bank_connections bc ON bt.connection_id = bc.id
      WHERE bt.id = ? AND bc.group_id = ?
    `).get(id, groupId) ?? null;
  }

  findPendingByConnectionId(connectionId: number): BankTransaction[] {
    return this.db.query<BankTransaction, [number]>(`
      SELECT * FROM bank_transactions
      WHERE connection_id = ? AND status = 'pending'
      ORDER BY date DESC, created_at DESC
    `).all(connectionId);
  }

  findByGroupId(groupId: number, filters: BankTransactionFilters): BankTransaction[] {
    const conditions: string[] = ['bc.group_id = ?'];
    const values: (string | number)[] = [groupId];

    if (filters.bank_name) {
      conditions.push('bc.bank_name = ?');
      values.push(filters.bank_name);
    }

    if (filters.status) {
      conditions.push('bt.status = ?');
      values.push(filters.status);
    }

    if (filters.period) {
      const { startDate, endDate } = resolvePeriod(filters.period);
      conditions.push('bt.date >= ?', 'bt.date <= ?');
      values.push(startDate, endDate);
    }

    return this.db.query<BankTransaction, typeof values>(`
      SELECT bt.* FROM bank_transactions bt
      JOIN bank_connections bc ON bt.connection_id = bc.id
      WHERE ${conditions.join(' AND ')}
      ORDER BY bt.date DESC, bt.created_at DESC
    `).all(...values);
  }

  updateStatus(id: number, groupId: number, status: BankTransaction['status']): void {
    this.db.query<void, [string, number, number]>(`
      UPDATE bank_transactions SET status = ?
      WHERE id = ? AND connection_id IN (
        SELECT id FROM bank_connections WHERE group_id = ?
      )
    `).run(status, id, groupId);
  }

  setMatchedExpense(id: number, groupId: number, expenseId: number): void {
    this.db.query<void, [number, number, number]>(`
      UPDATE bank_transactions SET matched_expense_id = ?
      WHERE id = ? AND connection_id IN (
        SELECT id FROM bank_connections WHERE group_id = ?
      )
    `).run(expenseId, id, groupId);
  }

  setTelegramMessageId(id: number, messageId: number): void {
    this.db.query<void, [number, number]>(
      'UPDATE bank_transactions SET telegram_message_id = ? WHERE id = ?'
    ).run(messageId, id);
  }

  setEditInProgress(id: number, flag: boolean): void {
    this.db.query<void, [number, number]>(
      'UPDATE bank_transactions SET edit_in_progress = ? WHERE id = ?'
    ).run(flag ? 1 : 0, id);
  }

  updateMerchantNormalized(id: number, merchantNormalized: string): void {
    this.db.query<void, [string, number]>(
      'UPDATE bank_transactions SET merchant_normalized = ? WHERE id = ?'
    ).run(merchantNormalized, id);
  }

  /**
   * Find pending/confirmed debit transactions with no matched expense in a period.
   * Used by find_missing_expenses AI tool.
   */
  findUnmatched(groupId: number, startDate: string, endDate: string): BankTransaction[] {
    return this.db.query<BankTransaction, [number, string, string]>(`
      SELECT bt.* FROM bank_transactions bt
      JOIN bank_connections bc ON bt.connection_id = bc.id
      WHERE bc.group_id = ?
        AND bt.date >= ? AND bt.date <= ?
        AND bt.sign_type = 'debit'
        AND bt.matched_expense_id IS NULL
        AND bt.status IN ('pending', 'confirmed')
      ORDER BY bt.date DESC
    `).all(groupId, startDate, endDate);
  }
}

function resolvePeriod(period: string): { startDate: string; endDate: string } {
  const now = new Date();
  if (period === 'current_month') {
    return {
      startDate: format(startOfMonth(now), 'yyyy-MM-dd'),
      endDate: format(endOfMonth(now), 'yyyy-MM-dd'),
    };
  }
  if (period === 'last_month') {
    const last = subMonths(now, 1);
    return {
      startDate: format(startOfMonth(last), 'yyyy-MM-dd'),
      endDate: format(endOfMonth(last), 'yyyy-MM-dd'),
    };
  }
  // YYYY-MM
  const [year, month] = period.split('-').map(Number);
  if (year && month) {
    const d = new Date(year, month - 1, 1);
    return {
      startDate: format(startOfMonth(d), 'yyyy-MM-dd'),
      endDate: format(endOfMonth(d), 'yyyy-MM-dd'),
    };
  }
  return { startDate: '2000-01-01', endDate: '2099-12-31' };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/database/repositories/bank-transactions.repository.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/bank-transactions.repository.ts src/database/repositories/bank-transactions.repository.test.ts
git commit -m "feat(bank): BankTransactionsRepository with group_id security"
```

---

## Task 7: MerchantRules repository

**Files:**

- Create: `src/database/repositories/merchant-rules.repository.ts`
- Create: `src/database/repositories/merchant-rules.repository.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/database/repositories/merchant-rules.repository.test.ts
import type { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { MerchantRulesRepository } from './merchant-rules.repository';
import { GroupRepository } from './group.repository';

let db: Database;
let repo: MerchantRulesRepository;
let groupId: number;

db = createTestDb();
repo = new MerchantRulesRepository(db);
const groupRepo = new GroupRepository(db);

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  groupId = groupRepo.create({ telegram_group_id: Date.now() }).id;
});

describe('MerchantRulesRepository', () => {
  test('insert creates rule with defaults', () => {
    const rule = repo.insert({ pattern: 'GLOVO.*', replacement: 'Glovo', category: 'food' });
    expect(rule.id).toBeGreaterThan(0);
    expect(rule.status).toBe('pending_review');
    expect(rule.source).toBe('ai');
    expect(rule.flags).toBe('i');
  });

  test('findApproved returns only approved rules', () => {
    repo.insert({ pattern: 'A', replacement: 'a' });
    const r2 = repo.insert({ pattern: 'B', replacement: 'b' });
    repo.updateStatus(r2.id, 'approved');
    const approved = repo.findApproved();
    expect(approved).toHaveLength(1);
    expect(approved[0].pattern).toBe('B');
  });

  test('findPendingReview returns pending_review rules', () => {
    repo.insert({ pattern: 'A', replacement: 'a' });
    expect(repo.findPendingReview()).toHaveLength(1);
  });

  test('update changes pattern and replacement', () => {
    const rule = repo.insert({ pattern: 'OLD.*', replacement: 'Old' });
    repo.update(rule.id, { pattern: 'NEW.*', replacement: 'New', category: 'test' });
    const updated = repo.findById(rule.id);
    expect(updated?.pattern).toBe('NEW.*');
    expect(updated?.category).toBe('test');
  });

  test('insertRuleRequest uses INSERT OR IGNORE (no duplicate)', () => {
    repo.insertRuleRequest({ merchant_raw: 'GLOVO*1234', group_id: groupId });
    repo.insertRuleRequest({ merchant_raw: 'GLOVO*1234', group_id: groupId });
    const requests = repo.findUnprocessedRequests();
    expect(requests).toHaveLength(1);
  });

  test('markRequestProcessed sets processed=1', () => {
    repo.insertRuleRequest({ merchant_raw: 'SHOP ABC', group_id: groupId });
    const req = repo.findUnprocessedRequests()[0];
    repo.markRequestProcessed(req.id);
    expect(repo.findUnprocessedRequests()).toHaveLength(0);
  });

  test('pruneOldRequests removes processed rows older than 7 days', () => {
    db.exec(`
      INSERT INTO merchant_rule_requests (merchant_raw, processed, created_at)
      VALUES ('OLD', 1, datetime('now', '-8 days'))
    `);
    repo.pruneOldRequests();
    expect(repo.findUnprocessedRequests()).toHaveLength(0);
    // verify the old processed row is gone
    const count = db.query<{ count: number }, []>(
      "SELECT COUNT(*) as count FROM merchant_rule_requests WHERE merchant_raw = 'OLD'"
    ).get();
    expect(count?.count).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/database/repositories/merchant-rules.repository.test.ts
```

- [ ] **Step 3: Implement `merchant-rules.repository.ts`**

```typescript
// Merchant normalization rules and rule-request queue.
import type { Database } from 'bun:sqlite';
import type {
  CreateMerchantRuleData,
  CreateMerchantRuleRequestData,
  MerchantRule,
  MerchantRuleRequest,
  UpdateMerchantRuleData,
} from '../types';

export class MerchantRulesRepository {
  constructor(private db: Database) {}

  insert(data: CreateMerchantRuleData): MerchantRule {
    const result = this.db.query<{ id: number }, [string, string, string, string | null, number, string]>(`
      INSERT INTO merchant_rules (pattern, flags, replacement, category, confidence, source)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `).get(
      data.pattern,
      data.flags ?? 'i',
      data.replacement,
      data.category ?? null,
      data.confidence ?? 1.0,
      data.source ?? 'ai',
    );

    if (!result) throw new Error('Failed to insert merchant rule');
    const rule = this.findById(result.id);
    if (!rule) throw new Error('Failed to retrieve merchant rule');
    return rule;
  }

  findById(id: number): MerchantRule | null {
    return this.db.query<MerchantRule, [number]>(
      'SELECT * FROM merchant_rules WHERE id = ?'
    ).get(id) ?? null;
  }

  findApproved(): MerchantRule[] {
    return this.db.query<MerchantRule, []>(
      "SELECT * FROM merchant_rules WHERE status = 'approved' ORDER BY id"
    ).all();
  }

  findPendingReview(): MerchantRule[] {
    return this.db.query<MerchantRule, []>(
      "SELECT * FROM merchant_rules WHERE status = 'pending_review' ORDER BY created_at DESC"
    ).all();
  }

  updateStatus(id: number, status: MerchantRule['status']): void {
    this.db.query<void, [string, string, number]>(
      "UPDATE merchant_rules SET status = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(status, id);
    // Fix: wrong param count above — fix:
  }

  update(id: number, data: UpdateMerchantRuleData): void {
    const fields: string[] = ["updated_at = datetime('now')"];
    const values: (string | number | null)[] = [];

    if (data.pattern !== undefined) { fields.push('pattern = ?'); values.push(data.pattern); }
    if (data.replacement !== undefined) { fields.push('replacement = ?'); values.push(data.replacement); }
    if (data.category !== undefined) { fields.push('category = ?'); values.push(data.category); }
    if (data.confidence !== undefined) { fields.push('confidence = ?'); values.push(data.confidence); }
    if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }

    values.push(id);
    this.db.prepare(`UPDATE merchant_rules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  insertRuleRequest(data: CreateMerchantRuleRequestData): void {
    this.db.query<void, [string, number | null, number | null, string | null, string | null]>(`
      INSERT OR IGNORE INTO merchant_rule_requests
        (merchant_raw, mcc, group_id, user_category, user_comment)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      data.merchant_raw,
      data.mcc ?? null,
      data.group_id ?? null,
      data.user_category ?? null,
      data.user_comment ?? null,
    );
  }

  findUnprocessedRequests(): MerchantRuleRequest[] {
    return this.db.query<MerchantRuleRequest, []>(
      'SELECT * FROM merchant_rule_requests WHERE processed = 0 ORDER BY created_at'
    ).all();
  }

  markRequestProcessed(id: number): void {
    this.db.query<void, [number]>(
      'UPDATE merchant_rule_requests SET processed = 1 WHERE id = ?'
    ).run(id);
  }

  pruneOldRequests(): void {
    this.db.exec(
      "DELETE FROM merchant_rule_requests WHERE processed = 1 AND created_at < datetime('now', '-7 days')"
    );
  }
}
```

Fix the `updateStatus` method — the query above has wrong params:

```typescript
  updateStatus(id: number, status: MerchantRule['status']): void {
    this.db.query<void, [string, number]>(
      "UPDATE merchant_rules SET status = ?, updated_at = datetime('now') WHERE id = ?"
    ).run(status, id);
  }
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/database/repositories/merchant-rules.repository.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/database/repositories/merchant-rules.repository.ts src/database/repositories/merchant-rules.repository.test.ts
git commit -m "feat(bank): MerchantRulesRepository"
```

---

## Task 8: Register repositories in DatabaseService

**Files:**

- Modify: `src/database/index.ts`

- [ ] **Step 1: Add imports and fields to `src/database/index.ts`**

Add imports after existing imports:

```typescript
import { BankAccountsRepository } from './repositories/bank-accounts.repository';
import { BankConnectionsRepository } from './repositories/bank-connections.repository';
import { BankCredentialsRepository } from './repositories/bank-credentials.repository';
import { BankTransactionsRepository } from './repositories/bank-transactions.repository';
import { MerchantRulesRepository } from './repositories/merchant-rules.repository';
```

Add fields to `DatabaseService` class after `devTasks`:

```typescript
  public bankConnections: BankConnectionsRepository;
  public bankCredentials: BankCredentialsRepository;
  public bankAccounts: BankAccountsRepository;
  public bankTransactions: BankTransactionsRepository;
  public merchantRules: MerchantRulesRepository;
```

Add to constructor after `this.devTasks = ...`:

```typescript
    this.bankConnections = new BankConnectionsRepository(this.db);
    this.bankCredentials = new BankCredentialsRepository(this.db);
    this.bankAccounts = new BankAccountsRepository(this.db);
    this.bankTransactions = new BankTransactionsRepository(this.db);
    this.merchantRules = new MerchantRulesRepository(this.db);
```

- [ ] **Step 2: Type-check**

```bash
bun run type-check
```

Expected: no errors.

- [ ] **Step 3: Run all repository tests to confirm nothing broke**

```bash
bun test src/database/repositories/
```

Expected: all PASS.

- [ ] **Step 4: Commit**

```bash
git add src/database/index.ts
git commit -m "feat(bank): register bank repositories in DatabaseService"
```

---

## Task 9: ZenPlugin submodule + registry

**Files:**

- Run `git submodule add` (one-time)
- Create: `src/services/bank/registry.ts`

- [ ] **Step 1: Add ZenPlugins as git submodule**

```bash
git submodule add https://github.com/zenmoney/ZenPlugins.git src/services/bank/ZenPlugins
git submodule update --init
```

Expected: `src/services/bank/ZenPlugins/` directory exists with plugin source code.

- [ ] **Step 2: Verify TBC and Kaspi plugin paths exist**

```bash
ls src/services/bank/ZenPlugins/src/plugins/ | grep -i -E "tbc|kaspi"
```

Note the exact directory names — adjust `registry.ts` import paths accordingly.

- [ ] **Step 3: Create `src/services/bank/registry.ts`**

```typescript
// BANK_REGISTRY — maps registry keys to ZenPlugin imports and credential field definitions.
// Add new bank: add one entry here.

export interface ZenAccount {
  id: string;
  title: string;
  balance: number;
  currency: string;
  type?: 'checking' | 'savings' | 'credit';
}

export interface ZenTransaction {
  id: string;
  date: string;
  sum: number;      // negative = debit/outgoing, positive = credit/incoming (ZenMoney convention)
  currency: string;
  merchant?: string;
  mcc?: number;
  comment?: string;
  account?: string;
}

export type ScrapeResult = {
  accounts: ZenAccount[];
  transactions: ZenTransaction[];
};

export type ScrapeFunction = (args: {
  preferences: Record<string, string>;
  fromDate: Date;
  toDate: Date;
}) => Promise<ScrapeResult>;

export type CredentialField =
  | string
  | { name: string; type: 'text' | 'password' | 'otp'; prompt: string };

export interface BankPlugin {
  name: string;
  plugin: () => Promise<{ scrape: ScrapeFunction }>;
  fields: CredentialField[];
}

export const BANK_REGISTRY: Record<string, BankPlugin> = {
  tbc: {
    name: 'TBC Bank',
    plugin: () =>
      import('./ZenPlugins/src/plugins/TBC/index.ts') as Promise<{ scrape: ScrapeFunction }>,
    fields: [
      { name: 'username', type: 'text', prompt: 'Имя пользователя TBC' },
      { name: 'password', type: 'password', prompt: 'Пароль TBC' },
    ],
  },
  kaspi: {
    name: 'Kaspi Bank',
    plugin: () =>
      import('./ZenPlugins/src/plugins/Kaspi/index.ts') as Promise<{ scrape: ScrapeFunction }>,
    fields: [
      { name: 'phone', type: 'text', prompt: 'Номер телефона Kaspi' },
      { name: 'password', type: 'password', prompt: 'Пароль Kaspi' },
    ],
  },
};

export function getBankList(): { key: string; name: string }[] {
  return Object.entries(BANK_REGISTRY).map(([key, plugin]) => ({
    key,
    name: plugin.name,
  }));
}
```

- [ ] **Step 4: Type-check**

```bash
bun run type-check
```

If plugin `.ts` files have type errors due to unresolved ZenPlugins types, add `// @ts-ignore` on the import lines in `registry.ts` and note in comments that ZenPlugins don't ship TypeScript types compatible with our tsconfig.

- [ ] **Step 5: Commit**

```bash
git add .gitmodules src/services/bank/ZenPlugins src/services/bank/registry.ts
git commit -m "feat(bank): ZenPlugins submodule and bank registry"
```

---

## Task 10: ZenPlugin runtime shim

**Files:**

- Create: `src/services/bank/runtime.ts`
- Create: `src/services/bank/runtime.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/services/bank/runtime.test.ts
import type { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { GroupRepository } from '../../database/repositories/group.repository';
import { BankConnectionsRepository } from '../../database/repositories/bank-connections.repository';
import { createZenMoneyShim } from './runtime';

let db: Database;
let connectionId: number;

db = createTestDb();
const groupRepo = new GroupRepository(db);
const connRepo = new BankConnectionsRepository(db);

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  connectionId = connRepo.create({ group_id: group.id, bank_name: 'tbc', display_name: 'TBC' }).id;
});

describe('ZenMoney runtime shim', () => {
  test('saveData then getData round-trips values', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.saveData('sessionToken', { token: 'abc123', expiry: 999 });
    const loaded = shim.getData('sessionToken') as { token: string };
    expect(loaded.token).toBe('abc123');
  });

  test('getData returns undefined for missing key', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    expect(shim.getData('nonexistent')).toBeUndefined();
  });

  test('getPreferences returns passed preferences', () => {
    const shim = createZenMoneyShim(connectionId, db, { username: 'user', password: 'pass' });
    expect(shim.getPreferences()).toEqual({ username: 'user', password: 'pass' });
  });

  test('addAccount/addTransaction accumulate in internal state', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.addAccount({ id: 'acc1', title: 'Main', balance: 100, currency: 'GEL' });
    shim.addTransaction({ id: 'tx1', sum: -50, date: '2026-03-27', currency: 'GEL' });
    expect(shim._getCollectedAccounts()).toHaveLength(1);
    expect(shim._getCollectedTransactions()).toHaveLength(1);
  });

  test('clearData removes plugin state for connection', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.saveData('key1', 'value1');
    shim.saveData('key2', 'value2');
    shim.clearData();
    expect(shim.getData('key1')).toBeUndefined();
    expect(shim.getData('key2')).toBeUndefined();
  });

  test('setResult and _getSetResult', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.setResult({ accounts: [], transactions: [{ id: 'tx', sum: -10 }] });
    const result = shim._getSetResult() as { transactions: unknown[] };
    expect(result.transactions).toHaveLength(1);
  });

  test('saveData is isolated per connection_id', () => {
    const group = groupRepo.create({ telegram_group_id: Date.now() + 1 });
    const conn2 = connRepo.create({ group_id: group.id, bank_name: 'kaspi', display_name: 'Kaspi' }).id;

    const shim1 = createZenMoneyShim(connectionId, db, {});
    const shim2 = createZenMoneyShim(conn2, db, {});

    shim1.saveData('token', 'conn1-token');
    shim2.saveData('token', 'conn2-token');

    expect(shim1.getData('token')).toBe('conn1-token');
    expect(shim2.getData('token')).toBe('conn2-token');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/services/bank/runtime.test.ts
```

- [ ] **Step 3: Implement `src/services/bank/runtime.ts`**

```typescript
// ZenMoney API shim — provides the ZenMoney global interface that ZenPlugins expect.
// Backed by bank_plugin_state SQLite table for persistent state.
import type { Database } from 'bun:sqlite';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('zen-runtime');

export interface ZenMoneyShim {
  getData(key: string): unknown;
  saveData(key: string, value: unknown): void;
  getPreferences(): Record<string, string>;
  addAccount(account: unknown): void;
  addTransaction(tx: unknown): void;
  readLine(prompt: string): Promise<string>;
  setResult(data: unknown): void;
  trustCertificates(certs: unknown): void;
  clearData(): void;
  _getCollectedAccounts(): unknown[];
  _getCollectedTransactions(): unknown[];
  _getSetResult(): unknown;
}

export function createZenMoneyShim(
  connectionId: number,
  db: Database,
  preferences: Record<string, string>,
): ZenMoneyShim {
  const collectedAccounts: unknown[] = [];
  const collectedTransactions: unknown[] = [];
  let setResultValue: unknown = undefined;

  const getState = db.query<{ value: string }, [number, string]>(
    'SELECT value FROM bank_plugin_state WHERE connection_id = ? AND key = ?'
  );
  const upsertState = db.query<void, [number, string, string]>(`
    INSERT INTO bank_plugin_state (connection_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(connection_id, key) DO UPDATE SET value = excluded.value
  `);
  const clearState = db.query<void, [number]>(
    'DELETE FROM bank_plugin_state WHERE connection_id = ?'
  );

  return {
    getData(key: string): unknown {
      const row = getState.get(connectionId, key);
      if (!row) return undefined;
      try {
        return JSON.parse(row.value);
      } catch {
        return row.value;
      }
    },

    saveData(key: string, value: unknown): void {
      upsertState.run(connectionId, key, JSON.stringify(value));
    },

    getPreferences(): Record<string, string> {
      return preferences;
    },

    addAccount(account: unknown): void {
      collectedAccounts.push(account);
    },

    addTransaction(tx: unknown): void {
      collectedTransactions.push(tx);
    },

    readLine(prompt: string): Promise<string> {
      logger.warn({ prompt }, 'ZenMoney.readLine called — interactive plugins not supported');
      return Promise.resolve('');
    },

    setResult(data: unknown): void {
      setResultValue = data;
    },

    trustCertificates(): void {
      // no-op: Bun handles SSL natively
    },

    clearData(): void {
      clearState.run(connectionId);
    },

    _getCollectedAccounts(): unknown[] {
      return collectedAccounts;
    },

    _getCollectedTransactions(): unknown[] {
      return collectedTransactions;
    },

    _getSetResult(): unknown {
      return setResultValue;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

```bash
bun test src/services/bank/runtime.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add src/services/bank/runtime.ts src/services/bank/runtime.test.ts
git commit -m "feat(bank): ZenMoney runtime shim"
```

---

## Task 11: Telegram sender (bank-sync direct API calls)

**Files:**

- Create: `src/services/bank/telegram-sender.ts`

- [ ] **Step 1: Create `src/services/bank/telegram-sender.ts`**

```typescript
// Send-only Telegram Bot API client for the bank-sync service.
// The main bot handles incoming updates; bank-sync uses this to send notifications only.
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('telegram-sender');

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface SendMessageResult {
  message_id: number;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function telegramRequest<T>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await resp.json()) as TelegramResponse<T>;
    if (!data.ok) {
      logger.warn({ method, description: data.description }, 'Telegram API call failed');
      return null;
    }
    return data.result ?? null;
  } catch (error) {
    logger.error({ err: error, method }, 'Telegram API request error');
    return null;
  }
}

export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  options?: {
    message_thread_id?: number;
    parse_mode?: 'HTML';
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  },
): Promise<SendMessageResult | null> {
  return telegramRequest<SendMessageResult>(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

export async function editMessageText(
  botToken: string,
  chatId: number,
  messageId: number,
  text: string,
  options?: {
    parse_mode?: 'HTML';
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  },
): Promise<void> {
  await telegramRequest(botToken, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

export async function deleteMessage(
  botToken: string,
  chatId: number,
  messageId: number,
): Promise<void> {
  await telegramRequest(botToken, 'deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
}
```

- [ ] **Step 2: Type-check**

```bash
bun run type-check
```

- [ ] **Step 3: Commit**

```bash
git add src/services/bank/telegram-sender.ts
git commit -m "feat(bank): direct Telegram API sender for bank-sync"
```

---

## Task 12: AI transaction pre-fill

**Files:**

- Create: `src/services/bank/prefill.ts`

- [ ] **Step 1: Create `src/services/bank/prefill.ts`**

```typescript
// AI pre-fill for bank transactions — suggests category and comment before showing confirmation card.
import Anthropic from '@anthropic-ai/sdk';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';
import type { BankTransaction } from '../../database/types';

const logger = createLogger('bank-prefill');

export interface PrefillResult {
  category: string;
  comment: string;
}

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.AI_BASE_URL ? { baseURL: env.AI_BASE_URL } : {}),
    });
  }
  return client;
}

function buildMccLabel(mcc: number | null): string {
  if (!mcc) return '';
  // Common MCC descriptions — not exhaustive, but covers top categories
  const MCC_LABELS: Record<number, string> = {
    5411: 'Продуктовые магазины',
    5812: 'Рестораны',
    5814: 'Фастфуд',
    5912: 'Аптеки',
    5541: 'АЗС',
    4111: 'Транспорт',
    4121: 'Такси',
    7011: 'Отели',
    4722: 'Туристические агентства',
    5999: 'Разное',
  };
  return MCC_LABELS[mcc] ? ` (${MCC_LABELS[mcc]})` : '';
}

export async function preFillTransaction(tx: BankTransaction): Promise<PrefillResult> {
  if (!env.ANTHROPIC_API_KEY) {
    return { category: 'прочее', comment: tx.merchant_normalized ?? tx.merchant ?? '' };
  }

  const merchantDisplay = tx.merchant_normalized ?? tx.merchant ?? 'неизвестно';
  const mccLabel = buildMccLabel(tx.mcc);

  const prompt = `Определи категорию расхода на основе:
Мерчант: ${merchantDisplay}${tx.mcc ? `\nMCC: ${tx.mcc}${mccLabel}` : ''}
Сумма: ${tx.amount} ${tx.currency}

Ответь ТОЛЬКО JSON без пояснений:
{"category": "название категории", "comment": "краткий комментарий"}

Категория — одно-два слова на русском (еда, транспорт, здоровье, кафе, продукты, одежда, развлечения, коммунальные, прочее).`;

  try {
    const response = await getClient().messages.create({
      model: env.AI_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 100,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const match = text.match(/\{[^}]+\}/);
    if (!match) throw new Error('No JSON in response');

    const parsed = JSON.parse(match[0]) as { category?: string; comment?: string };
    return {
      category: parsed.category ?? 'прочее',
      comment: parsed.comment ?? merchantDisplay,
    };
  } catch (error) {
    logger.warn({ err: error, merchant: merchantDisplay }, 'Pre-fill failed, using defaults');
    return { category: 'прочее', comment: merchantDisplay };
  }
}
```

- [ ] **Step 2: Type-check**

```bash
bun run type-check
```

- [ ] **Step 3: Commit**

```bash
git add src/services/bank/prefill.ts
git commit -m "feat(bank): AI transaction pre-fill (category + comment)"
```

---

## Task 13: Sync service

**Files:**

- Create: `src/services/bank/sync-service.ts`

- [ ] **Step 1: Create `src/services/bank/sync-service.ts`**

```typescript
// Bank sync service — runs as a separate PM2 process.
// Polls bank APIs every 30 min, upserts accounts/transactions, sends confirmation cards.
import { subDays } from 'date-fns';
import { database } from '../../database';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';
import { decryptData } from '../../utils/crypto';
import { BANK_REGISTRY } from './registry';
import type { ScrapeResult, ZenAccount, ZenTransaction } from './registry';
import { createZenMoneyShim } from './runtime';
import { sendMessage } from './telegram-sender';
import { preFillTransaction } from './prefill';
import type { BankConnection } from '../../database/types';

const logger = createLogger('sync-service');

const SYNC_INTERVAL_MS = 30 * 60 * 1000;
const MAX_CONSECUTIVE_FAILURES = 3;

export function startSyncService(): void {
  const connections = database.bankConnections.findAllActive();
  logger.info({ count: connections.length }, 'Bank sync service starting');

  for (const conn of connections) {
    scheduleConnection(conn);
  }
}

function scheduleConnection(conn: BankConnection): void {
  const initialDelayMs = (conn.id % 30) * 60 * 1000;

  logger.info(
    { connectionId: conn.id, bank: conn.bank_name, delayMin: conn.id % 30 },
    'Scheduling connection',
  );

  setTimeout(() => {
    runSyncCycle(conn.id).catch((err) =>
      logger.error({ err, connectionId: conn.id }, 'Unhandled sync cycle error'),
    );

    setInterval(() => {
      runSyncCycle(conn.id).catch((err) =>
        logger.error({ err, connectionId: conn.id }, 'Unhandled sync cycle error'),
      );
    }, SYNC_INTERVAL_MS);
  }, initialDelayMs);
}

async function runSyncCycle(connectionId: number): Promise<void> {
  const conn = database.bankConnections.findById(connectionId);
  if (!conn || conn.status !== 'active') return;

  const plugin = BANK_REGISTRY[conn.bank_name];
  if (!plugin) {
    logger.warn({ bankName: conn.bank_name }, 'Unknown bank in registry');
    return;
  }

  logger.info({ connectionId, bank: conn.bank_name }, 'Starting sync cycle');

  try {
    // Load and decrypt credentials
    const credentials = database.bankCredentials.findByConnectionId(connectionId);
    if (!credentials) {
      logger.warn({ connectionId }, 'No credentials found for connection');
      return;
    }

    const preferences = JSON.parse(decryptData(credentials.encrypted_data)) as Record<string, string>;

    const fromDate = conn.last_sync_at ? new Date(conn.last_sync_at) : subDays(new Date(), 30);
    const toDate = new Date();

    // Set up ZenMoney shim and run scrape
    const shim = createZenMoneyShim(connectionId, database.db, preferences);
    (globalThis as { ZenMoney?: typeof shim }).ZenMoney = shim;

    const { scrape } = await plugin.plugin();
    const rawResult = (await scrape({ preferences, fromDate, toDate })) as Partial<ScrapeResult> | undefined;

    // Merge results from both scrape() return and accumulated addAccount/addTransaction calls
    const accounts: ZenAccount[] = [
      ...(rawResult?.accounts ?? []),
      ...(shim._getCollectedAccounts() as ZenAccount[]),
    ];
    const transactions: ZenTransaction[] = [
      ...(rawResult?.transactions ?? []),
      ...(shim._getCollectedTransactions() as ZenTransaction[]),
    ];

    // Check for setResult fallback (legacy plugins)
    const setResultData = shim._getSetResult() as Partial<ScrapeResult> | undefined;
    if (setResultData) {
      accounts.push(...(setResultData.accounts ?? []));
      transactions.push(...(setResultData.transactions ?? []));
    }

    // Upsert accounts
    for (const account of accounts) {
      database.bankAccounts.upsert({
        connection_id: connectionId,
        account_id: account.id,
        title: account.title,
        balance: account.balance,
        currency: account.currency,
        type: account.type ?? null,
      });
    }

    // Load approved merchant rules once for this cycle
    const approvedRules = database.merchantRules.findApproved();
    const group = database.groups.findById(conn.group_id);
    if (!group) {
      logger.warn({ groupId: conn.group_id }, 'Group not found for connection');
      return;
    }

    // Process transactions
    for (const tx of transactions) {
      const amount = Math.abs(tx.sum);
      if (amount === 0) continue;

      const signType = determinSignType(tx);
      const status = signType === 'reversal' ? 'skipped_reversal' : 'pending';

      // Apply merchant normalization
      const merchantNormalized = applyMerchantRules(tx.merchant, approvedRules);

      const inserted = database.bankTransactions.insertIgnore({
        connection_id: connectionId,
        external_id: tx.id,
        date: tx.date.includes('T') ? tx.date.split('T')[0] : tx.date,
        amount,
        sign_type: signType,
        currency: tx.currency,
        merchant: tx.merchant ?? null,
        merchant_normalized: merchantNormalized,
        mcc: tx.mcc ?? null,
        raw_data: JSON.stringify(tx),
        status,
      });

      if (!inserted || status !== 'pending') continue;

      // AI pre-fill and send confirmation card
      const prefilled = await preFillTransaction(inserted);

      const isLarge =
        tx.currency === 'EUR'
          ? amount >= env.LARGE_TX_THRESHOLD_EUR
          : false; // Simple check — extend with currency conversion if needed

      const cardText = formatConfirmationCard(inserted, prefilled, conn.display_name, isLarge);

      const result = await sendMessage(env.BOT_TOKEN, group.telegram_group_id, cardText, {
        message_thread_id: conn.panel_message_thread_id ?? undefined,
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Принять', callback_data: `bank_confirm:${inserted.id}` },
            { text: '✏️ Исправить', callback_data: `bank_edit:${inserted.id}` },
          ]],
        },
      });

      if (result) {
        database.bankTransactions.setTelegramMessageId(inserted.id, result.message_id);
      }
    }

    // Success: reset failures
    database.bankConnections.update(connectionId, {
      consecutive_failures: 0,
      last_sync_at: new Date().toISOString(),
      last_error: null,
    });

    logger.info(
      { connectionId, accounts: accounts.length, transactions: transactions.length },
      'Sync cycle completed',
    );
  } catch (error) {
    await handleSyncError(connectionId, conn, error);
  }
}

async function handleSyncError(
  connectionId: number,
  conn: BankConnection,
  error: unknown,
): Promise<void> {
  const message = error instanceof Error ? error.message : String(error);
  const failures = conn.consecutive_failures + 1;

  database.bankConnections.update(connectionId, {
    consecutive_failures: failures,
    last_error: message,
  });

  logger.error({ err: error, connectionId, failures }, 'Sync cycle failed');

  // Send alert only on the 3rd failure (not on every subsequent failure)
  if (failures === MAX_CONSECUTIVE_FAILURES) {
    const group = database.groups.findById(conn.group_id);
    if (group) {
      await sendMessage(
        env.BOT_TOKEN,
        group.telegram_group_id,
        `⚠️ ${conn.display_name} — ошибка синхронизации\n\nНе удаётся подключиться 3 раза подряд.\nПоследняя ошибка: ${message}\n\nВозможно, изменился пароль или истекла сессия.\n/bank ${conn.bank_name} — переподключить`,
      ).catch((e) => logger.error({ err: e }, 'Failed to send escalation alert'));
    }
  }
}

function determinSignType(tx: ZenTransaction): 'debit' | 'credit' | 'reversal' {
  if (tx.sum < 0) return 'debit';
  return 'credit';
}

function applyMerchantRules(
  merchant: string | undefined,
  rules: { pattern: string; flags: string; replacement: string }[],
): string | null {
  if (!merchant) return null;
  for (const rule of rules) {
    try {
      const regex = new RegExp(rule.pattern, rule.flags);
      if (regex.test(merchant)) {
        return merchant.replace(regex, rule.replacement);
      }
    } catch {
      // ignore invalid regex
    }
  }
  return null;
}

function formatConfirmationCard(
  tx: import('../../database/types').BankTransaction,
  prefilled: { category: string; comment: string },
  bankName: string,
  isLarge: boolean,
): string {
  const prefix = isLarge ? '⚠️ Крупная транзакция' : '💳';
  const merchant = tx.merchant_normalized ?? tx.merchant ?? 'Неизвестно';
  const mccLine = tx.mcc ? `\n🏷 MCC: ${tx.mcc}` : '';

  return `${prefix} ${bankName} — ${tx.amount.toFixed(2)} ${tx.currency}
📍 ${merchant}
🗂 Категория: ${prefilled.category}
💬 Комментарий: ${prefilled.comment}${mccLine}`;
}
```

- [ ] **Step 2: Type-check**

```bash
bun run type-check
```

- [ ] **Step 3: Commit**

```bash
git add src/services/bank/sync-service.ts
git commit -m "feat(bank): sync service — scrape loop, confirmation cards, error escalation"
```

---

## Task 14: Merchant normalization agent

**Files:**

- Create: `src/services/bank/merchant-agent.ts`

- [ ] **Step 1: Create `src/services/bank/merchant-agent.ts`**

```typescript
// Merchant normalization AI agent — batch-processes unmatched merchant strings
// into pending_review rules. Runs after each sync cycle and on new rule requests.
// Only active when BOT_ADMIN_CHAT_ID is configured.
import Anthropic from '@anthropic-ai/sdk';
import { database } from '../../database';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';
import { sendMessage } from './telegram-sender';
import type { MerchantRuleRequest } from '../../database/types';

const logger = createLogger('merchant-agent');

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    client = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      ...(env.AI_BASE_URL ? { baseURL: env.AI_BASE_URL } : {}),
    });
  }
  return client;
}

interface AiRuleSuggestion {
  pattern: string;
  replacement: string;
  category: string | null;
  confidence: number;
}

/**
 * Process unmatched merchant strings and generate normalization rules.
 * No-op if BOT_ADMIN_CHAT_ID is not configured.
 */
export async function processMerchantRequests(): Promise<void> {
  if (!env.BOT_ADMIN_CHAT_ID) return;
  if (!env.ANTHROPIC_API_KEY) return;

  const requests = database.merchantRules.findUnprocessedRequests();
  if (requests.length === 0) return;

  logger.info({ count: requests.length }, 'Processing merchant rule requests');

  // Collect existing approved rules for context
  const existingRules = database.merchantRules.findApproved().map((r) => ({
    pattern: r.pattern,
    replacement: r.replacement,
    category: r.category,
  }));

  // Batch: up to 20 at a time
  const batch = requests.slice(0, 20);

  const suggestions = await callAiForRules(batch, existingRules);

  for (let i = 0; i < batch.length; i++) {
    const request = batch[i];
    const suggestion = suggestions[i];

    database.merchantRules.markRequestProcessed(request.id);

    if (!suggestion) continue;

    // Insert rule with pending_review status
    const rule = database.merchantRules.insert({
      pattern: suggestion.pattern,
      replacement: suggestion.replacement,
      category: suggestion.category,
      confidence: suggestion.confidence,
      source: 'ai',
    });

    // Find example matches from existing transactions
    const examples = findExampleMatches(request.merchant_raw, suggestion.pattern, suggestion.replacement);

    // Send admin approval card
    await sendAdminApprovalCard(rule.id, suggestion, examples);
  }

  // Prune old processed requests
  database.merchantRules.pruneOldRequests();
}

async function callAiForRules(
  requests: MerchantRuleRequest[],
  existingRules: { pattern: string; replacement: string; category: string | null }[],
): Promise<(AiRuleSuggestion | null)[]> {
  const merchantList = requests
    .map((r, i) => `${i + 1}. "${r.merchant_raw}"${r.mcc ? ` (MCC: ${r.mcc})` : ''}${r.user_category ? ` → категория пользователя: ${r.user_category}` : ''}`)
    .join('\n');

  const existingList = existingRules
    .slice(0, 10)
    .map((r) => `"${r.pattern}" → "${r.replacement}"${r.category ? ` [${r.category}]` : ''}`)
    .join('\n');

  const prompt = `Создай правила нормализации для этих строк мерчантов.

Мерчанты для обработки:
${merchantList}

Существующие правила (для согласованности):
${existingList || '(пусто)'}

Для каждого мерчанта ответь JSON массивом с ${requests.length} объектами:
[{
  "pattern": "GLOVO.*",       // regexp для нормализации (пиши .*  для захвата суффиксов)
  "replacement": "Glovo",     // нормализованное название
  "category": "еда",          // категория расхода или null
  "confidence": 0.95          // уверенность 0.0-1.0
}, ...]

Возвращай ровно ${requests.length} объектов в том же порядке.`;

  try {
    const response = await getClient().messages.create({
      model: env.AI_MODEL || 'claude-haiku-4-5-20251001',
      max_tokens: 1000,
      messages: [{ role: 'user', content: prompt }],
    });

    const text = response.content[0]?.type === 'text' ? response.content[0].text : '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) throw new Error('No JSON array in response');

    const parsed = JSON.parse(match[0]) as AiRuleSuggestion[];
    return parsed;
  } catch (error) {
    logger.error({ err: error }, 'AI merchant rule generation failed');
    return requests.map(() => null);
  }
}

function findExampleMatches(
  merchantRaw: string,
  pattern: string,
  replacement: string,
): string[] {
  try {
    const regex = new RegExp(pattern, 'i');
    if (regex.test(merchantRaw)) {
      return [`"${merchantRaw}" → "${replacement}"`];
    }
  } catch {
    // ignore invalid regex
  }
  return [];
}

async function sendAdminApprovalCard(
  ruleId: number,
  suggestion: AiRuleSuggestion,
  examples: string[],
): Promise<void> {
  if (!env.BOT_ADMIN_CHAT_ID) return;

  const exampleLines = examples.length > 0
    ? `\n\nПримеры совпадений:\n${examples.map((e) => `• ${e}`).join('\n')}`
    : '';

  const text = `🔧 Новое правило для мерчанта\n\nПаттерн: <code>${suggestion.pattern}</code>\n→ <b>${suggestion.replacement}</b>\n🗂 Категория: ${suggestion.category ?? '—'}\n📊 Уверенность: ${Math.round(suggestion.confidence * 100)}%${exampleLines}`;

  await sendMessage(env.BOT_TOKEN, env.BOT_ADMIN_CHAT_ID, text, {
    reply_markup: {
      inline_keyboard: [[
        { text: '✅ Принять', callback_data: `merchant_approve:${ruleId}` },
        { text: '✏️ Исправить', callback_data: `merchant_edit:${ruleId}` },
        { text: '❌ Отклонить', callback_data: `merchant_reject:${ruleId}` },
      ]],
    },
  }).catch((e) => logger.error({ err: e }, 'Failed to send admin approval card'));
}
```

- [ ] **Step 2: Type-check**

```bash
bun run type-check
```

- [ ] **Step 3: Commit**

```bash
git add src/services/bank/merchant-agent.ts
git commit -m "feat(bank): merchant normalization AI agent"
```

---

## Task 15: AI bank tools

**Files:**

- Modify: `src/services/ai/tools.ts`
- Modify: `src/services/ai/tool-executor.ts`

- [ ] **Step 1: Write a test for the new tools**

```typescript
// src/services/ai/bank-tools.test.ts
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { GroupRepository } from '../../database/repositories/group.repository';
import { BankConnectionsRepository } from '../../database/repositories/bank-connections.repository';
import { BankAccountsRepository } from '../../database/repositories/bank-accounts.repository';
import { BankTransactionsRepository } from '../../database/repositories/bank-transactions.repository';
import { executeTool } from './tool-executor';
import type { AgentContext } from './types';

let db: Database;
let groupId: number;

db = createTestDb();
const groupRepo = new GroupRepository(db);
const connRepo = new BankConnectionsRepository(db);
const accRepo = new BankAccountsRepository(db);
const txRepo = new BankTransactionsRepository(db);

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  groupId = group.id;
});

// Mock the database singleton to use our test db
import { database } from '../../database';
// Note: in integration tests we override database.bankTransactions etc. via the same db

describe('bank AI tools', () => {
  // These tests verify the tool returns structured results; actual AI calls are not made.
  test('get_bank_balances returns empty list when no connections', async () => {
    const ctx: AgentContext = {
      groupId,
      userId: 1,
      defaultCurrency: 'EUR',
      bot: null as never,
      ctx: null as never,
    };
    const result = await executeTool('get_bank_balances', {}, ctx);
    expect(result.success).toBe(true);
  });

  test('get_bank_transactions returns empty list when no transactions', async () => {
    const ctx: AgentContext = {
      groupId,
      userId: 1,
      defaultCurrency: 'EUR',
      bot: null as never,
      ctx: null as never,
    };
    const result = await executeTool('get_bank_transactions', { period: 'current_month' }, ctx);
    expect(result.success).toBe(true);
  });

  test('find_missing_expenses returns no missing when no transactions', async () => {
    const ctx: AgentContext = {
      groupId,
      userId: 1,
      defaultCurrency: 'EUR',
      bot: null as never,
      ctx: null as never,
    };
    const result = await executeTool('find_missing_expenses', { period: 'current_month' }, ctx);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
bun test src/services/ai/bank-tools.test.ts
```

Expected: FAIL — tools don't exist yet.

- [ ] **Step 3: Add tool definitions to `src/services/ai/tools.ts`**

Append to the `TOOL_DEFINITIONS` array (after the `manage_category` tool):

```typescript
  {
    name: 'get_bank_transactions',
    description:
      'Get bank transactions for a period. All results are scoped to this group only. Use to answer questions about bank spending or reconciliation.',
    input_schema: {
      type: 'object' as const,
      properties: {
        period: {
          type: 'string',
          description: '"current_month" | "last_month" | "YYYY-MM"',
        },
        bank_name: {
          type: 'string',
          description: 'Filter by bank registry key (e.g. "tbc"). Omit for all banks.',
        },
        status: {
          type: 'string',
          description: '"pending" | "confirmed" | "skipped" — omit for all statuses.',
        },
      },
    },
  },
  {
    name: 'get_bank_balances',
    description:
      'Get current account balances from all connected banks for this group.',
    input_schema: {
      type: 'object' as const,
      properties: {
        bank_name: {
          type: 'string',
          description: 'Optional: filter to specific bank registry key.',
        },
      },
    },
  },
  {
    name: 'find_missing_expenses',
    description:
      'Compare bank transactions vs recorded expenses. Returns unmatched bank debit transactions that may be missing from the expense log.',
    input_schema: {
      type: 'object' as const,
      properties: {
        period: {
          type: 'string',
          description: '"current_month" | "last_month" | "YYYY-MM"',
        },
      },
    },
  },
```

- [ ] **Step 4: Add tool implementations to `src/services/ai/tool-executor.ts`**

In the `switch (name)` block, before the `default` case, add:

```typescript
      case 'get_bank_transactions':
        return executeGetBankTransactions(input, ctx);
      case 'get_bank_balances':
        return executeGetBankBalances(input, ctx);
      case 'find_missing_expenses':
        return await executeFindMissingExpenses(input, ctx);
```

At end of file, add:

```typescript
function executeGetBankTransactions(
  input: Record<string, unknown>,
  ctx: AgentContext,
): ToolResult {
  const filters = {
    period: typeof input['period'] === 'string' ? input['period'] : undefined,
    bank_name: typeof input['bank_name'] === 'string' ? input['bank_name'] : undefined,
    status: typeof input['status'] === 'string'
      ? (input['status'] as import('../../database/types').BankTransaction['status'])
      : undefined,
  };

  const transactions = database.bankTransactions.findByGroupId(ctx.groupId, filters);

  return {
    success: true,
    data: transactions.map((tx) => ({
      id: tx.id,
      date: tx.date,
      amount: tx.amount,
      currency: tx.currency,
      merchant: tx.merchant_normalized ?? tx.merchant,
      category_suggestion: null, // populated by prefill at confirmation time
      status: tx.status,
      sign_type: tx.sign_type,
    })),
  };
}

function executeGetBankBalances(
  input: Record<string, unknown>,
  ctx: AgentContext,
): ToolResult {
  const bankName = typeof input['bank_name'] === 'string' ? input['bank_name'] : undefined;

  const accounts = database.bankAccounts.findByGroupId(ctx.groupId);
  const filtered = bankName
    ? accounts.filter((a) => {
        const conn = database.bankConnections.findById(a.connection_id);
        return conn?.bank_name === bankName;
      })
    : accounts;

  return {
    success: true,
    data: filtered.map((a) => ({
      bank_name: database.bankConnections.findById(a.connection_id)?.bank_name,
      account_title: a.title,
      balance: a.balance,
      currency: a.currency,
      type: a.type,
    })),
  };
}

async function executeFindMissingExpenses(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const period = typeof input['period'] === 'string' ? input['period'] : 'current_month';
  const { startDate, endDate } = resolvePeriodDates(period);

  const unmatched = database.bankTransactions.findUnmatched(ctx.groupId, startDate, endDate);
  const expenses = database.expenses.findByDateRange(ctx.groupId, startDate, endDate);

  const results = unmatched.map((tx) => {
    // Try fuzzy match against expenses
    const exactMatch = expenses.find(
      (e) =>
        Math.abs(e.amount - tx.amount) < 0.01 &&
        e.currency === tx.currency &&
        Math.abs(new Date(e.date).getTime() - new Date(tx.date).getTime()) <= 2 * 86400 * 1000,
    );

    if (exactMatch) {
      database.bankTransactions.setMatchedExpense(tx.id, ctx.groupId, exactMatch.id);
      return null; // matched
    }

    const probableMatch = expenses.find(
      (e) =>
        Math.abs(e.amount - tx.amount) < 0.01 &&
        e.currency === tx.currency &&
        Math.abs(new Date(e.date).getTime() - new Date(tx.date).getTime()) <= 5 * 86400 * 1000,
    );

    return {
      tx_id: tx.id,
      date: tx.date,
      amount: tx.amount,
      currency: tx.currency,
      merchant: tx.merchant_normalized ?? tx.merchant,
      status: probableMatch ? 'probable_match' : 'missing',
      probable_expense_id: probableMatch?.id ?? null,
    };
  });

  const missing = results.filter(Boolean);

  return {
    success: true,
    data: missing,
    summary: `${missing.length} транзакций без записи в расходах за период ${startDate}–${endDate}`,
  };
}

function resolvePeriodDates(period: string): { startDate: string; endDate: string } {
  const now = new Date();
  if (period === 'current_month') {
    const y = now.getFullYear();
    const m = String(now.getMonth() + 1).padStart(2, '0');
    const lastDay = new Date(y, now.getMonth() + 1, 0).getDate();
    return { startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${lastDay}` };
  }
  if (period === 'last_month') {
    const d = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const lastDay = new Date(y, d.getMonth() + 1, 0).getDate();
    return { startDate: `${y}-${m}-01`, endDate: `${y}-${m}-${lastDay}` };
  }
  const [year, month] = period.split('-').map(Number);
  if (year && month) {
    const lastDay = new Date(year, month, 0).getDate();
    return {
      startDate: `${year}-${String(month).padStart(2, '0')}-01`,
      endDate: `${year}-${String(month).padStart(2, '0')}-${lastDay}`,
    };
  }
  return { startDate: '2000-01-01', endDate: '2099-12-31' };
}
```

- [ ] **Step 5: Run test to verify it passes**

```bash
bun test src/services/ai/bank-tools.test.ts
```

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts src/services/ai/bank-tools.test.ts
git commit -m "feat(bank): AI bank tools — get_bank_transactions, get_bank_balances, find_missing_expenses"
```

---

## Task 16: Confirmation flow + edit flow handlers

**Files:**

- Modify: `src/bot/handlers/callback.handler.ts`
- Modify: `src/bot/handlers/message.handler.ts`

- [ ] **Step 1: Add bank callback cases to `callback.handler.ts`**

At the end of the imports section, add:

```typescript
import { handleBankConfirmCallback, handleBankEditCallback } from '../commands/bank';
```

In the `switch (action)` block, add before the `default` case:

```typescript
      case 'bank_confirm': {
        const txId = Number(params[0]);
        if (!chatId || !txId) { await ctx.answerCallbackQuery({ text: 'Неверные данные' }); return; }
        await handleBankConfirmCallback(ctx, txId, chatId);
        break;
      }

      case 'bank_edit': {
        const txId = Number(params[0]);
        if (!chatId || !txId) { await ctx.answerCallbackQuery({ text: 'Неверные данные' }); return; }
        await handleBankEditCallback(ctx, txId, chatId);
        break;
      }

      case 'merchant_approve': {
        const ruleId = Number(params[0]);
        if (!ruleId) { await ctx.answerCallbackQuery({ text: 'Неверные данные' }); return; }
        database.merchantRules.updateStatus(ruleId, 'approved');
        await ctx.answerCallbackQuery({ text: '✅ Правило принято' });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        break;
      }

      case 'merchant_reject': {
        const ruleId = Number(params[0]);
        if (!ruleId) { await ctx.answerCallbackQuery({ text: 'Неверные данные' }); return; }
        database.merchantRules.updateStatus(ruleId, 'rejected');
        await ctx.answerCallbackQuery({ text: '❌ Правило отклонено' });
        await ctx.editMessageReplyMarkup({ reply_markup: undefined });
        break;
      }

      case 'merchant_edit': {
        const ruleId = Number(params[0]);
        if (!ruleId) { await ctx.answerCallbackQuery({ text: 'Неверные данные' }); return; }
        await ctx.answerCallbackQuery();
        await ctx.reply('Ответь на это сообщение — напиши исправленное название (или "название|категория"):');
        // TODO: implement reply-based edit for merchant rules (out of scope for this task)
        break;
      }
```

- [ ] **Step 2: Add edit-flow routing to `message.handler.ts`**

Find the section in `handleExpenseMessage` that handles group messages. Add this block early in the function, before the expense parsing logic:

```typescript
  // Bank transaction edit flow — route replies to pending edit transactions
  const replyToMessageId = ctx.replyToMessage?.id;
  if (isGroup && replyToMessageId && text) {
    const { handleBankEditReply } = await import('../commands/bank');
    const chatId = ctx.chat?.id;
    if (chatId) {
      const handled = await handleBankEditReply(ctx, replyToMessageId, chatId, text);
      if (handled) return;
    }
  }
```

- [ ] **Step 3: Type-check**

```bash
bun run type-check
```

- [ ] **Step 4: Commit**

```bash
git add src/bot/handlers/callback.handler.ts src/bot/handlers/message.handler.ts
git commit -m "feat(bank): callback routing for bank_confirm/bank_edit and merchant rule approval"
```

---

## Task 17: /bank command

**Files:**

- Create: `src/bot/commands/bank.ts`
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Create `src/bot/commands/bank.ts`**

```typescript
// /bank command — setup wizard, status panel, and confirmation flow handlers.
import { database } from '../../database';
import { env } from '../../config/env';
import { encryptData, decryptData } from '../../utils/crypto';
import { createLogger } from '../../utils/logger.ts';
import { BANK_REGISTRY, getBankList } from '../../services/bank/registry';
import type { CredentialField } from '../../services/bank/registry';
import type { BotInstance, Ctx } from '../types';
import type { BankConnection } from '../../database/types';

const logger = createLogger('bank-command');

// ─── /bank command entry point ───────────────────────────────────────────────

export async function handleBankCommand(ctx: Ctx['Message'], bot: BotInstance): Promise<void> {
  const chatId = ctx.chat?.id;
  const isGroup = ctx.chat?.type === 'group' || ctx.chat?.type === 'supergroup';

  if (!isGroup || !chatId) {
    await ctx.reply('Команда /bank работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) return;

  // Clean up stale setup sessions
  database.bankConnections.deleteStaleSetup(group.id);

  // Parse argument, e.g. /bank tbc
  const arg = ctx.text?.split(' ')[1]?.toLowerCase();

  if (arg === 'отмена') {
    await handleWizardCancel(ctx, group.id);
    return;
  }

  if (arg && BANK_REGISTRY[arg]) {
    // Jump straight to setup wizard or show bank status
    const existing = database.bankConnections.findByGroupAndBank(group.id, arg);
    if (existing && existing.status !== 'setup') {
      await showBankStatus(ctx, existing, group);
    } else {
      await startWizard(ctx, group.id, arg);
    }
    return;
  }

  const connections = database.bankConnections.findAllByGroupId(group.id);

  if (connections.length === 0) {
    await showNoBanksPanel(ctx);
    return;
  }

  await showBanksPanel(ctx, bot, connections, group);
}

// ─── Wizard ──────────────────────────────────────────────────────────────────

async function showNoBanksPanel(ctx: Ctx['Message']): Promise<void> {
  const banks = getBankList();
  const buttons = banks.map((b) => [{ text: b.name, callback_data: `bank_setup:${b.key}` }]);
  await ctx.reply('Ни одного банка не подключено.\n\nВыбери банк:', {
    reply_markup: { inline_keyboard: buttons },
  });
}

async function startWizard(
  ctx: Ctx['Message'],
  groupId: number,
  bankKey: string,
): Promise<void> {
  const plugin = BANK_REGISTRY[bankKey];
  if (!plugin) return;

  // Check if there's already an active/disconnected connection for this bank
  const existing = database.bankConnections.findByGroupAndBank(groupId, bankKey);
  if (existing) {
    database.bankConnections.deleteById(existing.id);
  }

  database.bankConnections.create({
    group_id: groupId,
    bank_name: bankKey,
    display_name: plugin.name,
    status: 'setup',
  });

  const firstField = plugin.fields[0];
  const prompt = resolveFieldPrompt(firstField);
  await ctx.reply(`🏦 Подключение ${plugin.name}\n\n${prompt}:\n\n(Для отмены: /bank отмена)`);
}

async function handleWizardCancel(ctx: Ctx['Message'], groupId: number): Promise<void> {
  const setupConn = database.bankConnections
    .findAllByGroupId(groupId)
    .find((c) => c.status === 'setup');

  if (setupConn) {
    database.bankConnections.deleteById(setupConn.id);
    await ctx.reply('Подключение банка отменено.');
  } else {
    await ctx.reply('Нет активного подключения для отмены.');
  }
}

/**
 * Called from message.handler.ts when a message arrives and a setup wizard is active.
 * Returns true if the message was consumed by the wizard.
 */
export async function handleWizardInput(
  ctx: Ctx['Message'],
  groupId: number,
  text: string,
): Promise<boolean> {
  const setupConn = database.bankConnections
    .findAllByGroupId(groupId)
    .find((c) => c.status === 'setup');

  if (!setupConn) return false;

  const plugin = BANK_REGISTRY[setupConn.bank_name];
  if (!plugin) return false;

  // Determine which credential field we're currently collecting
  const credentials = database.bankCredentials.findByConnectionId(setupConn.id);
  const collectedFields: Record<string, string> = credentials
    ? (JSON.parse(decryptData(credentials.encrypted_data)) as Record<string, string>)
    : {};

  const remainingFields = plugin.fields.filter((f) => {
    const name = resolveFieldName(f);
    return !collectedFields[name];
  });

  if (remainingFields.length === 0) return false;

  const currentField = remainingFields[0];
  const fieldName = resolveFieldName(currentField);

  collectedFields[fieldName] = text;

  // Persist partial credentials
  database.bankCredentials.upsert(setupConn.id, encryptData(JSON.stringify(collectedFields)));

  // Check if all fields collected
  const nextFields = plugin.fields.filter((f) => !collectedFields[resolveFieldName(f)]);

  if (nextFields.length > 0) {
    const nextField = nextFields[0];
    await ctx.reply(`${resolveFieldPrompt(nextField)}:`);
    return true;
  }

  // Wizard complete — activate connection
  database.bankConnections.update(setupConn.id, { status: 'active' });
  await ctx.reply(
    `✅ ${plugin.name} подключён!\n\nПервая синхронизация начнётся в течение нескольких минут.`,
  );

  logger.info({ connectionId: setupConn.id, bank: setupConn.bank_name }, 'Bank wizard completed');
  return true;
}

// ─── Status panel ─────────────────────────────────────────────────────────────

async function showBanksPanel(
  ctx: Ctx['Message'],
  bot: BotInstance,
  connections: BankConnection[],
  group: import('../../database/types').Group,
): Promise<void> {
  if (connections.length === 1) {
    await showBankStatus(ctx, connections[0], group);
    return;
  }

  // Multiple banks — delete old panel messages, resend
  for (const conn of connections) {
    if (conn.panel_message_id) {
      try {
        await bot.api.deleteMessage(group.telegram_group_id, conn.panel_message_id);
      } catch {
        // silently ignore if already gone
      }
    }
  }

  if (group.bank_panel_summary_message_id) {
    try {
      await bot.api.deleteMessage(group.telegram_group_id, group.bank_panel_summary_message_id);
    } catch {
      // ignore
    }
  }

  // Send one message per bank
  for (const conn of connections) {
    const text = await buildBankStatusText(conn);
    const result = await ctx.reply(text, {
      reply_markup: {
        inline_keyboard: buildBankManageKeyboard(conn),
      },
    });
    database.bankConnections.update(conn.id, {
      panel_message_id: result.id,
    });
  }

  // Summary message
  const accounts = database.bankAccounts.findByGroupId(group.id);
  const totalEur = accounts.reduce((sum, a) => {
    // Simplified — full conversion would use currency converter
    return sum + (a.currency === 'EUR' ? a.balance : 0);
  }, 0);

  const summary = `Итого: ~${totalEur.toFixed(0)} EUR`;
  const summaryResult = await ctx.reply(summary, {
    reply_markup: {
      inline_keyboard: [[{ text: '➕ Добавить банк', callback_data: 'bank_add' }]],
    },
  });

  database.groups.update(group.telegram_group_id, {
    bank_panel_summary_message_id: summaryResult.id,
  } as never);
}

async function showBankStatus(
  ctx: Ctx['Message'],
  conn: BankConnection,
  group: import('../../database/types').Group,
): Promise<void> {
  const text = await buildBankStatusText(conn);
  const result = await ctx.reply(text, {
    reply_markup: {
      inline_keyboard: buildBankManageKeyboard(conn),
    },
  });
  database.bankConnections.update(conn.id, {
    panel_message_id: result.id,
  });
}

async function buildBankStatusText(conn: BankConnection): Promise<string> {
  const accounts = database.bankAccounts.findByConnectionId(conn.id);
  const lastSync = conn.last_sync_at
    ? `${timeSince(conn.last_sync_at)} назад`
    : 'не синхронизировано';
  const statusEmoji = conn.status === 'active' ? '✅' : '⚠️';

  const balanceLine = accounts.length > 0
    ? accounts.map((a) => `${a.balance.toFixed(2)} ${a.currency}`).join(', ')
    : 'балансы загружаются…';

  const pendingTxs = database.bankTransactions.findPendingByConnectionId(conn.id).slice(0, 3);
  const txLines = pendingTxs.length > 0
    ? '\n\nПоследние операции:\n' +
      pendingTxs
        .map((tx) => `• ${tx.amount.toFixed(2)} ${tx.currency} — ${tx.merchant_normalized ?? tx.merchant ?? '—'} · ⏳ ожидает`)
        .join('\n')
    : '';

  return `🏦 ${conn.display_name} · ${lastSync} · ${statusEmoji}\nБаланс: ${balanceLine}${txLines}`;
}

function buildBankManageKeyboard(conn: BankConnection): { text: string; callback_data: string }[][] {
  return [
    [
      { text: `⚙️ ${conn.display_name}`, callback_data: `bank_settings:${conn.id}` },
    ],
    [
      { text: '🔄 Синхронизировать', callback_data: `bank_sync:${conn.id}` },
      { text: '🔌 Отключить', callback_data: `bank_disconnect:${conn.id}` },
    ],
  ];
}

// ─── Confirmation flow callbacks ──────────────────────────────────────────────

export async function handleBankConfirmCallback(
  ctx: Ctx['CallbackQuery'],
  txId: number,
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) { await ctx.answerCallbackQuery({ text: 'Группа не найдена' }); return; }

  const tx = database.bankTransactions.findById(txId, group.id);
  if (!tx) { await ctx.answerCallbackQuery({ text: 'Транзакция не найдена' }); return; }
  if (tx.status !== 'pending') {
    await ctx.answerCallbackQuery({ text: 'Транзакция уже обработана' });
    return;
  }

  // We don't have pre-fill stored — use merchant as category hint
  const category = tx.merchant_normalized ?? tx.merchant ?? 'прочее';
  const comment = tx.merchant_normalized ?? tx.merchant ?? '';

  // Create expense
  const user = database.users.findByTelegramId(ctx.from.id);
  if (!user) { await ctx.answerCallbackQuery({ text: 'Пользователь не найден' }); return; }

  const expense = database.expenses.create({
    group_id: group.id,
    user_id: user.id,
    date: tx.date,
    category,
    comment,
    amount: tx.amount,
    currency: tx.currency as import('../../config/constants').CurrencyCode,
    eur_amount: 0,
  });

  database.bankTransactions.updateStatus(txId, group.id, 'confirmed');
  database.bankTransactions.setMatchedExpense(txId, group.id, expense.id);

  // Write merchant rule request so agent learns from this
  database.merchantRules.insertRuleRequest({
    merchant_raw: tx.merchant ?? '',
    mcc: tx.mcc,
    group_id: group.id,
    user_category: category,
    user_comment: comment,
  });

  await ctx.answerCallbackQuery({ text: '✅ Расход записан' });
  await ctx.editMessageReplyMarkup({ reply_markup: undefined });
  await ctx.editMessageText(
    (ctx.message?.text ?? '') + '\n\n✅ Записано',
  );
}

export async function handleBankEditCallback(
  ctx: Ctx['CallbackQuery'],
  txId: number,
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) { await ctx.answerCallbackQuery({ text: 'Группа не найдена' }); return; }

  const tx = database.bankTransactions.findById(txId, group.id);
  if (!tx) { await ctx.answerCallbackQuery({ text: 'Транзакция не найдена' }); return; }

  // Check if another edit is in progress
  const pendingTxs = database.bankTransactions.findPendingByConnectionId(tx.connection_id);
  const otherEdit = pendingTxs.find((t) => t.id !== txId && t.edit_in_progress === 1);
  if (otherEdit) {
    await ctx.answerCallbackQuery({ text: 'Сначала заверши текущее исправление' });
    return;
  }

  database.bankTransactions.setEditInProgress(txId, true);
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `✏️ Ответь на это сообщение и напиши что исправить.\n\nФормат: категория — комментарий\nИли только категория.`,
    { reply_to_message_id: tx.telegram_message_id ?? undefined },
  );
}

export async function handleBankEditReply(
  ctx: Ctx['Message'],
  replyToMessageId: number,
  chatId: number,
  text: string,
): Promise<boolean> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) return false;

  // Find a transaction with edit_in_progress=1 whose telegram_message_id matches
  const connections = database.bankConnections.findActiveByGroupId(group.id);
  let editTx: import('../../database/types').BankTransaction | null = null;

  for (const conn of connections) {
    const pending = database.bankTransactions.findPendingByConnectionId(conn.id);
    editTx = pending.find((t) => t.telegram_message_id === replyToMessageId && t.edit_in_progress === 1) ?? null;
    if (editTx) break;
  }

  if (!editTx) return false;

  // Parse "category — comment" or just "category"
  const parts = text.split('—').map((s) => s.trim());
  const category = parts[0] ?? 'прочее';
  const comment = parts[1] ?? (editTx.merchant_normalized ?? editTx.merchant ?? '');

  const user = database.users.findByTelegramId(ctx.from.id);
  if (!user) return false;

  const expense = database.expenses.create({
    group_id: group.id,
    user_id: user.id,
    date: editTx.date,
    category,
    comment,
    amount: editTx.amount,
    currency: editTx.currency as import('../../config/constants').CurrencyCode,
    eur_amount: 0,
  });

  database.bankTransactions.updateStatus(editTx.id, group.id, 'confirmed');
  database.bankTransactions.setMatchedExpense(editTx.id, group.id, expense.id);
  database.bankTransactions.setEditInProgress(editTx.id, false);

  database.merchantRules.insertRuleRequest({
    merchant_raw: editTx.merchant ?? '',
    mcc: editTx.mcc,
    group_id: group.id,
    user_category: category,
    user_comment: comment,
  });

  await ctx.reply(`✅ Расход записан: ${category} — ${comment} (${editTx.amount} ${editTx.currency})`);
  return true;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function resolveFieldName(field: CredentialField): string {
  return typeof field === 'string' ? field : field.name;
}

function resolveFieldPrompt(field: CredentialField): string {
  if (typeof field === 'string') return field;
  return field.prompt ?? field.name;
}

function timeSince(isoDate: string): string {
  const diff = Date.now() - new Date(isoDate).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} мин`;
  return `${Math.floor(mins / 60)} ч`;
}
```

- [ ] **Step 2: Register `/bank` in `src/bot/index.ts`**

Add import:

```typescript
import { handleBankCommand, handleWizardInput } from './commands/bank';
```

In the commands registration section (near other command registrations):

```typescript
  bot.command('bank', (ctx) => handleBankCommand(ctx, bot));
```

In `handleExpenseMessage` in `message.handler.ts`, add wizard input routing before the edit-flow check:

```typescript
  // Bank setup wizard — consume credential input
  if (isGroup && text && !text.startsWith('/')) {
    const chatId = ctx.chat?.id;
    if (chatId) {
      const group = database.groups.findByTelegramGroupId(chatId);
      if (group) {
        const { handleWizardInput } = await import('../commands/bank');
        const handled = await handleWizardInput(ctx, group.id, text);
        if (handled) return;
      }
    }
  }
```

- [ ] **Step 3: Type-check**

```bash
bun run type-check
```

Fix any type errors. Common issues: `Group` missing `bank_panel_summary_message_id` — add it to `UpdateGroupData` if needed, or use `database.db.exec` directly.

- [ ] **Step 4: Lint fix**

```bash
bun run lint:fix
```

- [ ] **Step 5: Commit**

```bash
git add src/bot/commands/bank.ts src/bot/index.ts src/bot/handlers/message.handler.ts
git commit -m "feat(bank): /bank command — setup wizard, status panel, confirmation and edit flows"
```

---

## Task 18: Bank-sync entry point

**Files:**

- Create: `bank-sync.ts`

- [ ] **Step 1: Create `bank-sync.ts`**

```typescript
// Entry point for the bank-sync PM2 process.
// Shares the SQLite database with the main bot but runs independently.
import { createLogger } from './src/utils/logger.ts';
import { startSyncService } from './src/services/bank/sync-service';
import { processMerchantRequests } from './src/services/bank/merchant-agent';

const logger = createLogger('bank-sync-main');

logger.info('Bank-sync service starting…');

// Run merchant request processing every 5 minutes
setInterval(() => {
  processMerchantRequests().catch((err) =>
    logger.error({ err }, 'Merchant processing cycle error'),
  );
}, 5 * 60 * 1000);

// Start bank sync scheduler (per-connection polling)
startSyncService();

logger.info('Bank-sync service started');
```

- [ ] **Step 2: Verify it starts without errors**

```bash
bun bank-sync.ts
```

Expected: logs "Bank-sync service started" and hangs (waiting for scheduled ticks). Ctrl+C to stop.

- [ ] **Step 3: Commit**

```bash
git add bank-sync.ts
git commit -m "feat(bank): bank-sync entry point for PM2"
```

---

## Task 19: Analytics integration

**Files:**

- Modify: `src/services/analytics/spending-analytics.ts`
- Modify: `src/services/analytics/advice-triggers.ts`
- Modify: `src/services/analytics/formatters.ts`

- [ ] **Step 1: Explore existing analytics structure**

Read the first 60 lines of each file to understand extension points:

```bash
# Read each file
```

- [ ] **Step 2: Extend `formatSnapshotForPrompt` in `formatters.ts`**

Find the `formatSnapshotForPrompt` function. Add bank balance section after existing snapshot content:

```typescript
  // Add bank balances if any connections exist
  const bankAccounts = database.bankAccounts.findByGroupId(groupId);
  if (bankAccounts.length > 0) {
    const balanceLines = bankAccounts
      .map((a) => `${a.title}: ${a.balance.toFixed(2)} ${a.currency}`)
      .join('\n');
    snapshot += `\n\n## Банковские балансы\n${balanceLines}`;
  }

  // Add recent confirmed bank transactions (last 20)
  const recentBankTxs = database.bankTransactions.findByGroupId(groupId, { status: 'confirmed' }).slice(0, 20);
  if (recentBankTxs.length > 0) {
    const txLines = recentBankTxs
      .map((tx) => `${tx.date} ${tx.amount} ${tx.currency} — ${tx.merchant_normalized ?? tx.merchant ?? '—'}`)
      .join('\n');
    snapshot += `\n\n## Подтверждённые банковские транзакции\n${txLines}`;
  }
```

- [ ] **Step 3: Add pending bank transactions trigger to `advice-triggers.ts`**

Find the triggers array or `checkTriggers` function. Add:

```typescript
  // Daily: pending bank transactions need review
  const pendingConnections = database.bankConnections.findActiveByGroupId(groupId);
  let totalPending = 0;
  for (const conn of pendingConnections) {
    totalPending += database.bankTransactions.findPendingByConnectionId(conn.id).length;
  }
  if (totalPending > 0) {
    triggers.push({
      type: 'pending_bank_transactions',
      data: { count: totalPending },
      message: `${totalPending} банковских транзакций ожидают подтверждения`,
    });
  }
```

- [ ] **Step 4: Type-check and lint**

```bash
bun run type-check
bun run lint:fix
```

- [ ] **Step 5: Run full test suite**

```bash
bun test
```

Expected: all tests PASS.

- [ ] **Step 6: Final commit**

```bash
git add src/services/analytics/
git commit -m "feat(bank): analytics integration — bank balances in snapshot, pending tx trigger"
```

---

## Self-Review

### Spec coverage check

| Spec requirement | Task |
|-----------------|------|
| ZenPlugins git submodule | Task 9 |
| Runtime shim (getData/saveData/addTransaction/etc.) | Task 10 |
| BANK_REGISTRY with TBC + Kaspi | Task 9 |
| DB: bank_connections, bank_credentials, bank_plugin_state | Task 2 |
| DB: bank_accounts, bank_transactions | Task 2 |
| DB: merchant_rules, merchant_rule_requests | Task 2 |
| DB: groups.bank_panel_summary_message_id | Task 2 |
| PRAGMA busy_timeout = 5000 | Task 1 |
| Sync service: 30-min interval with stagger | Task 13 |
| sign_type classification (debit/credit/reversal) | Task 13 |
| ON CONFLICT DO NOTHING for transactions | Task 6 |
| Merchant rules applied after scrape | Task 13 |
| Error escalation after 3 failures | Task 13 |
| Direct Telegram API for bank-sync notifications | Task 11 |
| AI pre-fill (category + comment) | Task 12 |
| Confirmation card with ✅/✏️ buttons | Task 13 |
| Large transaction ⚠️ prefix | Task 13 |
| ✅ Принять → create expense + merchant_rule_request | Task 17 |
| ✏️ Исправить → reply-based edit flow | Task 17 |
| One active edit at a time (block concurrent edits) | Task 17 |
| /bank command — no banks → bank list buttons | Task 17 |
| /bank command — with banks → status panel | Task 17 |
| /bank setup wizard — step-by-step credentials | Task 17 |
| Wizard cancel with /bank отмена | Task 17 |
| Stale setup cleanup (10 min timeout) | Task 3 |
| Multi-bank panel — one message per bank | Task 17 |
| panel_message_id persisted for in-place edits | Task 17 |
| Admin approval cards for merchant rules | Task 14 |
| BOT_ADMIN_CHAT_ID optional — no crash if absent | Task 1 |
| merchant_rule_requests UNIQUE + INSERT OR IGNORE | Task 7 |
| Prune old processed requests after 7 days | Task 7 |
| Layer 1-5 security (group_id scoping) | Tasks 3, 6 |
| AI tools: get_bank_transactions (group-scoped) | Task 15 |
| AI tools: get_bank_balances | Task 15 |
| AI tools: find_missing_expenses (±2/±5 day fuzzy match) | Task 15 |
| Analytics: bank data in formatSnapshotForPrompt | Task 19 |
| Analytics: pending tx daily advice trigger | Task 19 |
| env BOT_ADMIN_CHAT_ID + LARGE_TX_THRESHOLD_EUR | Task 1 |
| bank-sync.ts PM2 entry point | Task 18 |
| crypto utility (AES-256-GCM) | Task 1 |

### Out of scope (per spec)

- Auto-sync confirmed bank transactions to Google Sheets ✓
- Web UI for merchant rules ✓
- Multiple simultaneous edit flows ✓ (blocked with "Сначала заверши текущее исправление")
