import { InlineKeyboard } from 'gramio';
import { type CurrencyCode, MESSAGES } from '../../config/constants';
import { database } from '../../database';
import { generateAuthUrl } from '../../services/google/oauth';
import { createExpenseSpreadsheet } from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import { registerOAuthPromise, unregisterOAuthPromise } from '../../web/oauth-callback';
import { createCurrencyKeyboard, createDefaultCurrencyKeyboard } from '../keyboards';
import type { Ctx } from '../types';

const logger = createLogger('connect');

/**
 * /connect command handler - only works in groups
 */
export async function handleConnectCommand(ctx: Ctx['Command']): Promise<void> {
  const telegramId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  logger.info(`[CMD] /connect from user ${telegramId} in chat ${chatId} (${chatType})`);

  if (!telegramId || !chatId) {
    logger.info(`[CMD] Error: missing telegramId or chatId`);
    await ctx.send('Error: Unable to identify user or chat');
    return;
  }

  // Only allow in groups
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (!isGroup) {
    logger.info(`[CMD] Rejected: /connect only works in groups`);
    await ctx.send(
      '❌ Эта команда работает только в группах.\n\n' +
        'Добавь бота в группу и используй /connect там.',
    );
    return;
  }

  logger.info(`[CMD] Starting group setup for chat ${chatId}`);

  // Get or create group
  let group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    logger.info(`[CMD] Creating new group ${chatId}`);
    group = database.groups.create({ telegram_group_id: chatId });
  } else {
    logger.info(`[CMD] Group ${group.id} found`);

    // If group is already fully configured, don't re-run OAuth
    if (group.google_refresh_token && group.spreadsheet_id) {
      logger.info(`[CMD] Group ${group.id} already configured, skipping`);
      const spreadsheetUrl = `https://docs.google.com/spreadsheets/d/${group.spreadsheet_id}`;
      await ctx.send(
        `✅ Группа уже подключена к Google Sheets.\n\n` +
          `📊 <a href="${spreadsheetUrl}">Открыть таблицу</a>\n\n` +
          `Если нужно переподключить аккаунт, используй /reconnect`,
        { parse_mode: 'HTML' },
      );
      return;
    }
  }

  // Generate OAuth URL — state is a UUID mapped to group ID server-side
  logger.info(`[CMD] Generating OAuth URL for group ${group.id}`);
  const authUrl = generateAuthUrl(group.id);

  const authKeyboard = new InlineKeyboard().url('🔐 Подключить Google', authUrl);

  await ctx.send(
    `🔐 Подключение Google аккаунта для группы\n\n` +
      `Один из участников группы должен:\n` +
      `1. Нажать на кнопку ниже\n` +
      `2. Разрешить доступ к Google Sheets\n\n` +
      `После авторизации вернись сюда, я продолжу настройку.`,
    { reply_markup: authKeyboard },
  );

  // Wait for OAuth callback
  logger.info(`[CMD] Waiting for OAuth callback for group ${group.id}...`);
  const groupId = group.id;
  const refreshToken = await new Promise<string>((resolve, reject) => {
    registerOAuthPromise(groupId, resolve, reject);

    // Timeout after 5 minutes
    setTimeout(
      () => {
        unregisterOAuthPromise(groupId);
        reject(new Error('OAuth timeout'));
      },
      5 * 60 * 1000,
    );
  }).catch((err) => {
    logger.error({ err: err }, '[CMD] ❌ OAuth error');
    return null;
  });

  if (!refreshToken) {
    // Check if token was saved to DB by the callback anyway (race condition)
    const updatedGroup = database.groups.findByTelegramGroupId(chatId);
    if (updatedGroup?.google_refresh_token && updatedGroup?.spreadsheet_id) {
      // Group is fully configured — silently ignore the timeout
      logger.info(`[CMD] OAuth timeout but group ${groupId} already configured, ignoring`);
      return;
    }
    if (updatedGroup?.google_refresh_token) {
      logger.info(`[CMD] ✅ OAuth token found in DB despite timeout for group ${groupId}`);
      // Continue to currency selection below
    } else {
      logger.info(`[CMD] ❌ OAuth failed for group ${groupId}`);
      await ctx.send('❌ Не удалось подключить Google аккаунт. Попробуй еще раз: /connect');
      return;
    }
  } else {
    logger.info(`[CMD] ✅ OAuth successful for group ${groupId}`);
    await ctx.send(MESSAGES.authSuccess);
  }

  // Show currency set selection keyboard (Step 1)
  const keyboard = createCurrencyKeyboard();
  await ctx.send(
    '💱 Шаг 1/2: Выбери набор валют для учета:\n\n' +
      '• Можно выбрать несколько\n' +
      '• Эти валюты будут столбцами в таблице\n' +
      '• Нажми ✅ Далее когда закончишь',
    { reply_markup: keyboard },
  );
}

/**
 * Handle currency selection callback
 */
export async function handleCurrencyCallback(
  ctx: Ctx['CallbackQuery'],
  action: string,
  chatId: number,
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
      { reply_markup: keyboard },
    );

    await ctx.answerCallbackQuery({ text: 'Теперь выбери валюту по умолчанию' });
    return;
  }

  // Step 1: Toggle currency in the set
  const currency = action as CurrencyCode;
  let enabledCurrencies = [...group.enabled_currencies];

  if (enabledCurrencies.includes(currency)) {
    // Deselect
    enabledCurrencies = enabledCurrencies.filter((c) => c !== currency);
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
  ctx: Ctx['CallbackQuery'],
  action: string,
  chatId: number,
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
  logger.info(`[CMD] Creating spreadsheet for group ${chatId}...`);
  try {
    const { spreadsheetId, spreadsheetUrl } = await createExpenseSpreadsheet(
      group.google_refresh_token,
      currency,
      group.enabled_currencies,
    );

    logger.info(`[CMD] ✅ Spreadsheet created: ${spreadsheetId}`);

    database.groups.update(chatId, { spreadsheet_id: spreadsheetId });

    await ctx.editText(MESSAGES.setupComplete.replace('{spreadsheetUrl}', spreadsheetUrl));

    await ctx.answerCallbackQuery({ text: '✅ Настройка завершена!' });
    logger.info(`[CMD] ✅ Setup completed for group ${chatId}`);
  } catch (err) {
    logger.error({ err: err }, '[CMD] ❌ Error creating spreadsheet');
    await ctx.answerCallbackQuery({ text: '❌ Ошибка при создании таблицы' });
    await ctx.send('Произошла ошибка. Попробуй еще раз: /connect');
  }
}
