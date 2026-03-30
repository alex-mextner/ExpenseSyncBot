/** /connect command handler — group setup with optional Google Sheets */
import { InlineKeyboard } from 'gramio';
import { type CurrencyCode, MESSAGES } from '../../config/constants';
import { env } from '../../config/env';
import { database } from '../../database';
import { generateAuthUrl } from '../../services/google/oauth';
import { createExpenseSpreadsheet } from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import { registerOAuthState, unregisterOAuthState } from '../../web/oauth-callback';
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

    // If group is already fully configured with Google, don't re-run OAuth
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

    // If group has completed setup without Google, offer to connect Google
    if (database.groups.hasCompletedSetup(chatId) && !group.google_refresh_token) {
      await startGoogleOAuth(ctx, group.id, chatId);
      return;
    }
  }

  // Show Google connection choice
  const keyboard = new InlineKeyboard()
    .text('🔐 Подключить Google Sheets', `setup:google:${group.id}`)
    .row()
    .text('⏩ Пропустить (подключить позже)', `setup:skip_google:${group.id}`);

  await ctx.send(
    `👋 Настройка бота для группы\n\n` +
      `<b>Google Sheets</b> позволяет:\n` +
      `• Все расходы — в твоей таблице, ты владелец\n` +
      `• Редактировать руками — бот подхватит изменения\n` +
      `• Добавлять формулы, графики, сводные таблицы\n` +
      `• Делиться с семьёй или бухгалтером\n` +
      `• Скачать как CSV/Excel\n\n` +
      `Можно подключить сейчас или позже через /connect.`,
    { parse_mode: 'HTML', reply_markup: keyboard },
  );
}

/**
 * Handle setup choice callback (Google or Skip)
 */
export async function handleSetupChoiceCallback(
  ctx: Ctx['CallbackQuery'],
  action: string,
): Promise<void> {
  const parts = action.split(':');
  const choice = parts[0]; // 'google' or 'skip_google'
  const groupId = Number.parseInt(parts[1] || '', 10);

  if (!groupId) {
    await ctx.answerCallbackQuery({ text: 'Ошибка: группа не найдена' });
    return;
  }

  const group = database.groups.findById(groupId);
  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Ошибка: группа не найдена' });
    return;
  }

  if (choice === 'google') {
    await ctx.answerCallbackQuery({ text: 'Подключаем Google...' });
    await startGoogleOAuth(ctx, groupId, group.telegram_group_id);
  } else if (choice === 'skip_google') {
    await ctx.answerCallbackQuery({ text: 'Google пропущен' });
    await ctx.editText('⏩ Google Sheets пропущен. Можно подключить позже через /connect.');
    await startCurrencySelection(ctx, group.telegram_group_id);
  }
}

/**
 * Start Google OAuth flow
 */
async function startGoogleOAuth(
  ctx: Ctx['Command'] | Ctx['CallbackQuery'],
  groupId: number,
  chatId: number,
): Promise<void> {
  logger.info(`[CMD] Generating OAuth URL for group ${groupId}`);
  const authUrl = generateAuthUrl(groupId);

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
  logger.info(`[CMD] Waiting for OAuth callback for group ${groupId}...`);
  const refreshToken = await new Promise<string>((resolve, reject) => {
    registerOAuthState(groupId, resolve, reject);

    // Timeout after 5 minutes
    setTimeout(
      () => {
        unregisterOAuthState(groupId);
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

  // If group already has currencies (reconnecting Google), go straight to spreadsheet creation
  const group = database.groups.findByTelegramGroupId(chatId);
  if (group && group.enabled_currencies.length > 0 && group.default_currency) {
    await createSpreadsheetForGroup(ctx, chatId);
    return;
  }

  await startCurrencySelection(ctx, chatId);
}

/**
 * Start currency selection flow (Step 1/2)
 */
async function startCurrencySelection(
  ctx: Ctx['Command'] | Ctx['CallbackQuery'],
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  const keyboard = createCurrencyKeyboard(group?.enabled_currencies);
  await ctx.send(
    '💱 Шаг 1/2: Выбери набор валют для учета:\n\n' +
      '• Можно выбрать несколько\n' +
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

  // If Google is connected, create spreadsheet
  if (group.google_refresh_token) {
    await createSpreadsheetForGroup(ctx, chatId);
  } else {
    // No Google — setup complete without spreadsheet
    await ctx.editText(
      `✅ Настройка завершена!\n\n` +
        `Валюта по умолчанию: <b>${currency}</b>\n` +
        `Набор валют: ${group.enabled_currencies.join(', ')}\n\n` +
        `Пиши расходы в чат: <code>100 еда обед</code>\n` +
        `Подключить Google Sheets можно позже: /connect`,
      { parse_mode: 'HTML' },
    );
    await ctx.answerCallbackQuery({ text: '✅ Настройка завершена!' });
    await setMiniAppMenuButton(ctx, chatId);
    await sendTopicRecommendation(ctx, chatId);
    logger.info(`[CMD] ✅ Setup completed for group ${chatId} (without Google Sheets)`);
  }
}

/**
 * Create spreadsheet for a group that has Google tokens and currencies configured
 */
async function createSpreadsheetForGroup(
  ctx: Ctx['CallbackQuery'] | Ctx['Command'],
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group || !group.google_refresh_token || !group.default_currency) {
    await ctx.send('Произошла ошибка. Попробуй еще раз: /connect');
    return;
  }

  logger.info(`[CMD] Creating spreadsheet for group ${chatId}...`);
  try {
    const { spreadsheetId, spreadsheetUrl } = await createExpenseSpreadsheet(
      group.google_refresh_token,
      group.default_currency as CurrencyCode,
      group.enabled_currencies,
    );

    logger.info(`[CMD] ✅ Spreadsheet created: ${spreadsheetId}`);

    database.groups.update(chatId, { spreadsheet_id: spreadsheetId });

    await ctx.send(MESSAGES.setupComplete.replace('{spreadsheetUrl}', spreadsheetUrl));
    await setMiniAppMenuButton(ctx, chatId);
    await sendTopicRecommendation(ctx, chatId);
    logger.info(`[CMD] ✅ Setup completed for group ${chatId}`);
  } catch (err) {
    logger.error({ err: err }, '[CMD] ❌ Error creating spreadsheet');
    await ctx.send('❌ Ошибка при создании таблицы. Попробуй еще раз: /connect');
  }
}

/**
 * Set a persistent Mini App menu button for the chat after successful setup.
 */
async function setMiniAppMenuButton(
  ctx: Ctx['CallbackQuery'] | Ctx['Command'],
  chatId: number,
): Promise<void> {
  if (!env.MINIAPP_URL) return;
  await ctx.bot.api
    .setChatMenuButton({
      chat_id: chatId,
      menu_button: {
        type: 'web_app',
        text: 'Расходы',
        web_app: { url: `${env.MINIAPP_URL}?groupId=${chatId}` },
      },
    })
    .catch((err) => {
      logger.warn({ err }, '[CMD] Failed to set chat menu button, continuing');
    });
}

/**
 * If the group is a forum, recommend running /topic in the finance topic.
 * Sent as a separate message so the main completion message stays clean.
 */
async function sendTopicRecommendation(
  ctx: Ctx['CallbackQuery'] | Ctx['Command'],
  chatId: number,
): Promise<void> {
  const group = database.groups.findByTelegramGroupId(chatId);
  if (group?.active_topic_id) return; // already configured

  const isForum = 'chat' in ctx && ctx.chat && 'isForum' in ctx.chat && ctx.chat.isForum === true;
  if (!isForum) return;

  await ctx.send(
    `💡 <b>У тебя группа с топиками</b>\n\n` +
      `Сейчас бот слушает все топики — любое сообщение с числом он может принять за расход, ` +
      `а разговоры попытается обработать.\n\n` +
      `Чтобы бот работал только в одном топике (например, «Финансы»):\n` +
      `1. Перейди в нужный топик\n` +
      `2. Напиши там /topic\n\n` +
      `После этого в остальных топиках бот не будет реагировать на сообщения.`,
    { parse_mode: 'HTML' },
  );
}
