// /scan command: opens the Mini App scanner or explains how to use it
import type { Group } from '../../database/types';
import { sendMessage } from '../../services/bank/telegram-sender';
import { buildMiniAppUrl } from '../../utils/miniapp-url';
import type { Ctx } from '../types';

export async function handleScanCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  void ctx;
  const miniAppUrl = buildMiniAppUrl('scanner', group.telegram_group_id);
  if (miniAppUrl) {
    await sendMessage('Открой сканер чеков в Mini App:', {
      reply_markup: { inline_keyboard: [[{ text: '📷 Открыть сканер', url: miniAppUrl }]] },
    });
  } else {
    await sendMessage(
      'Сканер чеков доступен через Mini App бота. Попроси администратора настроить MINIAPP_SHORTNAME.',
    );
  }
}
