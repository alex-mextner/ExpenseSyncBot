# Spec: Monthly Budget Tabs in Google Sheets

## Overview

Replace the flat "Budget" sheet (Month | Category | Limit | Currency) with per-month tabs
named Jan–Dec. Each calendar year gets its own Google Spreadsheet. The "Expenses" tab
structure is unchanged.

## Goals

- Each month = one tab (`Jan`, `Feb`, …, `Dec`) with columns: Category | Limit | Currency
- Each year = separate Google Spreadsheet
- No budget inheritance: if a month has no budget entry, there is no fallback
- New month tab is auto-created on the 1st of the month at 00:00 by cloning the previous tab
- If the user created the tab manually beforehand, auto-clone is skipped
- User can plan future months manually (via bot command or AI)

## Database Changes

### New table: `group_spreadsheets`

```sql
CREATE TABLE group_spreadsheets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL REFERENCES groups(id),
  year INTEGER NOT NULL,
  spreadsheet_id TEXT NOT NULL,
  UNIQUE(group_id, year)
);
```

### Migration (single new migration entry in schema.ts)

1. Create `group_spreadsheets`
2. Insert existing `groups.spreadsheet_id` values into `group_spreadsheets` with `year = strftime('%Y', 'now')`
3. `ALTER TABLE groups DROP COLUMN spreadsheet_id`

### `Group` type

`spreadsheet_id` field is removed from the `groups` table but **kept on the `Group` TypeScript
interface**. `GroupRepository` populates it via a LEFT JOIN with `group_spreadsheets` on the
current year. All existing code using `group.spreadsheet_id` continues to work without changes.

`UpdateGroupData.spreadsheet_id` writes to `group_spreadsheets` (insert or replace for current
year) instead of `groups`.

## New Repository: `GroupSpreadsheetRepository`

Accessed via `database.groupSpreadsheets`.

```ts
getByYear(groupId: number, year: number): string | null
setYear(groupId: number, year: number, spreadsheetId: string): void
getCurrentYear(groupId: number): string | null  // shortcut for getByYear(groupId, currentYear)
```

## Google Sheets Structure

### Budget tabs

Each monthly tab is named with a 3-letter English abbreviation:
`Jan`, `Feb`, `Mar`, `Apr`, `May`, `Jun`, `Jul`, `Aug`, `Sep`, `Oct`, `Nov`, `Dec`

Columns (row 1 = frozen header):
```
Category | Limit | Currency
```

### Expenses tab

Unchanged — still named "Expenses" with the existing column structure.

### Old "Budget" flat sheet

Renamed to `Budget_old` the first time `syncBudgetsDiff()` runs on an existing group
that still has a sheet named "Budget". Bot no longer reads or writes it.
Not deleted — user keeps the data visible for reference.

## New Functions in `sheets.ts`

```ts
// Read all budget rows from a month tab
readMonthBudget(refreshToken, spreadsheetId, month: MonthAbbr): BudgetRow[]

// Write or update a single row in a month tab
writeMonthBudgetRow(refreshToken, spreadsheetId, month: MonthAbbr, row: BudgetRow): void

// Clone a tab within the same spreadsheet (or from another spreadsheet for Jan→Dec)
cloneMonthTab(
  refreshToken,
  sourceSpreadsheetId,
  sourceMonth: MonthAbbr,
  targetSpreadsheetId,
  targetMonth: MonthAbbr,
): void

// Check if a tab with the given month name exists
monthTabExists(refreshToken, spreadsheetId, month: MonthAbbr): boolean

// Create empty month tab with headers only
createEmptyMonthTab(refreshToken, spreadsheetId, month: MonthAbbr): void
```

`type MonthAbbr = 'Jan' | 'Feb' | 'Mar' | 'Apr' | 'May' | 'Jun' | 'Jul' | 'Aug' | 'Sep' | 'Oct' | 'Nov' | 'Dec'`

Old Budget sheet functions (`createBudgetSheet`, `createEmptyBudgetSheet`, `readBudgetData`,
`writeBudgetRow`, `hasBudgetSheet`) are removed.

## Budget Sync Changes

### `budget.ts` — `syncBudgetsDiff()`

Reads from `readMonthBudget()` for the current month tab instead of `readBudgetData()`.
Writes via `writeMonthBudgetRow()`. Diff logic (add/update/delete) is unchanged.

### `BudgetRepository` — remove inheritance

- `getBudgetForMonth()`: remove fallback to `getLatestBudget()`. Returns `null` if no exact match.
- `getAllBudgetsForMonth()`: only returns budgets with exact `month` match, no fallback loop.
- `getLatestBudget()`: deleted.

## Cron: Monthly Tab Auto-Clone

Runs at `00:00` on the 1st of every month for every active group (has a spreadsheet for current year).

### Algorithm

```
for each active group:
  year = current year
  month = current month abbreviation (e.g. "Jan")

  spreadsheetId = groupSpreadsheets.getByYear(groupId, year)

  if spreadsheetId is null:
    // New year — create new spreadsheet
    spreadsheetId = createExpenseSpreadsheet(...)
    groupSpreadsheets.setYear(groupId, year, spreadsheetId)

  if monthTabExists(spreadsheetId, month):
    // User created tab manually — skip
    continue

  prevMonth = previous month abbreviation
  prevYear = year (or year-1 for January)
  prevSpreadsheetId = groupSpreadsheets.getByYear(groupId, prevYear)

  if prevSpreadsheetId exists and monthTabExists(prevSpreadsheetId, prevMonth):
    cloneMonthTab(prevSpreadsheetId, prevMonth → spreadsheetId, month)
    notify chat: "📅 Создана вкладка {month} — скопирована из {prevMonth}"
  else:
    // No previous tab to clone from (first month ever)
    createEmptyMonthTab(spreadsheetId, month)
    notify chat: "📅 Создана вкладка {month}"
```

### "Active group" definition

Group that has a `google_refresh_token` AND at least one entry in `group_spreadsheets`
(any year). Groups without any entry are ignored by the cron.

## Affected Files

| File | Change |
|------|--------|
| `src/database/schema.ts` | New migration: create table, migrate data, DROP COLUMN |
| `src/database/types.ts` | Remove `spreadsheet_id` from `groups` table type; keep on `Group` interface |
| `src/database/repositories/group.repository.ts` | LEFT JOIN with `group_spreadsheets`; `update()` writes spreadsheet_id there |
| `src/database/repositories/group-spreadsheet.repository.ts` | New repository |
| `src/database/index.ts` | Register `groupSpreadsheets` |
| `src/services/google/sheets.ts` | Add month tab functions; remove Budget flat-sheet functions |
| `src/bot/commands/budget.ts` | Use month tab functions; remove old Budget sheet calls |
| `src/database/repositories/budget.repository.ts` | Remove `getLatestBudget` and fallback |
| `src/bot/cron.ts` (new file) | Monthly auto-clone cron job |
| `src/bot/index.ts` | Register cron |
