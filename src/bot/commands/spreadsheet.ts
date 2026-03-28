// /spreadsheet command — shows current year's spreadsheet and list of previous years

import { database } from '../../database';
import { getSpreadsheetUrl } from '../../services/google/sheets';
import type { Ctx } from '../types';

export async function handleSpreadsheetCommand(ctx: Ctx['Command']): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!chatId) {
    await ctx.send('Error: Unable to identify chat');
    return;
  }

  const isGroup = chatType === 'group' || chatType === 'supergroup';
  if (!isGroup) {
    await ctx.send('Эта команда работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.send('Группа не настроена. Используй /connect для настройки.');
    return;
  }

  const currentYear = new Date().getFullYear();
  const currentSpreadsheetId = database.groupSpreadsheets.getByYear(group.id, currentYear);
  const all = database.groupSpreadsheets.listAll(group.id);

  if (!currentSpreadsheetId && all.length === 0) {
    await ctx.send('Таблица не создана. Завершите настройку: /connect');
    return;
  }

  let message = '';

  if (currentSpreadsheetId) {
    message += `Таблица ${currentYear}:\n${getSpreadsheetUrl(currentSpreadsheetId)}\n`;
  } else {
    message += `Таблица за ${currentYear} ещё не создана.\n`;
  }

  const previous = all.filter((e) => e.year < currentYear);
  if (previous.length > 0) {
    message += `\nПредыдущие годы:\n`;
    for (const { year, spreadsheetId } of previous) {
      message += `• ${year}: ${getSpreadsheetUrl(spreadsheetId)}\n`;
    }
  }

  message +=
    `\nМожно редактировать прямо в таблице. После правок:\n` +
    `• /sync — подхватить изменения расходов\n` +
    `• /budget sync — подхватить изменения бюджетов`;

  await ctx.send(message.trim());
}
