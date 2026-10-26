/**
 * Helpers shared by the backtest scripts (backtest-forecast, backtest-qualitative):
 * cumulative day-of-month spending profiles and per-month budget lookup.
 */

import type { CurrencyCode } from '../../src/config/constants';
import { convertCurrency } from '../../src/services/currency/converter';

export interface DailyExpense {
  day: number;
  month: number;
  category: string;
  amount: number;
}

export interface CumulativeProfile {
  /** Average fraction of monthly total spent by each checkpoint day */
  fractionsByDay: Map<number, number>;
  /** Whether the profile is stable enough (CV < 0.3 at most checkpoints) */
  isStable: boolean;
}

export const CHECK_DAYS = [5, 10, 15, 20, 25];

function groupByCategory(expenses: DailyExpense[]): Map<string, DailyExpense[]> {
  const byCategory = new Map<string, DailyExpense[]>();
  for (const e of expenses) {
    const arr = byCategory.get(e.category) ?? [];
    arr.push(e);
    byCategory.set(e.category, arr);
  }
  return byCategory;
}

/** Per-checkpoint fractions of each month's total spent by that day */
function collectMonthFractions(catExpenses: DailyExpense[], months: Set<number>) {
  const monthFractions = new Map<number, number[]>(); // checkDay -> fraction[]
  for (const cp of CHECK_DAYS) {
    monthFractions.set(cp, []);
  }

  for (const m of months) {
    const mExpenses = catExpenses.filter((e) => e.month === m);
    const monthTotal = mExpenses.reduce((s, e) => s + e.amount, 0);
    if (monthTotal <= 0) continue;

    for (const cp of CHECK_DAYS) {
      const spentByDay = mExpenses.filter((e) => e.day <= cp).reduce((s, e) => s + e.amount, 0);
      monthFractions.get(cp)?.push(spentByDay / monthTotal);
    }
  }
  return monthFractions;
}

/** Average fractions per checkpoint and whether CV < 0.3 at >= 3 of 5 checkpoints */
function summarizeFractions(monthFractions: Map<number, number[]>): CumulativeProfile {
  const fractionsByDay = new Map<number, number>();
  let stableCount = 0;

  for (const cp of CHECK_DAYS) {
    const fractions = monthFractions.get(cp) ?? [];
    if (fractions.length < 3) continue;

    const mean = fractions.reduce((s, v) => s + v, 0) / fractions.length;
    const variance = fractions.reduce((s, v) => s + (v - mean) ** 2, 0) / fractions.length;
    const cv = mean > 0 ? Math.sqrt(variance) / mean : 999;

    fractionsByDay.set(cp, mean);
    if (cv < 0.3) stableCount++;
  }

  return { fractionsByDay, isStable: stableCount >= 3 };
}

/** Build cumulative spending profile from historical daily expenses */
export function buildCumulativeProfiles(expenses: DailyExpense[]): Map<string, CumulativeProfile> {
  const profiles = new Map<string, CumulativeProfile>();

  for (const [category, catExpenses] of groupByCategory(expenses)) {
    const monthsWithData = new Set<number>();
    for (const e of catExpenses) monthsWithData.add(e.month);

    if (monthsWithData.size < 3) continue; // Need >= 3 months

    profiles.set(category, summarizeFractions(collectMonthFractions(catExpenses, monthsWithData)));
  }

  return profiles;
}

/** Normalize inconsistent month formats ('2026-3' → '2026-03') to YYYY-MM */
export function normalizeMonth(raw: string): string {
  return raw.replace(/-(\d)$/, '-0$1');
}

interface BudgetRow {
  category: string;
  limit_amount: number;
  currency: string;
  month: string;
}

/** category → budgets (EUR) sorted by normalized month ascending */
function groupBudgetsByCategory(budgetRows: BudgetRow[]): Map<string, { month: string; amount: number }[]> {
  const byCat = new Map<string, { month: string; amount: number }[]>();
  for (const b of budgetRows) {
    const arr = byCat.get(b.category) ?? [];
    arr.push({
      month: normalizeMonth(b.month),
      amount: convertCurrency(b.limit_amount, b.currency as CurrencyCode, 'EUR'),
    });
    byCat.set(b.category, arr);
  }
  for (const arr of byCat.values()) {
    arr.sort((a, b) => a.month.localeCompare(b.month));
  }
  return byCat;
}

/** Exact-match or closest previous month's budget; budgets are sorted ascending */
function findBudgetForMonth(budgets: { month: string; amount: number }[], ym: string): number | null {
  let bestAmount: number | null = null;
  for (const entry of budgets) {
    if (entry.month > ym) break;
    bestAmount = entry.amount;
  }
  return bestAmount;
}

/**
 * Build a per-month budget lookup from DB rows.
 * Key: "monthIndex:category" → budget amount in EUR.
 * For months without an explicit budget, falls back to the closest previous month's budget.
 */
export function buildBudgetLookup(budgetRows: BudgetRow[], sortedMonths: string[]): Map<string, number> {
  const byCat = groupBudgetsByCategory(budgetRows);
  const lookup = new Map<string, number>();
  for (let i = 0; i < sortedMonths.length; i++) {
    const ym = sortedMonths[i]!;
    for (const [cat, budgets] of byCat) {
      const bestAmount = findBudgetForMonth(budgets, ym);
      if (bestAmount !== null) {
        lookup.set(`${i}:${cat}`, bestAmount);
      }
    }
  }
  return lookup;
}
