// /feedback command — send feedback or bug report to the bot admin

import { InlineKeyboard } from 'gramio';
import type { Group } from '../../database/types';
import { sendMessage } from '../../services/bank/telegram-sender';
import { sendFeedback } from '../../services/feedback';
import type { BotInstance, Ctx } from '../types';

interface PendingFeedbackState {
  userId: number;
  promptMessageId: number;
}

/** In-memory map: chatId → pending feedback state */
const pendingFeedback = new Map<number, PendingFeedbackState>();

/**
 * Check if a user has pending feedback input, consume it if so.
 * Returns the prompt message ID to delete, or null.
 */
export function consumePendingFeedback(chatId: number, userId: number): number | null {
  const pending = pendingFeedback.get(chatId);
  if (pending?.userId === userId) {
    pendingFeedback.delete(chatId);
    return pending.promptMessageId;
  }
  return null;
}

/** Cancel pending feedback for a chat (called from callback handler). */
export function cancelPendingFeedback(chatId: number): void {
  pendingFeedback.delete(chatId);
}

/** Set pending feedback state (exported for tests). */
export function setPendingFeedback(chatId: number, userId: number, promptMessageId: number): void {
  pendingFeedback.set(chatId, { userId, promptMessageId });
}

/**
 * /feedback [message] — sends user feedback to the bot admin.
 * Without arguments, prompts the user to type the message.
 */
export async function handleFeedbackCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  const text = ctx.text ?? '';
  // Strip "/feedback" (or "/feedback@BotName") prefix
  const message = text.replace(/^\/feedback(@\S+)?\s*/, '').trim();

  if (!message) {
    const keyboard = new InlineKeyboard().text('❌ Отмена', 'feedback_cancel');
    const sent = await sendMessage(
      '💬 Напиши сообщение с отзывом или описанием бага следующим сообщением:',
      { reply_markup: keyboard },
    );
    if (sent) {
      pendingFeedback.set(ctx.chat.id, { userId: ctx.from.id, promptMessageId: sent.message_id });
    }
    return;
  }

  await submitFeedback(ctx, group, message);
}

/** Shared submit logic for both inline and direct input. */
export async function submitFeedback(
  ctx: Ctx['Command'] | Ctx['Message'],
  group: Group,
  message: string,
  opts?: { promptMessageId?: number; bot?: BotInstance },
): Promise<void> {
  const result = await sendFeedback({
    message,
    groupId: group.id,
    chatId: ctx.chat.id,
    userName: ctx.from.firstName ?? ctx.from.username,
  });

  if (result.success) {
    await sendMessage('✅ Фидбек отправлен, спасибо!');
    // Delete the prompt message with Cancel button
    if (opts?.promptMessageId && opts.bot) {
      await opts.bot.api
        .deleteMessage({ chat_id: ctx.chat.id, message_id: opts.promptMessageId })
        .catch(() => {});
    }
  } else {
    await sendMessage(`❌ Не удалось отправить фидбек: ${result.error}`);
  }
}
