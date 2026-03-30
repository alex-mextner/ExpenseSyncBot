// /scan command: opens the Mini App scanner or explains how to use it
import { InlineKeyboard } from 'gramio';
import { env } from '../../config/env';
import type { Group } from '../../database/types';
import type { Ctx } from '../types';

export async function handleScanCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  if (env.MINIAPP_URL) {
    const keyboard = new InlineKeyboard().webApp(
      '📷 Открыть сканер',
      `${env.MINIAPP_URL}?groupId=${group.telegram_group_id}&tab=scanner`,
    );
    await ctx.send(
      'Открой сканер чеков в Mini App:',
      ...(keyboard ? [{ reply_markup: keyboard }] : []),
    );
  } else {
    await ctx.send(
      'Сканер чеков доступен через Mini App бота. Попроси администратора настроить MINIAPP_URL.',
    );
  }
}
