# Monthly Budget Tabs Implementation Plan — Part 3/5: Tasks 5-6: month tab functions, syncBudgetsDiff

[← Back to index](../2026-03-27-sheets-monthly-budget-tabs.md)

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

