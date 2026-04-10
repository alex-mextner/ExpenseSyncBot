// Unified Telegram message sender — works in both handler context and background workers.
// Reads chatId from chatStorage; message_thread_id is injected by GramIO preRequest hook.
// Handlers: middleware sets context automatically. Workers: use withChatContext() first.
import type { TelegramMessage, TelegramParams } from '@gramio/types';
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

/** Send a message to the current chat. Reads chatId from context; threadId injected by preRequest hook. */
export async function sendMessage(
  text: string,
  options?: SendOptions,
): Promise<TelegramMessage | null> {
  const { chatId } = getContext();
  const call = () =>
    getBot().api.sendMessage({ chat_id: chatId, text, parse_mode: 'HTML', ...options });
  try {
    return await call();
  } catch (error) {
    if ((error as { code?: number }).code === 429) {
      // rateLimitOnResponseError hook already set the global backoff;
      // rateLimitPreRequest on the retry call will wait it out.
      try {
        return await call();
      } catch (retryError) {
        logger.warn({ err: retryError }, 'sendMessage retry failed');
        return null;
      }
    }
    logger.warn({ err: error }, 'sendMessage failed');
    return null;
  }
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
