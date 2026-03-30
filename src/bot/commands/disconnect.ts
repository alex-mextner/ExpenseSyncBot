// /disconnect command — remove all group data and revoke Google access
import { database } from '../../database';
import { createLogger } from '../../utils/logger.ts';
import { createConfirmKeyboard } from '../keyboards';
import type { BotInstance, Ctx } from '../types';

const logger = createLogger('disconnect');

/**
 * /disconnect command handler — shows confirmation before deleting all group data
 */
export async function handleDisconnectCommand(ctx: Ctx['Command']): Promise<void> {
  const message =
    '⚠️ <b>Отключение бота</b>\n\n' +
    'Будут удалены:\n' +
    '• Все расходы и категории\n' +
    '• Все бюджеты\n' +
    '• Google-токен и привязка к таблице\n' +
    '• История чата с AI\n' +
    '• Банковские подключения\n\n' +
    '❗ Google-таблица <b>не будет удалена</b> — она останется в твоём Google Drive.\n\n' +
    'Ты уверен?';

  await ctx.send(message, {
    parse_mode: 'HTML',
    reply_markup: createConfirmKeyboard('disconnect'),
  });
}

/**
 * Handle disconnect confirmation callback
 */
export async function handleDisconnectConfirm(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
): Promise<void> {
  const chatId = ctx.message?.chat?.id;
  const messageId = ctx.message?.id;

  if (!chatId) {
    await ctx.answerCallbackQuery({ text: 'Ошибка: чат не найден' });
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа уже отключена' });
    return;
  }

  try {
    // group_spreadsheets lacks ON DELETE CASCADE — delete manually before the group
    database.transaction(() => {
      database.groupSpreadsheets.deleteByGroupId(group.id);
      database.groups.delete(chatId);
    });

    logger.info(
      { groupId: group.id, telegramGroupId: chatId },
      'Group disconnected and all data deleted',
    );

    await ctx.answerCallbackQuery({ text: '✅ Все данные удалены' });

    if (messageId) {
      await bot.api.editMessageText({
        chat_id: chatId,
        message_id: messageId,
        text: '✅ Бот отключён. Все данные удалены.\n\nЧтобы начать заново — /connect',
        parse_mode: 'HTML',
      });
    }
  } catch (err) {
    logger.error({ err }, 'Failed to disconnect group');
    await ctx.answerCallbackQuery({ text: '❌ Ошибка при удалении данных' });
  }
}

/**
 * Handle disconnect cancel callback
 */
export async function handleDisconnectCancel(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
): Promise<void> {
  const chatId = ctx.message?.chat?.id;
  const messageId = ctx.message?.id;

  await ctx.answerCallbackQuery({ text: '❌ Отменено' });

  if (messageId && chatId) {
    await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
  }
}
