/**
 * Safe message sender — always targets the group chat via AsyncLocalStorage context.
 * Replaces ctx.send() which sends to private chat in CallbackQuery handlers.
 */
import type { TelegramMessage, TelegramParams } from '@gramio/types';
import { threadStorage } from './topic-middleware';
import type { BotInstance } from './types';

let _bot: BotInstance | undefined;

/** Initialize with bot instance — call once at startup before any handler runs */
export function initSend(bot: BotInstance): void {
  _bot = bot;
}

type SendOptions = Omit<TelegramParams.SendMessageParams, 'chat_id' | 'text'>;

/**
 * Send a message to the current chat (group).
 * Reads chatId from AsyncLocalStorage populated by topic-middleware.
 * Works correctly in both Command and CallbackQuery handlers.
 *
 * NOT for background workers — they must use bot.api.sendMessage with explicit chat_id.
 */
export async function sendToChat(text: string, options?: SendOptions): Promise<TelegramMessage> {
  if (!_bot) throw new Error('sendToChat: bot not initialized — call initSend() first');

  const store = threadStorage.getStore();
  if (!store?.chatId) {
    throw new Error('sendToChat: no chat context — called outside request handler?');
  }

  return _bot.api.sendMessage({
    chat_id: store.chatId,
    text,
    ...options,
  });
}
