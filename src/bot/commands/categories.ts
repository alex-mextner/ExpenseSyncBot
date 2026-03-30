import { database } from '../../database';
import type { Group } from '../../database/types';
import type { Ctx } from '../types';

/**
 * /categories command handler
 */
export async function handleCategoriesCommand(ctx: Ctx['Command'], group: Group): Promise<void> {
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
}
