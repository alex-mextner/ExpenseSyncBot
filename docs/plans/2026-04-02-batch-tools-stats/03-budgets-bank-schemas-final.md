# Part 3: Tasks 5-11: get_budgets, bank transactions, missing expenses, schemas, prompt, labels, final checks

[← Back to index](../2026-04-02-batch-tools-stats.md)

### Task 5: Update get_budgets — Batch Months + Categories

**Files:**
- Modify: `src/services/ai/tool-executor.ts` (executeGetBudgets, lines 225-302)
- Modify: `src/services/ai/tool-executor.test.ts`

- [ ] **Step 1: Write failing test**

Add to `tool-executor.test.ts` — need additional mock for `database.budgets`:

```ts
// Add to mock setup:
// budgets: {
//   getAllBudgetsForMonth: (groupId: number, month: string) => [
//     { id: 1, group_id: 1, category: 'Еда', month, limit_amount: 50000, currency: 'RSD' },
//     { id: 2, group_id: 1, category: 'Развлечения', month, limit_amount: 30000, currency: 'RSD' },
//   ],
// },

describe('get_budgets batch', () => {
  test('single month works as before', async () => {
    const result = await executeTool('get_budgets', { month: '2026-01' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Budgets for 2026-01');
  });

  test('multiple months shows per-month breakdown', async () => {
    const result = await executeTool('get_budgets', { month: ['2026-01', '2026-02', '2026-03'] }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('=== 2026-01 ===');
    expect(result.output).toContain('=== 2026-02 ===');
    expect(result.output).toContain('=== 2026-03 ===');
  });

  test('category array filters multiple categories', async () => {
    const result = await executeTool('get_budgets', { month: '2026-01', category: ['Еда', 'Развлечения'] }, ctx);
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

- [ ] **Step 3: Refactor executeGetBudgets**

```ts
async function executeGetBudgets(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const months = normalizeArrayParam(input['month'], format(new Date(), 'yyyy-MM'));
  const categories = normalizeArrayParam(input['category']);
  const isBatch = months.length > 1;

  const group = database.groups.findById(ctx.groupId);
  const displayCurrency = (group?.default_currency ?? BASE_CURRENCY) as CurrencyCode;

  const allLines: string[] = [];

  for (const month of months) {
    let budgets = database.budgets.getAllBudgetsForMonth(ctx.groupId, month);

    if (categories.length > 0) {
      const lowerCategories = categories.map((c) => c.toLowerCase());
      budgets = budgets.filter((b) => lowerCategories.includes(b.category.toLowerCase()));
    }

    if (budgets.length === 0) {
      if (isBatch) allLines.push(`=== ${month} ===`, `No budgets set.`, '');
      continue;
    }

    const monthStart = `${month}-01`;
    const monthEnd = format(endOfMonth(new Date(`${month}-01`)), 'yyyy-MM-dd');
    const expenses = database.expenses.findByDateRange(ctx.groupId, monthStart, monthEnd);

    const spendingByCategory: Record<string, number> = {};
    for (const e of expenses) {
      spendingByCategory[e.category] = (spendingByCategory[e.category] || 0) + e.eur_amount;
    }

    if (isBatch) allLines.push(`=== ${month} ===`);
    else allLines.push(`Budgets for ${month}:`, '');

    for (const budget of budgets) {
      const spentEur = spendingByCategory[budget.category] || 0;
      const spentInCurrency = convertCurrency(spentEur, BASE_CURRENCY, budget.currency);
      const remaining = budget.limit_amount - spentInCurrency;
      const percent = budget.limit_amount > 0
        ? Math.round((spentInCurrency / budget.limit_amount) * 100)
        : 0;
      const status = remaining < 0 ? 'EXCEEDED' : percent >= 90 ? 'WARNING' : 'OK';

      allLines.push(
        `${budget.category}: ${formatAmount(spentInCurrency, budget.currency, true)}/${formatAmount(budget.limit_amount, budget.currency, true)} (${percent}%) [${status}]`,
      );
    }
    allLines.push('');
  }

  // Grand total across all months for batch
  if (isBatch) {
    const allMonthExpenses = months.flatMap((month) => {
      const monthStart = `${month}-01`;
      const monthEnd = format(endOfMonth(new Date(`${month}-01`)), 'yyyy-MM-dd');
      return database.expenses.findByDateRange(ctx.groupId, monthStart, monthEnd);
    });

    if (allMonthExpenses.length > 0) {
      const totalEur = allMonthExpenses.reduce((s, e) => s + e.eur_amount, 0);
      const totalDisplay = convertCurrency(totalEur, BASE_CURRENCY, displayCurrency);
      allLines.push(`=== Grand Total (${months.length} months) ===`);
      allLines.push(`${formatAmount(totalDisplay, displayCurrency, true)}`);
    }
  }

  return { success: true, output: allLines.join('\n') };
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test src/services/ai/tool-executor.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tool-executor.ts src/services/ai/tool-executor.test.ts
git commit -m "feat(ai): batch month/category support in get_budgets"
```

---

### Task 6: Update get_bank_transactions — Batch period, bank_name, status

**Files:**
- Modify: `src/services/ai/tool-executor.ts` (executeGetBankTransactions, lines 641-666)
- Modify: `src/database/types.ts` (BankTransactionFilters)
- Modify: `src/database/repositories/bank-transactions.repository.ts` (findByGroupId)
- Modify: `src/services/ai/tool-executor.test.ts`

- [ ] **Step 1: Write failing test**

```ts
describe('get_bank_transactions batch', () => {
  test('multiple periods concatenates transactions', async () => {
    const result = await executeTool(
      'get_bank_transactions',
      { period: ['2026-01', '2026-02'], bank_name: 'all' },
      ctx,
    );
    expect(result.success).toBe(true);
  });

  test('multiple bank_names filters by OR', async () => {
    const result = await executeTool(
      'get_bank_transactions',
      { bank_name: ['tbc', 'kaspi'], period: 'current_month' },
      ctx,
    );
    expect(result.success).toBe(true);
  });

  test('multiple statuses filters by OR', async () => {
    const result = await executeTool(
      'get_bank_transactions',
      { status: ['pending', 'confirmed'], bank_name: 'all' },
      ctx,
    );
    expect(result.success).toBe(true);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

- [ ] **Step 3: Update BankTransactionFilters type**

In `src/database/types.ts`:

```ts
export interface BankTransactionFilters {
  period?: string | string[];
  bank_name?: string | string[];
  status?: BankTransaction['status'] | BankTransaction['status'][];
}
```

- [ ] **Step 4: Replace local `resolvePeriod` with imported `resolvePeriodDates`**

In `bank-transactions.repository.ts`, remove the local `resolvePeriod` function and import from `src/utils/period.ts`:

```ts
import { resolvePeriodDates } from '../../utils/period';
```

Delete the local `resolvePeriod(period: string)` function (it duplicates the logic now in `src/utils/period.ts`).

- [ ] **Step 5: Update bank-transactions.repository.ts findByGroupId**

Update the filter logic to handle arrays, using `resolvePeriodDates`:

```ts
if (filters.bank_name) {
  if (Array.isArray(filters.bank_name)) {
    const placeholders = filters.bank_name.map(() => '?').join(', ');
    conditions.push(`bc.bank_name IN (${placeholders})`);
    values.push(...filters.bank_name);
  } else {
    conditions.push('bc.bank_name = ?');
    values.push(filters.bank_name);
  }
}

if (filters.status) {
  if (Array.isArray(filters.status)) {
    const placeholders = filters.status.map(() => '?').join(', ');
    conditions.push(`bt.status IN (${placeholders})`);
    values.push(...filters.status);
  } else {
    conditions.push('bt.status = ?');
    values.push(filters.status);
  }
}

if (filters.period) {
  const periods = Array.isArray(filters.period) ? filters.period : [filters.period];
  if (periods.length === 1) {
    const { startDate, endDate } = resolvePeriodDates(periods[0]);
    conditions.push('bt.date >= ?', 'bt.date <= ?');
    values.push(startDate, endDate);
  } else {
    // Multiple periods: OR of date ranges
    const dateConditions = periods.map((p) => {
      const { startDate, endDate } = resolvePeriodDates(p);
      values.push(startDate, endDate);
      return '(bt.date >= ? AND bt.date <= ?)';
    });
    conditions.push(`(${dateConditions.join(' OR ')})`);
  }
}
```

- [ ] **Step 6: Update executeGetBankTransactions in tool-executor.ts**

Uses `normalizeArrayParam` from `../../utils/period` (already imported in Task 4).

```ts
function executeGetBankTransactions(input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  const filters: BankTransactionFilters = {};

  const periods = normalizeArrayParam(input['period']);
  if (periods.length > 0) filters.period = periods.length === 1 ? periods[0] : periods;

  const bankNames = normalizeArrayParam(input['bank_name']);
  const nonAllBanks = bankNames.filter((b) => b.toLowerCase() !== 'all');
  if (nonAllBanks.length > 0) filters.bank_name = nonAllBanks.length === 1 ? nonAllBanks[0] : nonAllBanks;

  const statuses = normalizeArrayParam(input['status']);
  if (statuses.length === 1) filters.status = statuses[0] as BankTransaction['status'];
  else if (statuses.length > 1) filters.status = statuses as BankTransaction['status'][];

  const transactions = database.bankTransactions.findByGroupId(ctx.groupId, filters);

  return {
    success: true,
    data: transactions.map((tx) => ({
      id: tx.id,
      date: tx.date,
      amount: tx.amount,
      currency: tx.currency,
      merchant: tx.merchant_normalized ?? tx.merchant,
      category_suggestion: null,
      status: tx.status,
      sign_type: tx.sign_type,
    })),
  };
}
```

- [ ] **Step 7: Run tests — verify they pass**

Run: `bun run test`

- [ ] **Step 8: Commit**

```bash
git add src/services/ai/tool-executor.ts src/database/types.ts src/database/repositories/bank-transactions.repository.ts src/services/ai/tool-executor.test.ts
git commit -m "feat(ai): batch period/bank_name/status in get_bank_transactions"
```

---

### Task 7: Update find_missing_expenses — Batch Periods

**Files:**
- Modify: `src/services/ai/tool-executor.ts` (executeFindMissingExpenses, lines 729-778)
- Modify: `src/services/ai/tool-executor.test.ts`

- [ ] **Step 1: Write failing test**

```ts
describe('find_missing_expenses batch', () => {
  test('multiple periods finds missing across all', async () => {
    const result = await executeTool(
      'find_missing_expenses',
      { period: ['2026-01', '2026-02'] },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.summary).toContain('2026-01');
    // Should include data from both periods
  });
});
```

- [ ] **Step 2: Implement batch support in executeFindMissingExpenses**

```ts
async function executeFindMissingExpenses(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const periods = normalizeArrayParam(input['period'], 'current_month');
  const isBatch = periods.length > 1;

  const allMissing: Array<{
    tx_id: number; date: string; amount: number; currency: string;
    merchant: string; status: string; probable_expense_id: number | null;
  }> = [];
  const summaryParts: string[] = [];

  // Uses resolvePeriodDates from '../../utils/period' + normalizeArrayParam (already imported in Task 4)
  for (const period of periods) {
    const { startDate, endDate } = resolvePeriodDates(period);
    const unmatched = database.bankTransactions.findUnmatched(ctx.groupId, startDate, endDate);
    const expenses = database.expenses.findByDateRange(ctx.groupId, startDate, endDate);

    const results = unmatched.map((tx) => {
      const exactMatch = expenses.find(
        (e) =>
          Math.abs(e.amount - tx.amount) < 0.01 &&
          e.currency === tx.currency &&
          Math.abs(new Date(e.date).getTime() - new Date(tx.date).getTime()) <= 2 * 86400 * 1000,
      );
      if (exactMatch) return null;

      const probableMatch = expenses.find(
        (e) =>
          Math.abs(e.amount - tx.amount) < 0.01 &&
          e.currency === tx.currency &&
          Math.abs(new Date(e.date).getTime() - new Date(tx.date).getTime()) <= 5 * 86400 * 1000,
      );

      return {
        tx_id: tx.id,
        date: tx.date,
        amount: tx.amount,
        currency: tx.currency,
        merchant: tx.merchant_normalized ?? tx.merchant,
        status: probableMatch ? 'probable_match' : 'missing',
        probable_expense_id: probableMatch?.id ?? null,
      };
    });

    const missing = results.filter(Boolean);
    allMissing.push(...(missing as typeof allMissing));

    const label = isBatch ? `${period} (${startDate}–${endDate})` : `${startDate}–${endDate}`;
    summaryParts.push(
      `${label}: ${missing.length} ${pluralize(missing.length, 'транзакция', 'транзакции', 'транзакций')}`,
    );
  }

  return {
    success: true,
    data: allMissing,
    summary: isBatch
      ? `${allMissing.length} ${pluralize(allMissing.length, 'транзакция', 'транзакции', 'транзакций')} без записи:\n${summaryParts.join('\n')}`
      : summaryParts[0],
  };
}
```

- [ ] **Step 3: Run tests — verify they pass**

Run: `bun run test`

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/tool-executor.ts src/services/ai/tool-executor.test.ts
git commit -m "feat(ai): batch period support in find_missing_expenses"
```

---

### Task 8: Update Tool Schemas

Update `tools.ts` to document array support in parameter descriptions.

**Files:**
- Modify: `src/services/ai/tools.ts`

JSON Schema note: Anthropic tool schemas support `oneOf` for union types (verified in hypercalendarbot `get_timezone_info` tool). Use this pattern for all array-capable params:

```ts
// Pattern for string | string[] params:
paramName: {
  oneOf: [
    { type: 'string', description: 'Single value' },
    { type: 'array', items: { type: 'string' }, description: 'Array of values' },
  ],
  description: 'Overall description',
},
```

- [ ] **Step 1: Update get_expenses schema**

```ts
period: {
  oneOf: [
    { type: 'string', description: 'Single period' },
    { type: 'array', items: { type: 'string' }, description: 'Array of periods for multi-period breakdown' },
  ],
  description:
    'Time period: "current_month", "last_month", "last_3_months", "last_6_months", "all", or specific "YYYY-MM". Pass an ARRAY of periods to get per-period breakdown with stats, diff (2 periods), or trend (3+). Example: ["2025-11", "2025-12", "2026-01"]',
},
category: {
  oneOf: [
    { type: 'string', description: 'Single category' },
    { type: 'array', items: { type: 'string' }, description: 'Array of categories (OR match)' },
  ],
  description: 'Filter by category name(s). Pass an array to filter by multiple categories (OR match). Case-insensitive.',
},
```

Update `summary_only` description:

```ts
summary_only: {
  type: 'boolean',
  description:
    'If true, return pre-calculated totals by category with stats (count, total, avg, median, min, max). For multi-period arrays, includes per-period breakdown + diff/trend. ALWAYS prefer this for aggregation questions.',
},
```

- [ ] **Step 2: Update get_budgets schema**

```ts
month: {
  oneOf: [
    { type: 'string', description: 'Single month' },
    { type: 'array', items: { type: 'string' }, description: 'Array of months for multi-month comparison' },
  ],
  description: 'Month in "YYYY-MM" format. Pass an array for multi-month comparison. Default: current month.',
},
category: {
  oneOf: [
    { type: 'string', description: 'Single category' },
    { type: 'array', items: { type: 'string' }, description: 'Array of categories (OR filter)' },
  ],
  description: 'Filter by specific category or categories (array for multi-category filter).',
},
```

- [ ] **Step 3: Update get_bank_transactions schema**

```ts
period: {
  oneOf: [
    { type: 'string', description: 'Single period' },
    { type: 'array', items: { type: 'string' }, description: 'Array of periods' },
  ],
  description: '"current_month" | "last_month" | "YYYY-MM". Pass an array for multiple periods.',
},
bank_name: {
  oneOf: [
    { type: 'string', description: 'Single bank' },
    { type: 'array', items: { type: 'string' }, description: 'Array of bank names' },
  ],
  description: 'Bank name(s): "all" for all banks, or bank registry key(s). Pass an array for multiple banks.',
},
status: {
  oneOf: [
    { type: 'string', description: 'Single status' },
    { type: 'array', items: { type: 'string' }, description: 'Array of statuses' },
  ],
  description: '"pending" | "confirmed" | "skipped". Pass an array for multiple statuses. Omit for all.',
},
```

- [ ] **Step 4: Update find_missing_expenses schema**

```ts
period: {
  oneOf: [
    { type: 'string', description: 'Single period' },
    { type: 'array', items: { type: 'string' }, description: 'Array of periods' },
  ],
  description: '"current_month" | "last_month" | "YYYY-MM". Pass an array for multi-period search.',
},
```

- [ ] **Step 5: Run type check**

Run: `bun run type-check`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/tools.ts
git commit -m "feat(ai): update tool schemas for array parameter support"
```

---

### Task 9: Update System Prompt & Response Validator

**Files:**
- Modify: `src/services/ai/agent.ts` (lines 448-461)
- Modify: `src/services/ai/response-validator.ts` (line 23)

- [ ] **Step 1: Update system prompt rules in agent.ts**

Replace rule 6 (line 454):

```ts
`6. For ANY aggregation question (total for a period, breakdown by category, "what did X spend", "how much in total", "по итогам", "сводка по месяцам") → ALWAYS use summary_only: true in get_expenses. The tool returns pre-calculated totals per category WITH stats (count, total, avg, median, min, max). For multi-period comparison, pass an array of periods — e.g. period: ["2025-11", "2025-12", "2026-01"]. NEVER call get_expenses multiple times for different periods — use a single call with an array. Same for get_budgets: pass month as array for multi-month comparison.`
```

Update rule 7 (line 455):

```ts
`7. ANY arithmetic whatsoever → ALWAYS call calculate. EXCEPTION: stats already computed by get_expenses (count, total, avg, median, min, max) do NOT need recalculation — use them directly from the tool response. The calculate tool uses live exchange rates for currency conversion.`
```

Add new rule after rule 7:

```ts
`7a. When referring to "average" or "typical" spending → use MEDIAN from the stats, not avg. Median better represents the typical expense because it's not skewed by outliers. Avg is available for context but median should be the default "average" in your replies.`
```

- [ ] **Step 2: Update response validator**

In `response-validator.ts`, update rule 5:

```ts
`5. **Math done manually** — sums, conversions, or arithmetic not performed by the calculate tool (small counts like "3 operations" are OK; pre-calculated stats from tool responses like total/avg/median/min/max are OK — they don't need recalculation).`
```

- [ ] **Step 3: Run tests**

Run: `bun run test`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/agent.ts src/services/ai/response-validator.ts
git commit -m "feat(ai): update system prompt for batch params, median preference, stats exceptions"
```

---

### Task 10: Update TOOL_LABELS for Batch Display

Currently the tool indicator shows a generic label. For batch calls, show which values were requested.

**Files:**
- Modify: `src/services/ai/tools.ts` (TOOL_LABELS constant)
- Modify: `src/services/ai/telegram-stream.ts` (tool indicator rendering)

- [ ] **Step 1: Find where TOOL_LABELS are used for indicators**

`TOOL_LABELS` is defined in `src/services/ai/tools.ts` (line ~396). The rendering happens in `src/services/ai/telegram-stream.ts` (line ~189) where `this.toolLabel` is set to `<i>${labelText}...</i>`.

- [ ] **Step 2: Update indicator to show batch params**

The indicator already shows details like `period: all, сводка` (visible in the screenshot). Ensure array params render nicely:

```ts
// When building the tool call indicator label:
// For array params, join with ", "
// e.g. "Загружаю расходы: 2025-11, 2025-12, 2026-01, сводка"
```

In `telegram-stream.ts`, update the detail formatting to handle arrays — when an input param is an array, join with `", "` for display.

- [ ] **Step 3: Run full test suite**

Run: `bun run test`
Expected: all PASS

- [ ] **Step 4: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/telegram-stream.ts
git commit -m "feat(ai): batch-aware tool indicator labels"
```

---

### Task 11: Final Integration — Type Check, Lint, Full Tests

- [ ] **Step 1: Run type check**

Run: `bun run type-check`
Fix any errors.

- [ ] **Step 2: Run lint**

Run: `bun run lint:fix`
Fix any warnings.

- [ ] **Step 3: Run full test suite**

Run: `bun run test`
All must pass.

- [ ] **Step 4: Run knip**

Run: `bunx knip`
Remove unused exports if any.

- [ ] **Step 5: Final commit if needed**

```bash
git commit -m "chore: fix lint and type errors from batch tools feature"
```
