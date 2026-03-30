/** /prompt command handler — view or set the custom AI system prompt for a group */
import { database } from '../../database';
import type { Group } from '../../database/types';
import { createLogger } from '../../utils/logger.ts';
import { formatErrorForUser } from '../bot-error-formatter';
import type { Ctx } from '../types';

const logger = createLogger('cmd-prompt');

/**
 * /prompt command handler - set or view custom AI prompt for the group
 * Usage:
 *   /prompt - view current custom prompt
 *   /prompt <text> - set custom prompt
 *   /prompt clear - clear custom prompt
 */
export async function handlePromptCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  const chatId = ctx.chat?.id;

  try {
    // Get command argument
    const commandText = ctx.text || '';
    const args = commandText.split(/\s+/).slice(1).join(' ').trim();

    // If no args, show current prompt
    if (!args) {
      if (group.custom_prompt) {
        await ctx.send(
          `📝 Текущий кастомный промпт:\n\n${group.custom_prompt}\n\n<i>Используй /prompt clear чтобы очистить</i>`,
          { parse_mode: 'HTML' },
        );
      } else {
        await ctx.send(
          '📝 Кастомный промпт не установлен.\n\nИспользуй: /prompt <текст> чтобы установить промпт',
        );
      }
      return;
    }

    // If "clear", remove custom prompt
    if (args.toLowerCase() === 'clear') {
      database.groups.update(chatId, { custom_prompt: null });
      await ctx.send('✅ Кастомный промпт очищен');
      return;
    }

    // Set new prompt
    database.groups.update(chatId, { custom_prompt: args });
    await ctx.send(
      `✅ Кастомный промпт установлен:\n\n${args}\n\n<i>Этот промпт будет добавлен к системному при ответах бота</i>`,
      { parse_mode: 'HTML' },
    );
  } catch (error) {
    logger.error({ err: error }, '[CMD] Error in /prompt');
    await ctx.send(formatErrorForUser(error));
  }
}
