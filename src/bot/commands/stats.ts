import { CURRENCY_SYMBOLS } from '../../config/constants';
import { database } from '../../database';
import { createLogger } from '../../utils/logger.ts';
import { formatErrorForUser } from '../bot-error-formatter';
import type { Ctx } from '../types';
import { maybeSmartAdvice } from './ask';

const logger = createLogger('cmd-stats');

/**
 * /stats command handler
 */
export async function handleStatsCommand(ctx: Ctx['Command']): Promise<void> {
  try {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!chatId) {
    await ctx.send('❌ Не удалось определить чат');
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
  message += '<b>По валютам:</b>\n';
  for (const [currency, total] of Object.entries(totalsByCurrency)) {
    const symbol = CURRENCY_SYMBOLS[currency as keyof typeof CURRENCY_SYMBOLS] || currency;
    message += `• ${symbol} ${total.toFixed(2)}\n`;
  }

  message += `\n<b>Всего (EUR):</b> €${totalEUR.toFixed(2)}\n`;

  message += `\n<b>Последние ${recentExpenses.length} расходов:</b>\n`;
  for (const expense of recentExpenses) {
    const symbol =
      CURRENCY_SYMBOLS[expense.currency as keyof typeof CURRENCY_SYMBOLS] || expense.currency;
    message += `• ${expense.date}: ${symbol}${expense.amount} - ${expense.category}\n`;
  }

  await ctx.send(message, { parse_mode: 'HTML' });

  // Maybe send daily advice (20% probability)
  await maybeSmartAdvice(ctx, group.id);
  } catch (error) {
    logger.error({ err: error }, '[CMD] Error in /stats');
    await ctx.send(formatErrorForUser(error));
  }
}
