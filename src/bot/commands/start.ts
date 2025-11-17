import type { Ctx } from '../types';
import { database } from '../../database';

/**
 * /start command handler
 */
export async function handleStartCommand(ctx: Ctx["Command"]): Promise<void> {
  const telegramId = ctx.from?.id;
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!telegramId || !chatId) {
    await ctx.send('Error: Unable to identify user or chat');
    return;
  }

  // Check if this is group chat
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (isGroup) {
    // Group chat
    const group = database.groups.findByTelegramGroupId(chatId);

    if (group && database.groups.hasCompletedSetup(chatId)) {
      await ctx.send(
        `👋 Привет! Бот уже настроен.\n\n` +
        `Отправьте расход в формате:\n` +
        `190 евро Алекс кулёма\n` +
        `100$ еда обед\n\n` +
        `Команды:\n` +
        `/spreadsheet - ссылка на таблицу\n` +
        `/stats - статистика\n` +
        `/categories - категории\n` +
        `/connect - переподключить`
      );
    } else {
      await ctx.send(
        `👋 Привет! Я помогу вести учет расходов группы.\n\n` +
        `Для начала используй /connect`
      );
    }
  } else {
    // Private chat
    await ctx.send(
      `👋 Привет! Я работаю только в группах.\n\n` +
      `Добавь меня в группу и используй /connect для настройки.`
    );
  }
}
