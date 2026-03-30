/** /start command handler */
import { database } from '../../database';
import { createLogger } from '../../utils/logger.ts';
import { formatErrorForUser } from '../bot-error-formatter';
import type { Ctx } from '../types';
import { buildHelpText, EXPENSE_EXAMPLES } from './help';

const logger = createLogger('cmd-start');

export async function handleStartCommand(ctx: Ctx['Command']): Promise<void> {
  try {
    const telegramId = ctx.from?.id;
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;

    if (!telegramId || !chatId) {
      await ctx.send('❌ Не удалось определить пользователя или чат');
      return;
    }

    const isGroup = chatType === 'group' || chatType === 'supergroup';

    if (isGroup) {
      const group = database.groups.findByTelegramGroupId(chatId);
      const setupDone = database.groups.hasCompletedSetup(chatId);
      const hasGoogle = !!(group?.google_refresh_token && group?.spreadsheet_id);

      if (group && setupDone) {
        let message = `👋 Бот настроен и готов к работе.\n\n${buildHelpText()}`;

        if (hasGoogle) {
          message += `\n\n🔄 /reconnect — если таблица перестала обновляться или сменился Google-аккаунт.`;
        } else {
          message += `\n\n💡 /connect — подключить Google Sheets, расходы будут вноситься в таблицу и читаться из неё.`;
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
            `<b>Формат расходов:</b>\n` +
            EXPENSE_EXAMPLES,
          { parse_mode: 'HTML' },
        );
      }
    } else {
      await ctx.send(
        `👋 Я работаю только в группах.\n\n` +
          `Добавь меня в группу и набери /connect для настройки.`,
      );
    }
  } catch (error) {
    logger.error({ err: error }, '[CMD] Error in /start');
    await ctx.send(formatErrorForUser(error));
  }
}
