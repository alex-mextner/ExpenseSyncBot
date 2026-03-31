// /scan command: opens the Mini App scanner or explains how to use it
import { sendMessage } from '../../services/bank/telegram-sender';
import { buildMiniAppUrl } from '../../utils/miniapp-url';

export async function handleScanCommand(): Promise<void> {
  const miniAppUrl = buildMiniAppUrl('scanner');
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
