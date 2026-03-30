/** /categories command handler — lists all expense categories for the group */
import { database } from '../../database';
import type { Group } from '../../database/types';
import { createLogger } from '../../utils/logger.ts';
import { formatErrorForUser } from '../bot-error-formatter';
import type { Ctx } from '../types';

const logger = createLogger('cmd-categories');

/**
 * /categories command handler
 */
export async function handleCategoriesCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
  try {
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
