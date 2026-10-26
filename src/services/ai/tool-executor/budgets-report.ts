/**
 * get_budgets tool: per-category budget progress, burn rate / projection for the current month,
 * and a grand total. The report text is the only place the model reads budget progress from, so
 * the wording and the arithmetic are pinned by tool-executor.get-budgets-report.test.ts.
 */
import { endOfMonth, format, getDaysInMonth } from 'date-fns';
import { BASE_CURRENCY, type CurrencyCode } from '../../../config/constants';
import { database } from '../../../database';
import { computeBudgetProgress } from '../../../database/repositories/budget.repository';
import type { Budget, Expense } from '../../../database/types';
import { normalizeArrayParam } from '../../../utils/period';
import { spendingAnalytics } from '../../analytics/spending-analytics';
import { convertCurrency, formatAmount } from '../../currency/converter';
import type { AgentContext, ToolResult } from '../types';
import { filterByCategories } from './category-filter';

/** EMA-based projection for one category, as computed by spending-analytics (budget currency). */
interface BurnRate {
  projected_total: number;
  daily_burn_rate: number;
  runway_days: number;
}

/** Calendar facts about one requested month, relative to "now". */
interface MonthClock {
  daysInMonth: number;
  daysElapsed: number;
  daysRemaining: number;
  /** True when burn rate / projection figures are meaningful (current month, at least one day). */
  tracksPace: boolean;
}

/** A runway at or above this many days means "the budget will not run out". */
const UNLIMITED_RUNWAY_DAYS = 999;

function monthClock(month: string, monthDate: Date, now: Date): MonthClock {
  const isCurrentMonth = format(now, 'yyyy-MM') === month;
  const daysInMonth = getDaysInMonth(monthDate);
  const daysElapsed = isCurrentMonth ? now.getDate() : daysInMonth;
  return {
    daysInMonth,
    daysElapsed,
    daysRemaining: isCurrentMonth ? daysInMonth - daysElapsed : 0,
    tracksPace: isCurrentMonth && daysElapsed > 0,
  };
}

/** EMA-based burn rates for the current month (avoids a naive linear projection). */
function loadBurnRates(groupId: number): Map<string, BurnRate> {
  const burnRates = new Map<string, BurnRate>();
  for (const br of spendingAnalytics.getFinancialSnapshot(groupId).burnRates) {
    burnRates.set(br.category, {
      projected_total: br.projected_total,
      daily_burn_rate: br.daily_burn_rate,
      runway_days: br.runway_days,
    });
  }
  return burnRates;
}

function formatRunway(runwayDays: number): string {
  return runwayDays >= UNLIMITED_RUNWAY_DAYS ? '∞' : `${Math.round(runwayDays)}d`;
}

function sumEurByCategory(expenses: Expense[]): Record<string, number> {
  const spendingByCategory: Record<string, number> = {};
  for (const e of expenses) {
    spendingByCategory[e.category] = (spendingByCategory[e.category] || 0) + e.eur_amount;
  }
  return spendingByCategory;
}

/** Burn / projected / runway suffix for one budget line of the current month. */
function burnDetails(
  budget: Budget,
  spentInCurrency: number,
  clock: MonthClock,
  burnRate: BurnRate | undefined,
): string {
  const { currency } = budget;
  if (burnRate) {
    const projectedDisplay = formatAmount(burnRate.projected_total, currency, true);
    const burnDisplay = formatAmount(burnRate.daily_burn_rate, currency, true);
    return ` | burn: ${burnDisplay}/day, projected: ${projectedDisplay}, runway: ${formatRunway(burnRate.runway_days)}`;
  }
  // Fallback for categories without burn rate data (e.g. no spending yet)
  const dailyBurn = spentInCurrency / clock.daysElapsed;
  const remaining = budget.limit_amount - spentInCurrency;
  const runwayDays = dailyBurn > 0 ? Math.max(0, remaining / dailyBurn) : UNLIMITED_RUNWAY_DAYS;
  return ` | burn: ${formatAmount(dailyBurn, currency, true)}/day, projected: ${formatAmount(dailyBurn * clock.daysInMonth, currency, true)}, runway: ${formatRunway(runwayDays)}`;
}

function budgetLine(
  budget: Budget,
  spentInCurrency: number,
  clock: MonthClock,
  burnRate: BurnRate | undefined,
): string {
  const progress = computeBudgetProgress(budget, spentInCurrency);
  const status = progress.is_exceeded ? 'EXCEEDED' : progress.is_warning ? 'WARNING' : 'OK';
  const details = clock.tracksPace ? burnDetails(budget, spentInCurrency, clock, burnRate) : '';
  return `${budget.category}: ${formatAmount(spentInCurrency, budget.currency, true)}/${formatAmount(budget.limit_amount, budget.currency, true)} (${progress.percentage}%) [${status}]${details}`;
}

/** Single-month view: total spent vs. total limit of the listed budgets, in the group currency. */
function grandTotalLine(
  spentEur: number,
  limitEur: number,
  displayCurrency: CurrencyCode,
  clock: MonthClock,
): string {
  const spentDisplay = convertCurrency(spentEur, BASE_CURRENCY, displayCurrency);
  const limitDisplay = convertCurrency(limitEur, BASE_CURRENCY, displayCurrency);
  const percentage = limitDisplay > 0 ? Math.round((spentDisplay / limitDisplay) * 100) : 0;
  const line = `Grand Total: ${formatAmount(spentDisplay, displayCurrency, true)}/${formatAmount(limitDisplay, displayCurrency, true)} (${percentage}%)`;
  if (!clock.tracksPace) return line;

  const dailyBurn = spentDisplay / clock.daysElapsed;
  const projected = dailyBurn * clock.daysInMonth;
  return `${line} | burn: ${formatAmount(dailyBurn, displayCurrency, true)}/day, projected: ${formatAmount(projected, displayCurrency, true)}, ${clock.daysRemaining}d left`;
}

/** Lines for one month that has budgets; totals are in EUR so months can be summed. */
function renderMonth(
  month: string,
  budgets: Budget[],
  expenses: Expense[],
  clock: MonthClock,
  burnRates: Map<string, BurnRate>,
  isBatch: boolean,
  displayCurrency: CurrencyCode,
): string[] {
  const spendingByCategory = sumEurByCategory(expenses);
  const lines = isBatch
    ? [`=== ${month} ===`]
    : [`Budgets for ${month} (day ${clock.daysElapsed}/${clock.daysInMonth}):`, ''];

  let spentEur = 0;
  let limitEur = 0;
  for (const budget of budgets) {
    const categorySpentEur = spendingByCategory[budget.category] || 0;
    const spentInCurrency = convertCurrency(categorySpentEur, BASE_CURRENCY, budget.currency);
    lines.push(budgetLine(budget, spentInCurrency, clock, burnRates.get(budget.category)));
    spentEur += categorySpentEur;
    limitEur += convertCurrency(budget.limit_amount, budget.currency, BASE_CURRENCY);
  }

  if (!isBatch) {
    lines.push('', grandTotalLine(spentEur, limitEur, displayCurrency, clock));
  }
  lines.push('');
  return lines;
}

function noBudgetsLines(month: string, isBatch: boolean): string[] {
  return isBatch ? [`=== ${month} ===`, 'No budgets set.', ''] : [`No budgets set for ${month}.`];
}

export async function executeGetBudgets(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const now = new Date();
  const nowMonth = format(now, 'yyyy-MM');
  const months = normalizeArrayParam(input['month'], nowMonth);
  const categories = normalizeArrayParam(input['category']);
  const isBatch = months.length > 1;

  const group = database.groups.findById(ctx.groupId);
  const displayCurrency = (group?.default_currency ?? BASE_CURRENCY) as CurrencyCode;
  const burnRates = months.includes(nowMonth) ? loadBurnRates(ctx.groupId) : new Map();

  const allLines: string[] = [];
  let grandTotalEur = 0;

  for (const month of months) {
    const budgets = filterByCategories(
      database.budgets.getAllBudgetsForMonth(ctx.groupId, month),
      categories,
    );
    if (budgets.length === 0) {
      allLines.push(...noBudgetsLines(month, isBatch));
      continue;
    }

    const monthDate = new Date(`${month}-01`);
    const monthEnd = format(endOfMonth(monthDate), 'yyyy-MM-dd');
    const expenses = database.expenses.findByDateRange(ctx.groupId, `${month}-01`, monthEnd);
    grandTotalEur = expenses.reduce((total, e) => total + e.eur_amount, grandTotalEur);

    const clock = monthClock(month, monthDate, now);
    allLines.push(
      ...renderMonth(month, budgets, expenses, clock, burnRates, isBatch, displayCurrency),
    );
  }

  // Grand total across all months for batch (uses accumulated EUR total from all expenses)
  if (isBatch && grandTotalEur > 0) {
    const totalDisplay = convertCurrency(grandTotalEur, BASE_CURRENCY, displayCurrency);
    allLines.push(`=== Grand Total (${months.length} months) ===`);
    allLines.push(`${formatAmount(totalDisplay, displayCurrency, true)}`);
  }

  return { success: true, output: allLines.join('\n') };
}
