/** Pre-calculated statistics for expense data — avg, median, min, max, and trend/diff formatters */
import type { CurrencyCode } from '../../config/constants';
import { BASE_CURRENCY } from '../../config/constants';
import type { Expense } from '../../database/types';
import { convertCurrency, formatAmount } from '../currency/converter';

type ExpenseRecord = Pick<
  Expense,
  'amount' | 'currency' | 'eur_amount' | 'category' | 'comment' | 'date'
>;

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
  let median: number;
  if (sorted.length % 2 === 0) {
    median = ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
  } else {
    median = sorted[mid] ?? 0;
  }

  // Non-null assertion safe here: we checked expenses.length > 0 at the top
  // biome-ignore lint/style/noNonNullAssertion: guarded by early return on empty array
  let minItem = converted[0]!;
  // biome-ignore lint/style/noNonNullAssertion: guarded by early return on empty array
  let maxItem = converted[0]!;
  for (const e of converted) {
    if (e.displayAmount < minItem.displayAmount) minItem = e;
    if (e.displayAmount > maxItem.displayAmount) maxItem = e;
  }

  return {
    count,
    total,
    avg,
    median,
    min: {
      amount: minItem.displayAmount,
      comment: minItem.comment,
      category: minItem.category,
      date: minItem.date,
    },
    max: {
      amount: maxItem.displayAmount,
      comment: maxItem.comment,
      category: maxItem.category,
      date: maxItem.date,
    },
  };
}

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
 * Returns mapping of category → total in display currency.
 */
function aggregateByCategory(
  expenses: ExpenseRecord[],
  displayCurrency: CurrencyCode,
): Record<string, number> {
  const result: Record<string, number> = {};
  for (const e of expenses) {
    const displayAmount = convertCurrency(e.eur_amount, BASE_CURRENCY, displayCurrency);
    result[e.category] = (result[e.category] ?? 0) + displayAmount;
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
      const delta = (catB[cat] ?? 0) - (catA[cat] ?? 0);
      if (delta > biggestGrowth.delta) biggestGrowth = { category: cat, delta };
      if (delta < biggestDrop.delta) biggestDrop = { category: cat, delta };
    }

    if (biggestGrowth.delta > 0) {
      lines.push(
        `Biggest growth: ${biggestGrowth.category} +${formatAmount(biggestGrowth.delta, currency, true)}`,
      );
    }
    if (biggestDrop.delta < 0) {
      lines.push(
        `Biggest drop: ${biggestDrop.category} \u2212${formatAmount(Math.abs(biggestDrop.delta), currency, true)}`,
      );
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
  for (const [i, e] of sorted.entries()) {
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
