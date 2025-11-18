import type { Ctx } from '../types';
import { database } from '../../database';
import { format, startOfMonth, endOfMonth, subMonths, startOfDay } from 'date-fns';

/**
 * /sum and /total command handler - show current month expenses summary
 */
export async function handleSumCommand(ctx: Ctx["Command"]): Promise<void> {
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

  // Get current month boundaries
  const now = new Date();
  const currentMonthStart = format(startOfMonth(now), 'yyyy-MM-dd');
  const currentMonthEnd = format(endOfMonth(now), 'yyyy-MM-dd');

  // Get all expenses for the group (with high limit to get all)
  const allExpenses = database.expenses.findByGroupId(group.id, 100000);

  console.log(`[SUM] Group ${group.id}: Total expenses: ${allExpenses.length}`);
  console.log(`[SUM] Date range: ${currentMonthStart} to ${currentMonthEnd}`);

  if (allExpenses.length === 0) {
    await ctx.send('📊 Пока нет расходов');
    return;
  }

  // Filter current month expenses
  const currentMonthExpenses = allExpenses.filter(
    expense => expense.date >= currentMonthStart && expense.date <= currentMonthEnd
  );

  console.log(`[SUM] Current month expenses: ${currentMonthExpenses.length}`);
  console.log(`[SUM] Current month expenses details:`);
  currentMonthExpenses.forEach(exp => {
    console.log(`  - ${exp.date}: ${exp.amount} ${exp.currency} = ${exp.eur_amount} EUR (${exp.category})`);
  });

  if (currentMonthExpenses.length === 0) {
    await ctx.send(`📊 В ${format(now, 'LLLL yyyy')} пока нет расходов`);
    return;
  }

  // Calculate current month total in EUR
  const currentMonthTotal = currentMonthExpenses.reduce((sum, exp) => sum + exp.eur_amount, 0);
  console.log(`[SUM] Current month total: €${currentMonthTotal.toFixed(2)}`);

  // Calculate average per month (for all complete months)
  const expenses = allExpenses.filter(exp => exp.date < currentMonthStart);

  let monthlyAverages: Record<string, number> = {};

  for (const expense of expenses) {
    const monthKey = expense.date.substring(0, 7); // YYYY-MM
    if (!monthlyAverages[monthKey]) {
      monthlyAverages[monthKey] = 0;
    }
    monthlyAverages[monthKey] += expense.eur_amount;
  }

  const monthsCount = Object.keys(monthlyAverages).length;
  const averagePerMonth = monthsCount > 0
    ? Object.values(monthlyAverages).reduce((sum, val) => sum + val, 0) / monthsCount
    : 0;

  // Calculate difference
  const difference = currentMonthTotal - averagePerMonth;
  const percentDifference = averagePerMonth > 0
    ? ((difference / averagePerMonth) * 100)
    : 0;

  // Calculate category statistics for current month
  const categoryTotals: Record<string, number> = {};
  for (const expense of currentMonthExpenses) {
    if (!categoryTotals[expense.category]) {
      categoryTotals[expense.category] = 0;
    }
    categoryTotals[expense.category]! += expense.eur_amount;
  }

  // Calculate category averages from previous months
  const categoryAverages: Record<string, { sum: number; count: number }> = {};
  for (const expense of expenses) {
    const monthKey = expense.date.substring(0, 7);
    const key = `${expense.category}:${monthKey}`;

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
    categoryMonths[expense.category]!.add(monthKey);
  }

  // Calculate average per category
  for (const expense of expenses) {
    if (!categoryAverages[expense.category]) {
      categoryAverages[expense.category] = { sum: 0, count: 0 };
    }
    categoryAverages[expense.category]!.sum += expense.eur_amount;
  }

  // Calculate category differences
  const categoryDifferences: Array<{ category: string; diff: number; percent: number }> = [];

  for (const [category, currentTotal] of Object.entries(categoryTotals)) {
    const monthsWithCategory = categoryMonths[category]?.size || 0;
    const categoryAvg = categoryAverages[category];
    const avgForCategory = monthsWithCategory > 0 && categoryAvg
      ? categoryAvg.sum / monthsWithCategory
      : 0;

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
  message += `💰 Всего: €${currentMonthTotal.toFixed(2)}\n`;

  if (monthsCount > 0) {
    message += `📈 Средняя: €${averagePerMonth.toFixed(2)}\n`;

    if (difference > 0) {
      message += `📊 Разница: +€${difference.toFixed(2)} (+${percentDifference.toFixed(1)}%)\n`;
    } else if (difference < 0) {
      message += `📊 Разница: €${difference.toFixed(2)} (${percentDifference.toFixed(1)}%)\n`;
    } else {
      message += `📊 Разница: точно в среднем\n`;
    }
  }

  // Show top categories above/below average
  if (categoryDifferences.length > 0) {
    message += `\n🔥 Больше среднего:\n`;

    const above = categoryDifferences.filter(c => c.percent > 5);
    if (above.length > 0) {
      for (const { category, diff, percent } of above.slice(0, 3)) {
        message += `  • ${category}: +€${diff.toFixed(2)} (+${percent.toFixed(1)}%)\n`;
      }
    } else {
      message += `  • Нет категорий\n`;
    }

    message += `\n❄️ Меньше среднего:\n`;
    const below = categoryDifferences.filter(c => c.percent < -5);
    if (below.length > 0) {
      // Sort by percent ascending (most negative first)
      below.sort((a, b) => a.percent - b.percent);
      for (const { category, diff, percent } of below.slice(0, 3)) {
        message += `  • ${category}: €${diff.toFixed(2)} (${percent.toFixed(1)}%)\n`;
      }
    } else {
      message += `  • Нет категорий\n`;
    }
  }

  await ctx.send(message);
}
