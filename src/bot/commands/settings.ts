import type { Group } from '../../database/types';
import type { Ctx } from '../types';
import { handleConnectCommand } from './connect';

/**
 * /settings command handler
 */
export async function handleSettingsCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  let message = '⚙️ Настройки группы:\n\n';
  message += `💱 Валюта по умолчанию: ${group.default_currency}\n`;
  message += `💵 Включенные валюты: ${group.enabled_currencies.join(', ')}\n`;
  message += `📊 Таблица: ${group.spreadsheet_id ? 'настроена' : 'не настроена'}\n`;

  await ctx.send(message);
}

/**
 * /reconnect command handler - reconnect Google account
 */
export async function handleReconnectCommand(ctx: Ctx['Command']): Promise<void> {
  await handleConnectCommand(ctx);
}
