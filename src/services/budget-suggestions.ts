// Builds explainable suggested budget amounts from plans, spending history and group budgets

import { addMonths, format, startOfMonth } from 'date-fns';
import { BASE_CURRENCY, type CurrencyCode } from '../config/constants';
import { database } from '../database';
import type { Budget } from '../database/types';
import { findBestCategoryMatch } from '../utils/fuzzy-search';
import { convertCurrency } from './currency/converter';

export type BudgetSuggestionKind =
  | 'previous_budget'
  | 'current_plan'
  | 'last_month_spend'
  | 'average_spend'
  | 'group_median'
  | 'group_average';

export interface BudgetSuggestion {
  /** Whole units of the prompt currency — also used verbatim in callback data. */
  amount: number;
  kind: BudgetSuggestionKind;
  /** Short Russian explanation shown next to the amount. */
  reason: string;
}

interface MoneyAmount {
  amount: number;
  currency: CurrencyCode;
}

export interface SuggestionInputs {
  currency: CurrencyCode;
  previousBudget: MoneyAmount | null;
  currentBudget: MoneyAmount | null;
  /** EUR totals of the category for recent full months with spending, oldest first. */
  monthlySpendEur: number[];
  /** This month's budgets of the group's other categories. */
  otherBudgets: MoneyAmount[];
}

export interface BudgetSuggestions {
  options: BudgetSuggestion[];
}

const MAX_OPTIONS = 3;
const HISTORY_MONTHS = 3;

/** Round to two significant digits so suggestions look like plans, not statistics. */
export function roundToNiceAmount(value: number): number {
  if (value < 10) return Math.max(1, Math.round(value));
  const step = 10 ** (Math.floor(Math.log10(value)) - 1);
  return Math.max(1, Math.round(value / step) * step);
}

function toCurrency(money: MoneyAmount, target: CurrencyCode): number {
  return convertCurrency(money.amount, money.currency, target);
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}

function planSuggestions(input: SuggestionInputs): BudgetSuggestion[] {
  const result: BudgetSuggestion[] = [];
  if (input.currentBudget) {
    result.push({
      amount: roundToNiceAmount(toCurrency(input.currentBudget, input.currency)),
      kind: 'current_plan',
      reason: 'текущий бюджет на этот месяц',
    });
  }
  if (input.previousBudget) {
    result.push({
      amount: roundToNiceAmount(toCurrency(input.previousBudget, input.currency)),
      kind: 'previous_budget',
      reason: 'бюджет прошлого месяца',
    });
  }
  return result;
}

function spendingSuggestions(input: SuggestionInputs): BudgetSuggestion[] {
  const spend = input.monthlySpendEur;
  const last = spend[spend.length - 1];
  if (last === undefined) return [];
  const inCurrency = (eur: number) =>
    roundToNiceAmount(convertCurrency(eur, BASE_CURRENCY, input.currency));
  const result: BudgetSuggestion[] = [];
  if (spend.length >= 2) {
    const average = spend.reduce((sum, value) => sum + value, 0) / spend.length;
    result.push({
      amount: inCurrency(average),
      kind: 'average_spend',
      reason: `средние траты за ${spend.length} мес. с расходами`,
    });
  }
  result.push({
    amount: inCurrency(last),
    kind: 'last_month_spend',
    reason: 'последний месяц с расходами',
  });
  return result;
}

function groupSuggestions(input: SuggestionInputs): BudgetSuggestion[] {
  if (input.otherBudgets.length === 0) return [];
  const amounts = input.otherBudgets.map((budget) => toCurrency(budget, input.currency));
  const average = amounts.reduce((sum, value) => sum + value, 0) / amounts.length;
  const reason = `бюджеты других категорий (${amounts.length})`;
  const result: BudgetSuggestion[] = [
    {
      amount: roundToNiceAmount(median(amounts)),
      kind: 'group_median',
      reason: `медиана: ${reason}`,
    },
  ];
  if (amounts.length >= 3) {
    result.push({
      amount: roundToNiceAmount(average),
      kind: 'group_average',
      reason: `среднее: ${reason}`,
    });
  }
  return result;
}

/** Pure suggestion logic: no DB access, deterministic for the given inputs. */
export function buildBudgetSuggestions(input: SuggestionInputs): BudgetSuggestions {
  const own = [...planSuggestions(input), ...spendingSuggestions(input)];
  // The group distribution only stands in when the category itself has no data.
  const candidates = own.length > 0 ? own : groupSuggestions(input);

  const options: BudgetSuggestion[] = [];
  for (const candidate of candidates) {
    if (options.some((option) => option.amount === candidate.amount)) continue;
    options.push(candidate);
    if (options.length === MAX_OPTIONS) break;
  }
  return { options };
}

function monthKey(date: Date): string {
  return format(date, 'yyyy-MM');
}

/** Gather shared history/current and previous budgets once for a wizard's category batch. */
export function suggestBudgetAmountsBatch(
  groupId: number,
  categories: string[],
  currency: CurrencyCode,
  now: Date = new Date(),
): Map<string, BudgetSuggestions> {
  const result = new Map<string, BudgetSuggestions>();
  if (categories.length === 0) return result;
  const currentStart = startOfMonth(now);
  const current = database.budgets.getBudgetCandidatesForMonth(groupId, monthKey(now));
  const previous = database.budgets.getBudgetCandidatesForMonth(
    groupId,
    monthKey(addMonths(currentStart, -1)),
  );
  const history = database.expenses.getMonthlyHistoryByCategory(
    groupId,
    format(addMonths(currentStart, -HISTORY_MONTHS), 'yyyy-MM-dd'),
    format(currentStart, 'yyyy-MM-dd'),
  );
  const wanted = new Set(categories.map((category) => category.toLowerCase()));
  const spend = new Map<string, { month: string; amount: number }[]>();
  for (const row of history) {
    if (row.monthly_total <= 0) continue;
    const key = row.category.toLowerCase();
    if (!wanted.has(key)) continue;
    const amounts = spend.get(key) ?? [];
    amounts.push({ month: row.month, amount: row.monthly_total });
    spend.set(key, amounts);
  }
  const matchingBudget = (budgets: Budget[], category: string): MoneyAmount | null => {
    const match = findBestCategoryMatch(
      category,
      budgets.map((budget) => budget.category),
    );
    const budget = budgets.find((row) => row.category === match);
    return budget ? { amount: budget.limit_amount, currency: budget.currency } : null;
  };
  for (const category of categories) {
    result.set(
      category,
      buildBudgetSuggestions({
        currency,
        previousBudget: matchingBudget(previous, category),
        currentBudget: matchingBudget(current, category),
        monthlySpendEur: (spend.get(category.toLowerCase()) ?? [])
          .sort((a, b) => a.month.localeCompare(b.month))
          .map((row) => row.amount),
        otherBudgets: current
          .filter((row) => row.category.toLowerCase() !== category.toLowerCase())
          .map((row) => ({ amount: row.limit_amount, currency: row.currency })),
      }),
    );
  }
  return result;
}

/** Gather the real data for one category, using the same snapshot path as wizard batches. */
export function suggestBudgetAmounts(
  groupId: number,
  category: string,
  currency: CurrencyCode,
  now: Date = new Date(),
): BudgetSuggestions {
  return (
    suggestBudgetAmountsBatch(groupId, [category], currency, now).get(category) ?? { options: [] }
  );
}
