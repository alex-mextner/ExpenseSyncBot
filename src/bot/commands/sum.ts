import { endOfMonth, format, startOfMonth } from 'date-fns';
import { getCategoryEmoji } from '../../config/category-emojis';
import type { CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import { convertCurrency, formatAmount } from '../../services/currency/converter';
import { createBudgetSheet, hasBudgetSheet } from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import type { Ctx } from '../types';
import { maybeSmartAdvice } from './ask';
import { silentSyncBudgets } from './budget';

const logger = createLogger('sum');

/**
 * /sum and /total command handler - show current month expenses summary
 */
export async function handleSumCommand(ctx: Ctx['Command']): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!chatId) {
    await ctx.send('Error: Unable to identify chat');
    return;
  }

  // Only allow in groups
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (!isGroup) {
    await ctx.send('❌ Эта команда работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    await ctx.send('❌ Группа не настроена. Используй /connect');
    return;
  }

  // Silent sync budgets from Google Sheets
  if (group.google_refresh_token && group.spreadsheet_id) {
    const syncedCount = await silentSyncBudgets(
      group.google_refresh_token,
      group.spreadsheet_id,
      group.id,
    );
    if (syncedCount > 0) {
      await ctx.send(`🔄 Синхронизировано записей бюджета: ${syncedCount}`);
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
    await ctx.send('📊 Пока нет расходов');
    return;
  }

  // Filter current month expenses
  const currentMonthExpenses = allExpenses.filter(
    (expense) => expense.date >= currentMonthStart && expense.date <= currentMonthEnd,
  );

  logger.info(`[SUM] Current month expenses: ${currentMonthExpenses.length}`);
  logger.info(`[SUM] Current month expenses details:`);
  currentMonthExpenses.forEach((exp) => {
    logger.info(
      `  - ${exp.date}: ${exp.amount} ${exp.currency} = ${exp.eur_amount} EUR (${exp.category})`,
    );
  });

  if (currentMonthExpenses.length === 0) {
    await ctx.send(`📊 В ${format(now, 'LLLL yyyy')} пока нет расходов`);
    return;
  }

  // Calculate current month total in EUR
  const currentMonthTotal = currentMonthExpenses.reduce((sum, exp) => sum + exp.eur_amount, 0);
  logger.info(`[SUM] Current month total: €${currentMonthTotal.toFixed(2)}`);

  // Calculate average per month (for all complete months)
  const expenses = allExpenses.filter((exp) => exp.date < currentMonthStart);

  const monthlyAverages: Record<string, number> = {};

  for (const expense of expenses) {
    const monthKey = expense.date.substring(0, 7); // YYYY-MM
    if (!monthlyAverages[monthKey]) {
      monthlyAverages[monthKey] = 0;
    }
    monthlyAverages[monthKey] += expense.eur_amount;
  }

  const monthsCount = Object.keys(monthlyAverages).length;
  const averagePerMonth =
    monthsCount > 0
      ? Object.values(monthlyAverages).reduce((sum, val) => sum + val, 0) / monthsCount
      : 0;

  // Calculate difference
  const difference = currentMonthTotal - averagePerMonth;
  const percentDifference = averagePerMonth > 0 ? (difference / averagePerMonth) * 100 : 0;

  // Convert EUR totals to group's display currency for user output
  const displayCurrency = group.default_currency;
  const currentMonthTotalDisplay = convertCurrency(currentMonthTotal, 'EUR', displayCurrency);
  const averagePerMonthDisplay = convertCurrency(averagePerMonth, 'EUR', displayCurrency);
  const differenceDisplay = convertCurrency(difference, 'EUR', displayCurrency);

  // Calculate category statistics for current month
  const categoryTotals: Record<string, number> = {};
  for (const expense of currentMonthExpenses) {
    if (!categoryTotals[expense.category]) {
      categoryTotals[expense.category] = 0;
    }
    categoryTotals[expense.category] = (categoryTotals[expense.category] ?? 0) + expense.eur_amount;
  }

  // Calculate category averages from previous months
  const categoryAverages: Record<string, { sum: number; count: number }> = {};
  for (const expense of expenses) {
    if (!categoryAverages[expense.category]) {
      categoryAverages[expense.category] = { sum: 0, count: 0 };
    }
  }

  // Count unique months per category
  const categoryMonths: Record<string, Set<string>> = {};
  for (const expense of expenses) {
    const monthKey = expense.date.substring(0, 7);
    if (!categoryMonths[expense.category]) {
      categoryMonths[expense.category] = new Set();
    }
    categoryMonths[expense.category]?.add(monthKey);
  }

  // Calculate average per category
  for (const expense of expenses) {
    if (!categoryAverages[expense.category]) {
      categoryAverages[expense.category] = { sum: 0, count: 0 };
    }
    const avgEntry = categoryAverages[expense.category];
    if (avgEntry) avgEntry.sum += expense.eur_amount;
  }

  // Calculate category differences
  const categoryDifferences: Array<{
    category: string;
    diff: number;
    percent: number;
  }> = [];

  for (const [category, currentTotal] of Object.entries(categoryTotals)) {
    const monthsWithCategory = categoryMonths[category]?.size || 0;
    const categoryAvg = categoryAverages[category];
    const avgForCategory =
      monthsWithCategory > 0 && categoryAvg ? categoryAvg.sum / monthsWithCategory : 0;

    if (avgForCategory > 0) {
      const diff = currentTotal - avgForCategory;
      const percent = (diff / avgForCategory) * 100;
      categoryDifferences.push({ category, diff, percent });
    }
  }

  // Sort by absolute percent difference
  categoryDifferences.sort((a, b) => Math.abs(b.percent) - Math.abs(a.percent));

  // Build message
  let message = `📊 Расходы за ${format(now, 'LLLL yyyy')}\n\n`;
  message += `💰 Всего: ${formatAmount(currentMonthTotalDisplay, displayCurrency)}\n`;

  if (monthsCount > 0) {
    message += `📈 Средняя: ${formatAmount(averagePerMonthDisplay, displayCurrency)}\n`;

    if (difference > 0) {
      message += `📊 Разница: +${formatAmount(differenceDisplay, displayCurrency)} (+${percentDifference.toFixed(1)}%)\n`;
    } else if (difference < 0) {
      message += `📊 Разница: ${formatAmount(differenceDisplay, displayCurrency)} (${percentDifference.toFixed(1)}%)\n`;
    } else {
      message += `📊 Разница: точно в среднем\n`;
    }
  }

  // Show top categories above/below average
  if (categoryDifferences.length > 0) {
    message += `\n🔥 Больше среднего:\n`;

    const above = categoryDifferences.filter((c) => c.percent > 5);
    if (above.length > 0) {
      for (const { category, diff, percent } of above.slice(0, 3)) {
        const diffDisplay = convertCurrency(diff, 'EUR', displayCurrency);
        message += `  • ${category}: +${formatAmount(diffDisplay, displayCurrency)} (+${percent.toFixed(1)}%)\n`;
      }
    } else {
      message += `  • Нет категорий\n`;
    }

    message += `\n❄️ Меньше среднего:\n`;
    const below = categoryDifferences.filter((c) => c.percent < -5);
    if (below.length > 0) {
      // Sort by percent ascending (most negative first)
      below.sort((a, b) => a.percent - b.percent);
      for (const { category, diff, percent } of below.slice(0, 3)) {
        const diffDisplay = convertCurrency(diff, 'EUR', displayCurrency);
        message += `  • ${category}: ${formatAmount(diffDisplay, displayCurrency)} (${percent.toFixed(1)}%)\n`;
      }
    } else {
      message += `  • Нет категорий\n`;
    }
  }

  // Add budget information
  await addBudgetInfo(message, group, currentMonthExpenses, ctx);

  // Maybe send daily advice (20% probability)
  await maybeSmartAdvice(ctx, group.id);
}

/**
 * Add budget information to /sum output
 */
async function addBudgetInfo(
  baseMessage: string,
  group: {
    id: number;
    google_refresh_token: string | null;
    spreadsheet_id: string | null;
    default_currency: import('../../config/constants').CurrencyCode;
  },
  currentMonthExpenses: Array<{ category: string; eur_amount: number }>,
  ctx: Ctx['Command'],
): Promise<void> {
  const now = new Date();
  const currentMonth = format(now, 'yyyy-MM');

  // Ensure Budget sheet exists
  if (group.google_refresh_token && group.spreadsheet_id) {
    const hasSheet = await hasBudgetSheet(group.google_refresh_token, group.spreadsheet_id);
    if (!hasSheet) {
      const categories = database.categories.getCategoryNames(group.id);
      if (categories.length > 0) {
        try {
          await createBudgetSheet(
            group.google_refresh_token,
            group.spreadsheet_id,
            categories,
            100,
            group.default_currency,
          );
          logger.info('[SUM] Budget sheet created');
        } catch (err) {
          logger.error({ err: err }, '[SUM] Failed to create Budget sheet');
        }
      }
    }
  }

  // Get budgets for current month
  const budgets = database.budgets.getAllBudgetsForMonth(group.id, currentMonth);

  if (budgets.length === 0) {
    // No budgets set - just send base message
    await ctx.send(baseMessage);
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

  await ctx.send(baseMessage + budgetMessage);
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
  const spentInCurrency = convertCurrency(spentEur, 'EUR', currency);
  const percentage =
    budget.limit_amount > 0 ? Math.round((spentInCurrency / budget.limit_amount) * 100) : 0;
  return {
    category: budget.category,
    spentInCurrency,
    limit: budget.limit_amount,
    currency,
    percentage,
    is_exceeded: spentInCurrency > budget.limit_amount,
    is_warning: percentage >= 90 && spentInCurrency <= budget.limit_amount,
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
    totalBudgetEur += convertCurrency(budget.limit_amount, budget.currency as CurrencyCode, 'EUR');
  }
  const totalSpentDisplay = convertCurrency(totalSpentEur, 'EUR', displayCurrency);
  const totalBudgetDisplay = convertCurrency(totalBudgetEur, 'EUR', displayCurrency);
  const percentage =
    totalBudgetDisplay > 0 ? Math.round((totalSpentDisplay / totalBudgetDisplay) * 100) : 0;
  return { totalSpentDisplay, totalBudgetDisplay, percentage };
}
