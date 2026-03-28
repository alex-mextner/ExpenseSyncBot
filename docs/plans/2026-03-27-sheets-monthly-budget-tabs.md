# Monthly Budget Tabs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat "Budget" sheet with per-month tabs (Jan–Dec), one Google Spreadsheet per calendar year, auto-cloned on the 1st of each month via cron.

**Architecture:** New `group_spreadsheets` table (group_id, year → spreadsheet_id) replaces `groups.spreadsheet_id`. `GroupRepository` LEFT JOINs on current year for backward compatibility. Budget sync reads/writes the current month's tab instead of the flat sheet. A one-time startup migration moves the old "Budget" flat sheet to monthly tabs. `node-cron` creates new month tabs at 00:00 on the 1st.

**Tech Stack:** Bun, bun:sqlite, googleapis, node-cron, date-fns

---

## File Map

| File | Action |
|------|--------|
| `src/database/schema.ts` | Add migration 021 |
| `src/database/types.ts` | Add `GroupSpreadsheet` interface |
| `src/database/repositories/group-spreadsheet.repository.ts` | **Create** |
| `src/database/repositories/group-spreadsheet.repository.test.ts` | **Create** |
| `src/database/repositories/group.repository.ts` | LEFT JOIN on `group_spreadsheets` |
| `src/database/repositories/group.repository.test.ts` | Add tests for JOIN + update routing |
| `src/database/repositories/budget.repository.ts` | Remove `getLatestBudget`, no fallback |
| `src/database/repositories/budget.repository.test.ts` | Update/add tests |
| `src/database/index.ts` | Register `groupSpreadsheets` |
| `src/test-utils/db.ts` | Add `group_spreadsheets` to `clearTestDb` |
| `src/services/google/month-abbr.ts` | **Create** — `MonthAbbr` type + helpers |
| `src/services/google/month-abbr.test.ts` | **Create** |
| `src/services/google/sheets.ts` | Add month tab functions; remove old Budget functions; fix `createExpenseSpreadsheet` |
| `src/services/google/budget-migration.ts` | **Create** — one-time migration |
| `src/services/google/budget-migration.test.ts` | **Create** — tests for `applyInheritance` |
| `src/bot/commands/budget.ts` | Use month tab functions; rewrite sync |
| `src/bot/commands/spreadsheet.ts` | Show current year + list previous |
| `src/bot/cron.ts` | **Create** — `node-cron` monthly auto-clone |
| `src/bot/index.ts` | Register cron; trigger startup migration |

---

### Task 1: DB Migration 021 + GroupSpreadsheetRepository

**Files:**

- Modify: `src/database/schema.ts`
- Modify: `src/database/types.ts`
- Create: `src/database/repositories/group-spreadsheet.repository.ts`
- Create: `src/database/repositories/group-spreadsheet.repository.test.ts`
- Modify: `src/database/index.ts`
- Modify: `src/test-utils/db.ts`

- [ ] **Step 1.1: Write failing tests for GroupSpreadsheetRepository**

Create `src/database/repositories/group-spreadsheet.repository.test.ts`:

```ts
// Tests for GroupSpreadsheetRepository — getByYear, setYear, getCurrentYear, listAll

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { GroupSpreadsheetRepository } from './group-spreadsheet.repository';
import { GroupRepository } from './group.repository';

let db: Database;
let repo: GroupSpreadsheetRepository;
let groupRepo: GroupRepository;
let groupId: number;

beforeAll(() => {
  db = createTestDb();
  repo = new GroupSpreadsheetRepository(db);
  groupRepo = new GroupRepository(db);
});

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  groupId = group.id;
});

describe('GroupSpreadsheetRepository', () => {
  test('getByYear returns null when no entry', () => {
    expect(repo.getByYear(groupId, 2026)).toBeNull();
  });

  test('setYear creates entry, getByYear returns it', () => {
    repo.setYear(groupId, 2026, 'spreadsheet-123');
    expect(repo.getByYear(groupId, 2026)).toBe('spreadsheet-123');
  });

  test('setYear replaces existing entry (INSERT OR REPLACE)', () => {
    repo.setYear(groupId, 2026, 'old-id');
    repo.setYear(groupId, 2026, 'new-id');
    expect(repo.getByYear(groupId, 2026)).toBe('new-id');
  });

  test('getCurrentYear returns null when no entry for current year', () => {
    repo.setYear(groupId, 2020, 'old-spreadsheet');
    expect(repo.getCurrentYear(groupId)).toBeNull();
  });

  test('getCurrentYear returns spreadsheet for current year', () => {
    const year = new Date().getFullYear();
    repo.setYear(groupId, year, 'current-spreadsheet');
    expect(repo.getCurrentYear(groupId)).toBe('current-spreadsheet');
  });

  test('listAll returns entries sorted by year desc', () => {
    repo.setYear(groupId, 2024, 'id-2024');
    repo.setYear(groupId, 2026, 'id-2026');
    repo.setYear(groupId, 2025, 'id-2025');
    const all = repo.listAll(groupId);
    expect(all).toHaveLength(3);
    expect(all[0]).toEqual({ year: 2026, spreadsheetId: 'id-2026' });
    expect(all[2]).toEqual({ year: 2024, spreadsheetId: 'id-2024' });
  });

  test('listAll returns empty array when no entries', () => {
    expect(repo.listAll(groupId)).toEqual([]);
  });

  test('getByYear is isolated per group', () => {
    const g2 = groupRepo.create({ telegram_group_id: Date.now() + 1 });
    repo.setYear(groupId, 2026, 'id-g1');
    repo.setYear(g2.id, 2026, 'id-g2');
    expect(repo.getByYear(groupId, 2026)).toBe('id-g1');
    expect(repo.getByYear(g2.id, 2026)).toBe('id-g2');
  });
});
```

- [ ] **Step 1.2: Run tests — confirm they fail (module not found)**

```bash
cd /Users/ultra/xp/ExpenseSyncBot/.claude/worktrees/sheets-monthly-tabs
bun test src/database/repositories/group-spreadsheet.repository.test.ts
```

Expected: FAIL — `Cannot find module './group-spreadsheet.repository'`

- [ ] **Step 1.3: Add migration 021 to `src/database/schema.ts`**

After migration `020_add_failed_at_state_to_dev_tasks`, add:

```ts
    {
      name: '021_create_group_spreadsheets',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS group_spreadsheets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL REFERENCES groups(id),
            year INTEGER NOT NULL,
            spreadsheet_id TEXT NOT NULL,
            UNIQUE(group_id, year)
          );
        `);

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_group_spreadsheets_group_year
          ON group_spreadsheets(group_id, year);
        `);

        // Migrate existing spreadsheet_id to the year of the group's earliest expense.
        // Fallback: current_year - 1 (for groups with no expenses yet).
        // This ensures a spreadsheet created/used in 2025 is mapped to 2025,
        // not to the current year (2026).
        db.exec(`
          INSERT OR IGNORE INTO group_spreadsheets (group_id, year, spreadsheet_id)
          SELECT
            g.id,
            COALESCE(
              (SELECT MIN(CAST(strftime('%Y', e.date) AS INTEGER)) FROM expenses e WHERE e.group_id = g.id),
              CAST(strftime('%Y', 'now') AS INTEGER) - 1
            ),
            g.spreadsheet_id
          FROM groups g
          WHERE g.spreadsheet_id IS NOT NULL;
        `);

        // Drop the now-redundant column from groups
        db.exec(`ALTER TABLE groups DROP COLUMN spreadsheet_id;`);

        logger.info('✓ Created group_spreadsheets table, migrated existing spreadsheet_ids');
      },
    },
```

- [ ] **Step 1.4: Add `GroupSpreadsheet` type to `src/database/types.ts`**

After the `Group` / `UpdateGroupData` block, add:

```ts
/**
 * Per-year spreadsheet mapping for a group
 */
export interface GroupSpreadsheet {
  id: number;
  group_id: number;
  year: number;
  spreadsheet_id: string;
}
```

- [ ] **Step 1.5: Create `src/database/repositories/group-spreadsheet.repository.ts`**

```ts
// Maps groups to their per-year Google Spreadsheets

import type { Database } from 'bun:sqlite';

export class GroupSpreadsheetRepository {
  constructor(private db: Database) {}

  getByYear(groupId: number, year: number): string | null {
    const result = this.db
      .query<{ spreadsheet_id: string }, [number, number]>(
        'SELECT spreadsheet_id FROM group_spreadsheets WHERE group_id = ? AND year = ?',
      )
      .get(groupId, year);
    return result?.spreadsheet_id ?? null;
  }

  setYear(groupId: number, year: number, spreadsheetId: string): void {
    this.db
      .query<void, [number, number, string]>(
        'INSERT OR REPLACE INTO group_spreadsheets (group_id, year, spreadsheet_id) VALUES (?, ?, ?)',
      )
      .run(groupId, year, spreadsheetId);
  }

  getCurrentYear(groupId: number): string | null {
    return this.getByYear(groupId, new Date().getFullYear());
  }

  listAll(groupId: number): { year: number; spreadsheetId: string }[] {
    return this.db
      .query<{ year: number; spreadsheet_id: string }, [number]>(
        'SELECT year, spreadsheet_id FROM group_spreadsheets WHERE group_id = ? ORDER BY year DESC',
      )
      .all(groupId)
      .map((r) => ({ year: r.year, spreadsheetId: r.spreadsheet_id }));
  }
}
```

- [ ] **Step 1.6: Register `groupSpreadsheets` in `src/database/index.ts`**

Add import:

```ts
import { GroupSpreadsheetRepository } from './repositories/group-spreadsheet.repository';
```

Add field to `DatabaseService`:

```ts
public groupSpreadsheets: GroupSpreadsheetRepository;
```

Add to constructor (after `this.groups = ...`):

```ts
this.groupSpreadsheets = new GroupSpreadsheetRepository(this.db);
```

- [ ] **Step 1.7: Add `group_spreadsheets` to `clearTestDb` in `src/test-utils/db.ts`**

```ts
export function clearTestDb(db: Database): void {
  db.exec(`
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
    DELETE FROM group_spreadsheets;
    DELETE FROM groups;
  `);
}
```

- [ ] **Step 1.8: Run tests — confirm they pass**

```bash
bun test src/database/repositories/group-spreadsheet.repository.test.ts
```

Expected: all tests PASS

- [ ] **Step 1.9: Run full test suite to confirm no regressions**

```bash
bun test
```

Expected: all tests PASS

- [ ] **Step 1.10: Commit**

```bash
git add src/database/schema.ts src/database/types.ts \
  src/database/repositories/group-spreadsheet.repository.ts \
  src/database/repositories/group-spreadsheet.repository.test.ts \
  src/database/index.ts src/test-utils/db.ts
git commit -m "feat(db): add group_spreadsheets table and repository (migration 021)"
```

---

### Task 2: GroupRepository — LEFT JOIN + spreadsheet_id routing

**Files:**

- Modify: `src/database/repositories/group.repository.ts`
- Modify: `src/database/repositories/group.repository.test.ts`

- [ ] **Step 2.1: Add failing tests to `group.repository.test.ts`**

Add these tests in `describe('GroupRepository')`:

```ts
describe('spreadsheet_id via group_spreadsheets JOIN', () => {
  test('new group has null spreadsheet_id (no group_spreadsheets entry)', () => {
    const group = repo.create({ telegram_group_id: 200 });
    expect(group.spreadsheet_id).toBeNull();
  });

  test('findById returns spreadsheet_id from group_spreadsheets for current year', () => {
    const group = repo.create({ telegram_group_id: 201 });
    const year = new Date().getFullYear();
    db.exec(
      `INSERT INTO group_spreadsheets (group_id, year, spreadsheet_id) VALUES (${group.id}, ${year}, 'test-sheet-id')`,
    );
    const found = repo.findById(group.id);
    expect(found?.spreadsheet_id).toBe('test-sheet-id');
  });

  test('findById returns null spreadsheet_id when entry is for different year', () => {
    const group = repo.create({ telegram_group_id: 202 });
    db.exec(
      `INSERT INTO group_spreadsheets (group_id, year, spreadsheet_id) VALUES (${group.id}, 2020, 'old-sheet')`,
    );
    const found = repo.findById(group.id);
    expect(found?.spreadsheet_id).toBeNull();
  });

  test('update with spreadsheet_id writes to group_spreadsheets', () => {
    const group = repo.create({ telegram_group_id: 203 });
    repo.update(203, { spreadsheet_id: 'new-sheet' });
    const year = new Date().getFullYear();
    const row = db
      .query<{ spreadsheet_id: string }, [number, number]>(
        'SELECT spreadsheet_id FROM group_spreadsheets WHERE group_id = ? AND year = ?',
      )
      .get(group.id, year);
    expect(row?.spreadsheet_id).toBe('new-sheet');
  });
});
```

- [ ] **Step 2.2: Run tests — confirm new ones fail**

```bash
bun test src/database/repositories/group.repository.test.ts
```

Expected: new tests FAIL (queries still use `SELECT * FROM groups`)

- [ ] **Step 2.3: Rewrite `group.repository.ts`**

Replace the entire file content:

```ts
// Group repository — manages Telegram group records and their per-year spreadsheet mappings

import type { Database } from 'bun:sqlite';
import type { CurrencyCode } from '../../config/constants';
import type { CreateGroupData, Group, UpdateGroupData } from '../types';

/** Raw row from the LEFT JOIN query */
interface GroupRow extends Omit<Group, 'enabled_currencies'> {
  enabled_currencies: string;
}

/** SELECT clause that includes spreadsheet_id via LEFT JOIN on current year */
const GROUP_JOIN_SELECT = `
  SELECT
    g.id, g.telegram_group_id, g.google_refresh_token,
    g.default_currency, g.enabled_currencies, g.custom_prompt,
    g.active_topic_id, g.created_at, g.updated_at,
    gs.spreadsheet_id
  FROM groups g
  LEFT JOIN group_spreadsheets gs
    ON gs.group_id = g.id AND gs.year = CAST(strftime('%Y', 'now') AS INTEGER)
`;

function parseRow(row: GroupRow): Group {
  return {
    ...row,
    spreadsheet_id: row.spreadsheet_id ?? null,
    enabled_currencies: JSON.parse(row.enabled_currencies) as CurrencyCode[],
  };
}

export class GroupRepository {
  constructor(private db: Database) {}

  findByTelegramGroupId(telegramGroupId: number): Group | null {
    const result = this.db
      .query<GroupRow, [number]>(`${GROUP_JOIN_SELECT} WHERE g.telegram_group_id = ?`)
      .get(telegramGroupId);
    return result ? parseRow(result) : null;
  }

  findById(id: number): Group | null {
    const result = this.db
      .query<GroupRow, [number]>(`${GROUP_JOIN_SELECT} WHERE g.id = ?`)
      .get(id);
    return result ? parseRow(result) : null;
  }

  findAll(): Group[] {
    return this.db
      .query<GroupRow, []>(GROUP_JOIN_SELECT)
      .all()
      .map(parseRow);
  }

  create(data: CreateGroupData): Group {
    const result = this.db
      .query<{ id: number }, [number, string]>(
        'INSERT INTO groups (telegram_group_id, default_currency) VALUES (?, ?) RETURNING id',
      )
      .get(data.telegram_group_id, data.default_currency || 'USD');

    if (!result) throw new Error('Failed to create group');

    const group = this.findById(result.id);
    if (!group) throw new Error('Failed to retrieve created group');
    return group;
  }

  update(telegramGroupId: number, data: UpdateGroupData): Group | null {
    const group = this.findByTelegramGroupId(telegramGroupId);
    if (!group) return null;

    // spreadsheet_id lives in group_spreadsheets, not groups
    if (data.spreadsheet_id !== undefined) {
      const currentYear = new Date().getFullYear();
      this.db
        .query<void, [number, number, string]>(
          'INSERT OR REPLACE INTO group_spreadsheets (group_id, year, spreadsheet_id) VALUES (?, ?, ?)',
        )
        .run(group.id, currentYear, data.spreadsheet_id);
    }

    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.google_refresh_token !== undefined) {
      updates.push('google_refresh_token = ?');
      values.push(data.google_refresh_token);
    }
    if (data.default_currency !== undefined) {
      updates.push('default_currency = ?');
      values.push(data.default_currency);
    }
    if (data.enabled_currencies !== undefined) {
      updates.push('enabled_currencies = ?');
      values.push(JSON.stringify(data.enabled_currencies));
    }
    if (data.custom_prompt !== undefined) {
      updates.push('custom_prompt = ?');
      values.push(data.custom_prompt);
    }
    if (data.active_topic_id !== undefined) {
      updates.push('active_topic_id = ?');
      values.push(data.active_topic_id);
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(telegramGroupId);
      this.db
        .query(`UPDATE groups SET ${updates.join(', ')} WHERE telegram_group_id = ?`)
        .run(...values);
    }

    return this.findByTelegramGroupId(telegramGroupId);
  }

  /** @deprecated Use findAll() */
  getAll(): Group[] {
    return this.findAll();
  }

  delete(telegramGroupId: number): boolean {
    this.db
      .query<void, [number]>('DELETE FROM groups WHERE telegram_group_id = ?')
      .run(telegramGroupId);
    return true;
  }

  hasCompletedSetup(telegramGroupId: number): boolean {
    const group = this.findByTelegramGroupId(telegramGroupId);
    if (!group) return false;
    return !!(group.google_refresh_token && group.spreadsheet_id && group.enabled_currencies.length > 0);
  }
}
```

- [ ] **Step 2.4: Run tests**

```bash
bun test src/database/repositories/group.repository.test.ts
```

Expected: all tests PASS

- [ ] **Step 2.5: Run full suite**

```bash
bun test
```

Expected: all PASS

- [ ] **Step 2.6: Commit**

```bash
git add src/database/repositories/group.repository.ts \
  src/database/repositories/group.repository.test.ts
git commit -m "feat(db): GroupRepository uses LEFT JOIN on group_spreadsheets for spreadsheet_id"
```

---

### Task 3: BudgetRepository — remove inheritance

**Files:**

- Modify: `src/database/repositories/budget.repository.ts`
- Modify: `src/database/repositories/budget.repository.test.ts`

- [ ] **Step 3.1: Find and update existing inheritance tests in `budget.repository.test.ts`**

Find tests that rely on fallback behaviour. They will be in a `describe` block testing `getBudgetForMonth` or `getAllBudgetsForMonth`. Replace them:

```ts
describe('getBudgetForMonth (no inheritance)', () => {
  test('returns budget for exact month match', () => {
    budgetRepo.setBudget({ group_id: groupId, category: 'Food', month: '2024-03', limit_amount: 500 });
    const budget = budgetRepo.getBudgetForMonth(groupId, 'Food', '2024-03');
    expect(budget).not.toBeNull();
    expect(budget?.limit_amount).toBe(500);
  });

  test('returns null when no exact match — no fallback', () => {
    budgetRepo.setBudget({ group_id: groupId, category: 'Food', month: '2024-01', limit_amount: 500 });
    const result = budgetRepo.getBudgetForMonth(groupId, 'Food', '2024-03');
    expect(result).toBeNull();
  });
});

describe('getAllBudgetsForMonth (exact match only)', () => {
  test('returns only budgets for the exact month', () => {
    budgetRepo.setBudget({ group_id: groupId, category: 'Food', month: '2024-01', limit_amount: 500 });
    budgetRepo.setBudget({ group_id: groupId, category: 'Transport', month: '2024-03', limit_amount: 200 });

    const budgets = budgetRepo.getAllBudgetsForMonth(groupId, '2024-03');
    expect(budgets).toHaveLength(1);
    expect(budgets[0].category).toBe('Transport');
  });

  test('returns empty array when no budgets for month', () => {
    budgetRepo.setBudget({ group_id: groupId, category: 'Food', month: '2024-01', limit_amount: 500 });
    expect(budgetRepo.getAllBudgetsForMonth(groupId, '2024-03')).toHaveLength(0);
  });
});
```

- [ ] **Step 3.2: Run tests — confirm updated ones fail**

```bash
bun test src/database/repositories/budget.repository.test.ts
```

Expected: the `getBudgetForMonth` fallback test and `getAllBudgetsForMonth` loop tests FAIL

- [ ] **Step 3.3: Update `budget.repository.ts`**

Replace `getBudgetForMonth`, `getLatestBudget`, `getAllBudgetsForMonth`, and `getBudgetProgress`:

```ts
getBudgetForMonth(groupId: number, category: string, month: string): Budget | null {
  return this.findByGroupCategoryMonth(groupId, category, month);
}

getAllBudgetsForMonth(groupId: number, month: string): Budget[] {
  return this.db
    .query<Budget, [number, string]>(
      'SELECT * FROM budgets WHERE group_id = ? AND month = ? ORDER BY category ASC',
    )
    .all(groupId, month);
}

getBudgetProgress(
  groupId: number,
  category: string,
  month: string,
  spentAmount: number,
): BudgetProgress | null {
  const budget = this.findByGroupCategoryMonth(groupId, category, month);
  if (!budget) return null;

  const percentage =
    budget.limit_amount > 0 ? Math.round((spentAmount / budget.limit_amount) * 100) : 0;

  return {
    category,
    limit_amount: budget.limit_amount,
    spent_amount: spentAmount,
    currency: budget.currency,
    percentage,
    is_exceeded: spentAmount > budget.limit_amount,
    is_warning: percentage >= 90,
  };
}
```

Also **delete** the entire `getLatestBudget` method.

- [ ] **Step 3.4: Run tests**

```bash
bun test src/database/repositories/budget.repository.test.ts
```

Expected: all PASS

- [ ] **Step 3.5: Run full suite**

```bash
bun test
```

Expected: all PASS

- [ ] **Step 3.6: Commit**

```bash
git add src/database/repositories/budget.repository.ts \
  src/database/repositories/budget.repository.test.ts
git commit -m "feat(budget): remove inheritance fallback from BudgetRepository"
```

---

### Task 4: MonthAbbr helpers

**Files:**

- Create: `src/services/google/month-abbr.ts`
- Create: `src/services/google/month-abbr.test.ts`

- [ ] **Step 4.1: Write tests**

Create `src/services/google/month-abbr.test.ts`:

```ts
// Tests for MonthAbbr helpers

import { describe, expect, test } from 'bun:test';
import { MONTH_ABBREVS, monthAbbrFromDate, monthAbbrFromYYYYMM, prevMonthAbbr } from './month-abbr';

describe('monthAbbrFromDate', () => {
  test('returns correct abbreviation for all 12 months', () => {
    const expected: string[] = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    for (let i = 0; i < 12; i++) {
      expect(monthAbbrFromDate(new Date(2026, i, 15))).toBe(expected[i]);
    }
  });
});

describe('monthAbbrFromYYYYMM', () => {
  test('converts YYYY-MM string to abbreviation', () => {
    expect(monthAbbrFromYYYYMM('2026-01')).toBe('Jan');
    expect(monthAbbrFromYYYYMM('2026-03')).toBe('Mar');
    expect(monthAbbrFromYYYYMM('2026-12')).toBe('Dec');
  });

  test('throws for out-of-range month', () => {
    expect(() => monthAbbrFromYYYYMM('2026-13')).toThrow();
    expect(() => monthAbbrFromYYYYMM('2026-00')).toThrow();
  });
});

describe('prevMonthAbbr', () => {
  test('returns previous month, same year', () => {
    expect(prevMonthAbbr(2026, 'Mar')).toEqual({ year: 2026, month: 'Feb' });
    expect(prevMonthAbbr(2026, 'Dec')).toEqual({ year: 2026, month: 'Nov' });
    expect(prevMonthAbbr(2026, 'Feb')).toEqual({ year: 2026, month: 'Jan' });
  });

  test('wraps January to previous year December', () => {
    expect(prevMonthAbbr(2026, 'Jan')).toEqual({ year: 2025, month: 'Dec' });
  });
});

describe('MONTH_ABBREVS', () => {
  test('has 12 entries', () => {
    expect(MONTH_ABBREVS).toHaveLength(12);
  });
});
```

- [ ] **Step 4.2: Run tests — confirm FAIL (module not found)**

```bash
bun test src/services/google/month-abbr.test.ts
```

- [ ] **Step 4.3: Create `src/services/google/month-abbr.ts`**

```ts
// Converts between MonthAbbr (Jan-Dec) and standard date formats

export type MonthAbbr =
  | 'Jan' | 'Feb' | 'Mar' | 'Apr' | 'May' | 'Jun'
  | 'Jul' | 'Aug' | 'Sep' | 'Oct' | 'Nov' | 'Dec';

export const MONTH_ABBREVS: MonthAbbr[] = [
  'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
  'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec',
];

export function monthAbbrFromDate(date: Date): MonthAbbr {
  return MONTH_ABBREVS[date.getMonth()];
}

export function monthAbbrFromYYYYMM(yyyyMM: string): MonthAbbr {
  const monthIndex = parseInt(yyyyMM.slice(5, 7), 10) - 1;
  const abbr = MONTH_ABBREVS[monthIndex];
  if (!abbr) throw new Error(`Invalid month in YYYY-MM string: ${yyyyMM}`);
  return abbr;
}

export function prevMonthAbbr(year: number, month: MonthAbbr): { year: number; month: MonthAbbr } {
  const idx = MONTH_ABBREVS.indexOf(month);
  if (idx === 0) return { year: year - 1, month: 'Dec' };
  return { year, month: MONTH_ABBREVS[idx - 1] };
}
```

- [ ] **Step 4.4: Run tests**

```bash
bun test src/services/google/month-abbr.test.ts
```

Expected: all PASS

- [ ] **Step 4.5: Commit**

```bash
git add src/services/google/month-abbr.ts src/services/google/month-abbr.test.ts
git commit -m "feat(sheets): add MonthAbbr type and helpers"
```

---

### Task 5: Month tab functions in `sheets.ts`

**Files:**

- Modify: `src/services/google/sheets.ts`

These functions call the Google Sheets API — no unit tests (integration only). Add them after the existing helper functions near the end of `sheets.ts`.

- [ ] **Step 5.1: Add `BudgetRow` export and month tab functions to `sheets.ts`**

Add after the `hasBudgetSheet` function (before `readExpensesFromSheet`):

```ts
// ── Monthly budget tab functions ────────────────────────────────────────────

export interface BudgetRow {
  category: string;
  limit: number;
  currency: CurrencyCode;
}

const MONTH_TAB_HEADERS = ['Category', 'Limit', 'Currency'];

/**
 * Check if a monthly budget tab (e.g. "Mar") exists in the spreadsheet
 */
export async function monthTabExists(
  refreshToken: string,
  spreadsheetId: string,
  month: MonthAbbr,
): Promise<boolean> {
  try {
    const auth = getAuthenticatedClient(refreshToken);
    const sheets = google.sheets({ version: 'v4', auth });
    const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
    return !!spreadsheet.data.sheets?.find((s) => s.properties?.title === month);
  } catch (err) {
    logger.error({ err }, `[SHEETS] monthTabExists failed for ${month}`);
    return false;
  }
}

/**
 * Create an empty monthly budget tab with header row (Category | Limit | Currency)
 */
export async function createEmptyMonthTab(
  refreshToken: string,
  spreadsheetId: string,
  month: MonthAbbr,
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  const addResponse = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: month,
              gridProperties: { frozenRowCount: 1 },
            },
          },
        },
      ],
    },
  });

  const sheetId = addResponse.data.replies?.[0]?.addSheet?.properties?.sheetId;

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          updateCells: {
            rows: [
              {
                values: MONTH_TAB_HEADERS.map((header) => ({
                  userEnteredValue: { stringValue: header },
                  userEnteredFormat: {
                    textFormat: { bold: true },
                    backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
                  },
                })),
              },
            ],
            fields: 'userEnteredValue,userEnteredFormat',
            start: { sheetId: sheetId ?? 0, rowIndex: 0, columnIndex: 0 },
          },
        },
        {
          autoResizeDimensions: {
            dimensions: {
              sheetId: sheetId ?? 0,
              dimension: 'COLUMNS',
              startIndex: 0,
              endIndex: 3,
            },
          },
        },
      ],
    },
  });

  logger.info(`[SHEETS] Created empty month tab: ${month}`);
}

/**
 * Read all budget rows from a monthly tab
 */
export async function readMonthBudget(
  refreshToken: string,
  spreadsheetId: string,
  month: MonthAbbr,
): Promise<BudgetRow[]> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  try {
    const response = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `${month}!A2:C`,
    });

    const rows = response.data.values ?? [];
    return rows
      .filter((r) => r.length >= 2)
      .map(([category, limitStr, currencyStr]) => ({
        category: (category as string).trim(),
        limit: parseFloat(limitStr as string),
        currency: ((currencyStr as string | undefined)?.trim() || 'EUR') as CurrencyCode,
      }))
      .filter((r) => r.category && !Number.isNaN(r.limit));
  } catch (err) {
    logger.error({ err }, `[SHEETS] readMonthBudget failed for ${month}`);
    return [];
  }
}

/**
 * Write or update a single budget row in a monthly tab (upsert by category)
 */
export async function writeMonthBudgetRow(
  refreshToken: string,
  spreadsheetId: string,
  month: MonthAbbr,
  row: BudgetRow,
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${month}!A2:C`,
  });

  const existingRows = response.data.values ?? [];
  let targetRow = -1;
  for (let i = 0; i < existingRows.length; i++) {
    if ((existingRows[i]?.[0] as string | undefined)?.toLowerCase() === row.category.toLowerCase()) {
      targetRow = i + 2; // 1-indexed + header row
      break;
    }
  }

  const values = [[row.category, row.limit, row.currency]];

  if (targetRow !== -1) {
    await sheets.spreadsheets.values.update({
      spreadsheetId,
      range: `${month}!A${targetRow}:C${targetRow}`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
  } else {
    await sheets.spreadsheets.values.append({
      spreadsheetId,
      range: `${month}!A2:C`,
      valueInputOption: 'RAW',
      requestBody: { values },
    });
  }
}

/**
 * Clone a monthly tab from one spreadsheet to another (cross-spreadsheet supported).
 * Uses the Google Sheets copyTo API, then renames the resulting sheet.
 */
export async function cloneMonthTab(
  refreshToken: string,
  sourceSpreadsheetId: string,
  sourceMonth: MonthAbbr,
  targetSpreadsheetId: string,
  targetMonth: MonthAbbr,
): Promise<void> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Find source sheet ID
  const sourceSpreadsheet = await sheets.spreadsheets.get({ spreadsheetId: sourceSpreadsheetId });
  const sourceSheet = sourceSpreadsheet.data.sheets?.find(
    (s) => s.properties?.title === sourceMonth,
  );
  const sourceSheetId = sourceSheet?.properties?.sheetId;
  if (sourceSheetId === undefined) {
    throw new Error(`Source tab "${sourceMonth}" not found in ${sourceSpreadsheetId}`);
  }

  // Copy sheet to target spreadsheet
  const copyResponse = await sheets.spreadsheets.sheets.copyTo({
    spreadsheetId: sourceSpreadsheetId,
    sheetId: sourceSheetId,
    requestBody: { destinationSpreadsheetId: targetSpreadsheetId },
  });

  const newSheetId = copyResponse.data.sheetId;
  if (newSheetId === undefined) {
    throw new Error('copyTo did not return a sheetId');
  }

  // Rename the copied sheet to targetMonth
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId: targetSpreadsheetId,
    requestBody: {
      requests: [
        {
          updateSheetProperties: {
            properties: { sheetId: newSheetId, title: targetMonth },
            fields: 'title',
          },
        },
      ],
    },
  });

  logger.info(`[SHEETS] Cloned ${sourceMonth} → ${targetMonth}`);
}
```

Also add the import for `MonthAbbr` at the top of `sheets.ts`:

```ts
import type { MonthAbbr } from './month-abbr';
```

- [ ] **Step 5.2: Add raw expense row helpers to `sheets.ts`**

These are needed by the year-split migration. Add after the month tab functions:

```ts
// ── Raw expense row helpers (used by year-split migration) ──────────────────

const EXPENSES_TAB = 'Expenses';

/**
 * Read all data rows from the Expenses tab as raw string arrays.
 * Skips the header row. Uses UNFORMATTED_VALUE to capture calculated values, not formulas.
 */
export async function readExpenseRowsRaw(
  refreshToken: string,
  spreadsheetId: string,
): Promise<string[][]> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${EXPENSES_TAB}!A2:Z`,
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  return (response.data.values ?? []).map((row) => row.map((cell) => String(cell ?? '')));
}

/**
 * Append raw rows to the Expenses tab.
 */
export async function appendExpenseRowsRaw(
  refreshToken: string,
  spreadsheetId: string,
  rows: string[][],
): Promise<void> {
  if (rows.length === 0) return;
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `${EXPENSES_TAB}!A2`,
    valueInputOption: 'RAW',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: rows },
  });
}

/**
 * Delete rows from the Expenses tab by their 1-based sheet row indices.
 * Sorted and processed in reverse order to avoid index shifting.
 * Uses the Expenses tab's sheetId (resolved from spreadsheet metadata).
 */
export async function deleteExpenseRowsByIndex(
  refreshToken: string,
  spreadsheetId: string,
  rowIndices: number[],
): Promise<void> {
  if (rowIndices.length === 0) return;
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId });
  const expensesSheet = spreadsheet.data.sheets?.find(
    (s) => s.properties?.title === EXPENSES_TAB,
  );
  const sheetId = expensesSheet?.properties?.sheetId;
  if (sheetId === undefined) throw new Error(`"${EXPENSES_TAB}" tab not found in ${spreadsheetId}`);

  // Process in reverse order to avoid row-index shifting
  const sorted = [...rowIndices].sort((a, b) => b - a);

  const requests = sorted.map((rowIdx) => ({
    deleteDimension: {
      range: {
        sheetId,
        dimension: 'ROWS' as const,
        startIndex: rowIdx - 1, // 0-based
        endIndex: rowIdx,       // exclusive
      },
    },
  }));

  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}
```

- [ ] **Step 5.4: Run typecheck**

```bash
bun run type-check
```

Expected: no errors

- [ ] **Step 5.5: Run lint**

```bash
node_modules/.bin/biome lint src/services/google/sheets.ts
```

Expected: no errors

- [ ] **Step 5.6: Commit**

```bash
git add src/services/google/sheets.ts
git commit -m "feat(sheets): add month tab functions and raw expense row helpers"
```

---

### Task 6: Rewrite `syncBudgetsDiff` + `silentSyncBudgets` in `budget.ts`

**Files:**

- Modify: `src/bot/commands/budget.ts`

- [ ] **Step 6.1: Replace `syncBudgetsDiff` in `budget.ts`**

The new version reads from the current month tab instead of the flat Budget sheet.
Replace the entire `syncBudgetsDiff` function:

```ts
export async function syncBudgetsDiff(groupId: number): Promise<BudgetSyncResult> {
  const group = database.groups.findById(groupId);
  if (!group?.google_refresh_token) {
    throw new Error('Group not configured for Google Sheets');
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = format(now, 'yyyy-MM');
  const currentMonthAbbr = monthAbbrFromDate(now);

  const spreadsheetId = database.groupSpreadsheets.getByYear(groupId, currentYear);
  if (!spreadsheetId) {
    return { unchanged: 0, added: [], updated: [], deleted: [], createdCategories: [] };
  }

  const tabExists = await monthTabExists(group.google_refresh_token, spreadsheetId, currentMonthAbbr);
  if (!tabExists) {
    return { unchanged: 0, added: [], updated: [], deleted: [], createdCategories: [] };
  }

  const sheetBudgets = await readMonthBudget(
    group.google_refresh_token,
    spreadsheetId,
    currentMonthAbbr,
  );

  const result: BudgetSyncResult = {
    unchanged: 0,
    added: [],
    updated: [],
    deleted: [],
    createdCategories: [],
  };

  const sheetCategories = new Set<string>(sheetBudgets.map((b) => b.category));

  for (const b of sheetBudgets) {
    if (!database.categories.exists(groupId, b.category)) {
      database.categories.create({ group_id: groupId, name: b.category });
      result.createdCategories.push(b.category);
    }

    const existing = database.budgets.findByGroupCategoryMonth(groupId, b.category, currentMonth);

    if (!existing) {
      database.budgets.setBudget({
        group_id: groupId,
        category: b.category,
        month: currentMonth,
        limit_amount: b.limit,
        currency: b.currency,
      });
      result.added.push({ month: currentMonth, category: b.category, limit: b.limit, currency: b.currency });
    } else if (existing.limit_amount !== b.limit || existing.currency !== b.currency) {
      database.budgets.setBudget({
        group_id: groupId,
        category: b.category,
        month: currentMonth,
        limit_amount: b.limit,
        currency: b.currency,
      });
      result.updated.push({
        month: currentMonth,
        category: b.category,
        limit: b.limit,
        currency: b.currency,
        oldLimit: existing.limit_amount,
      });
    } else {
      result.unchanged++;
    }
  }

  const dbBudgets = database.budgets.getAllBudgetsForMonth(groupId, currentMonth);
  for (const db of dbBudgets) {
    if (!sheetCategories.has(db.category)) {
      database.budgets.delete(db.id);
      result.deleted.push({
        month: db.month,
        category: db.category,
        limit: db.limit_amount,
        currency: db.currency,
      });
    }
  }

  logger.info(
    `[BUDGET-SYNC] +${result.added.length} -${result.deleted.length} ~${result.updated.length} =${result.unchanged}`,
  );

  return result;
}
```

- [ ] **Step 6.2: Replace `silentSyncBudgets` in `budget.ts`**

```ts
export async function silentSyncBudgets(
  googleRefreshToken: string,
  spreadsheetId: string,
  groupId: number,
): Promise<number> {
  try {
    const now = new Date();
    const currentMonth = format(now, 'yyyy-MM');
    const currentMonthAbbr = monthAbbrFromDate(now);

    const tabExists = await monthTabExists(googleRefreshToken, spreadsheetId, currentMonthAbbr);
    if (!tabExists) return 0;

    const budgetsFromSheet = await readMonthBudget(googleRefreshToken, spreadsheetId, currentMonthAbbr);
    if (budgetsFromSheet.length === 0) return 0;

    let syncedCount = 0;
    for (const b of budgetsFromSheet) {
      if (!database.categories.exists(groupId, b.category)) {
        database.categories.create({ group_id: groupId, name: b.category });
      }

      const existing = database.budgets.findByGroupCategoryMonth(groupId, b.category, currentMonth);
      const hasChanged =
        !existing || existing.limit_amount !== b.limit || existing.currency !== b.currency;

      if (hasChanged) {
        database.budgets.setBudget({
          group_id: groupId,
          category: b.category,
          month: currentMonth,
          limit_amount: b.limit,
          currency: b.currency,
        });
        syncedCount++;
      }
    }

    return syncedCount;
  } catch (err) {
    logger.error({ err }, '[BUDGET] Silent sync failed');
    return 0;
  }
}
```

- [ ] **Step 6.3: Update imports at top of `budget.ts`**

Replace:

```ts
import {
  createBudgetSheet,
  hasBudgetSheet,
  readBudgetData,
  writeBudgetRow,
} from '../../services/google/sheets';
```

With:

```ts
import {
  monthTabExists,
  readMonthBudget,
  writeMonthBudgetRow,
  createEmptyMonthTab,
} from '../../services/google/sheets';
import { monthAbbrFromDate } from '../../services/google/month-abbr';
```

- [ ] **Step 6.4: Run typecheck**

```bash
bun run type-check
```

Expected: no errors (old imports still exist in file — they'll be unused, that's OK for now)

- [ ] **Step 6.5: Run full test suite**

```bash
bun test
```

Expected: all PASS

- [ ] **Step 6.6: Commit**

```bash
git add src/bot/commands/budget.ts
git commit -m "feat(budget): rewrite syncBudgetsDiff/silentSyncBudgets to use month tabs"
```

---

### Task 7: Update `budget.ts` command handlers

**Files:**

- Modify: `src/bot/commands/budget.ts`

- [ ] **Step 7.1: Replace `setBudget` function**

Replace the `setBudget` async function:

```ts
async function setBudget(
  ctx: Ctx['Command'],
  group: Group,
  categoryName: string,
  amount: number,
  currency: CurrencyCode,
): Promise<void> {
  const now = new Date();
  const currentMonth = format(now, 'yyyy-MM');
  const currentMonthAbbr = monthAbbrFromDate(now);

  const normalizedCategory =
    categoryName.charAt(0).toUpperCase() + categoryName.slice(1).toLowerCase();

  const categoryExists = database.categories.exists(group.id, normalizedCategory);

  if (!categoryExists) {
    const existingCategories = database.categories.getCategoryNames(group.id);
    const keyboard = createAddCategoryWithBudgetKeyboard(normalizedCategory, amount, currency);
    const currencySymbol = getCurrencySymbol(currency);

    await ctx.send(
      `Категория "${normalizedCategory}" не существует.\n\n` +
        `Хочешь добавить новую категорию "${normalizedCategory}" с бюджетом ${currencySymbol}${amount}?\n\n` +
        `Или выбери из существующих:\n${existingCategories.join(', ')}`,
      { reply_markup: keyboard.build() },
    );
    return;
  }

  database.budgets.setBudget({
    group_id: group.id,
    category: normalizedCategory,
    month: currentMonth,
    limit_amount: amount,
    currency,
  });

  if (!group.google_refresh_token || !group.spreadsheet_id) {
    const emoji = getCategoryEmoji(normalizedCategory);
    await ctx.send(
      `Бюджет установлен: ${emoji} ${normalizedCategory} = ${formatAmount(amount, currency)}\n\n` +
        'Подключи Google Sheets (/connect) чтобы синхронизировать бюджеты.',
    );
    return;
  }

  try {
    const tabExists = await monthTabExists(
      group.google_refresh_token,
      group.spreadsheet_id,
      currentMonthAbbr,
    );
    if (!tabExists) {
      await createEmptyMonthTab(group.google_refresh_token, group.spreadsheet_id, currentMonthAbbr);
    }

    await writeMonthBudgetRow(group.google_refresh_token, group.spreadsheet_id, currentMonthAbbr, {
      category: normalizedCategory,
      limit: amount,
      currency,
    });

    const emoji = getCategoryEmoji(normalizedCategory);
    await ctx.send(
      `Бюджет установлен: ${emoji} ${normalizedCategory} = ${formatAmount(amount, currency)}`,
    );
  } catch (err) {
    logger.error({ err }, '[BUDGET] Failed to write to Google Sheets');
    await ctx.send(
      `Бюджет сохранен в базу данных, но не удалось записать в Google Sheets.\n` +
        `Проверь доступ к таблице или используй /budget sync позже.`,
    );
  }

  await maybeSmartAdvice(ctx, group.id);
}
```

- [ ] **Step 7.2: Replace `showBudgetProgress` function**

Remove the `hasBudgetSheet` / `createBudgetSheet` block. The function now just reads from DB:

```ts
async function showBudgetProgress(ctx: Ctx['Command'], group: Group): Promise<void> {
  const now = new Date();
  const currentMonth = format(now, 'yyyy-MM');
  const currentMonthName = format(now, 'LLLL yyyy');

  const currentMonthStart = format(startOfMonth(now), 'yyyy-MM-dd');
  const currentMonthEnd = format(endOfMonth(now), 'yyyy-MM-dd');
  const expenses = database.expenses.findByDateRange(group.id, currentMonthStart, currentMonthEnd);

  const categorySpending: Record<string, number> = {};
  for (const expense of expenses) {
    categorySpending[expense.category] =
      (categorySpending[expense.category] || 0) + expense.eur_amount;
  }

  const budgets = database.budgets.getAllBudgetsForMonth(group.id, currentMonth);

  if (budgets.length === 0) {
    await ctx.send(
      `Бюджет на ${currentMonthName}\n\n` +
        `Бюджеты не установлены.\n\n` +
        `Используй:\n` +
        `• /budget set <Категория> <Сумма>\n` +
        `• /budget sync — синхронизировать с Google Sheets`,
    );
    await maybeSmartAdvice(ctx, group.id);
    return;
  }

  const budgetsByCurrency: Record<CurrencyCode, { totalBudget: number; totalSpent: number }> =
    {} as Record<CurrencyCode, { totalBudget: number; totalSpent: number }>;

  for (const budget of budgets) {
    const currency = budget.currency;
    if (!budgetsByCurrency[currency]) {
      budgetsByCurrency[currency] = { totalBudget: 0, totalSpent: 0 };
    }
    const spentEur = categorySpending[budget.category] || 0;
    const spentInCurrency = convertCurrency(spentEur, BASE_CURRENCY, currency);
    budgetsByCurrency[currency].totalBudget += budget.limit_amount;
    budgetsByCurrency[currency].totalSpent += spentInCurrency;
  }

  let message = `Бюджет на ${currentMonthName}\n\n`;

  for (const [currency, { totalBudget, totalSpent }] of Object.entries(budgetsByCurrency)) {
    const percentage = totalBudget > 0 ? Math.round((totalSpent / totalBudget) * 100) : 0;
    message += `Всего (${currency}): ${formatAmount(totalSpent, currency as CurrencyCode)} / ${formatAmount(totalBudget, currency as CurrencyCode)} (${percentage}%)\n`;
  }
  message += '\n';

  const budgetProgress = budgets.map((budget) => {
    const spentEur = categorySpending[budget.category] || 0;
    const spent = convertCurrency(spentEur, BASE_CURRENCY, budget.currency);
    const percentage =
      budget.limit_amount > 0 ? Math.round((spent / budget.limit_amount) * 100) : 0;
    return { budget, spent, percentage, is_exceeded: spent > budget.limit_amount, is_warning: percentage >= 90 };
  });

  budgetProgress.sort((a, b) => b.percentage - a.percentage);

  for (const { budget, spent, percentage, is_exceeded, is_warning } of budgetProgress) {
    const emoji = getCategoryEmoji(budget.category);
    const status = is_exceeded ? '(!)' : is_warning ? '(~)' : '';
    message += `${emoji} ${budget.category}: ${formatAmount(spent, budget.currency)} / ${formatAmount(budget.limit_amount, budget.currency)} (${percentage}%) ${status}\n`;
  }

  await ctx.send(message.trim());
  await maybeSmartAdvice(ctx, group.id);
}
```

- [ ] **Step 7.3: Replace `syncBudgets` (user-triggered `/budget sync` handler)**

```ts
async function syncBudgets(ctx: Ctx['Command'], group: Group): Promise<void> {
  if (!group.google_refresh_token || !group.spreadsheet_id) {
    await ctx.send('Сначала подключи Google Sheets с помощью /connect');
    return;
  }

  try {
    const now = new Date();
    const currentMonthAbbr = monthAbbrFromDate(now);
    const currentMonth = format(now, 'yyyy-MM');

    const tabExists = await monthTabExists(
      group.google_refresh_token,
      group.spreadsheet_id,
      currentMonthAbbr,
    );

    if (!tabExists) {
      await createEmptyMonthTab(
        group.google_refresh_token,
        group.spreadsheet_id,
        currentMonthAbbr,
      );
      await ctx.send(
        `Вкладка ${currentMonthAbbr} создана в таблице.\n\n` +
          `Добавь бюджеты через:\n/budget set <Категория> <Сумма>`,
      );
      return;
    }

    const budgetsFromSheet = await readMonthBudget(
      group.google_refresh_token,
      group.spreadsheet_id,
      currentMonthAbbr,
    );

    if (budgetsFromSheet.length === 0) {
      await ctx.send(`В вкладке ${currentMonthAbbr} нет бюджетов для синхронизации.`);
      return;
    }

    let syncedCount = 0;
    let createdCategoriesCount = 0;

    for (const b of budgetsFromSheet) {
      if (!database.categories.exists(group.id, b.category)) {
        database.categories.create({ group_id: group.id, name: b.category });
        createdCategoriesCount++;
      }
      database.budgets.setBudget({
        group_id: group.id,
        category: b.category,
        month: currentMonth,
        limit_amount: b.limit,
        currency: b.currency,
      });
      syncedCount++;
    }

    let message = `Синхронизировано записей бюджета: ${syncedCount}`;
    if (createdCategoriesCount > 0) {
      message += `\nСоздано новых категорий: ${createdCategoriesCount}`;
    }
    await ctx.send(message);
    await maybeSmartAdvice(ctx, group.id);
  } catch (err) {
    logger.error({ err }, '[BUDGET] Failed to sync budgets');
    await ctx.send('Не удалось синхронизировать бюджеты. Проверь доступ к Google Sheets.');
  }
}
```

- [ ] **Step 7.4: Update `handleBudgetCommand` — remove old silentSyncBudgets call**

In `handleBudgetCommand`, the block:

```ts
if (group.google_refresh_token && group.spreadsheet_id) {
  const syncedCount = await silentSyncBudgets(
    group.google_refresh_token,
    group.spreadsheet_id,
    group.id,
  );
  ...
}
```

Update it to pass `group.spreadsheet_id` — but now `group.spreadsheet_id` comes from the LEFT JOIN. This still works correctly; no change needed to the call signature. Just verify the code compiles.

- [ ] **Step 7.5: Run typecheck**

```bash
bun run type-check
```

Expected: no errors

- [ ] **Step 7.6: Run lint**

```bash
node_modules/.bin/biome lint src/bot/commands/budget.ts
```

Expected: no errors (old Budget function references may show as unused — they'll be removed in Task 8)

- [ ] **Step 7.7: Run full suite**

```bash
bun test
```

Expected: all PASS

- [ ] **Step 7.8: Commit**

```bash
git add src/bot/commands/budget.ts
git commit -m "feat(budget): update command handlers to use monthly tab functions"
```

---

### Task 8: `budget-migration.ts` — one-time migration

**Files:**

- Create: `src/services/google/budget-migration.ts`
- Create: `src/services/google/budget-migration.test.ts`

- [ ] **Step 8.1: Write tests for `applyInheritance` (pure function)**

Create `src/services/google/budget-migration.test.ts`:

```ts
// Tests for the pure inheritance-expansion logic used in Budget sheet migration

import { describe, expect, test } from 'bun:test';
import { applyInheritance } from './budget-migration';
import type { FlatBudgetRow } from './budget-migration';

describe('applyInheritance', () => {
  test('returns empty map for empty input', () => {
    expect(applyInheritance([])).toEqual(new Map());
  });

  test('keeps explicit entries unchanged', () => {
    const rows: FlatBudgetRow[] = [
      { month: '2026-01', category: 'Food', limit: 500, currency: 'EUR' },
      { month: '2026-02', category: 'Food', limit: 600, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    expect(result.get('2026-01')).toEqual([{ category: 'Food', limit: 500, currency: 'EUR' }]);
    expect(result.get('2026-02')).toEqual([{ category: 'Food', limit: 600, currency: 'EUR' }]);
  });

  test('inherits from latest prior month when no explicit entry', () => {
    const rows: FlatBudgetRow[] = [
      { month: '2026-01', category: 'Food', limit: 500, currency: 'EUR' },
      { month: '2026-03', category: 'Food', limit: 700, currency: 'EUR' },
      // March also has a new category
      { month: '2026-03', category: 'Rent', limit: 1000, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    // January: only Food (Rent has no prior entry, skip)
    const jan = result.get('2026-01');
    expect(jan).toHaveLength(1);
    expect(jan?.[0]).toEqual({ category: 'Food', limit: 500, currency: 'EUR' });
    // March: Food explicit + Rent explicit
    const march = result.get('2026-03');
    expect(march).toHaveLength(2);
    expect(march).toContainEqual({ category: 'Food', limit: 700, currency: 'EUR' });
    expect(march).toContainEqual({ category: 'Rent', limit: 1000, currency: 'EUR' });
  });

  test('inherits from the LATEST prior month, not earliest', () => {
    const rows: FlatBudgetRow[] = [
      { month: '2026-01', category: 'Food', limit: 100, currency: 'EUR' },
      { month: '2026-02', category: 'Food', limit: 200, currency: 'EUR' },
      // March: Food missing → should inherit from Feb (200), not Jan (100)
      { month: '2026-03', category: 'Transport', limit: 150, currency: 'USD' },
    ];
    const result = applyInheritance(rows);
    const march = result.get('2026-03');
    const food = march?.find((r) => r.category === 'Food');
    expect(food?.limit).toBe(200);
  });

  test('skips category in a month when no prior entry exists', () => {
    const rows: FlatBudgetRow[] = [
      // Rent only appears in Feb for the first time
      { month: '2026-01', category: 'Food', limit: 500, currency: 'EUR' },
      { month: '2026-02', category: 'Rent', limit: 1000, currency: 'EUR' },
    ];
    const result = applyInheritance(rows);
    // Jan: Food only (Rent has no prior, skip)
    expect(result.get('2026-01')).toHaveLength(1);
    // Feb: both (Food inherited from Jan, Rent explicit)
    const feb = result.get('2026-02');
    expect(feb).toHaveLength(2);
    expect(feb).toContainEqual({ category: 'Food', limit: 500, currency: 'EUR' });
    expect(feb).toContainEqual({ category: 'Rent', limit: 1000, currency: 'EUR' });
  });
});
```

- [ ] **Step 8.2: Run tests — confirm FAIL (module not found)**

```bash
bun test src/services/google/budget-migration.test.ts
```

- [ ] **Step 8.3: Create `src/services/google/budget-migration.ts`**

```ts
// Year-split migration: moves current-year expense rows and budget months from the old
// mixed-year spreadsheet to a freshly created current-year spreadsheet.

import { format } from 'date-fns';
import { google } from 'googleapis';
import type { CurrencyCode } from '../../config/constants';
import { createLogger } from '../../utils/logger.ts';
import { getAuthenticatedClient } from './oauth';
import { monthAbbrFromYYYYMM } from './month-abbr';
import {
  appendExpenseRowsRaw,
  createEmptyMonthTab,
  deleteExpenseRowsByIndex,
  monthTabExists,
  readExpenseRowsRaw,
  writeMonthBudgetRow,
} from './sheets';

const logger = createLogger('budget-migration');

export interface FlatBudgetRow {
  month: string; // YYYY-MM
  category: string;
  limit: number;
  currency: CurrencyCode;
}

/**
 * Expand flat budget rows using inheritance: for each (month, category) pair
 * that has no explicit entry, copy from the latest prior month that does.
 * Returns a map from YYYY-MM to resolved rows for that month.
 */
export function applyInheritance(
  rows: FlatBudgetRow[],
): Map<string, { category: string; limit: number; currency: CurrencyCode }[]> {
  if (rows.length === 0) return new Map();

  const months = [...new Set(rows.map((r) => r.month))].sort();
  const categories = [...new Set(rows.map((r) => r.category))];

  const explicit = new Map<string, Map<string, { limit: number; currency: CurrencyCode }>>();
  for (const row of rows) {
    if (!explicit.has(row.month)) explicit.set(row.month, new Map());
    explicit.get(row.month)!.set(row.category, { limit: row.limit, currency: row.currency });
  }

  const result = new Map<string, { category: string; limit: number; currency: CurrencyCode }[]>();

  for (const month of months) {
    const monthRows: { category: string; limit: number; currency: CurrencyCode }[] = [];

    for (const category of categories) {
      const explicitEntry = explicit.get(month)?.get(category);
      if (explicitEntry) {
        monthRows.push({ category, ...explicitEntry });
        continue;
      }

      // Find latest prior month with this category
      const priorMonths = months.filter((m) => m < month).reverse();
      for (const prior of priorMonths) {
        const priorEntry = explicit.get(prior)?.get(category);
        if (priorEntry) {
          monthRows.push({ category, ...priorEntry });
          break;
        }
      }
      // No prior entry → skip this category for this month
    }

    result.set(month, monthRows);
  }

  return result;
}

/** Parse year from a date cell in DD.MM.YYYY format. Returns null if unparseable. */
function yearFromDateCell(cell: string): number | null {
  const parts = cell.split('.');
  if (parts.length !== 3) return null;
  const year = parseInt(parts[2], 10);
  return Number.isNaN(year) ? null : year;
}

function normalizeMonth(month: string): string {
  const match = month.match(/^(\d{4})-(\d{1,2})$/);
  if (!match) return month;
  const [, year, m] = match;
  return `${year}-${(m ?? '').padStart(2, '0')}`;
}

/**
 * Full year-split migration for a group's spreadsheet.
 *
 * - oldSpreadsheetId: the prior-year spreadsheet (will be backed up before modification).
 * - newSpreadsheetId: freshly created current-year spreadsheet (already exists, empty Expenses tab).
 * - splitYear: rows/budget-months with this year move to newSpreadsheetId; prior years stay in old.
 *
 * Returns backup spreadsheet URL. Returns null if there is nothing to migrate (no split-year rows
 * and no Budget sheet). Throws on backup failure or any subsequent error.
 */
export async function runYearSplitMigration(
  refreshToken: string,
  oldSpreadsheetId: string,
  newSpreadsheetId: string,
  splitYear: number,
): Promise<string | null> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheetsApi = google.sheets({ version: 'v4', auth });

  // Check what needs to be done
  const oldSpreadsheet = await sheetsApi.spreadsheets.get({ spreadsheetId: oldSpreadsheetId });
  const budgetSheet = oldSpreadsheet.data.sheets?.find((s) => s.properties?.title === 'Budget');
  const budgetSheetId = budgetSheet?.properties?.sheetId;

  const allExpenseRows = await readExpenseRowsRaw(refreshToken, oldSpreadsheetId);
  const splitYearRows = allExpenseRows
    .map((row, idx) => ({ row, sheetRowIdx: idx + 2 })) // +2: 1-based + skip header
    .filter(({ row }) => yearFromDateCell(row[0] ?? '') === splitYear);

  const hasSomethingToMigrate = splitYearRows.length > 0 || budgetSheet !== undefined;
  if (!hasSomethingToMigrate) {
    logger.info('[MIGRATION] Nothing to migrate for this spreadsheet');
    return null;
  }

  // 1. Backup old spreadsheet before any modifications
  const drive = google.drive({ version: 'v3', auth });
  const copy = await drive.files.copy({
    fileId: oldSpreadsheetId,
    requestBody: { name: `Expenses Tracker — backup ${format(new Date(), 'yyyy-MM-dd')}` },
  });
  const backupId = copy.data.id;
  if (!backupId) throw new Error('[MIGRATION] Drive backup failed: no file ID returned');
  const backupUrl = `https://docs.google.com/spreadsheets/d/${backupId}`;
  logger.info(`[MIGRATION] Backup created: ${backupUrl}`);

  // 2. Copy splitYear expense rows to new spreadsheet
  if (splitYearRows.length > 0) {
    await appendExpenseRowsRaw(
      refreshToken,
      newSpreadsheetId,
      splitYearRows.map(({ row }) => row),
    );
    logger.info(`[MIGRATION] Copied ${splitYearRows.length} expense rows to new spreadsheet`);

    // 3. Delete those rows from the old spreadsheet
    await deleteExpenseRowsByIndex(
      refreshToken,
      oldSpreadsheetId,
      splitYearRows.map(({ sheetRowIdx }) => sheetRowIdx),
    );
    logger.info(`[MIGRATION] Deleted ${splitYearRows.length} expense rows from old spreadsheet`);
  }

  // 4. Migrate Budget flat sheet (if present), splitting months by year
  if (budgetSheet !== undefined) {
    const budgetResponse = await sheetsApi.spreadsheets.values.get({
      spreadsheetId: oldSpreadsheetId,
      range: 'Budget!A2:D',
    });
    const rawRows = budgetResponse.data.values ?? [];

    const flatRows: FlatBudgetRow[] = rawRows
      .filter((r) => r.length >= 3)
      .map(([month, category, limitStr, currencyStr]) => ({
        month: normalizeMonth(String(month ?? '').trim()),
        category: String(category ?? '').trim(),
        limit: parseFloat(String(limitStr ?? '')),
        currency: (String(currencyStr ?? '').trim() || 'EUR') as CurrencyCode,
      }))
      .filter((r) => r.category && !Number.isNaN(r.limit));

    logger.info(`[MIGRATION] Read ${flatRows.length} rows from Budget sheet`);
    const resolved = applyInheritance(flatRows);

    for (const [month, budgetRows] of resolved) {
      // Route to the correct spreadsheet based on the month's year
      const monthYear = parseInt(month.slice(0, 4), 10);
      const targetSpreadsheetId = monthYear >= splitYear ? newSpreadsheetId : oldSpreadsheetId;

      const tabName = monthAbbrFromYYYYMM(month);
      const tabExists = await monthTabExists(refreshToken, targetSpreadsheetId, tabName);
      if (!tabExists) {
        await createEmptyMonthTab(refreshToken, targetSpreadsheetId, tabName);
      }
      for (const row of budgetRows) {
        await writeMonthBudgetRow(refreshToken, targetSpreadsheetId, tabName, row);
      }
      logger.info(`[MIGRATION] Wrote ${budgetRows.length} budget rows to ${monthYear >= splitYear ? 'new' : 'old'} spreadsheet tab ${tabName}`);
    }

    // 5. Delete old Budget flat sheet
    if (budgetSheetId !== undefined) {
      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId: oldSpreadsheetId,
        requestBody: {
          requests: [{ deleteSheet: { sheetId: budgetSheetId } }],
        },
      });
      logger.info('[MIGRATION] Deleted old "Budget" sheet');
    }
  }

  return backupUrl;
}
```

- [ ] **Step 8.4: Run tests**

```bash
bun test src/services/google/budget-migration.test.ts
```

Expected: all PASS

- [ ] **Step 8.5: Run typecheck**

```bash
bun run type-check
```

Expected: no errors

- [ ] **Step 8.6: Commit**

```bash
git add src/services/google/budget-migration.ts src/services/google/budget-migration.test.ts
git commit -m "feat(sheets): add year-split migration (runYearSplitMigration, applyInheritance)"
```

---

### Task 9: Remove old Budget functions from `sheets.ts`

**Files:**

- Modify: `src/services/google/sheets.ts`

At this point, `budget.ts` no longer imports `createBudgetSheet`, `hasBudgetSheet`, `readBudgetData`, `writeBudgetRow`. Time to delete them and fix `createExpenseSpreadsheet`.

- [ ] **Step 9.1: Remove old Budget functions from `sheets.ts`**

Delete these functions entirely:

- `createEmptyBudgetSheet` (private, lines ~478–555)
- `createBudgetSheet` (lines ~560–658)
- `readBudgetData` (lines ~663–705)
- `writeBudgetRow` (lines ~710–768)
- `hasBudgetSheet` (lines ~773–791)
- `BUDGET_SHEET_CONFIG` constant (lines ~459–462)
- `normalizeMonth` function (lines ~468–473) — it's now in `budget-migration.ts`

Also remove the `normalizeMonth` call and the `createEmptyBudgetSheet` call from `createExpenseSpreadsheet`. Specifically, remove this line near line 118:

```ts
  await createEmptyBudgetSheet(refreshToken, spreadsheetId);
```

- [ ] **Step 9.2: Run typecheck**

```bash
bun run type-check
```

Expected: no errors

- [ ] **Step 9.3: Run lint**

```bash
node_modules/.bin/biome lint src/services/google/sheets.ts
```

Expected: no warnings or errors

- [ ] **Step 9.4: Run full test suite**

```bash
bun test
```

Expected: all PASS

- [ ] **Step 9.5: Commit**

```bash
git add src/services/google/sheets.ts
git commit -m "chore(sheets): remove flat Budget sheet functions, stop creating Budget tab on setup"
```

---

### Task 10: Update `spreadsheet.ts` command

**Files:**

- Modify: `src/bot/commands/spreadsheet.ts`

- [ ] **Step 10.1: Rewrite `handleSpreadsheetCommand`**

```ts
// /spreadsheet command — shows current year's spreadsheet and list of previous years

import { database } from '../../database';
import { getSpreadsheetUrl } from '../../services/google/sheets';
import type { Ctx } from '../types';

export async function handleSpreadsheetCommand(ctx: Ctx['Command']): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!chatId) {
    await ctx.send('Error: Unable to identify chat');
    return;
  }

  const isGroup = chatType === 'group' || chatType === 'supergroup';
  if (!isGroup) {
    await ctx.send('Эта команда работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.send('Группа не настроена. Используй /connect для настройки.');
    return;
  }

  const currentYear = new Date().getFullYear();
  const currentSpreadsheetId = database.groupSpreadsheets.getByYear(group.id, currentYear);
  const all = database.groupSpreadsheets.listAll(group.id);

  if (!currentSpreadsheetId && all.length === 0) {
    await ctx.send('Таблица не создана. Завершите настройку: /connect');
    return;
  }

  let message = '';

  if (currentSpreadsheetId) {
    message += `Таблица ${currentYear}:\n${getSpreadsheetUrl(currentSpreadsheetId)}\n`;
  } else {
    message += `Таблица за ${currentYear} ещё не создана.\n`;
  }

  const previous = all.filter((e) => e.year < currentYear);
  if (previous.length > 0) {
    message += `\nПредыдущие годы:\n`;
    for (const { year, spreadsheetId } of previous) {
      message += `• ${year}: ${getSpreadsheetUrl(spreadsheetId)}\n`;
    }
  }

  message +=
    `\nМожно редактировать прямо в таблице. После правок:\n` +
    `• /sync — подхватить изменения расходов\n` +
    `• /budget sync — подхватить изменения бюджетов`;

  await ctx.send(message.trim());
}
```

- [ ] **Step 10.2: Run typecheck**

```bash
bun run type-check
```

Expected: no errors

- [ ] **Step 10.3: Commit**

```bash
git add src/bot/commands/spreadsheet.ts
git commit -m "feat(bot): /spreadsheet shows current year + list of previous years"
```

---

### Task 11: cron.ts + bot/index.ts — wire everything together

**Files:**

- Create: `src/bot/cron.ts`
- Modify: `src/bot/index.ts`

- [ ] **Step 11.1: Create `src/bot/cron.ts`**

```ts
// Monthly budget tab auto-clone — runs at 00:00 on the 1st of every month

import cron from 'node-cron';
import { database } from '../database';
import {
  cloneMonthTab,
  createEmptyMonthTab,
  createExpenseSpreadsheet,
  monthTabExists,
} from '../services/google/sheets';
import { monthAbbrFromDate, prevMonthAbbr } from '../services/google/month-abbr';
import { createLogger } from '../utils/logger.ts';
import type { BotInstance } from './types';

const logger = createLogger('cron');

export function registerMonthlyCron(bot: BotInstance): void {
  cron.schedule('0 0 1 * *', async () => {
    logger.info('[CRON] Monthly tab auto-clone started');

    const now = new Date();
    const year = now.getFullYear();
    const month = monthAbbrFromDate(now);

    const groups = database.groups.findAll();

    for (const group of groups) {
      if (!group.google_refresh_token) continue;

      // Only active groups (have at least one spreadsheet entry)
      const allSpreadsheets = database.groupSpreadsheets.listAll(group.id);
      if (allSpreadsheets.length === 0) continue;

      try {
        let spreadsheetId = database.groupSpreadsheets.getByYear(group.id, year);

        if (!spreadsheetId) {
          // New year — create spreadsheet (Expenses tab only)
          const { spreadsheetId: newId } = await createExpenseSpreadsheet(
            group.google_refresh_token,
            group.default_currency,
            group.enabled_currencies,
          );
          database.groupSpreadsheets.setYear(group.id, year, newId);
          spreadsheetId = newId;
          logger.info(`[CRON] Created new spreadsheet for group ${group.id}, year ${year}: ${newId}`);
        }

        const tabAlreadyExists = await monthTabExists(
          group.google_refresh_token,
          spreadsheetId,
          month,
        );
        if (tabAlreadyExists) {
          logger.info(`[CRON] Tab ${month} already exists for group ${group.id}, skipping`);
          continue;
        }

        const { year: prevYear, month: prevMonth } = prevMonthAbbr(year, month);
        const prevSpreadsheetId = database.groupSpreadsheets.getByYear(group.id, prevYear);

        let notifyText: string;
        if (
          prevSpreadsheetId &&
          (await monthTabExists(group.google_refresh_token, prevSpreadsheetId, prevMonth))
        ) {
          await cloneMonthTab(
            group.google_refresh_token,
            prevSpreadsheetId,
            prevMonth,
            spreadsheetId,
            month,
          );
          notifyText = `Создана вкладка ${month} — скопирована из ${prevMonth}`;
          logger.info(`[CRON] Cloned ${prevMonth} → ${month} for group ${group.id}`);
        } else {
          await createEmptyMonthTab(group.google_refresh_token, spreadsheetId, month);
          notifyText = `Создана вкладка ${month}`;
          logger.info(`[CRON] Created empty tab ${month} for group ${group.id}`);
        }

        await bot.api
          .sendMessage({ chat_id: group.telegram_group_id, text: notifyText })
          .catch((err: unknown) =>
            logger.error({ err }, `[CRON] Failed to notify group ${group.id}`),
          );
      } catch (err) {
        logger.error({ err }, `[CRON] Failed for group ${group.id}`);
      }
    }

    logger.info('[CRON] Monthly tab auto-clone complete');
  });

  logger.info('[CRON] Monthly tab cron registered (00:00 on 1st of each month)');
}
```

- [ ] **Step 11.2: Update `src/bot/index.ts` — add startup migration + cron**

Add these imports near the top of `index.ts`:

```ts
import { runYearSplitMigration } from '../services/google/budget-migration';
import { createExpenseSpreadsheet } from '../services/google/sheets';
import { registerMonthlyCron } from './cron';
```

Inside `createBot()`, after all command handlers are registered (just before `return bot`), add:

```ts
  // Register monthly budget tab cron
  registerMonthlyCron(bot);

  return bot;
```

Then, add a startup migration function and call it from the bot startup. In `index.ts` (or wherever the bot is started — look for the `createBot()` call in `src/index.ts`), after the bot starts, add:

```ts
// One-time year-split migration: for each group whose existing spreadsheet pre-dates the
// current year, create a new current-year spreadsheet, copy current-year rows there,
// and clean up the old spreadsheet.
async function runStartupYearSplitMigration(): Promise<void> {
  const currentYear = new Date().getFullYear();
  const groups = database.groups.findAll();

  for (const group of groups) {
    if (!group.google_refresh_token) continue;

    const allSpreadsheets = database.groupSpreadsheets.listAll(group.id);
    if (allSpreadsheets.length === 0) continue;

    // Skip if current year already has a spreadsheet (migration already done or not needed)
    const currentSpreadsheetId = database.groupSpreadsheets.getByYear(group.id, currentYear);
    if (currentSpreadsheetId) continue;

    // Find the most recent prior-year spreadsheet to split from
    const priorSpreadsheet = allSpreadsheets.find((s) => s.year < currentYear);
    if (!priorSpreadsheet) continue;

    try {
      // 1. Create new current-year spreadsheet
      const { spreadsheetId: newId, spreadsheetUrl: newUrl } = await createExpenseSpreadsheet(
        group.google_refresh_token,
        group.default_currency,
        group.enabled_currencies,
      );
      database.groupSpreadsheets.setYear(group.id, currentYear, newId);
      logger.info(`[STARTUP] Created ${currentYear} spreadsheet for group ${group.id}: ${newId}`);

      // 2. Run year-split: move currentYear rows from old spreadsheet to new one
      const backupUrl = await runYearSplitMigration(
        group.google_refresh_token,
        priorSpreadsheet.spreadsheetId,
        newId,
        currentYear,
      );
      if (backupUrl) {
        logger.info(
          `[STARTUP] Year-split done for group ${group.id}. Backup: ${backupUrl}`,
        );
      }

      // 3. Notify the group
      await bot.api
        .sendMessage({
          chat_id: group.telegram_group_id,
          text:
            `Создана таблица ${currentYear}: ${newUrl}\n` +
            `Данные за ${currentYear} перенесены из таблицы ${priorSpreadsheet.year}.`,
          ...(group.active_topic_id ? { message_thread_id: group.active_topic_id } : {}),
        })
        .catch((err: unknown) =>
          logger.error({ err }, `[STARTUP] Failed to notify group ${group.id}`),
        );
    } catch (err) {
      logger.error({ err }, `[STARTUP] Year-split migration FAILED for group ${group.id} — shutting down`);
      process.exit(1);
    }
  }
}
```

Then call `await runStartupYearSplitMigration()` in the startup sequence (wherever `bot.start()` is called in `src/index.ts`).

- [ ] **Step 11.3: Find where bot is started and add the migration call**

Read `src/index.ts` and find where `bot.start()` is called.

Add `await runStartupYearSplitMigration()` before `bot.start()`. Export the function from
`src/bot/index.ts` and import it in `src/index.ts`.

Note: `runStartupYearSplitMigration` needs access to `bot` to send notifications —
pass `bot` as a parameter or close over it. The cleanest approach: export
`export function createStartupMigration(bot: BotInstance)` that returns the async function.

- [ ] **Step 11.4: Run typecheck**

```bash
bun run type-check
```

Expected: no errors

- [ ] **Step 11.5: Run full test suite**

```bash
bun test
```

Expected: all PASS

- [ ] **Step 11.6: Run lint on all changed files**

```bash
node_modules/.bin/biome lint src/bot/cron.ts src/bot/index.ts
```

Expected: no errors

- [ ] **Step 11.7: Final full check before commit**

```bash
bun run type-check && bun test && node_modules/.bin/biome lint src/
```

Expected: all pass, no errors

- [ ] **Step 11.8: Commit**

```bash
git add src/bot/cron.ts src/bot/index.ts src/index.ts
git commit -m "feat(bot): register monthly tab cron and startup Budget migration"
```

---

## Verification Checklist

Before calling this done, verify:

- [ ] `bun test` — all tests pass
- [ ] `bun run type-check` — no errors
- [ ] `node_modules/.bin/biome lint src/` — no warnings
- [ ] `database.groupSpreadsheets` accessible in code via `database.groupSpreadsheets.getByYear(...)`
- [ ] `group.spreadsheet_id` still works in all existing command handlers (backward compat via LEFT JOIN)
- [ ] Old `Budget` flat sheet functions no longer exported from `sheets.ts`
- [ ] `createExpenseSpreadsheet` no longer creates a Budget tab
- [ ] `/spreadsheet` command shows current year + previous years
- [ ] Cron registered with `node-cron` expression `'0 0 1 * *'`
- [ ] DB migration maps existing spreadsheet to year of earliest expense (not current year)
- [ ] `runYearSplitMigration` copies splitYear expense rows to new spreadsheet, deletes from old
- [ ] Budget months with year >= splitYear go to new spreadsheet; prior years stay in old
- [ ] Startup migration skips groups that already have a current-year spreadsheet (idempotent)
- [ ] Startup migration sends Telegram notification with new spreadsheet URL after split
- [ ] Startup migration calls `process.exit(1)` on ANY failure after backup
