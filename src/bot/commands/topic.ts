/** /topic command handler — restrict the bot to a specific Telegram forum topic */
import { database } from '../../database';
import type { Group } from '../../database/types';
import { createLogger } from '../../utils/logger.ts';
import { formatErrorForUser } from '../bot-error-formatter';
import { sendToChat } from '../send';
import type { Ctx } from '../types';

const logger = createLogger('cmd-topic');

/**
 * /topic command handler - set topic for bot to listen to
 * Usage:
 *   /topic - if called from a topic, bot will only listen to that topic
 *   /topic clear - clear topic restriction, bot listens to all messages
 */
export async function handleTopicCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  try {
    const chatId = ctx.chat?.id;

    // Get thread_id from message context
    const threadId = ctx.update?.message?.message_thread_id;

    // Get command argument
    const commandText = ctx.text || '';
    const args = commandText.split(/\s+/).slice(1).join(' ').trim();

    // If "clear", remove topic restriction
    if (args.toLowerCase() === 'clear') {
      database.groups.update(chatId, { active_topic_id: null });
      await sendToChat('✅ Ограничение по топику снято. Бот слушает все сообщения в группе.');
      return;
    }

    // If no thread_id, we're in the general chat
    if (!threadId) {
      if (group.active_topic_id) {
        await sendToChat(
          `📍 Бот слушает топик #${group.active_topic_id}\n\n` +
            `<i>Вызови /topic в нужном топике чтобы сменить, или /topic clear чтобы слушать всё</i>`,
          { parse_mode: 'HTML' },
        );
      } else {
        await sendToChat(
          '📍 Бот слушает все сообщения в группе.\n\n' +
            '<i>Вызови /topic в нужном топике чтобы ограничить</i>',
          { parse_mode: 'HTML' },
        );
      }
      return;
    }

    // Set topic restriction
    database.groups.update(chatId, { active_topic_id: threadId });
    await sendToChat(
      `✅ Бот теперь слушает только этот топик (#${threadId})\n\n` +
        `<i>Расходы и команды из других топиков будут игнорироваться.\n` +
        `/topic clear — слушать все сообщения</i>`,
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    logger.error({ err: error }, '[CMD] Error in /topic');
    await sendToChat(formatErrorForUser(error));
  }
}
