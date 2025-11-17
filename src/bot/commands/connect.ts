import type { Ctx } from '../types';
import { database } from '../../database';
import { generateAuthUrl } from '../../services/google/oauth';
import { registerOAuthState } from '../../web/oauth-callback';
import { createExpenseSpreadsheet } from '../../services/google/sheets';
import { createCurrencyKeyboard } from '../keyboards';
import { MESSAGES, type CurrencyCode } from '../../config/constants';

/**
 * /connect command handler
 */
export async function handleConnectCommand(ctx: Ctx["Command"]): Promise<void> {
  const telegramId = ctx.from?.id;

  if (!telegramId) {
    await ctx.send('Error: Unable to identify user');
    return;
  }

  // Get or create user
  let user = database.users.findByTelegramId(telegramId);

  if (!user) {
    user = database.users.create({ telegram_id: telegramId });
  }

  // Generate OAuth URL
  const authUrl = generateAuthUrl(user.id);

  await ctx.send(
    `🔐 Подключение Google аккаунта\n\n` +
    `Нажми на ссылку ниже и разреши доступ к Google Sheets:\n\n` +
    `${authUrl}\n\n` +
    `После авторизации вернись сюда, я продолжу настройку.`
  );

  // Wait for OAuth callback
  const refreshToken = await new Promise<string>((resolve, reject) => {
    registerOAuthState(user!.id, resolve, reject);

    // Timeout after 5 minutes
    setTimeout(() => {
      reject(new Error('OAuth timeout'));
    }, 5 * 60 * 1000);
  }).catch(err => {
    console.error('OAuth error:', err);
    return null;
  });

  if (!refreshToken) {
    await ctx.send('❌ Не удалось подключить Google аккаунт. Попробуй еще раз: /connect');
    return;
  }

  await ctx.send(MESSAGES.authSuccess);

  // Show currency selection keyboard
  const keyboard = createCurrencyKeyboard();
  await ctx.send('Выбери валюту по умолчанию:', { reply_markup: keyboard });
}

/**
 * Handle currency selection callback
 */
export async function handleCurrencyCallback(
  ctx: Ctx["CallbackQuery"],
  action: string,
  telegramId: number
): Promise<void> {
  const user = database.users.findByTelegramId(telegramId);

  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Пользователь не найден' });
    return;
  }

  if (action === 'done') {
    // User finished selecting currencies
    if (user.enabled_currencies.length === 0) {
      await ctx.answerCallbackQuery({ text: 'Выбери хотя бы одну валюту' });
      return;
    }

    // Create spreadsheet
    try {
      const { spreadsheetId, spreadsheetUrl } = await createExpenseSpreadsheet(
        user.google_refresh_token!,
        user.default_currency,
        user.enabled_currencies
      );

      database.users.update(telegramId, { spreadsheet_id: spreadsheetId });

      await ctx.editText(
        MESSAGES.setupComplete.replace('{spreadsheetUrl}', spreadsheetUrl)
      );

      await ctx.answerCallbackQuery({ text: '✅ Настройка завершена!' });
    } catch (err) {
      console.error('Error creating spreadsheet:', err);
      await ctx.answerCallbackQuery({ text: '❌ Ошибка при создании таблицы' });
      await ctx.send('Произошла ошибка. Попробуй еще раз: /connect');
    }

    return;
  }

  // Toggle currency selection
  const currency = action as CurrencyCode;
  let enabledCurrencies = [...user.enabled_currencies];

  if (enabledCurrencies.includes(currency)) {
    // Deselect
    enabledCurrencies = enabledCurrencies.filter(c => c !== currency);

    // If this was default currency, clear it
    if (user.default_currency === currency) {
      database.users.update(telegramId, {
        enabled_currencies: enabledCurrencies,
        default_currency: enabledCurrencies[0] || 'USD',
      });
    } else {
      database.users.update(telegramId, { enabled_currencies: enabledCurrencies });
    }
  } else {
    // Select
    enabledCurrencies.push(currency);
    database.users.update(telegramId, { enabled_currencies: enabledCurrencies });

    // Set as default if it's the first one
    if (enabledCurrencies.length === 1) {
      database.users.update(telegramId, { default_currency: currency });
    }
  }

  // Update keyboard
  const updatedUser = database.users.findByTelegramId(telegramId);
  if (!updatedUser) return;

  const keyboard = createCurrencyKeyboard(updatedUser.enabled_currencies);

  await ctx.editReplyMarkup({
    inline_keyboard: keyboard.build().inline_keyboard,
  });
  await ctx.answerCallbackQuery({ text: `${currency} ${enabledCurrencies.includes(currency) ? 'добавлен' : 'удален'}` });
}
