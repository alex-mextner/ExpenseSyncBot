import { database } from '../../database';
import { createLogger } from '../../utils/logger.ts';
import { formatErrorForUser } from '../bot-error-formatter';
import type { Ctx } from '../types';

const logger = createLogger('cmd-categories');

/**
 * /categories command handler
 */
export async function handleCategoriesCommand(ctx: Ctx['Command']): Promise<void> {
  try {
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;

    if (!chatId) {
      await ctx.send('❌ Не удалось определить чат');
      return;
    }

    // Only allow in groups
    const isGroup = chatType === 'group' || chatType === 'supergroup';

    if (!isGroup) {
      await ctx.send('❌ Эта команда работает только в группах.');
      return;
    }

    const group = database.groups.findByTelegramGroupId(chatId);

    if (!group) {
      await ctx.send('❌ Группа не настроена. Используй /connect');
      return;
    }

    const categories = database.categories.findByGroupId(group.id);

    if (categories.length === 0) {
      await ctx.send(
        '📋 Категории пока не созданы.\n\nОни будут создаваться автоматически из ваших расходов.',
      );
      return;
    }

    let message = '📋 Категории группы:\n\n';
    for (const category of categories) {
      message += `• ${category.name}\n`;
    }

    await ctx.send(message);
  } catch (error) {
    logger.error({ err: error }, '[CMD] Error in /categories');
    await ctx.send(formatErrorForUser(error));
  }
}
