# Bank Integration Implementation Plan — Part 3/7: Tasks 7-9: merchant rules, DatabaseService registration, ZenPlugin submodule

[← Back to index](../2026-03-27-bank-integration.md)

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

