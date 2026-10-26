# Monthly Budget Tabs Implementation Plan — Part 1/5: File map, Task 1: migration 021 + GroupSpreadsheetRepository

[← Back to index](../2026-03-27-sheets-monthly-budget-tabs.md)

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

