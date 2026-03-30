/** /settings and /reconnect command handlers — show current config and re-authorize Google OAuth */
import type { Group } from '../../database/types';
import { createLogger } from '../../utils/logger.ts';
import { formatErrorForUser } from '../bot-error-formatter';
import type { Ctx } from '../types';
import { handleConnectCommand } from './connect';

const logger = createLogger('cmd-settings');

/**
 * /settings command handler
 */
export async function handleSettingsCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  try {
    let message = '⚙️ Настройки группы:\n\n';
    message += `💱 Валюта по умолчанию: ${group.default_currency}\n`;
    message += `💵 Включенные валюты: ${group.enabled_currencies.join(', ')}\n`;
    message += `📊 Таблица: ${group.spreadsheet_id ? 'настроена' : 'не настроена'}\n`;

    await ctx.send(message);
  } catch (error) {
    logger.error({ err: error }, '[CMD] Error in /settings');
    await ctx.send(formatErrorForUser(error));
  }
}

/**
 * /reconnect command handler - reconnect Google account
 */
export async function handleReconnectCommand(ctx: Ctx['Command']): Promise<void> {
  await handleConnectCommand(ctx);
}
