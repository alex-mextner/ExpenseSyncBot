// Unified AsyncLocalStorage for chat context.
// Bot handlers: populated by topic-middleware on every incoming update.
// Background workers: populated by withChatContext() before sending messages.
import { AsyncLocalStorage } from 'node:async_hooks';

interface ChatContext {
  chatId: number;
  threadId: number | null;
}

export const chatStorage = new AsyncLocalStorage<ChatContext>();

/** Run fn with a specific chat context — sendMessage/editMessageText read from it automatically. */
export function withChatContext<T>(
  chatId: number,
  threadId: number | null,
  fn: () => Promise<T>,
): Promise<T> {
  return chatStorage.run({ chatId, threadId }, fn);
}
