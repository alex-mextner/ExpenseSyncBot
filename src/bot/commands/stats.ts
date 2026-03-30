import { BASE_CURRENCY, CURRENCY_SYMBOLS, type CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import type { Group } from '../../database/types';
import { convertCurrency, formatAmount } from '../../services/currency/converter';
import type { Ctx } from '../types';
import { maybeSmartAdvice } from './ask';

/**
 * /stats command handler
 */
export async function handleStatsCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
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

  const totalDisplay = convertCurrency(totalEUR, BASE_CURRENCY, group.default_currency);
  message += `\n**Всего:** ${formatAmount(totalDisplay, group.default_currency)}\n`;

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
