# Part 2: Tasks 3-4: period resolution, get_expenses batch + stats

[← Back to index](../2026-04-02-batch-tools-stats.md)

### Task 3: Period Resolution Utility

Currently `resolvePeriodDates` is duplicated in `tool-executor.ts` (lines 841-866) and `bank-transactions.repository.ts` (lines 201+, named `resolvePeriod`). The version in tool-executor.ts also has a duplicate inline switch in `executeGetExpenses` (lines 115-145). Unify into one shared module in `src/utils/` (not `src/services/ai/`) to avoid inverted dependency — database layer must not import from AI service layer.

**Files:**
- Create: `src/utils/period.ts`
- Create: `src/utils/period.test.ts`

- [ ] **Step 1: Write failing tests for resolvePeriodDates**

```ts
// src/utils/period.test.ts
import { describe, expect, test } from 'bun:test';
import { normalizeArrayParam, resolvePeriodDates } from './period';

describe('resolvePeriodDates', () => {
  test('resolves specific month YYYY-MM', () => {
    const { startDate, endDate } = resolvePeriodDates('2026-02');
    expect(startDate).toBe('2026-02-01');
    expect(endDate).toBe('2026-02-28');
  });

  test('resolves leap year February', () => {
    const { startDate, endDate } = resolvePeriodDates('2024-02');
    expect(startDate).toBe('2024-02-01');
    expect(endDate).toBe('2024-02-29');
  });

  test('resolves current_month', () => {
    const { startDate, endDate } = resolvePeriodDates('current_month');
    expect(startDate).toMatch(/^\d{4}-\d{2}-01$/);
    expect(endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('resolves last_month', () => {
    const { startDate, endDate } = resolvePeriodDates('last_month');
    expect(startDate).toMatch(/^\d{4}-\d{2}-01$/);
  });

  test('resolves last_3_months', () => {
    const { startDate } = resolvePeriodDates('last_3_months');
    const now = new Date();
    // Start date should be ~2 months before current month start
    const startMonth = new Date(startDate);
    expect(now.getTime() - startMonth.getTime()).toBeGreaterThan(50 * 86400 * 1000);
  });

  test('resolves last_6_months', () => {
    const { startDate } = resolvePeriodDates('last_6_months');
    const now = new Date();
    const startMonth = new Date(startDate);
    expect(now.getTime() - startMonth.getTime()).toBeGreaterThan(140 * 86400 * 1000);
  });

  test('resolves "all" to wide range', () => {
    const { startDate, endDate } = resolvePeriodDates('all');
    expect(startDate).toBe('2000-01-01');
  });

  test('falls back to current_month for invalid input', () => {
    const { startDate } = resolvePeriodDates('garbage');
    const { startDate: currentStart } = resolvePeriodDates('current_month');
    expect(startDate).toBe(currentStart);
  });
});

describe('normalizeArrayParam', () => {
  test('wraps string in array', () => {
    expect(normalizeArrayParam('hello')).toEqual(['hello']);
  });

  test('passes array through', () => {
    expect(normalizeArrayParam(['a', 'b'])).toEqual(['a', 'b']);
  });

  test('returns default for undefined', () => {
    expect(normalizeArrayParam(undefined, 'default')).toEqual(['default']);
  });

  test('returns empty array for undefined with no default', () => {
    expect(normalizeArrayParam(undefined)).toEqual([]);
  });

  test('converts non-string array elements to strings', () => {
    expect(normalizeArrayParam([1, 2, 3])).toEqual(['1', '2', '3']);
  });

  test('falls back to default for empty array', () => {
    expect(normalizeArrayParam([], 'default')).toEqual(['default']);
  });

  test('returns empty array for empty array with no default', () => {
    expect(normalizeArrayParam([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test src/utils/period.test.ts`
Expected: FAIL — module not found

- [ ] **Step 3: Implement resolvePeriodDates and normalizeArrayParam**

```ts
// src/utils/period.ts
/**
 * Period date resolution and array param normalization for AI tools
 */
import { endOfMonth, format, startOfMonth, subMonths } from 'date-fns';

export interface DateRange {
  startDate: string;
  endDate: string;
}

/**
 * Resolve a period string to start/end dates.
 * Supports: "current_month", "last_month", "last_3_months", "last_6_months", "all", "YYYY-MM"
 */
export function resolvePeriodDates(period: string): DateRange {
  const now = new Date();

  switch (period) {
    case 'current_month':
      return {
        startDate: format(startOfMonth(now), 'yyyy-MM-dd'),
        endDate: format(endOfMonth(now), 'yyyy-MM-dd'),
      };
    case 'last_month': {
      const lastMonth = subMonths(now, 1);
      return {
        startDate: format(startOfMonth(lastMonth), 'yyyy-MM-dd'),
        endDate: format(endOfMonth(lastMonth), 'yyyy-MM-dd'),
      };
    }
    case 'last_3_months':
      return {
        startDate: format(startOfMonth(subMonths(now, 2)), 'yyyy-MM-dd'),
        endDate: format(endOfMonth(now), 'yyyy-MM-dd'),
      };
    case 'last_6_months':
      return {
        startDate: format(startOfMonth(subMonths(now, 5)), 'yyyy-MM-dd'),
        endDate: format(endOfMonth(now), 'yyyy-MM-dd'),
      };
    case 'all':
      return { startDate: '2000-01-01', endDate: format(endOfMonth(now), 'yyyy-MM-dd') };
    default:
      if (/^\d{4}-\d{2}$/.test(period)) {
        const monthDate = new Date(`${period}-01`);
        return {
          startDate: `${period}-01`,
          endDate: format(endOfMonth(monthDate), 'yyyy-MM-dd'),
        };
      }
      // Fallback to current month
      return {
        startDate: format(startOfMonth(now), 'yyyy-MM-dd'),
        endDate: format(endOfMonth(now), 'yyyy-MM-dd'),
      };
  }
}

/**
 * Normalize a tool input parameter to a string array.
 * Accepts string, string[], or undefined (with optional default).
 */
export function normalizeArrayParam(value: unknown, defaultValue?: string): string[] {
  if (Array.isArray(value) && value.length > 0) return value.map(String);
  if (typeof value === 'string') return [value];
  if (defaultValue !== undefined) return [defaultValue];
  return [];
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test src/utils/period.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/utils/period.ts src/utils/period.test.ts
git commit -m "feat: extract resolvePeriodDates and normalizeArrayParam into src/utils/period"
```

---

### Task 4: Update get_expenses — Batch Periods + Stats

The biggest change. `executeGetExpenses` now handles `period: string | string[]` and `category: string | string[]`, and appends stats to all summary_only responses. For non-summary batch, concat and add stats for full set + current page.

**Files:**
- Modify: `src/services/ai/tool-executor.ts` (lines 101-223)
- Create: `src/services/ai/tool-executor.test.ts`

- [ ] **Step 1: Write failing test for single-period summary with stats**

```ts
// src/services/ai/tool-executor.test.ts
import { describe, expect, mock, test } from 'bun:test';

const januaryExpenses = [
  { id: 1, group_id: 1, user_id: 1, date: '2026-01-05', category: 'Еда', comment: 'Хлеб', amount: 120, currency: 'RSD', eur_amount: 1.02, created_at: '' },
  { id: 2, group_id: 1, user_id: 1, date: '2026-01-10', category: 'Еда', comment: 'Молоко', amount: 250, currency: 'RSD', eur_amount: 2.13, created_at: '' },
  { id: 3, group_id: 1, user_id: 1, date: '2026-01-15', category: 'Развлечения', comment: 'Кино', amount: 1500, currency: 'RSD', eur_amount: 12.77, created_at: '' },
];

const februaryExpenses = [
  { id: 4, group_id: 1, user_id: 1, date: '2026-02-03', category: 'Еда', comment: 'Сыр', amount: 800, currency: 'RSD', eur_amount: 6.88, created_at: '' },
  { id: 5, group_id: 1, user_id: 1, date: '2026-02-14', category: 'Развлечения', comment: 'Ресторан', amount: 5000, currency: 'RSD', eur_amount: 42.5, created_at: '' },
];

// Mock database and dependencies before importing
mock.module('../../database', () => ({
  database: {
    expenses: {
      findByDateRange: (_groupId: number, start: string, _end: string) => {
        if (start.startsWith('2026-01')) return januaryExpenses;
        if (start.startsWith('2026-02')) return februaryExpenses;
        return [];
      },
    },
    groups: {
      findById: (_id: number) => ({ default_currency: 'RSD', enabled_currencies: ['RSD', 'EUR'] }),
    },
  },
}));

mock.module('../../utils/logger.ts', () => ({
  createLogger: () => ({ info: () => {}, error: () => {}, warn: () => {}, debug: () => {} }),
}));

mock.module('../../bot/commands/sync', () => ({
  ensureFreshExpenses: async () => {},
}));

mock.module('../../bot/services/budget-sync', () => ({
  ensureFreshBudgets: async () => {},
}));

import { executeTool } from './tool-executor';
import type { AgentContext } from './types';

const ctx: AgentContext = {
  groupId: 1,
  userId: 1,
  chatId: 123,
  telegramGroupId: 123,
  userName: 'test',
  userFullName: 'Test User',
  customPrompt: null,
  isForumWithoutTopic: false,
};

describe('get_expenses with stats', () => {
  test('summary_only includes stats block', async () => {
    const result = await executeTool('get_expenses', { period: '2026-01', summary_only: true }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('=== Stats ===');
    expect(result.output).toContain('count: 3');
    expect(result.output).toContain('median:');
    expect(result.output).toContain('min:');
    expect(result.output).toContain('max:');
    expect(result.output).toContain('Хлеб');
    expect(result.output).toContain('Кино');
  });

  test('empty period array falls back to current_month', async () => {
    const result = await executeTool('get_expenses', { period: [], summary_only: true }, ctx);
    expect(result.success).toBe(true);
    // normalizeArrayParam([], 'current_month') → ['current_month'] via default
    expect(result.output).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run: `bun test src/services/ai/tool-executor.test.ts`
Expected: FAIL — output doesn't contain `=== Stats ===`

- [ ] **Step 3: Refactor executeGetExpenses to use resolvePeriodDates and add stats**

Replace the inline switch (lines 115-145) with `resolvePeriodDates` from `period.ts`. After the summary output, append stats block.

In `tool-executor.ts`, update the imports:

```ts
import { normalizeArrayParam, resolvePeriodDates } from '../../utils/period';
import { computeExpenseStats, formatStats, formatStatsDiff, formatStatsTrend, type ExpenseRecord, type TrendEntry } from './stats';
```

Replace `executeGetExpenses` function body. Key changes:

1. Replace inline period switch with `resolvePeriodDates(period)`
2. Normalize `period` and `category` params via `normalizeArrayParam`
3. For single period: same logic as before + stats appended to summary
4. For multiple periods with summary_only: per-period sections + overall stats + diff/trend
5. For multiple periods without summary_only: concat, sort by date desc, paginate, stats for all + page
6. Category array: filter where `category matches any` instead of single match

The full refactored function (showing summary_only path for batch):

```ts
async function executeGetExpenses(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const periods = normalizeArrayParam(input['period'], 'current_month');
  const categories = normalizeArrayParam(input['category']);
  const pageSize = Math.min(Math.max((input['page_size'] as number) || 100, 1), 500);
  const page = Math.max((input['page'] as number) || 1, 1);
  const summaryOnly = (input['summary_only'] as boolean) || false;

  const group = database.groups.findById(ctx.groupId);
  const displayCurrency = (group?.default_currency ?? BASE_CURRENCY) as CurrencyCode;

  // Resolve all periods and fetch expenses
  const periodData: { label: string; startDate: string; endDate: string; expenses: Expense[] }[] = [];

  for (const period of periods) {
    const { startDate, endDate } = resolvePeriodDates(period);
    let expenses = database.expenses.findByDateRange(ctx.groupId, startDate, endDate);

    if (categories.length > 0) {
      const lowerCategories = categories.map((c) => c.toLowerCase());
      expenses = expenses.filter((e) => lowerCategories.includes(e.category.toLowerCase()));
    }

    periodData.push({ label: period, startDate, endDate, expenses });
  }

  const isBatch = periods.length > 1;
  const allExpenses = periodData.flatMap((p) => p.expenses);

  if (summaryOnly) {
    return buildSummaryOutput(periodData, allExpenses, displayCurrency, isBatch);
  }

  return buildDetailOutput(periodData, allExpenses, displayCurrency, isBatch, page, pageSize);
}
```

Helper functions `buildSummaryOutput` and `buildDetailOutput` handle the formatting:

```ts
function buildSummaryOutput(
  periodData: { label: string; startDate: string; endDate: string; expenses: Expense[] }[],
  allExpenses: Expense[],
  displayCurrency: CurrencyCode,
  isBatch: boolean,
): ToolResult {
  const lines: string[] = [];
  // Cache per-period stats to avoid recomputation for diff/trend
  const perPeriodStats: ExpenseStats[] = [];

  for (const pd of periodData) {
    if (isBatch) lines.push(`=== ${pd.label} ===`);
    lines.push(`Period: ${pd.startDate} to ${pd.endDate}`);

    if (pd.expenses.length === 0) {
      perPeriodStats.push({ count: 0, total: 0, avg: 0, median: 0, min: null, max: null });
      lines.push('No expenses', '');
      continue;
    }

    // Category aggregation (same as current logic)
    const totals: Record<string, { count: number; eur_total: number; amounts: Record<string, number> }> = {};
    for (const e of pd.expenses) {
      const cat = totals[e.category] ?? (totals[e.category] = { count: 0, eur_total: 0, amounts: {} });
      cat.count++;
      cat.eur_total += e.eur_amount;
      cat.amounts[e.currency] = (cat.amounts[e.currency] || 0) + e.amount;
    }

    const totalEur = Object.values(totals).reduce((s, c) => s + c.eur_total, 0);
    const totalDisplay = convertCurrency(totalEur, BASE_CURRENCY, displayCurrency);
    lines.push(`Total: ${formatAmount(totalDisplay, displayCurrency, true)}`, '');

    const sorted = Object.entries(totals).sort((a, b) => b[1].eur_total - a[1].eur_total);
    for (const [cat, data] of sorted) {
      const amountParts = Object.entries(data.amounts)
        .map(([c, a]) => formatAmount(a, c as CurrencyCode, true))
        .join(', ');
      const catDisplay = convertCurrency(data.eur_total, BASE_CURRENCY, displayCurrency);
      lines.push(`${cat}: ${formatAmount(catDisplay, displayCurrency, true)} (${data.count} ops) [${amountParts}]`);
    }

    // Per-period stats (computed once, cached for diff/trend below)
    const stats = computeExpenseStats(pd.expenses, displayCurrency);
    perPeriodStats.push(stats);
    lines.push('', `=== Stats${isBatch ? ` (${pd.label})` : ''} ===`);
    lines.push(formatStats(stats, displayCurrency));
    lines.push('');
  }

  // Overall stats for batch
  if (isBatch && allExpenses.length > 0) {
    const overallStats = computeExpenseStats(allExpenses, displayCurrency);
    const overallEur = allExpenses.reduce((s, e) => s + e.eur_amount, 0);
    const overallDisplay = convertCurrency(overallEur, BASE_CURRENCY, displayCurrency);
    lines.push('=== Overall ===');
    lines.push(`Total: ${formatAmount(overallDisplay, displayCurrency, true)}`);
    lines.push(formatStats(overallStats, displayCurrency));
    lines.push('');

    // Diff for exactly 2 periods — reuse cached stats, pass expenses for per-category diff
    if (periodData.length === 2) {
      lines.push(formatStatsDiff(
        perPeriodStats[0], perPeriodStats[1],
        periodData[0].label, periodData[1].label,
        displayCurrency,
        periodData[0].expenses, periodData[1].expenses,
      ));
    }

    // Trend for 3+ periods — reuse cached stats
    if (periodData.length >= 3) {
      const entries: TrendEntry[] = periodData.map((pd, i) => ({
        label: pd.label,
        stats: perPeriodStats[i],
      }));
      lines.push(formatStatsTrend(entries, displayCurrency));
    }
  }

  const output = lines.join('\n');
  logger.info(`[TOOL] get_expenses summary output (${allExpenses.length} expenses, ${periodData.length} periods)`);
  return { success: true, output };
}

function buildDetailOutput(
  periodData: { label: string; startDate: string; endDate: string; expenses: Expense[] }[],
  allExpenses: Expense[],
  displayCurrency: CurrencyCode,
  isBatch: boolean,
  page: number,
  pageSize: number,
): ToolResult {
  // Sort all expenses by date desc
  allExpenses.sort((a, b) => b.date.localeCompare(a.date));

  const totalPages = Math.max(1, Math.ceil(allExpenses.length / pageSize));
  const offset = (page - 1) * pageSize;
  const pageItems = allExpenses.slice(offset, offset + pageSize);

  const totalEur = allExpenses.reduce((s, e) => s + e.eur_amount, 0);
  const totalDisplay = convertCurrency(totalEur, BASE_CURRENCY, displayCurrency);

  const dateRange = isBatch
    ? `${periodData[0].startDate} to ${periodData[periodData.length - 1].endDate}`
    : `${periodData[0].startDate} to ${periodData[0].endDate}`;

  const lines = [
    `Period: ${dateRange}`,
    `Total: ${allExpenses.length} expenses | Grand total: ${formatAmount(totalDisplay, displayCurrency, true)} | Page ${page}/${totalPages}`,
    '',
  ];

  // Stats for ALL expenses (not just page)
  const allStats = computeExpenseStats(allExpenses, displayCurrency);
  lines.push('=== Stats (all) ===');
  lines.push(formatStats(allStats, displayCurrency));
  lines.push('');

  // Stats for current page
  if (totalPages > 1) {
    const pageStats = computeExpenseStats(pageItems, displayCurrency);
    lines.push(`=== Stats (page ${page}) ===`);
    lines.push(formatStats(pageStats, displayCurrency));
    lines.push('');
  }

  for (const e of pageItems) {
    lines.push(
      `[id:${e.id}] ${e.date} | ${e.category} | ${formatAmount(e.amount, e.currency, true)} (EUR ${formatAmount(e.eur_amount, BASE_CURRENCY, true)}) | ${e.comment.trim() || '(no comment)'}`,
    );
  }

  const output = lines.join('\n');
  logger.info(`[TOOL] get_expenses detail output (page ${page}/${totalPages}, ${allExpenses.length} total)`);
  return { success: true, output };
}
```

- [ ] **Step 4: Run test — verify it passes**

Run: `bun test src/services/ai/tool-executor.test.ts`
Expected: PASS

- [ ] **Step 5: Add batch period test**

Add to `tool-executor.test.ts`:

```ts
test('batch periods returns per-period stats and diff', async () => {
  const result = await executeTool(
    'get_expenses',
    { period: ['2026-01', '2026-02'], summary_only: true },
    ctx,
  );
  expect(result.success).toBe(true);
  // Per-period sections (data-aware mock returns different expenses per period)
  expect(result.output).toContain('=== 2026-01 ===');
  expect(result.output).toContain('=== 2026-02 ===');
  // Jan has 3 expenses, Feb has 2
  expect(result.output).toContain('count: 3');
  expect(result.output).toContain('count: 2');
  // Diff for exactly 2 periods
  expect(result.output).toContain('=== Diff:');
  // Overall stats across both periods
  expect(result.output).toContain('=== Overall ===');
});
```

- [ ] **Step 6: Run tests — verify all pass**

Run: `bun test src/services/ai/tool-executor.test.ts`

- [ ] **Step 7: Add multi-category filter test**

```ts
test('category array filters multiple categories', async () => {
  const result = await executeTool(
    'get_expenses',
    { period: '2026-01', category: ['Еда', 'Развлечения'], summary_only: true },
    ctx,
  );
  expect(result.success).toBe(true);
  expect(result.output).toContain('Еда');
  expect(result.output).toContain('Развлечения');
});
```

- [ ] **Step 8: Run tests**

Run: `bun test src/services/ai/tool-executor.test.ts`

- [ ] **Step 9: Remove old duplicate resolvePeriodDates from tool-executor.ts**

Delete the `resolvePeriodDates` function at lines 841-866 in `tool-executor.ts`. It's replaced by the import from `src/utils/period.ts`. Update `executeFindMissingExpenses` to use the imported version.

Note: the duplicate `resolvePeriod` in `bank-transactions.repository.ts` is removed later in Task 6 Step 4.

- [ ] **Step 10: Run full test suite**

Run: `bun run test`
Expected: all PASS

- [ ] **Step 11: Commit**

```bash
git add src/services/ai/tool-executor.ts src/services/ai/tool-executor.test.ts
git commit -m "feat(ai): batch period/category support + stats in get_expenses"
```

---

