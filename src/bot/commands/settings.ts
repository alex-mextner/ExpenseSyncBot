import { database } from '../../database';
import type { Ctx } from '../types';
import { handleConnectCommand } from './connect';

/**
 * /settings command handler
 */
export async function handleSettingsCommand(ctx: Ctx['Command']): Promise<void> {
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

  const group = database.groups.findByTelegramGroupId(chatId);

  if (!group) {
    await ctx.send('❌ Группа не настроена. Используй /connect');
    return;
  }

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
