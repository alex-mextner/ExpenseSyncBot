# Test Coverage 1000 / TDD Error Handling — Implementation Plan — Part 2/4: Agents 2-3: core and small repositories

[← Back to index](../2026-03-22-test-coverage-1000-plan.md)

## AGENT 2 — Core Repositories (~180 tests)

**Files owned:** `src/test-utils/db.ts`, six repository test files.

**Depends on:** Nothing. Creates `src/test-utils/db.ts` first (used by Agent 3).

**Run tests with:** `bun test src/test-utils/ src/database/repositories/expense.repository.test.ts src/database/repositories/category.repository.test.ts src/database/repositories/expense-items.repository.test.ts src/database/repositories/budget.repository.test.ts src/database/repositories/group.repository.test.ts src/database/repositories/user.repository.test.ts`

---

### Task A2-1: Create shared test DB helper

**Files:**
- Read first: `src/database/schema.ts` (for runMigrations function)
- Create: `src/test-utils/db.ts`

- [ ] **Step 1: Write helper**

```typescript
// src/test-utils/db.ts
// Shared in-memory SQLite setup for repository tests

import { Database } from 'bun:sqlite';
import { runMigrations } from '../database/schema'; // runMigrations IS exported at schema.ts:23

/**
 * Create a fresh in-memory database with all migrations applied.
 * Call in beforeAll(). Close in afterAll(). Clear tables in beforeEach().
 */
export function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}

/**
 * Remove all rows from all tables (call in beforeEach to isolate tests).
 * Order matters due to foreign keys.
 */
export function clearTestDb(db: Database): void {
  db.exec(`
    DELETE FROM advice_log;
    DELETE FROM chat_messages;
    DELETE FROM receipt_items;
    DELETE FROM photo_processing_queue;
    DELETE FROM expense_items;
    DELETE FROM expenses;
    DELETE FROM pending_expenses;
    DELETE FROM budgets;
    DELETE FROM categories;
    DELETE FROM dev_tasks;
    DELETE FROM users;
    DELETE FROM groups;
  `);
}

/**
 * Insert a test group and return its id.
 */
export function insertTestGroup(db: Database, overrides: Partial<{
  telegram_group_id: number;
  default_currency: string;
}> = {}): number {
  const stmt = db.prepare(
    `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies)
     VALUES (?, ?, '["EUR"]')`
  );
  const result = stmt.run(
    overrides.telegram_group_id ?? Math.floor(Math.random() * 1_000_000),
    overrides.default_currency ?? 'EUR'
  );
  return result.lastInsertRowid as number;
}

/**
 * Insert a test user in a group and return its id.
 */
export function insertTestUser(db: Database, groupId: number): number {
  const stmt = db.prepare(
    `INSERT INTO users (telegram_id, group_id) VALUES (?, ?)`
  );
  const result = stmt.run(Math.floor(Math.random() * 1_000_000), groupId);
  return result.lastInsertRowid as number;
}
```

- [ ] **Step 2: Verify helper compiles**

```bash
bunx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/test-utils/db.ts
git commit -m "test(utils): add shared in-memory SQLite test helper"
```

---

### Task A2-2: Group repository tests (~25 tests)

**Files:**
- Read first: `src/database/repositories/group.repository.ts`
- Create: `src/database/repositories/group.repository.test.ts`

- [ ] **Step 1: Read the repository to understand its methods**

Read `src/database/repositories/group.repository.ts` fully before writing tests.

- [ ] **Step 2: Write tests covering all public methods**

Pattern to follow for every repository:
```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestDb } from '../../test-utils/db';
import { GroupRepository } from './group.repository';

let db: Database;
let repo: GroupRepository;

beforeAll(() => {
  db = createTestDb();
  repo = new GroupRepository(db);
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec('DELETE FROM groups');
});

describe('GroupRepository', () => {
  describe('create', () => {
    it('creates and returns group with id', () => {
      const group = repo.create({ telegram_group_id: 100500, default_currency: 'EUR' });
      expect(group.id).toBeGreaterThan(0);
      expect(group.telegram_group_id).toBe(100500);
    });

    it('throws on duplicate telegram_group_id', () => {
      repo.create({ telegram_group_id: 1, default_currency: 'EUR' });
      expect(() => repo.create({ telegram_group_id: 1, default_currency: 'USD' })).toThrow();
    });
  });

  describe('findByTelegramId', () => {
    it('returns group by telegram id', () => {
      repo.create({ telegram_group_id: 200, default_currency: 'USD' });
      const found = repo.findByTelegramId(200);
      expect(found?.telegram_group_id).toBe(200);
    });

    it('returns null for unknown id', () => {
      expect(repo.findByTelegramId(999999)).toBeNull();
    });
  });

  // ... (findById, update, delete, etc. — cover all methods you find in the file)
});
```

Write tests for **every method** in the repository. Aim for 25+ tests covering: create, find variants, update, delete, edge cases (NULL values, constraints).

- [ ] **Step 3: Run tests**

```bash
bun test src/database/repositories/group.repository.test.ts
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/database/repositories/group.repository.test.ts
git commit -m "test(repo): add group repository tests"
```

---

### Task A2-3: User repository tests (~25 tests)

Same pattern as A2-2. Read `user.repository.ts` first.

Key cases to cover:
- `findByTelegramId` — found / not found
- `findById` — found / not found
- `create` — with and without group_id
- `update` — partial updates
- Foreign key: user with group_id when group deleted (ON DELETE SET NULL)

```bash
bun test src/database/repositories/user.repository.test.ts
git commit -m "test(repo): add user repository tests"
```

---

### Task A2-4: Category repository tests (~25 tests)

Read `category.repository.ts` first.

Key cases:
- `findByGroupId` — returns only group's categories
- `findByName` — case-sensitive vs case-insensitive
- UNIQUE(group_id, name) constraint
- Cascade delete when group deleted
- Create/update/delete

```bash
bun test src/database/repositories/category.repository.test.ts
git commit -m "test(repo): add category repository tests"
```

---

### Task A2-5: Expense repository tests (~40 tests)

Read `expense.repository.ts` first. This is the most complex repository.

Key cases:
- Create expense with all fields
- `findByGroupId` — basic fetch
- Date range filter (`from`, `to`)
- Category filter (case-insensitive)
- Currency filter
- Pagination / limit
- Sum aggregation by category
- Sum aggregation by currency
- Order by date descending
- Delete expense (own group vs wrong group — access control)
- `findByDateRange` with empty result
- NULL comment handling

```bash
bun test src/database/repositories/expense.repository.test.ts
git commit -m "test(repo): add expense repository tests — 40 cases"
```

---

### Task A2-6: Budget repository tests (~25 tests)

Read `budget.repository.ts` first.

Key cases:
- UNIQUE(group_id, category, month)
- `findByGroupAndMonth` — returns correct month only
- `upsert` or `createOrUpdate` pattern
- `findExceededBudgets` — comparing sum to limit
- Currency handling

```bash
bun test src/database/repositories/budget.repository.test.ts
git commit -m "test(repo): add budget repository tests"
```

---

### Task A2-7: Expense-items repository tests (~20 tests)

Read `expense-items.repository.ts` first.

Key cases:
- Create item linked to expense
- `findByExpenseId`
- Cascade delete when expense deleted

```bash
bun test src/database/repositories/expense-items.repository.test.ts
git commit -m "test(repo): add expense-items repository tests"
```

---

### Task A2-8: Final run — all Agent 2 tests

```bash
bun test src/test-utils/ src/database/repositories/expense.repository.test.ts src/database/repositories/category.repository.test.ts src/database/repositories/expense-items.repository.test.ts src/database/repositories/budget.repository.test.ts src/database/repositories/group.repository.test.ts src/database/repositories/user.repository.test.ts
```
Expected: ~180 tests, all green.

---

## AGENT 3 — Small Repositories (~110 tests)

**Files owned:** five repository test files.

**Depends on:** `src/test-utils/db.ts` (created by Agent 2). If Agent 2 hasn't committed it yet, create a local inline version:

```typescript
// Inline fallback if test-utils/db.ts not yet available
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../database/schema';
function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}
```

**Run tests with:** `bun test src/database/repositories/pending-expense.repository.test.ts src/database/repositories/advice-log.repository.test.ts src/database/repositories/chat-message.repository.test.ts src/database/repositories/receipt-items.repository.test.ts src/database/repositories/photo-queue.repository.test.ts`

---

### Task A3-1: Pending expense repository tests (~20 tests)

Read `pending-expense.repository.ts` first.

Key cases:
- Create pending expense with `status = 'pending_category'`
- `findByUserId`
- `findByMessageId`
- Update status to 'confirmed'
- Delete after confirmation
- Multiple pending expenses for same user

```bash
bun test src/database/repositories/pending-expense.repository.test.ts
git commit -m "test(repo): add pending-expense repository tests"
```

---

### Task A3-2: Chat message repository tests (~20 tests)

Read `chat-message.repository.ts` first.

Key cases:
- Create message with role 'user' / 'assistant'
- `findByGroupId` — returns messages for group only
- Order by created_at
- Limit (get last N messages)
- Invalid role → throws constraint error
- Clear history for group

```bash
bun test src/database/repositories/chat-message.repository.test.ts
git commit -m "test(repo): add chat-message repository tests"
```

---

### Task A3-3: Advice log repository tests (~20 tests)

Read `advice-log.repository.ts` first.

Key cases:
- Create log entry
- `findByGroupId` with date range
- `findRecent` — last N entries
- tier constraint ('quick', 'alert', 'deep')
- trigger_data JSON storage (stored as text, parsed as needed)

```bash
bun test src/database/repositories/advice-log.repository.test.ts
git commit -m "test(repo): add advice-log repository tests"
```

---

### Task A3-4: Photo queue repository tests (~25 tests)

Read `photo-queue.repository.ts` first.

Key cases:
- Create with status 'pending'
- `findByStatus` — returns only matching status
- `updateStatus` — pending → processing → done / error
- Invalid status → throws constraint error
- `findByGroupId`
- summary_mode flag (0/1)
- message_thread_id nullable

```bash
bun test src/database/repositories/photo-queue.repository.test.ts
git commit -m "test(repo): add photo-queue repository tests"
```

---

### Task A3-5: Receipt items repository tests (~25 tests)

Read `receipt-items.repository.ts` first.

Key cases:
- Create item linked to photo_queue entry
- `findByQueueId`
- Status: 'pending', 'confirmed', 'skipped'
- `updateStatus` including 'skipped'
- confirmed_category nullable
- possible_categories stored as JSON text
- waiting_for_category_input flag
- Cascade delete when photo_queue entry deleted

```bash
bun test src/database/repositories/receipt-items.repository.test.ts
git commit -m "test(repo): add receipt-items repository tests"
```

---

### Task A3-6: Final run — all Agent 3 tests

```bash
bun test src/database/repositories/pending-expense.repository.test.ts src/database/repositories/advice-log.repository.test.ts src/database/repositories/chat-message.repository.test.ts src/database/repositories/receipt-items.repository.test.ts src/database/repositories/photo-queue.repository.test.ts
```
Expected: ~110 tests, all green.

---

