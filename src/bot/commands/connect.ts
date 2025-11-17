import type { Ctx } from '../types';
import { database } from '../../database';
import { generateAuthUrl } from '../../services/google/oauth';
import { registerOAuthState } from '../../web/oauth-callback';
import { createExpenseSpreadsheet } from '../../services/google/sheets';
import { createCurrencyKeyboard, createDefaultCurrencyKeyboard } from '../keyboards';
import { MESSAGES, type CurrencyCode } from '../../config/constants';
import { InlineKeyboard } from 'gramio';

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

  const authKeyboard = new InlineKeyboard().url('🔐 Подключить Google', authUrl);

  await ctx.send(
    `🔐 Подключение Google аккаунта\n\n` +
    `Нажми на кнопку ниже и разреши доступ к Google Sheets.\n\n` +
    `После авторизации вернись сюда, я продолжу настройку.`,
    { reply_markup: authKeyboard }
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

  // Show currency set selection keyboard (Step 1)
  const keyboard = createCurrencyKeyboard();
  await ctx.send(
    '💱 Шаг 1/2: Выбери набор валют для учета:\n\n' +
    '• Можно выбрать несколько\n' +
    '• Эти валюты будут столбцами в таблице\n' +
    '• Нажми ✅ Далее когда закончишь',
    { reply_markup: keyboard }
  );
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

  // Step 1: Currency set selection - user clicked "Далее"
  if (action === 'next') {
    if (user.enabled_currencies.length === 0) {
      await ctx.answerCallbackQuery({ text: 'Выбери хотя бы одну валюту' });
      return;
    }

    // Move to Step 2: Default currency selection
    const keyboard = createDefaultCurrencyKeyboard(user.enabled_currencies);

    await ctx.editText(
      '💱 Шаг 2/2: Выбери валюту по умолчанию:\n\n' +
      '• Эта валюта будет использоваться, если не указать явно\n' +
      '• Например, если выбрать EUR, то "100 еда обед" = 100 евро\n\n' +
      `📊 Набор валют: ${user.enabled_currencies.join(', ')}`,
      { reply_markup: keyboard }
    );

    await ctx.answerCallbackQuery({ text: 'Теперь выбери валюту по умолчанию' });
    return;
  }

  // Step 1: Toggle currency in the set
  const currency = action as CurrencyCode;
  let enabledCurrencies = [...user.enabled_currencies];

  if (enabledCurrencies.includes(currency)) {
    // Deselect
    enabledCurrencies = enabledCurrencies.filter(c => c !== currency);
    database.users.update(telegramId, { enabled_currencies: enabledCurrencies });
  } else {
    // Select
    enabledCurrencies.push(currency);
    database.users.update(telegramId, { enabled_currencies: enabledCurrencies });
  }

  // Update keyboard
  const updatedUser = database.users.findByTelegramId(telegramId);
  if (!updatedUser) return;

  const keyboard = createCurrencyKeyboard(updatedUser.enabled_currencies);

  // Update message with current status
  const statusText =
    '💱 Шаг 1/2: Выбери набор валют для учета:\n\n' +
    '• Можно выбрать несколько\n' +
    '• Эти валюты будут столбцами в таблице\n' +
    '• Нажми ✅ Далее когда закончишь\n\n' +
    `📊 Выбрано: ${updatedUser.enabled_currencies.join(', ') || 'нет'}`;

  await ctx.editText(statusText, {
    reply_markup: keyboard,
  });

  const action_text = enabledCurrencies.includes(currency) ? 'добавлена' : 'удалена';
  await ctx.answerCallbackQuery({ text: `${currency} ${action_text}` });
}

/**
 * Handle default currency selection callback (Step 2)
 */
export async function handleDefaultCurrencyCallback(
  ctx: Ctx["CallbackQuery"],
  action: string,
  telegramId: number
): Promise<void> {
  const user = database.users.findByTelegramId(telegramId);

  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Пользователь не найден' });
    return;
  }

  const currency = action as CurrencyCode;

  // Verify the currency is in enabled set
  if (!user.enabled_currencies.includes(currency)) {
    await ctx.answerCallbackQuery({ text: 'Ошибка: валюта не в наборе' });
    return;
  }

  // Set as default currency
  database.users.update(telegramId, { default_currency: currency });

  // Verify refresh token exists
  if (!user.google_refresh_token) {
    await ctx.answerCallbackQuery({ text: 'Ошибка: Google не подключен' });
    await ctx.send('Произошла ошибка. Попробуй еще раз: /connect');
    return;
  }

  // Create spreadsheet
  try {
    const { spreadsheetId, spreadsheetUrl } = await createExpenseSpreadsheet(
      user.google_refresh_token,
      currency,
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
}
