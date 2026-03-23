/** /start command handler */
import { env } from '../../config/env';
import { database } from '../../database';
import type { Ctx } from '../types';

export async function handleStartCommand(ctx: Ctx['Command']): Promise<void> {
  const telegramId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!telegramId || !chatId) {
    await ctx.send('Error: Unable to identify user or chat');
    return;
  }

  const isGroup = chatType === 'group' || chatType === 'supergroup';
  const bot = env.BOT_USERNAME;

  if (isGroup) {
    const group = database.groups.findByTelegramGroupId(chatId);

    if (group && database.groups.hasCompletedSetup(chatId)) {
      await ctx.send(
        `👋 Бот настроен и готов к работе.\n\n` +
          `Отправь расход: <code>100$ еда обед</code>\n` +
          `Фото чека: бот разберёт позиции\n` +
          `AI: <code>@${bot} вопрос</code>\n\n` +
          `/help — все возможности бота`,
        { parse_mode: 'HTML' },
      );
    } else {
      await ctx.send(
        `👋 Привет! Я помогу вести учёт расходов группы и синхронизировать их с Google Sheets.\n\n` +
          `<b>Как начать:</b>\n` +
          `1. Набери /connect\n` +
          `2. Нажми кнопку «Подключить Google» и авторизуйся\n` +
          `3. Выбери валюты для учёта\n` +
          `4. Готово — таблица создастся автоматически\n\n` +
          `После настройки просто пиши расходы в чат: <code>100$ еда обед</code>`,
        { parse_mode: 'HTML' },
      );
    }
  } else {
    await ctx.send(
      `👋 Я работаю только в группах.\n\n` +
        `Добавь меня в группу и набери /connect для настройки.`,
    );
  }
}
