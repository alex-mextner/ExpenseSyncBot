/** /sum command handler — totals expenses for a date range with optional category filter */
import { endOfMonth, format, startOfMonth } from 'date-fns';
import { InlineKeyboard } from 'gramio';
import { getCategoryEmoji } from '../../config/category-emojis';
import { BASE_CURRENCY, type CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import { computeBudgetProgress } from '../../database/repositories/budget.repository';
import type { Expense, Group } from '../../database/types';
import { spendingAnalytics } from '../../services/analytics/spending-analytics';
import type { CategoryTaAnalysis } from '../../services/analytics/ta/analyzer';
import type { TechnicalAnalysis } from '../../services/analytics/types';
import { sendMessage } from '../../services/bank/telegram-sender';
import { convertCurrency, formatAmount } from '../../services/currency/converter';
import { googleConn } from '../../services/google/sheets';
import { truncateForTelegram } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import { buildMiniAppUrl } from '../../utils/miniapp-url';
import { silentSyncBudgets } from '../services/budget-sync';
import type { Ctx } from '../types';
import { maybeSmartAdvice } from './ask';

const logger = createLogger('sum');

interface SumExpense {
  date: string;
  category: string;
  eur_amount: number;
}

interface CategoryDifference {
  category: string;
  diff: number;
  percent: number;
}

/** Average EUR spend over complete past months (0 when there are none). */
function computeMonthlyAverage(pastExpenses: SumExpense[]): {
  monthsCount: number;
  averagePerMonth: number;
} {
  const monthlyTotals: Record<string, number> = {};
  for (const expense of pastExpenses) {
    const monthKey = expense.date.substring(0, 7); // YYYY-MM
    monthlyTotals[monthKey] = (monthlyTotals[monthKey] ?? 0) + expense.eur_amount;
  }
  const monthsCount = Object.keys(monthlyTotals).length;
  const averagePerMonth =
    monthsCount > 0
      ? Object.values(monthlyTotals).reduce((sum, val) => sum + val, 0) / monthsCount
      : 0;
  return { monthsCount, averagePerMonth };
}

function sumByCategory(expenses: SumExpense[]): Record<string, number> {
  const totals: Record<string, number> = {};
  for (const expense of expenses) {
    totals[expense.category] = (totals[expense.category] ?? 0) + expense.eur_amount;
  }
  return totals;
}

/** Number of distinct months in which each category has spending. */
function countMonthsPerCategory(expenses: SumExpense[]): Record<string, number> {
  const months: Record<string, Set<string>> = {};
  for (const expense of expenses) {
    const set = months[expense.category] ?? new Set<string>();
    set.add(expense.date.substring(0, 7));
    months[expense.category] = set;
  }
  return Object.fromEntries(Object.entries(months).map(([category, set]) => [category, set.size]));
}

/**
 * Current-month total vs. the category's average over the months it appeared in,
 * sorted by absolute percent difference. Categories without history are skipped.
 */
function computeCategoryDifferences(
  currentExpenses: SumExpense[],
  pastExpenses: SumExpense[],
): CategoryDifference[] {
  const categoryTotals = sumByCategory(currentExpenses);
  const pastTotals = sumByCategory(pastExpenses);
  const monthsPerCategory = countMonthsPerCategory(pastExpenses);

  const differences: CategoryDifference[] = [];
  for (const [category, currentTotal] of Object.entries(categoryTotals)) {
    const monthsWithCategory = monthsPerCategory[category] || 0;
    const pastTotal = pastTotals[category];
    const avgForCategory =
      monthsWithCategory > 0 && pastTotal !== undefined ? pastTotal / monthsWithCategory : 0;

    if (avgForCategory > 0) {
      const diff = currentTotal - avgForCategory;
      differences.push({ category, diff, percent: (diff / avgForCategory) * 100 });
    }
  }

  differences.sort((a, b) => Math.abs(b.percent) - Math.abs(a.percent));
  return differences;
}

function renderAverageComparison(
  averagePerMonth: number,
  currentMonthTotal: number,
  displayCurrency: CurrencyCode,
): string {
  const difference = currentMonthTotal - averagePerMonth;
  const percentDifference = averagePerMonth > 0 ? (difference / averagePerMonth) * 100 : 0;
  const averageDisplay = convertCurrency(averagePerMonth, BASE_CURRENCY, displayCurrency);
  const differenceDisplay = convertCurrency(difference, BASE_CURRENCY, displayCurrency);

  let text = `📈 Средняя: ${formatAmount(averageDisplay, displayCurrency)}\n`;
  if (difference > 0) {
    text += `📊 Разница: +${formatAmount(differenceDisplay, displayCurrency)} (+${percentDifference.toFixed(1)}%)\n`;
  } else if (difference < 0) {
    text += `📊 Разница: ${formatAmount(differenceDisplay, displayCurrency)} (${percentDifference.toFixed(1)}%)\n`;
  } else {
    text += `📊 Разница: точно в среднем\n`;
  }
  return text;
}

/** Up to 3 categories as bullet lines; sign is the sign prefix for positive diffs ('+' or ''). */
function renderCategoryDeltaLines(
  entries: CategoryDifference[],
  positiveSign: string,
  displayCurrency: CurrencyCode,
): string {
  if (entries.length === 0) return `  • Нет категорий\n`;
  let text = '';
  for (const { category, diff, percent } of entries.slice(0, 3)) {
    const diffDisplay = convertCurrency(diff, BASE_CURRENCY, displayCurrency);
    text += `  • ${category}: ${positiveSign}${formatAmount(diffDisplay, displayCurrency)} (${positiveSign}${percent.toFixed(1)}%)\n`;
  }
  return text;
}

/** Top categories above/below their own average (±5% dead zone). */
function renderCategoryDifferences(
  categoryDifferences: CategoryDifference[],
  displayCurrency: CurrencyCode,
): string {
  if (categoryDifferences.length === 0) return '';

  const above = categoryDifferences.filter((c) => c.percent > 5);
  // Sort by percent ascending (most negative first)
  const below = categoryDifferences
    .filter((c) => c.percent < -5)
    .sort((a, b) => a.percent - b.percent);

  let text = `\n🔥 Больше среднего:\n`;
  text += renderCategoryDeltaLines(above, '+', displayCurrency);
  text += `\n❄️ Меньше среднего:\n`;
  text += renderCategoryDeltaLines(below, '', displayCurrency);
  return text;
}

function describeTrendSignals(cat: CategoryTaAnalysis): string[] {
  const signals: string[] = [];
  if (cat.anomaly.isAnomaly) signals.push('⚠️ необычный расход');
  if (cat.trend.direction === 'rising' && cat.trend.confidence >= 0.6) signals.push('↑ растут');
  else if (cat.trend.direction === 'falling' && cat.trend.confidence >= 0.6)
    signals.push('↓ снижаются');
  if (cat.trend.macd.crossover === 'bullish') signals.push('📈 начали расти');
  else if (cat.trend.macd.crossover === 'bearish') signals.push('📉 пошли на спад');
  if (cat.volatility.donchian.isBreakoutHigh) signals.push('🚨 рекорд');
  return signals;
}

/**
 * Trend summary for top spending categories — cap at 10 entries so the
 * message still fits Telegram's 4096-char limit alongside budget info. Per
 * the N+2 rule, only emit "и ещё N..." when N ≥ 3.
 */
function renderTrendSummary(analysis: TechnicalAnalysis, displayCurrency: CurrencyCode): string {
  const taLines: string[] = [];
  for (const cat of analysis.categories) {
    const signals = describeTrendSignals(cat);
    if (signals.length === 0) continue;
    const forecast = convertCurrency(cat.forecasts.ensemble, BASE_CURRENCY, displayCurrency);
    const emoji = getCategoryEmoji(cat.category);
    taLines.push(
      `  ${emoji} ${cat.category}: ${signals.join(', ')} (прогноз ${formatAmount(forecast, displayCurrency)})`,
    );
  }
  if (taLines.length === 0) return '';

  const MAX_TA_LINES = 10;
  const hidden = taLines.length - MAX_TA_LINES;
  const visibleLines = hidden >= 3 ? taLines.slice(0, MAX_TA_LINES) : taLines;
  let text = `\n📈 Тренды:\n${visibleLines.join('\n')}\n`;
  if (hidden >= 3) {
    text += `  … и ещё ${hidden}\n`;
  }
  return text;
}

function logCurrentMonthExpenses(currentMonthExpenses: Expense[]): void {
  logger.info(`[SUM] Current month expenses: ${currentMonthExpenses.length}`);
  logger.info(`[SUM] Current month expenses details:`);
  currentMonthExpenses.forEach((exp) => {
    logger.info(
      `  - ${exp.date}: ${exp.amount} ${exp.currency} = ${exp.eur_amount} EUR (${exp.category})`,
    );
  });
}

/**
 * /sum and /total command handler - show current month expenses summary
 */
export async function handleSumCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  void ctx;
  // Silent sync budgets from Google Sheets
  if (group.google_refresh_token) {
    const syncedCount = await silentSyncBudgets(googleConn(group), group.id);
    if (syncedCount > 0) {
      await sendMessage(`🔄 Синхронизировано записей бюджета: ${syncedCount}`);
    }
  }

  // Get current month boundaries
  const now = new Date();
  const currentMonthStart = format(startOfMonth(now), 'yyyy-MM-dd');
  const currentMonthEnd = format(endOfMonth(now), 'yyyy-MM-dd');

  // Get all expenses for the group (with high limit to get all)
  const allExpenses = database.expenses.findByGroupId(group.id, 100000);

  logger.info(`[SUM] Group ${group.id}: Total expenses: ${allExpenses.length}`);
  logger.info(`[SUM] Date range: ${currentMonthStart} to ${currentMonthEnd}`);

  if (allExpenses.length === 0) {
    await sendMessage('📊 Пока нет расходов');
    return;
  }

  const currentMonthExpenses = allExpenses.filter(
    (expense) => expense.date >= currentMonthStart && expense.date <= currentMonthEnd,
  );
  logCurrentMonthExpenses(currentMonthExpenses);

  if (currentMonthExpenses.length === 0) {
    await sendMessage(`📊 В ${format(now, 'LLLL yyyy')} пока нет расходов`);
    return;
  }

  const currentMonthTotal = currentMonthExpenses.reduce((sum, exp) => sum + exp.eur_amount, 0);
  logger.info(`[SUM] Current month total: €${currentMonthTotal.toFixed(2)}`);

  // Averages are based on all complete months before the current one
  const pastExpenses = allExpenses.filter((exp) => exp.date < currentMonthStart);
  const { monthsCount, averagePerMonth } = computeMonthlyAverage(pastExpenses);

  // Convert EUR totals to group's display currency for user output
  const displayCurrency = group.default_currency;
  const currentMonthTotalDisplay = convertCurrency(
    currentMonthTotal,
    BASE_CURRENCY,
    displayCurrency,
  );

  let message = `📊 Расходы за ${format(now, 'LLLL yyyy')}\n\n`;
  message += `💰 Всего: ${formatAmount(currentMonthTotalDisplay, displayCurrency)}\n`;

  if (monthsCount > 0) {
    message += renderAverageComparison(averagePerMonth, currentMonthTotal, displayCurrency);
  }

  message += renderCategoryDifferences(
    computeCategoryDifferences(currentMonthExpenses, pastExpenses),
    displayCurrency,
  );

  const snapshot = spendingAnalytics.getFinancialSnapshot(group.id);
  if (snapshot.technicalAnalysis && snapshot.technicalAnalysis.categories.length > 0) {
    message += renderTrendSummary(snapshot.technicalAnalysis, displayCurrency);
  }

  // Add budget information
  await addBudgetInfo(message, group, currentMonthExpenses);

  // Maybe send daily advice (20% probability)
  await maybeSmartAdvice(group.id);
}

/**
 * Add budget information to /sum output
 */
async function addBudgetInfo(
  baseMessage: string,
  group: {
    id: number;
    telegram_group_id: number;
    google_refresh_token: string | null;
    spreadsheet_id: string | null;
    default_currency: import('../../config/constants').CurrencyCode;
  },
  currentMonthExpenses: Array<{ category: string; eur_amount: number }>,
): Promise<void> {
  const now = new Date();
  const currentMonth = format(now, 'yyyy-MM');

  const miniAppUrl = buildMiniAppUrl('dashboard', group.telegram_group_id);
  const keyboard = miniAppUrl ? new InlineKeyboard().url('📊 Дашборд', miniAppUrl) : undefined;

  // Get budgets for current month
  const budgets = database.budgets.getAllBudgetsForMonth(group.id, currentMonth);

  if (budgets.length === 0) {
    // No budgets set - just send base message
    await sendMessage(truncateForTelegram(baseMessage), keyboard ? { reply_markup: keyboard } : {});
    return;
  }

  // Calculate spending by category
  const categorySpending: Record<string, number> = {};
  for (const expense of currentMonthExpenses) {
    categorySpending[expense.category] =
      (categorySpending[expense.category] || 0) + expense.eur_amount;
  }

  // Calculate budget progress — convert EUR spending to each budget's currency
  const budgetProgress = budgets.map((budget) =>
    buildBudgetProgressEntry(categorySpending[budget.category] || 0, budget),
  );

  // Calculate totals in group's display currency
  const {
    totalSpentDisplay,
    totalBudgetDisplay,
    percentage: totalPercentage,
  } = buildBudgetTotals(categorySpending, budgets, group.default_currency);

  // Sort by percentage descending
  budgetProgress.sort((a, b) => b.percentage - a.percentage);

  // Build budget section
  let budgetMessage = `\n\n💰 Бюджет:\n`;
  budgetMessage += `Всего: ${formatAmount(totalSpentDisplay, group.default_currency)} / ${formatAmount(totalBudgetDisplay, group.default_currency)} (${totalPercentage}%)\n\n`;

  // Show only exceeded and warning categories
  const importantCategories = budgetProgress.filter((bp) => bp.is_exceeded || bp.is_warning);

  if (importantCategories.length > 0) {
    for (const bp of importantCategories) {
      const emoji = getCategoryEmoji(bp.category);
      const status = bp.is_exceeded ? '🔴' : '⚠️';
      budgetMessage += `${status} ${emoji} ${bp.category}: ${formatAmount(bp.spentInCurrency, bp.currency)} / ${formatAmount(bp.limit, bp.currency)} (${bp.percentage}%)\n`;
    }
  }

  // Add hint to view full budget
  if (budgets.length > importantCategories.length) {
    budgetMessage += `\nℹ️ Используй /budget для полного отчета`;
  }

  await sendMessage(
    truncateForTelegram(baseMessage + budgetMessage),
    keyboard ? { reply_markup: keyboard } : {},
  );
}

/**
 * Compute progress for a single budget entry.
 * spentEur — category spending in EUR; budget — with limit in budget.currency.
 * Returns spending converted to budget currency with correct percentage.
 */
export function buildBudgetProgressEntry(
  spentEur: number,
  budget: { category: string; limit_amount: number; currency: string },
): {
  category: string;
  spentInCurrency: number;
  limit: number;
  currency: CurrencyCode;
  percentage: number;
  is_exceeded: boolean;
  is_warning: boolean;
} {
  const currency = budget.currency as CurrencyCode;
  const spentInCurrency = convertCurrency(spentEur, BASE_CURRENCY, currency);
  const progress = computeBudgetProgress(budget, spentInCurrency);
  return {
    category: budget.category,
    spentInCurrency,
    limit: budget.limit_amount,
    currency,
    percentage: progress.percentage,
    is_exceeded: progress.is_exceeded,
    is_warning: progress.is_warning,
  };
}

/**
 * Compute overall budget totals in a given display currency.
 * All spending is in EUR; all limits may be in different currencies.
 */
export function buildBudgetTotals(
  categorySpendingEur: Record<string, number>,
  budgets: Array<{ category: string; limit_amount: number; currency: string }>,
  displayCurrency: CurrencyCode,
): { totalSpentDisplay: number; totalBudgetDisplay: number; percentage: number } {
  let totalSpentEur = 0;
  let totalBudgetEur = 0;
  for (const budget of budgets) {
    totalSpentEur += categorySpendingEur[budget.category] ?? 0;
    totalBudgetEur += convertCurrency(
      budget.limit_amount,
      budget.currency as CurrencyCode,
      BASE_CURRENCY,
    );
  }
  const totalSpentDisplay = convertCurrency(totalSpentEur, BASE_CURRENCY, displayCurrency);
  const totalBudgetDisplay = convertCurrency(totalBudgetEur, BASE_CURRENCY, displayCurrency);
  // Guard on display value: if all budgets have limit_amount=0, totalBudgetDisplay is 0 → return 0% not NaN
  const percentage =
    totalBudgetDisplay > 0 ? Math.round((totalSpentDisplay / totalBudgetDisplay) * 100) : 0;
  return { totalSpentDisplay, totalBudgetDisplay, percentage };
}
