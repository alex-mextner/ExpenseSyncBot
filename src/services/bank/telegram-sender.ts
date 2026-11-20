// Unified Telegram message sender — works in both handler context and background workers.
// Reads chatId from chatStorage; message_thread_id is injected by GramIO preRequest hook.
// Handlers: middleware sets context automatically. Workers: use withChatContext() first.
import type { TelegramMessage, TelegramParams } from '@gramio/types';
import type { InputRichMessage } from '../../bot/telegram-rich-message';
import type { BotInstance } from '../../bot/types';
import { chatStorage, withChatContext } from '../../utils/chat-context';
import { createLogger } from '../../utils/logger.ts';

export { withChatContext };

const logger = createLogger('telegram-sender');

let _bot: BotInstance | undefined;

/** Initialize with bot instance — call once at startup before any handler runs. */
export function initSender(bot: BotInstance): void {
  _bot = bot;
}

function getBot(): BotInstance {
  if (!_bot) throw new Error('telegram-sender: bot not initialized — call initSender() first');
  return _bot;
}

function getContext() {
  const ctx = chatStorage.getStore();
  if (!ctx) throw new Error('Telegram sender called outside chat context');
  return ctx;
}

type SendOptions = Omit<TelegramParams.SendMessageParams, 'chat_id' | 'text'>;

/**
 * Run a send call; on 429 retry once (rateLimitOnResponseError already set the global
 * backoff and rateLimitPreRequest waits it out on the retry). Failures are logged, never thrown.
 */
async function sendWithRetry(
  method: string,
  call: () => Promise<TelegramMessage>,
): Promise<TelegramMessage | null> {
  try {
    return await call();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 429) {
      try {
        return await call();
      } catch (retryError) {
        logger.warn({ err: retryError }, `${method} retry failed`);
        return null;
      }
    }
    logger.warn({ err: error }, `${method} failed`);
    return null;
  }
}

/** Send a message to the current chat. Reads chatId from context; threadId injected by preRequest hook. */
export async function sendMessage(
  text: string,
  options?: SendOptions,
): Promise<TelegramMessage | null> {
  const { chatId } = getContext();
  return sendWithRetry('sendMessage', () =>
    getBot().api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', ...options }),
  );
}

/**
 * Send a Bot API 10.1 rich message (native tables, headings) to the current chat.
 * Same context and thread rules as sendMessage; null when Telegram rejected it.
 */
export async function sendRichMessage(
  richMessage: InputRichMessage,
): Promise<TelegramMessage | null> {
  const { chatId } = getContext();
  return sendWithRetry('sendRichMessage', () =>
    getBot().api.sendRichMessage({ chat_id: chatId, rich_message: richMessage }),
  );
}

/**
 * Edit a message. Reads chatId from context.
 *
 * By default swallows all edit errors (log-only) because most callers fire
 * these as best-effort UI updates where a failed edit shouldn't tank the
 * whole handler. Callers that actually care about the final edit landing
 * (e.g. StatusWriter.finalize) can pass `throwOnError: true` to get the
 * error propagated instead.
 */
export async function editMessageText(
  messageId: number,
  text: string,
  options?: Omit<TelegramParams.EditMessageTextParams, 'chat_id' | 'message_id' | 'text'> & {
    throwOnError?: boolean;
  },
): Promise<void> {
  const { chatId } = getContext();
  const { throwOnError, ...telegramOptions } = options ?? {};
  try {
    await getBot().api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text,
      parse_mode: 'HTML',
      ...telegramOptions,
    });
  } catch (error) {
    logger.warn({ err: error, messageId }, 'editMessageText failed');
    if (throwOnError) {
      throw error;
    }
  }
}

/**
 * Strip a message's inline keyboard, leaving its text as is. Reads chatId from context.
 * A failure is logged, never thrown — dead buttons are cosmetic, the flow already succeeded.
 */
export async function removeInlineKeyboard(messageId: number): Promise<void> {
  try {
    const { chatId } = getContext();
    await getBot().api.editMessageReplyMarkup({
      chat_id: chatId,
      message_id: messageId,
      reply_markup: { inline_keyboard: [] },
    });
  } catch (error) {
    // Includes a missing chat context: the whole call is best-effort, never thrown.
    logger.warn({ err: error, messageId }, 'removeInlineKeyboard failed');
  }
}

/** Delete a message. Reads chatId from context. */
export async function deleteMessage(messageId: number): Promise<void> {
  const { chatId } = getContext();
  try {
    await getBot().api.deleteMessage({
      chat_id: chatId,
      message_id: messageId,
    });
  } catch (error) {
    logger.warn({ err: error, messageId }, 'deleteMessage failed');
  }
}

/** Direct send to a specific chatId — no context needed.
 * Use for admin notifications and other non-group messages. */
export async function sendDirect(
  chatId: number,
  text: string,
  options?: SendOptions,
): Promise<TelegramMessage | null> {
  return withChatContext(chatId, null, () => sendMessage(text, options));
}

/** Send a "typing" chat action to the current chat. Best-effort, errors are silently ignored. */
export async function sendChatAction(): Promise<void> {
  try {
    const { chatId } = getContext();
    await getBot().api.sendChatAction({ chat_id: chatId, action: 'typing' });
  } catch {
    // Best-effort — typing indicators are non-critical
  }
}

/** Create a non-primary invite link for a group chat.
 * Uses createChatInviteLink (not exportChatInviteLink) to avoid revoking existing invite links. */
export async function createInviteLink(chatId: number): Promise<string | null> {
  try {
    const result = await getBot().api.createChatInviteLink({
      chat_id: chatId,
      name: 'ExpenseSyncBot redirect',
    });
    return result.invite_link;
  } catch (error) {
    logger.debug({ err: error, chatId }, 'createInviteLink failed');
    return null;
  }
}

/** Send a document (file) directly to a specific chatId via Telegram API.
 * Used for admin notifications with log attachments. */
export async function sendDocumentDirect(
  chatId: number,
  file: File,
  caption?: string,
): Promise<void> {
  const bot = getBot();
  try {
    await bot.api.sendDocument({
      chat_id: chatId,
      document: file,
      ...(caption ? { caption, parse_mode: 'HTML' as const } : {}),
    });
  } catch (error) {
    logger.warn({ err: error }, 'sendDocumentDirect failed');
  }
}
