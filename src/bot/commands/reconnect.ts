// /reconnect command — re-authorize Google account without losing existing data

import { InlineKeyboard } from 'gramio';
import { database } from '../../database';
import { generateAuthUrl } from '../../services/google/oauth';
import { createLogger } from '../../utils/logger.ts';
import { registerOAuthState, unregisterOAuthState } from '../../web/oauth-callback';
import type { Ctx } from '../types';
import { syncExpenses } from './sync';

const logger = createLogger('reconnect');

/**
 * /reconnect command handler — re-authorize Google without recreating the spreadsheet
 */
export async function handleReconnectCommand(ctx: Ctx['Command']): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (!chatId || !isGroup) {
    await ctx.send('❌ Эта команда работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.send('❌ Группа не настроена. Используй /connect');
    return;
  }

  if (!group.spreadsheet_id) {
    await ctx.send('❌ Таблица не создана. Используй /connect для первоначальной настройки.');
    return;
  }

  logger.info(`[CMD] /reconnect for group ${group.id} (chat ${chatId})`);

  const authUrl = generateAuthUrl(group.id);
  const authKeyboard = new InlineKeyboard().url('🔐 Переподключить Google', authUrl);

  await ctx.send(
    '🔄 <b>Переподключение Google аккаунта</b>\n\n' +
      'Таблица и данные сохранятся — обновится только авторизация.\n\n' +
      '1. Нажми на кнопку ниже\n' +
      '2. Разреши доступ к Google Sheets\n' +
      '3. Вернись сюда — бот синхронизирует данные',
    { parse_mode: 'HTML', reply_markup: authKeyboard },
  );

  const refreshToken = await new Promise<string>((resolve, reject) => {
    registerOAuthState(group.id, resolve, reject);

    setTimeout(
      () => {
        unregisterOAuthState(group.id);
        reject(new Error('OAuth timeout'));
      },
      5 * 60 * 1000,
    );
  }).catch((err) => {
    logger.error({ err }, '[CMD] OAuth error during reconnect');
    return null;
  });

  if (!refreshToken) {
    // Check if token was saved to DB by the callback anyway (race condition)
    const updatedGroup = database.groups.findByTelegramGroupId(chatId);
    if (updatedGroup?.google_refresh_token) {
      logger.info(`[CMD] OAuth timeout but token found in DB for group ${group.id}`);
      await syncAfterReconnect(ctx, group.id);
      return;
    }
    await ctx.send('❌ Не удалось переподключить Google аккаунт. Попробуй ещё раз: /reconnect');
    return;
  }

  logger.info(`[CMD] ✅ Reconnect OAuth successful for group ${group.id}`);
  await ctx.send('✅ Google аккаунт переподключён!');
  await syncAfterReconnect(ctx, group.id);
}

/**
 * Sync expenses from the existing spreadsheet after successful re-authorization
 */
async function syncAfterReconnect(ctx: Ctx['Command'], groupId: number): Promise<void> {
  try {
    await ctx.send('🔄 Синхронизирую расходы из таблицы...');
    const result = await syncExpenses(groupId);

    const total = result.unchanged + result.added.length + result.updated.length;
    const changes: string[] = [];
    if (result.added.length > 0) changes.push(`+${result.added.length}`);
    if (result.deleted.length > 0) changes.push(`-${result.deleted.length}`);
    if (result.updated.length > 0) changes.push(`~${result.updated.length}`);

    const changeSummary = changes.length > 0 ? ` (${changes.join(', ')})` : '';
    await ctx.send(
      `✅ Синхронизация завершена: ${total} расходов в БД${changeSummary}\n\n` +
        'Всё готово! Бот снова синхронизирует расходы с таблицей.',
    );
  } catch (err) {
    logger.error({ err }, '[RECONNECT] Sync after reconnect failed');
    await ctx.send(
      '⚠️ Аккаунт подключён, но синхронизация не удалась.\n' + 'Попробуй /sync вручную позже.',
    );
  }
}
