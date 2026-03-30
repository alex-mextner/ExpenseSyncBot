// /feedback command — send feedback or bug report to the bot admin

import { InlineKeyboard } from 'gramio';
import type { Group } from '../../database/types';
import { sendFeedback } from '../../services/feedback';
import type { Ctx } from '../types';

/** In-memory map: chatId → userId waiting to type feedback */
const pendingFeedback = new Map<number, number>();

/**
 * Check if a user has pending feedback input, consume it if so.
 * Called from message handler.
 */
export function consumePendingFeedback(chatId: number, userId: number): boolean {
  const pending = pendingFeedback.get(chatId);
  if (pending === userId) {
    pendingFeedback.delete(chatId);
    return true;
  }
  return false;
}

/** Cancel pending feedback for a chat (called from callback handler). */
export function cancelPendingFeedback(chatId: number): void {
  pendingFeedback.delete(chatId);
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
    pendingFeedback.set(ctx.chat.id, ctx.from.id);
    const keyboard = new InlineKeyboard().text('❌ Отмена', 'feedback_cancel');
    await ctx.send('💬 Напиши сообщение с отзывом или описанием бага следующим сообщением:', {
      reply_markup: keyboard,
    });
    return;
  }

  await submitFeedback(ctx, group, message);
}

/** Shared submit logic for both inline and direct input. */
export async function submitFeedback(
  ctx: Ctx['Command'] | Ctx['Message'],
  group: Group,
  message: string,
): Promise<void> {
  const result = await sendFeedback({
    message,
    groupId: group.id,
    chatId: ctx.chat.id,
    userName: ctx.from.firstName ?? ctx.from.username,
  });

  if (result.success) {
    await ctx.send('✅ Фидбек отправлен, спасибо!');
  } else {
    await ctx.send(`❌ Не удалось отправить фидбек: ${result.error}`);
  }
}
