// /scan command: opens the Mini App scanner or explains how to use it
import { InlineKeyboard } from 'gramio';
import { buildMiniAppUrl } from '../../utils/miniapp-url';
import { sendToChat } from '../send';

export async function handleScanCommand(): Promise<void> {
  const miniAppUrl = buildMiniAppUrl('scanner');
  if (miniAppUrl) {
    const keyboard = new InlineKeyboard().url('📷 Открыть сканер', miniAppUrl);
    await sendToChat('Открой сканер чеков в Mini App:', { reply_markup: keyboard });
  } else {
    await sendToChat(
      'Сканер чеков доступен через Mini App бота. Попроси администратора настроить MINIAPP_SHORTNAME.',
    );
  }
}
