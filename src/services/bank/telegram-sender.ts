// Send-only Telegram Bot API client for the bank-sync service.
// The main bot handles incoming updates; bank-sync uses this to send notifications only.
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('telegram-sender');

export interface InlineKeyboardButton {
  text: string;
  callback_data: string;
}

export interface SendMessageResult {
  message_id: number;
}

interface TelegramResponse<T> {
  ok: boolean;
  result?: T;
  description?: string;
}

async function telegramRequest<T>(
  botToken: string,
  method: string,
  body: Record<string, unknown>,
): Promise<T | null> {
  try {
    const resp = await fetch(`https://api.telegram.org/bot${botToken}/${method}`, {
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

export async function sendMessage(
  botToken: string,
  chatId: number,
  text: string,
  options?: {
    message_thread_id?: number;
    parse_mode?: 'HTML';
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  },
): Promise<SendMessageResult | null> {
  return telegramRequest<SendMessageResult>(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

export async function editMessageText(
  botToken: string,
  chatId: number,
  messageId: number,
  text: string,
  options?: {
    parse_mode?: 'HTML';
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  },
): Promise<void> {
  await telegramRequest(botToken, 'editMessageText', {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...options,
  });
}

export async function deleteMessage(
  botToken: string,
  chatId: number,
  messageId: number,
): Promise<void> {
  await telegramRequest(botToken, 'deleteMessage', {
    chat_id: chatId,
    message_id: messageId,
  });
}
