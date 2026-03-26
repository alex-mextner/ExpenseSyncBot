/** /spreadsheet command handler — sends the Google Sheets URL for the group */
import { database } from '../../database';
import { getSpreadsheetUrl } from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import { formatErrorForUser } from '../bot-error-formatter';
import type { Ctx } from '../types';

const logger = createLogger('cmd-spreadsheet');

/**
 * /spreadsheet command handler - get link to the Google Sheet
 */
export async function handleSpreadsheetCommand(ctx: Ctx['Command']): Promise<void> {
  try {
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;

    if (!chatId) {
      await ctx.send('❌ Не удалось определить чат');
      return;
    }

    // Only allow in groups
    const isGroup = chatType === 'group' || chatType === 'supergroup';

    if (!isGroup) {
      await ctx.send('❌ Эта команда работает только в группах.');
      return;
    }

    // Get group
    const group = database.groups.findByTelegramGroupId(chatId);

    if (!group) {
      await ctx.send('❌ Группа не настроена. Используй /connect для настройки.');
      return;
    }

    if (!group.spreadsheet_id) {
      await ctx.send('❌ Таблица не создана. Завершите настройку: /connect');
      return;
    }

    const spreadsheetUrl = getSpreadsheetUrl(group.spreadsheet_id);

    await ctx.send(`📊 Ссылка на таблицу:\n\n${spreadsheetUrl}`);
  } catch (error) {
    logger.error({ err: error }, '[CMD] Error in /spreadsheet');
    await ctx.send(formatErrorForUser(error));
  }
}
