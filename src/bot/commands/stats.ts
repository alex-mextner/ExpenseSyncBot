/** /stats command handler — shows per-currency expense totals and category breakdown */
import { InlineKeyboard } from 'gramio';
import { BASE_CURRENCY, type CurrencyCode, getCurrencySymbol } from '../../config/constants';
import { database } from '../../database';
import type { Group } from '../../database/types';
import { convertCurrency, formatAmount } from '../../services/currency/converter';
import { createLogger } from '../../utils/logger.ts';
import { buildMiniAppUrl } from '../../utils/miniapp-url';
import { formatErrorForUser } from '../bot-error-formatter';
import { sendToChat } from '../send';
import type { Ctx } from '../types';
import { maybeSmartAdvice } from './ask';

const logger = createLogger('cmd-stats');

/**
 * /stats command handler
 */
export async function handleStatsCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  void ctx;
  try {
    // Get expenses stats
    const recentExpenses = database.expenses.findByGroupId(group.id, 10);
    const totalsByCurrency = database.expenses.getTotalsByCurrency(group.id);
    const totalEUR = database.expenses.getTotalInEUR(group.id);

    let message = '📊 Статистика расходов группы:\n\n';

    // Total by currency
    message += '<b>По валютам:</b>\n';
    for (const [currency, total] of Object.entries(totalsByCurrency)) {
      message += `• ${formatAmount(total, currency as CurrencyCode)}\n`;
    }

    const totalDisplay = convertCurrency(totalEUR, BASE_CURRENCY, group.default_currency);
    message += `\n<b>Всего:</b> ${formatAmount(totalDisplay, group.default_currency)}\n`;

    message += `\n<b>Последние ${recentExpenses.length} расходов:</b>\n`;
    for (const expense of recentExpenses) {
      const symbol = getCurrencySymbol(expense.currency);
      message += `• ${expense.date}: ${symbol}${expense.amount} - ${expense.category}\n`;
    }

    const miniAppUrl = buildMiniAppUrl('dashboard');
    const keyboard = miniAppUrl ? new InlineKeyboard().url('📊 Дашборд', miniAppUrl) : undefined;

    await sendToChat(message, {
      parse_mode: 'HTML',
      ...(keyboard ? { reply_markup: keyboard } : {}),
    });

    // Maybe send daily advice (20% probability)
    await maybeSmartAdvice(group.id);
  } catch (error) {
    logger.error({ err: error }, '[CMD] Error in /stats');
    await sendToChat(formatErrorForUser(error));
  }
}
