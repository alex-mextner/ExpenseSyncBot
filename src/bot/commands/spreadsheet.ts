// /spreadsheet command — shows current year's spreadsheet and list of previous years

import { database } from '../../database';
import type { Group } from '../../database/types';
import { getSpreadsheetUrl } from '../../services/google/sheets';
import type { Ctx } from '../types';

export async function handleSpreadsheetCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
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
