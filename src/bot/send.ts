/**
 * Safe message sender — always targets the group chat via chatStorage context.
 * Replaces ctx.send() which sends to private chat in CallbackQuery handlers.
 */
import type { TelegramMessage, TelegramParams } from '@gramio/types';
import { chatStorage } from '../utils/chat-context';
import type { BotInstance } from './types';

let _bot: BotInstance | undefined;

/** Initialize with bot instance — call once at startup before any handler runs */
export function initSend(bot: BotInstance): void {
  _bot = bot;
}

type SendOptions = Omit<TelegramParams.SendMessageParams, 'chat_id' | 'text'>;

/**
 * Send a message to the current chat (group).
 * Reads chatId from chatStorage populated by topic-middleware.
 * Works correctly in both Command and CallbackQuery handlers.
 *
 * NOT for background workers — they must use sendMessage from telegram-sender.
 */
export async function sendToChat(text: string, options?: SendOptions): Promise<TelegramMessage> {
  if (!_bot) throw new Error('sendToChat: bot not initialized — call initSend() first');

  const store = chatStorage.getStore();
  if (!store?.chatId) {
    throw new Error('sendToChat: no chat context — called outside request handler?');
  }

  return _bot.api.sendMessage({
    chat_id: store.chatId,
    text,
    ...options,
  });
}
