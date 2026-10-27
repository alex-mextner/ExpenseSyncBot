# Bank Integration Implementation Plan — Part 1/7: File map, Tasks 1-2: env/crypto, DB migrations

[← Back to index](../2026-03-27-bank-integration.md)

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

