# Part 1: File Structure; Tasks 1-2: stats module and formatting

[← Back to index](../2026-04-02-batch-tools-stats.md)

## File Structure

| File | Responsibility |
|------|---------------|
| `src/services/ai/stats.ts` (create) | Pure functions: `computeExpenseStats`, `formatStats`, `formatStatsDiff`, `formatStatsTrend` |
| `src/services/ai/stats.test.ts` (create) | Unit tests for stats module |
| `src/utils/period.ts` (create) | Unified `resolvePeriodDates(period)` extracted from tool-executor.ts |
| `src/utils/period.test.ts` (create) | Tests for period resolution |
| `src/services/ai/tool-executor.ts` (modify) | Update handlers: `executeGetExpenses`, `executeGetBudgets`, `executeGetBankTransactions`, `executeFindMissingExpenses` |
| `src/services/ai/tool-executor.test.ts` (create) | Integration tests for batch tool behavior |
| `src/services/ai/tools.ts` (modify) | Update schema descriptions for array-capable params |
| `src/services/ai/agent.ts` (modify) | Update system prompt rules 6, 7; add median guidance |
| `src/services/ai/response-validator.ts` (modify) | Allow pre-calculated stats without calculator |
| `src/database/types.ts` (modify) | Extend `BankTransactionFilters` for array filters |
| `src/database/repositories/bank-transactions.repository.ts` (modify) | Replace local `resolvePeriod` with import from `src/utils/period.ts`; handle array filters |
| `src/services/ai/telegram-stream.ts` (modify) | Update tool indicator rendering for array params |

---

### Task 1: Stats Module — Types & computeExpenseStats

**Files:**
- Create: `src/services/ai/stats.ts`
- Test: `src/services/ai/stats.test.ts`

- [ ] **Step 1: Write failing tests for computeExpenseStats**

```ts
// src/services/ai/stats.test.ts
import { describe, expect, mock, test } from 'bun:test';

// Mock convertCurrency — use simple 1:100 EUR→RSD rate for predictable tests
mock.module('../currency/converter', () => ({
  convertCurrency: (amount: number, _from: string, to: string) => {
    if (to === 'RSD') return amount * 100; // 1 EUR = 100 RSD (test rate)
    if (to === 'EUR') return amount / 100;
    return amount;
  },
  formatAmount: (amount: number, currency: string) => `${Math.round(amount)} ${currency}`,
}));

import { computeExpenseStats, formatStats, formatStatsDiff, formatStatsTrend } from './stats';

describe('computeExpenseStats', () => {
  test('returns zeroed stats for empty array', () => {
    const stats = computeExpenseStats([], 'RSD');
    expect(stats.count).toBe(0);
    expect(stats.total).toBe(0);
    expect(stats.avg).toBe(0);
    expect(stats.median).toBe(0);
    expect(stats.min).toBeNull();
    expect(stats.max).toBeNull();
  });

  test('computes correct stats for single expense', () => {
    const expenses = [
      { amount: 1000, currency: 'RSD' as const, eur_amount: 8.5, category: 'Еда', comment: 'Хлеб', date: '2026-01-15' },
    ];
    const stats = computeExpenseStats(expenses, 'RSD');
    expect(stats.count).toBe(1);
    // 8.5 EUR * 100 = 850 RSD (via mock rate)
    expect(stats.total).toBeCloseTo(850, 0);
    expect(stats.avg).toBeCloseTo(850, 0);
    expect(stats.median).toBeCloseTo(850, 0);
    expect(stats.min?.comment).toBe('Хлеб');
    expect(stats.max?.comment).toBe('Хлеб');
  });

  test('computes median for even number of items', () => {
    const expenses = [
      { amount: 100, currency: 'RSD' as const, eur_amount: 1, category: 'A', comment: 'a', date: '2026-01-01' },
      { amount: 200, currency: 'RSD' as const, eur_amount: 2, category: 'B', comment: 'b', date: '2026-01-02' },
      { amount: 300, currency: 'RSD' as const, eur_amount: 3, category: 'C', comment: 'c', date: '2026-01-03' },
      { amount: 400, currency: 'RSD' as const, eur_amount: 4, category: 'D', comment: 'd', date: '2026-01-04' },
    ];
    const stats = computeExpenseStats(expenses, 'RSD');
    expect(stats.count).toBe(4);
    // converted amounts: 100, 200, 300, 400 (EUR * 100)
    // median of [100, 200, 300, 400] = (200+300)/2 = 250
    expect(stats.median).toBeCloseTo(250, 0);
    expect(stats.min?.amount).toBeCloseTo(100, 0);
    expect(stats.max?.amount).toBeCloseTo(400, 0);
  });

  test('computes median for odd number of items', () => {
    const expenses = [
      { amount: 100, currency: 'RSD' as const, eur_amount: 1, category: 'A', comment: 'a', date: '2026-01-01' },
      { amount: 300, currency: 'RSD' as const, eur_amount: 3, category: 'B', comment: 'b', date: '2026-01-02' },
      { amount: 500, currency: 'RSD' as const, eur_amount: 5, category: 'C', comment: 'c', date: '2026-01-03' },
    ];
    const stats = computeExpenseStats(expenses, 'RSD');
    // converted: 100, 300, 500 → median = 300
    expect(stats.median).toBeCloseTo(300, 0);
  });

  test('min/max reference correct expense', () => {
    const expenses = [
      { amount: 5000, currency: 'RSD' as const, eur_amount: 42.5, category: 'Развлечения', comment: 'Кино', date: '2026-01-10' },
      { amount: 120, currency: 'RSD' as const, eur_amount: 1.02, category: 'Еда', comment: 'Хлеб', date: '2026-01-05' },
      { amount: 45000, currency: 'RSD' as const, eur_amount: 382.5, category: 'Ресторан', comment: 'НГ ужин', date: '2025-12-31' },
    ];
    const stats = computeExpenseStats(expenses, 'RSD');
    expect(stats.min?.comment).toBe('Хлеб');
    expect(stats.min?.category).toBe('Еда');
    expect(stats.min?.date).toBe('2026-01-05');
    expect(stats.max?.comment).toBe('НГ ужин');
    expect(stats.max?.category).toBe('Ресторан');
  });

  test('handles multi-currency by converting via eur_amount', () => {
    // Mock rate: 1 EUR = 100 RSD
    // 100 EUR → eur_amount=100 → 100*100 = 10000 RSD
    // 1000 RSD → eur_amount=8.5 → 8.5*100 = 850 RSD
    const expenses = [
      { amount: 100, currency: 'EUR' as const, eur_amount: 100, category: 'A', comment: 'euros', date: '2026-01-01' },
      { amount: 1000, currency: 'RSD' as const, eur_amount: 8.5, category: 'B', comment: 'dinars', date: '2026-01-02' },
    ];
    const stats = computeExpenseStats(expenses, 'RSD');
    expect(stats.count).toBe(2);
    // max should be the EUR expense (10000 RSD via mock)
    expect(stats.max?.comment).toBe('euros');
    expect(stats.max?.amount).toBeCloseTo(10000, 0);
    // min should be the RSD expense (850 RSD via mock)
    expect(stats.min?.comment).toBe('dinars');
    expect(stats.min?.amount).toBeCloseTo(850, 0);
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test src/services/ai/stats.test.ts`
Expected: FAIL — module `./stats` not found

- [ ] **Step 3: Implement computeExpenseStats**

```ts
// src/services/ai/stats.ts
/**
 * Pre-calculated statistics for expense data — avg, median, min, max
 */
import type { CurrencyCode } from '../../config/constants';
import { BASE_CURRENCY } from '../../config/constants';
import type { Expense } from '../../database/types';
import { convertCurrency } from '../currency/converter';

export type ExpenseRecord = Pick<Expense, 'amount' | 'currency' | 'eur_amount' | 'category' | 'comment' | 'date'>;

export interface ExpenseStats {
  count: number;
  total: number;
  avg: number;
  median: number;
  min: { amount: number; comment: string; category: string; date: string } | null;
  max: { amount: number; comment: string; category: string; date: string } | null;
}

export function computeExpenseStats(
  expenses: ExpenseRecord[],
  displayCurrency: CurrencyCode,
): ExpenseStats {
  if (expenses.length === 0) {
    return { count: 0, total: 0, avg: 0, median: 0, min: null, max: null };
  }

  const converted = expenses.map((e) => ({
    displayAmount: convertCurrency(e.eur_amount, BASE_CURRENCY, displayCurrency),
    comment: e.comment,
    category: e.category,
    date: e.date,
  }));

  const amounts = converted.map((e) => e.displayAmount);
  const total = amounts.reduce((s, a) => s + a, 0);
  const count = amounts.length;
  const avg = total / count;

  const sorted = [...amounts].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0
    ? (sorted[mid - 1] + sorted[mid]) / 2
    : sorted[mid];

  let minItem = converted[0];
  let maxItem = converted[0];
  for (const e of converted) {
    if (e.displayAmount < minItem.displayAmount) minItem = e;
    if (e.displayAmount > maxItem.displayAmount) maxItem = e;
  }

  return {
    count,
    total,
    avg,
    median,
    min: { amount: minItem.displayAmount, comment: minItem.comment, category: minItem.category, date: minItem.date },
    max: { amount: maxItem.displayAmount, comment: maxItem.comment, category: maxItem.category, date: maxItem.date },
  };
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test src/services/ai/stats.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/stats.ts src/services/ai/stats.test.ts
git commit -m "feat(ai): add computeExpenseStats — avg, median, min, max"
```

---

### Task 2: Stats Formatting — formatStats, formatStatsDiff, formatStatsTrend

**Files:**
- Modify: `src/services/ai/stats.ts`
- Modify: `src/services/ai/stats.test.ts`

- [ ] **Step 1: Write failing tests for formatStats**

Add to `stats.test.ts`:

```ts
describe('formatStats', () => {
  test('formats stats with all fields', () => {
    const stats: ExpenseStats = {
      count: 87,
      total: 275304,
      avg: 3164.41,
      median: 1850,
      min: { amount: 120, comment: 'Хлеб', category: 'Еда', date: '2026-01-15' },
      max: { amount: 45000, comment: 'Ресторан НГ', category: 'Развлечения', date: '2025-12-31' },
    };
    const result = formatStats(stats, 'RSD');
    expect(result).toContain('count: 87');
    expect(result).toContain('median:');
    expect(result).toContain('Хлеб');
    expect(result).toContain('Ресторан НГ');
    expect(result).toContain('Еда');
    expect(result).toContain('Развлечения');
  });

  test('returns "No expenses" for empty stats', () => {
    const stats = computeExpenseStats([], 'RSD');
    expect(formatStats(stats, 'RSD')).toBe('No expenses');
  });
});

describe('formatStatsDiff', () => {
  test('shows delta and percentage between two stats', () => {
    const a: ExpenseStats = {
      count: 50, total: 300000, avg: 6000, median: 4000,
      min: { amount: 100, comment: 'a', category: 'A', date: '2026-01-01' },
      max: { amount: 50000, comment: 'b', category: 'B', date: '2026-01-15' },
    };
    const b: ExpenseStats = {
      count: 62, total: 438000, avg: 7065, median: 4800,
      min: { amount: 80, comment: 'c', category: 'C', date: '2026-02-01' },
      max: { amount: 60000, comment: 'd', category: 'D', date: '2026-02-20' },
    };
    const expA = [
      { amount: 200000, currency: 'RSD' as const, eur_amount: 2000, category: 'Еда', comment: '', date: '2026-01-01' },
      { amount: 100000, currency: 'RSD' as const, eur_amount: 1000, category: 'Жилье', comment: '', date: '2026-01-01' },
    ];
    const expB = [
      { amount: 245000, currency: 'RSD' as const, eur_amount: 2450, category: 'Еда', comment: '', date: '2026-02-01' },
      { amount: 18000, currency: 'RSD' as const, eur_amount: 180, category: 'Жилье', comment: '', date: '2026-02-01' },
    ];
    const result = formatStatsDiff(a, b, '2026-01', '2026-02', 'RSD', expA, expB);
    expect(result).toContain('+46.0%'); // (438000-300000)/300000 = 46%
    expect(result).toContain('2026-01');
    expect(result).toContain('2026-02');
    // Per-category biggest growth/drop (from spec)
    expect(result).toContain('Biggest growth');
    expect(result).toContain('Еда');
    expect(result).toContain('Biggest drop');
    expect(result).toContain('Жилье');
  });

  test('handles zero-base stats gracefully', () => {
    const a: ExpenseStats = {
      count: 0, total: 0, avg: 0, median: 0, min: null, max: null,
    };
    const b: ExpenseStats = {
      count: 5, total: 10000, avg: 2000, median: 1500,
      min: { amount: 500, comment: 'x', category: 'X', date: '2026-02-01' },
      max: { amount: 5000, comment: 'y', category: 'Y', date: '2026-02-15' },
    };
    const result = formatStatsDiff(a, b, '2026-01', '2026-02', 'RSD');
    // Should not crash or show NaN/Infinity
    expect(result).not.toContain('NaN');
    expect(result).not.toContain('Infinity');
  });

  test('omits per-category diff when no expenses provided', () => {
    const a: ExpenseStats = { count: 10, total: 5000, avg: 500, median: 400, min: null, max: null };
    const b: ExpenseStats = { count: 15, total: 8000, avg: 533, median: 450, min: null, max: null };
    const result = formatStatsDiff(a, b, '2026-01', '2026-02', 'RSD');
    expect(result).not.toContain('Biggest');
  });
});

describe('formatStatsTrend', () => {
  test('ranks periods by total descending', () => {
    const entries = [
      { label: '2025-11', stats: { count: 45, total: 698578, avg: 0, median: 0, min: null, max: null } },
      { label: '2025-12', stats: { count: 30, total: 317719, avg: 0, median: 0, min: null, max: null } },
      { label: '2026-01', stats: { count: 35, total: 331128, avg: 0, median: 0, min: null, max: null } },
    ];
    const result = formatStatsTrend(entries, 'RSD');
    expect(result).toContain('2025-11'); // highest total, should be first
    // Ranking should show max and min markers
    expect(result).toContain('max');
    expect(result).toContain('min');
  });

  test('handles single entry without max/min markers', () => {
    const entries = [
      { label: '2026-01', stats: { count: 10, total: 50000, avg: 5000, median: 4000, min: null, max: null } },
    ];
    const result = formatStatsTrend(entries, 'RSD');
    expect(result).toContain('2026-01');
    expect(result).not.toContain('max');
    expect(result).not.toContain('min');
  });

  test('handles entries with equal totals', () => {
    const entries = [
      { label: '2026-01', stats: { count: 10, total: 50000, avg: 5000, median: 4000, min: null, max: null } },
      { label: '2026-02', stats: { count: 12, total: 50000, avg: 4167, median: 3800, min: null, max: null } },
    ];
    const result = formatStatsTrend(entries, 'RSD');
    // Equal totals → no max/min distinction
    expect(result).not.toContain('max');
    expect(result).not.toContain('min');
  });

  test('handles entries with zero totals', () => {
    const entries = [
      { label: '2026-01', stats: { count: 0, total: 0, avg: 0, median: 0, min: null, max: null } },
      { label: '2026-02', stats: { count: 0, total: 0, avg: 0, median: 0, min: null, max: null } },
      { label: '2026-03', stats: { count: 0, total: 0, avg: 0, median: 0, min: null, max: null } },
    ];
    const result = formatStatsTrend(entries, 'RSD');
    expect(result).not.toContain('NaN');
    expect(result).not.toContain('Infinity');
  });
});
```

- [ ] **Step 2: Run tests — verify they fail**

Run: `bun test src/services/ai/stats.test.ts`
Expected: FAIL — `formatStats`, `formatStatsDiff`, `formatStatsTrend` not exported

- [ ] **Step 3: Implement formatStats, formatStatsDiff, formatStatsTrend**

Add to `src/services/ai/stats.ts`:

```ts
import { formatAmount } from '../currency/converter';

export function formatStats(stats: ExpenseStats, currency: CurrencyCode): string {
  if (stats.count === 0) return 'No expenses';

  const lines = [
    `count: ${stats.count}`,
    `total: ${formatAmount(stats.total, currency, true)}`,
    `avg: ${formatAmount(stats.avg, currency, true)}`,
    `median: ${formatAmount(stats.median, currency, true)}`,
  ];

  if (stats.min) {
    const comment = stats.min.comment.trim() || '(no comment)';
    lines.push(
      `min: ${formatAmount(stats.min.amount, currency, true)} — "${comment}" (${stats.min.category}, ${stats.min.date})`,
    );
  }
  if (stats.max) {
    const comment = stats.max.comment.trim() || '(no comment)';
    lines.push(
      `max: ${formatAmount(stats.max.amount, currency, true)} — "${comment}" (${stats.max.category}, ${stats.max.date})`,
    );
  }

  return lines.join('\n');
}

function formatDelta(current: number, previous: number, currency: CurrencyCode): string {
  const delta = current - previous;
  const sign = delta >= 0 ? '+' : '';
  const formatted = `${sign}${formatAmount(delta, currency, true)}`;

  if (previous === 0) {
    return delta === 0 ? '0' : `${formatted} (new)`;
  }
  const pct = ((delta / previous) * 100).toFixed(1);
  return `${formatted} (${sign}${pct}%)`;
}

function formatCountDelta(current: number, previous: number): string {
  const delta = current - previous;
  const sign = delta >= 0 ? '+' : '';
  if (previous === 0) {
    return delta === 0 ? '0' : `${sign}${delta} (new)`;
  }
  const pct = ((delta / previous) * 100).toFixed(1);
  return `${sign}${delta} (${sign}${pct}%)`;
}

/**
 * Aggregate expenses by category in display currency.
 * Returns Record<category, totalInDisplayCurrency>.
 */
function aggregateByCategory(
  expenses: ExpenseRecord[],
  displayCurrency: CurrencyCode,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const e of expenses) {
    const displayAmount = convertCurrency(e.eur_amount, BASE_CURRENCY, displayCurrency);
    result[e.category] = (result[e.category] || 0) + displayAmount;
  }
  return result;
}

export function formatStatsDiff(
  a: ExpenseStats,
  b: ExpenseStats,
  labelA: string,
  labelB: string,
  currency: CurrencyCode,
  expensesA?: ExpenseRecord[],
  expensesB?: ExpenseRecord[],
): string {
  const lines = [
    `=== Diff: ${labelA} → ${labelB} ===`,
    `total: ${formatDelta(b.total, a.total, currency)}`,
    `count: ${formatCountDelta(b.count, a.count)}`,
    `median: ${formatDelta(b.median, a.median, currency)}`,
    `avg: ${formatDelta(b.avg, a.avg, currency)}`,
  ];

  // Per-category biggest growth/drop (requires raw expenses)
  if (expensesA && expensesB && expensesA.length > 0 && expensesB.length > 0) {
    const catA = aggregateByCategory(expensesA, currency);
    const catB = aggregateByCategory(expensesB, currency);
    const allCategories = new Set([...Object.keys(catA), ...Object.keys(catB)]);

    let biggestGrowth = { category: '', delta: 0 };
    let biggestDrop = { category: '', delta: 0 };

    for (const cat of allCategories) {
      const delta = (catB[cat] || 0) - (catA[cat] || 0);
      if (delta > biggestGrowth.delta) biggestGrowth = { category: cat, delta };
      if (delta < biggestDrop.delta) biggestDrop = { category: cat, delta };
    }

    if (biggestGrowth.delta > 0) {
      lines.push(`Biggest growth: ${biggestGrowth.category} +${formatAmount(biggestGrowth.delta, currency, true)}`);
    }
    if (biggestDrop.delta < 0) {
      lines.push(`Biggest drop: ${biggestDrop.category} −${formatAmount(Math.abs(biggestDrop.delta), currency, true)}`);
    }
  }

  return lines.join('\n');
}

export interface TrendEntry {
  label: string;
  stats: ExpenseStats;
}

export function formatStatsTrend(entries: TrendEntry[], currency: CurrencyCode): string {
  const sorted = [...entries].sort((a, b) => b.stats.total - a.stats.total);
  const maxTotal = sorted[0]?.stats.total ?? 0;
  const minTotal = sorted[sorted.length - 1]?.stats.total ?? 0;

  const lines = ['=== Trend (sorted by total desc) ==='];
  for (let i = 0; i < sorted.length; i++) {
    const e = sorted[i];
    let marker = '';
    if (e.stats.total === maxTotal && maxTotal !== minTotal) marker = ' (max)';
    else if (e.stats.total === minTotal && maxTotal !== minTotal) marker = ' (min)';
    lines.push(`${i + 1}. ${e.label}: ${formatAmount(e.stats.total, currency, true)}${marker}`);
  }

  if (sorted.length >= 2) {
    const range = maxTotal - minTotal;
    lines.push(`Range: ${formatAmount(range, currency, true)}`);
  }

  return lines.join('\n');
}
```

- [ ] **Step 4: Run tests — verify they pass**

Run: `bun test src/services/ai/stats.test.ts`
Expected: all PASS

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/stats.ts src/services/ai/stats.test.ts
git commit -m "feat(ai): add formatStats, formatStatsDiff, formatStatsTrend"
```

---

