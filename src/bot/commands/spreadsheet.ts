/** /spreadsheet command handler — shows current year's spreadsheet and list of previous years */
import { database } from '../../database';
import type { Group } from '../../database/types';
import { getSpreadsheetUrl } from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import { formatErrorForUser } from '../bot-error-formatter';
import { sendToChat } from '../send';
import type { Ctx } from '../types';

const logger = createLogger('cmd-spreadsheet');

/**
 * /spreadsheet command handler - get link to the Google Sheet
 */
export async function handleSpreadsheetCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  void ctx;
  try {
    const currentYear = new Date().getFullYear();
    const currentSpreadsheetId = database.groupSpreadsheets.getByYear(group.id, currentYear);
    const all = database.groupSpreadsheets.listAll(group.id);

    if (!currentSpreadsheetId && all.length === 0) {
      await sendToChat('Таблица не создана. Завершите настройку: /connect');
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

    await sendToChat(message.trim());
  } catch (error) {
    logger.error({ err: error }, '[CMD] Error in /spreadsheet');
    await sendToChat(formatErrorForUser(error));
  }
}
