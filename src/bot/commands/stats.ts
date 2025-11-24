import type { Ctx } from '../types';
import { database } from '../../database';
import { CURRENCY_SYMBOLS } from '../../config/constants';
import { maybeSendDailyAdvice } from './ask';

/**
 * /stats command handler
 */
export async function handleStatsCommand(ctx: Ctx["Command"]): Promise<void> {
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

  // Get expenses stats
  const recentExpenses = database.expenses.findByGroupId(group.id, 10);
  const totalsByCurrency = database.expenses.getTotalsByCurrency(group.id);
  const totalEUR = database.expenses.getTotalInEUR(group.id);

  let message = '📊 Статистика расходов группы:\n\n';

  // Total by currency
  message += '**По валютам:**\n';
  for (const [currency, total] of Object.entries(totalsByCurrency)) {
    const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || currency;
    message += `• ${symbol} ${total.toFixed(2)}\n`;
  }

  message += `\n**Всего (EUR):** €${totalEUR.toFixed(2)}\n`;

  message += `\n**Последние ${recentExpenses.length} расходов:**\n`;
  for (const expense of recentExpenses) {
    const symbol = CURRENCY_SYMBOLS[expense.currency as keyof typeof CURRENCY_SYMBOLS] || expense.currency;
    message += `• ${expense.date}: ${symbol}${expense.amount} - ${expense.category}\n`;
  }

  await ctx.send(message);

  // Maybe send daily advice (20% probability)
  await maybeSendDailyAdvice(ctx, group.id);
}
