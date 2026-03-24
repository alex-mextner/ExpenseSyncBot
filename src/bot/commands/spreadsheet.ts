import { database } from '../../database';
import { getSpreadsheetUrl } from '../../services/google/sheets';
import type { Ctx } from '../types';

/**
 * /spreadsheet command handler - get link to the Google Sheet
 */
export async function handleSpreadsheetCommand(ctx: Ctx['Command']): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!chatId) {
    await ctx.send('Error: Unable to identify chat');
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

  await ctx.send(
    `📊 Ссылка на таблицу:\n${spreadsheetUrl}\n\n` +
      `Можно редактировать прямо в таблице. После правок:\n` +
      `• /sync — подхватить изменения расходов\n` +
      `• /budget sync — подхватить изменения бюджетов`,
  );
}
