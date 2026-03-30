/**
 * Global topic-aware messaging middleware.
 * Stores incoming message_thread_id in AsyncLocalStorage and injects it
 * into all outgoing Telegram API calls via GramIO preRequest hook.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { APIMethods } from '@gramio/types';
import type { Bot } from 'gramio';

interface ThreadContext {
  chatId: number;
  threadId: number | undefined;
}

/** Common params shared by all thread-aware Telegram API methods */
interface ThreadAwareParams {
  chat_id: number | string;
  message_thread_id?: number;
}

export const threadStorage = new AsyncLocalStorage<ThreadContext>();

/** Telegram API methods that support message_thread_id */
const THREAD_AWARE_METHODS: Array<keyof APIMethods> = [
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
];

/**
 * Register topic-aware middleware and preRequest hook on the bot.
 * Must be called BEFORE registering any command/message handlers.
 */
export function registerTopicMiddleware(bot: Bot): void {
  // Middleware: extract thread_id from incoming update, store in AsyncLocalStorage
  bot.use((ctx, next) => {
    const update = ctx.update;
    // callback_query.message can be TelegramMaybeInaccessibleMessage (union),
    // only TelegramMessage has message_thread_id and chat
    const cbMessage = update?.callback_query?.message;
    const cbMsg =
      cbMessage !== undefined && 'message_thread_id' in cbMessage ? cbMessage : undefined;
    const threadId = update?.message?.message_thread_id ?? cbMsg?.message_thread_id;
    const chatId = update?.message?.chat?.id ?? cbMsg?.chat?.id;

    if (chatId !== undefined) {
      return threadStorage.run({ chatId, threadId }, () => next());
    }
    return next();
  });

  // preRequest: inject message_thread_id into outgoing API calls
  bot.preRequest(THREAD_AWARE_METHODS, (context) => {
    const stored = threadStorage.getStore();
    const params = context.params as ThreadAwareParams;
    if (stored?.threadId && !params.message_thread_id && params.chat_id === stored.chatId) {
      params.message_thread_id = stored.threadId;
    }
    return context;
  });
}
