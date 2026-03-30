/** /start command handler */
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

  if (isGroup) {
    const group = database.groups.findByTelegramGroupId(chatId);
    const setupDone = database.groups.hasCompletedSetup(chatId);
    const hasGoogle = !!(group?.google_refresh_token && group?.spreadsheet_id);

    if (group && setupDone) {
      let message =
        `👋 Бот настроен и готов к работе.\n\n` +
        `<b>Основные возможности:</b>\n` +
        `• Расход: <code>100$ еда обед</code>\n` +
        `• Фото чека — бот разберёт позиции\n` +
        `• Бюджеты по категориям: /budget\n` +
        `• Подключение банка: /bank\n` +
        `• Пиши свободным текстом — AI-ассистент ответит на вопросы о расходах\n` +
        `• /sum — итого за месяц по категориям и сравнение со средним\n` +
        `• /stats — общая статистика по валютам и последние расходы`;

      if (!hasGoogle) {
        message +=
          `\n\n💡 Можно подключить Google Sheets (/connect) — ` +
          `расходы будут дублироваться в таблицу, можно редактировать оттуда и делиться.`;
      }

      await ctx.send(message, { parse_mode: 'HTML' });
    } else {
      await ctx.send(
        `👋 Привет! Я помогу вести учёт расходов группы и синхронизировать их с Google Sheets.\n\n` +
          `<b>Что умеет бот:</b>\n` +
          `• Учёт расходов в нескольких валютах с автоконвертацией\n` +
          `• Синхронизация с Google Sheets — редактируй и в таблице, и в боте\n` +
          `• Сканирование чеков по фото\n` +
          `• Бюджеты по категориям с уведомлениями\n` +
          `• Подключение банков — автоимпорт транзакций\n` +
          `• AI-ассистент — аналитика, советы, ответы на вопросы о расходах\n\n` +
          `<b>Как начать:</b>\n` +
          `Набери /connect и следуй инструкциям.\n\n` +
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
