import type { Ctx } from '../types';
import { database } from '../../database';
import { getSpreadsheetUrl } from '../../services/google/sheets';
import { CURRENCY_SYMBOLS } from '../../config/constants';

/**
 * /settings command handler
 */
export async function handleSettingsCommand(ctx: Ctx["Command"]): Promise<void> {
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

  let message = '⚙️ **Настройки**\n\n';

  // Default currency
  const defaultSymbol = CURRENCY_SYMBOLS[user.default_currency];
  message += `**Валюта по умолчанию:** ${user.default_currency} ${defaultSymbol}\n\n`;

  // Enabled currencies
  message += '**Активные валюты:**\n';
  for (const currency of user.enabled_currencies) {
    const symbol = CURRENCY_SYMBOLS[currency];
    message += `• ${currency} ${symbol}\n`;
  }

  // Spreadsheet
  if (user.spreadsheet_id) {
    const url = getSpreadsheetUrl(user.spreadsheet_id);
    message += `\n**Google Таблица:** [Открыть](${url})`;
  }

  message += '\n\n_Чтобы изменить настройки, используй /reconnect_';

  await ctx.send(message, { parse_mode: 'Markdown' });
}

/**
 * /reconnect command handler
 */
export async function handleReconnectCommand(ctx: Ctx["Command"]): Promise<void> {
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

  await ctx.send(
    '🔄 Переподключение к Google\n\n' +
    'Это создаст новую таблицу и сбросит текущие настройки.\n\n' +
    'Используй /connect чтобы начать.'
  );
}
