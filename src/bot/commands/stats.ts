import { CURRENCY_SYMBOLS, type CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import { formatAmount } from '../../services/currency/converter';
import type { Ctx } from '../types';
import { maybeSmartAdvice } from './ask';

/**
 * /stats command handler
 */
export async function handleStatsCommand(ctx: Ctx['Command']): Promise<void> {
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
    message += `• ${formatAmount(total, currency as CurrencyCode)}\n`;
  }

  message += `\n**Всего (EUR):** ${formatAmount(totalEUR, 'EUR')}\n`;

  message += `\n**Последние ${recentExpenses.length} расходов:**\n`;
  for (const expense of recentExpenses) {
    const symbol =
      CURRENCY_SYMBOLS[expense.currency as keyof typeof CURRENCY_SYMBOLS] || expense.currency;
    message += `• ${expense.date}: ${symbol}${expense.amount} - ${expense.category}\n`;
  }

  await ctx.send(message);

  // Maybe send daily advice (20% probability)
  await maybeSmartAdvice(ctx, group.id);
}
