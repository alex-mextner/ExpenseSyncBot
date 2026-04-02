# Batch Tool Parameters & Pre-calculated Statistics — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add array support to tool parameters and pre-calculated statistics (avg, median, min, max) to eliminate redundant tool calls and manual arithmetic.

**Architecture:** Extract stats computation into a pure module. Normalize all array-capable params with a shared utility. Each tool handler loops over normalized arrays and appends stats/diff/trend blocks. Schema descriptions updated for array types.

**Tech Stack:** Bun, TypeScript, bun:test

**Spec:** `docs/specs/2026-04-02-batch-tools-stats.md`

---

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
