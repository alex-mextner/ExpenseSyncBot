// /feedback command — send feedback or bug report to the bot admin

import type { Group } from '../../database/types';
import { sendFeedback } from '../../services/feedback';
import type { Ctx } from '../types';

/**
 * /feedback <message> — sends user feedback to the bot admin
 */
export async function handleFeedbackCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  const text = ctx.text ?? '';
  // Strip "/feedback" (or "/feedback@BotName") prefix
  const message = text.replace(/^\/feedback(@\S+)?\s*/, '').trim();

  if (!message) {
    await ctx.send('💬 Напиши сообщение после команды:\n<code>/feedback текст</code>', {
      parse_mode: 'HTML',
    });
    return;
  }

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
