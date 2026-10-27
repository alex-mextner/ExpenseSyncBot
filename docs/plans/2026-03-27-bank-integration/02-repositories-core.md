# Bank Integration Implementation Plan — Part 2/7: Tasks 3-6: connections, credentials, accounts, transactions repositories

[← Back to index](../2026-03-27-bank-integration.md)

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

