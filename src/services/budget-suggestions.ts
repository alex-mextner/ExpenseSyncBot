// Builds explainable suggested budget amounts from plans, spending history and group budgets

import { addMonths, format, startOfMonth } from 'date-fns';
import { BASE_CURRENCY, type CurrencyCode } from '../config/constants';
import { database } from '../database';
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

function collectMonthlySpendEur(groupId: number, category: string, now: Date): number[] {
  const currentStart = startOfMonth(now);
  const from = format(addMonths(currentStart, -HISTORY_MONTHS), 'yyyy-MM-dd');
  const to = format(currentStart, 'yyyy-MM-dd');
  const wanted = category.toLowerCase();
  return database.expenses
    .getMonthlyHistoryByCategory(groupId, from, to)
    .filter((row) => row.category.toLowerCase() === wanted && row.monthly_total > 0)
    .sort((a, b) => a.month.localeCompare(b.month))
    .map((row) => row.monthly_total);
}

/** Gather the real data for a category and build suggestions from it. */
export function suggestBudgetAmounts(
  groupId: number,
  category: string,
  currency: CurrencyCode,
  now: Date = new Date(),
): BudgetSuggestions {
  const thisMonth = monthKey(now);
  const previous = database.budgets.getBudgetForMonth(
    groupId,
    category,
    monthKey(addMonths(startOfMonth(now), -1)),
  );
  const current = database.budgets.getBudgetForMonth(groupId, category, thisMonth);
  const others = database.budgets
    .getAllBudgetsForMonth(groupId, thisMonth)
    .filter((budget) => budget.category.toLowerCase() !== category.toLowerCase());

  return buildBudgetSuggestions({
    currency,
    previousBudget: previous
      ? { amount: previous.limit_amount, currency: previous.currency }
      : null,
    currentBudget: current ? { amount: current.limit_amount, currency: current.currency } : null,
    monthlySpendEur: collectMonthlySpendEur(groupId, category, now),
    otherBudgets: others.map((b) => ({ amount: b.limit_amount, currency: b.currency })),
  });
}
