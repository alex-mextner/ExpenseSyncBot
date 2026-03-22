/**
 * Global topic-aware messaging middleware.
 * Stores incoming message_thread_id in AsyncLocalStorage and injects it
 * into all outgoing Telegram API calls via GramIO preRequest hook.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Bot } from 'gramio';

interface ThreadContext {
  chatId: number;
  threadId: number | undefined;
}

export const threadStorage = new AsyncLocalStorage<ThreadContext>();

/** Telegram API methods that support message_thread_id */
const THREAD_AWARE_METHODS = [
  'sendMessage',
  'sendPhoto',
  'sendDocument',
  'sendVideo',
  'sendAudio',
  'sendVoice',
  'sendVideoNote',
  'sendAnimation',
  'sendSticker',
  'sendLocation',
  'sendContact',
  'sendPoll',
  'sendDice',
  'sendMediaGroup',
  'copyMessage',
  'forwardMessage',
  'sendChatAction',
] as const;

/**
 * Register topic-aware middleware and preRequest hook on the bot.
 * Must be called BEFORE registering any command/message handlers.
 */
export function registerTopicMiddleware(bot: Bot): void {
  // Middleware: extract thread_id from incoming update, store in AsyncLocalStorage
  bot.use((ctx, next) => {
    const payload = (ctx as any).payload;
    // For messages: payload.message_thread_id
    // For callback queries: ctx.message?.message_thread_id
    const threadId = payload?.message_thread_id ?? (ctx as any).message?.message_thread_id;
    const chatId = (ctx as any).chat?.id ?? (ctx as any).message?.chat?.id;

    if (chatId !== undefined) {
      return threadStorage.run({ chatId, threadId }, () => next());
    }
    return next();
  });

  // preRequest: inject message_thread_id into outgoing API calls
  bot.preRequest(THREAD_AWARE_METHODS as any, (context) => {
    const stored = threadStorage.getStore();
    const params = context.params as Record<string, unknown>;
    if (stored?.threadId && !params.message_thread_id && params.chat_id === stored.chatId) {
      params.message_thread_id = stored.threadId;
    }
    return context;
  });
}
