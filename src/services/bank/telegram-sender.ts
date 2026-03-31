// Send-only Telegram Bot API client for background workers (sync-service, cron, etc.).
// Uses AsyncLocalStorage for chat context — set once at the entry point, sendMessage reads automatically.
import { AsyncLocalStorage } from 'node:async_hooks';
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

interface ChatContext {
  botToken: string;
  chatId: number;
  threadId: number | null;
}

const chatContext = new AsyncLocalStorage<ChatContext>();

/** Run a function with chat context — sendMessage/editMessageText read from it automatically. */
export function withChatContext<T>(
  botToken: string,
  chatId: number,
  threadId: number | null,
  fn: () => Promise<T>,
): Promise<T> {
  return chatContext.run({ botToken, chatId, threadId }, fn);
}

function getContext(): ChatContext {
  const ctx = chatContext.getStore();
  if (!ctx) throw new Error('Telegram sender called outside withChatContext');
  return ctx;
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

/** Send a message. Reads chatId + threadId from withChatContext automatically. */
export async function sendMessage(
  text: string,
  options?: {
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  },
): Promise<SendMessageResult | null> {
  const ctx = getContext();
  return telegramRequest<SendMessageResult>(ctx.botToken, 'sendMessage', {
    chat_id: ctx.chatId,
    text,
    parse_mode: 'HTML',
    ...(ctx.threadId !== null ? { message_thread_id: ctx.threadId } : {}),
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
  const ctx = getContext();
  await telegramRequest(ctx.botToken, 'editMessageText', {
    chat_id: ctx.chatId,
    message_id: messageId,
    text,
    parse_mode: 'HTML',
    ...(options?.reply_markup ? { reply_markup: options.reply_markup } : {}),
  });
}

export async function deleteMessage(messageId: number): Promise<void> {
  const ctx = getContext();
  await telegramRequest(ctx.botToken, 'deleteMessage', {
    chat_id: ctx.chatId,
    message_id: messageId,
  });
}

/** Direct send to a specific chatId — no context, no topic handling.
 * Use for admin notifications and other non-group messages. */
export async function sendDirect(
  botToken: string,
  chatId: number,
  text: string,
  options?: {
    reply_markup?: { inline_keyboard: InlineKeyboardButton[][] };
  },
): Promise<SendMessageResult | null> {
  return telegramRequest<SendMessageResult>(botToken, 'sendMessage', {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...(options?.reply_markup ? { reply_markup: options.reply_markup } : {}),
  });
}
