import type { Ctx } from '../types';
import { database } from '../../database';
import { generateAuthUrl } from '../../services/google/oauth';
import { registerOAuthState } from '../../web/oauth-callback';
import { createExpenseSpreadsheet } from '../../services/google/sheets';
import { createCurrencyKeyboard, createDefaultCurrencyKeyboard } from '../keyboards';
import { MESSAGES, type CurrencyCode } from '../../config/constants';
import { InlineKeyboard } from 'gramio';

/**
 * /connect command handler - only works in groups
 */
export async function handleConnectCommand(ctx: Ctx["Command"]): Promise<void> {
  const telegramId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  console.log(`[CMD] /connect from user ${telegramId} in chat ${chatId} (${chatType})`);

  if (!telegramId || !chatId) {
    console.log(`[CMD] Error: missing telegramId or chatId`);
    await ctx.send('Error: Unable to identify user or chat');
    return;
  }

  // Only allow in groups
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (!isGroup) {
    console.log(`[CMD] Rejected: /connect only works in groups`);
    await ctx.send(
      '❌ Эта команда работает только в группах.\n\n' +
      'Добавь бота в группу и используй /connect там.'
    );
    return;
  }

  console.log(`[CMD] Starting group setup for chat ${chatId}`);

  // Get or create group
  let group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    console.log(`[CMD] Creating new group ${chatId}`);
    group = database.groups.create({ telegram_group_id: chatId });
  } else {
    console.log(`[CMD] Group ${group.id} found, reconfiguring...`);
  }

  // Generate OAuth URL - use group ID as state
  console.log(`[CMD] Generating OAuth URL for group ${group.id}`);
  const authUrl = generateAuthUrl(group.id);

  const authKeyboard = new InlineKeyboard().url('🔐 Подключить Google', authUrl);

  await ctx.send(
    `🔐 Подключение Google аккаунта для группы\n\n` +
    `Один из участников группы должен:\n` +
    `1. Нажать на кнопку ниже\n` +
    `2. Разрешить доступ к Google Sheets\n\n` +
    `После авторизации вернись сюда, я продолжу настройку.`,
    { reply_markup: authKeyboard }
  );

  // Wait for OAuth callback
  console.log(`[CMD] Waiting for OAuth callback for group ${group.id}...`);
  const refreshToken = await new Promise<string>((resolve, reject) => {
    registerOAuthState(group!.id, resolve, reject);

    // Timeout after 5 minutes
    setTimeout(() => {
      reject(new Error('OAuth timeout'));
    }, 5 * 60 * 1000);
  }).catch(err => {
    console.error('[CMD] ❌ OAuth error:', err);
    return null;
  });

  if (!refreshToken) {
    console.log(`[CMD] ❌ OAuth failed for group ${group.id}`);
    await ctx.send('❌ Не удалось подключить Google аккаунт. Попробуй еще раз: /connect');
    return;
  }

  console.log(`[CMD] ✅ OAuth successful for group ${group.id}`);
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
  chatId: number
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  // Step 1: Currency set selection - user clicked "Далее"
  if (action === 'next') {
    if (group.enabled_currencies.length === 0) {
      await ctx.answerCallbackQuery({ text: 'Выбери хотя бы одну валюту' });
      return;
    }

    // Move to Step 2: Default currency selection
    const keyboard = createDefaultCurrencyKeyboard(group.enabled_currencies);

    await ctx.editText(
      '💱 Шаг 2/2: Выбери валюту по умолчанию:\n\n' +
      '• Эта валюта будет использоваться, если не указать явно\n' +
      '• Например, если выбрать EUR, то "100 еда обед" = 100 евро\n\n' +
      `📊 Набор валют: ${group.enabled_currencies.join(', ')}`,
      { reply_markup: keyboard }
    );

    await ctx.answerCallbackQuery({ text: 'Теперь выбери валюту по умолчанию' });
    return;
  }

  // Step 1: Toggle currency in the set
  const currency = action as CurrencyCode;
  let enabledCurrencies = [...group.enabled_currencies];

  if (enabledCurrencies.includes(currency)) {
    // Deselect
    enabledCurrencies = enabledCurrencies.filter(c => c !== currency);
    database.groups.update(chatId, { enabled_currencies: enabledCurrencies });
  } else {
    // Select
    enabledCurrencies.push(currency);
    database.groups.update(chatId, { enabled_currencies: enabledCurrencies });
  }

  // Update keyboard
  const updatedGroup = database.groups.findByTelegramGroupId(chatId);
  if (!updatedGroup) return;

  const keyboard = createCurrencyKeyboard(updatedGroup.enabled_currencies);

  // Update message with current status
  const statusText =
    '💱 Шаг 1/2: Выбери набор валют для учета:\n\n' +
    '• Можно выбрать несколько\n' +
    '• Эти валюты будут столбцами в таблице\n' +
    '• Нажми ✅ Далее когда закончишь\n\n' +
    `📊 Выбрано: ${updatedGroup.enabled_currencies.join(', ') || 'нет'}`;

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
  chatId: number
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return;
  }

  const currency = action as CurrencyCode;

  // Verify the currency is in enabled set
  if (!group.enabled_currencies.includes(currency)) {
    await ctx.answerCallbackQuery({ text: 'Ошибка: валюта не в наборе' });
    return;
  }

  // Set as default currency
  database.groups.update(chatId, { default_currency: currency });

  // Verify refresh token exists
  if (!group.google_refresh_token) {
    await ctx.answerCallbackQuery({ text: 'Ошибка: Google не подключен' });
    await ctx.send('Произошла ошибка. Попробуй еще раз: /connect');
    return;
  }

  // Create spreadsheet
  console.log(`[CMD] Creating spreadsheet for group ${chatId}...`);
  try {
    const { spreadsheetId, spreadsheetUrl } = await createExpenseSpreadsheet(
      group.google_refresh_token,
      currency,
      group.enabled_currencies
    );

    console.log(`[CMD] ✅ Spreadsheet created: ${spreadsheetId}`);

    database.groups.update(chatId, { spreadsheet_id: spreadsheetId });

    await ctx.editText(
      MESSAGES.setupComplete.replace('{spreadsheetUrl}', spreadsheetUrl)
    );

    await ctx.answerCallbackQuery({ text: '✅ Настройка завершена!' });
    console.log(`[CMD] ✅ Setup completed for group ${chatId}`);
  } catch (err) {
    console.error('[CMD] ❌ Error creating spreadsheet:', err);
    await ctx.answerCallbackQuery({ text: '❌ Ошибка при создании таблицы' });
    await ctx.send('Произошла ошибка. Попробуй еще раз: /connect');
  }
}
