# Monthly Budget Tabs Implementation Plan — Part 4/5: Tasks 7-8: budget handlers, one-time migration

[← Back to index](../2026-03-27-sheets-monthly-budget-tabs.md)

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

