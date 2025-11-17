import type { Ctx } from '../types';
import { database } from '../../database';
import { CURRENCY_SYMBOLS } from '../../config/constants';

/**
 * /stats command handler
 */
export async function handleStatsCommand(ctx: Ctx["Command"]): Promise<void> {
  const telegramId = ctx.from?.id;

  if (!telegramId) {
    await ctx.send('Error: Unable to identify user');
    return;
  }

  const user = database.users.findByTelegramId(telegramId);

  if (!user) {
    await ctx.send('Пожалуйста, начни с команды /start');
    return;
  }

  if (!database.users.hasCompletedSetup(telegramId)) {
    await ctx.send('Пожалуйста, завершите настройку: /connect');
    return;
  }

  // Get expenses
  const expenses = database.expenses.findByUserId(user.id, 100);

  if (expenses.length === 0) {
    await ctx.send('📊 У тебя пока нет расходов');
    return;
  }

  // Calculate totals
  const totalsByCurrency = database.expenses.getTotalsByCurrency(user.id);
  const totalUSD = database.expenses.getTotalInUSD(user.id);

  // Format message
  let message = '📊 **Статистика расходов**\n\n';

  message += '**По валютам:**\n';
  for (const [currency, total] of Object.entries(totalsByCurrency)) {
    const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || currency;
    message += `• ${symbol} ${total.toFixed(2)}\n`;
  }

  message += `\n**Всего в USD:** $${totalUSD.toFixed(2)}\n`;
  message += `\n**Всего записей:** ${expenses.length}`;

  // Get top categories
  const categoryCounts: Record<string, number> = {};
  for (const expense of expenses) {
    categoryCounts[expense.category] = (categoryCounts[expense.category] || 0) + 1;
  }

  const topCategories = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);

  if (topCategories.length > 0) {
    message += '\n\n**Топ категорий:**\n';
    for (const [category, count] of topCategories) {
      message += `• ${category}: ${count} ${count === 1 ? 'расход' : 'расходов'}\n`;
    }
  }

  await ctx.send(message, { parse_mode: 'Markdown' });
}
