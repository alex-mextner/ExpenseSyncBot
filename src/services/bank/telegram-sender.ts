// Send-only Telegram Bot API client for background workers (sync-service, cron, etc.).
// sendMessage/editMessageText/deleteMessage read chatId + threadId from chatStorage automatically.
// Use withChatContext() to set context before calling them.
import { env } from '../../config/env';
import { chatStorage, withChatContext } from '../../utils/chat-context';
import { createLogger } from '../../utils/logger.ts';

export { withChatContext } from '../../utils/chat-context';

const logger = createLogger('telegram-sender');

export interface InlineKeyboardButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export interface SendMessageResult {
  message_id: number;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

function getContext() {
  const ctx = chatStorage.getStore();
  if (!ctx) throw new Error('Telegram sender called outside withChatContext');
  return ctx;
}

async function telegramRequest<T>(
  method: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = (await resp.json()) as TelegramResponse<T>;
    if (!data.ok) {
      logger.warn({ method, description: data.description }, 'Telegram API call failed');
      return null;
    }
    return data.result ?? null;
  } catch (error) {
    logger.error({ err: error, method }, 'Telegram API request error');
    return null;
  }
}

/** Send a message. Reads chatId + threadId from withChatContext automatically. */
export async function sendMessage(
  text: string,
  options?: {
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  },
): Promise<SendMessageResult | null> {
  const { chatId, threadId } = getContext();
  return telegramRequest<SendMessageResult>('sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(threadId !== null ? { message_thread_id: threadId } : {}),
    ...(options?.reply_markup ? { reply_markup: options.reply_markup } : {}),
  });
}

/** Edit a message. Reads chatId from withChatContext automatically. */
export async function editMessageText(
  messageId: number,
  text: string,
  options?: {
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  },
): Promise<void> {
  const { chatId } = getContext();
  await telegramRequest('editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...(options?.reply_markup ? { reply_markup: options.reply_markup } : {}),
  });
}

/** Delete a message. Reads chatId from withChatContext automatically. */
export async function deleteMessage(messageId: number): Promise<void> {
  const { chatId } = getContext();
  await telegramRequest('deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
}

/** Direct send to a specific chatId — no context needed.
 * Use for admin notifications and other non-group messages. */
export async function sendDirect(
  chatId: number,
  text: string,
  options?: {
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  },
): Promise<SendMessageResult | null> {
  return withChatContext(chatId, null, () => sendMessage(text, options));
}
