# Monthly Budget Tabs Implementation Plan — Part 2/5: Tasks 2-4: GroupRepository, BudgetRepository, MonthAbbr

[← Back to index](../2026-03-27-sheets-monthly-budget-tabs.md)

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

