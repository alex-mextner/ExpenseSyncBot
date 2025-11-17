import type { Ctx } from '../types';
import { database } from '../../database';

/**
 * /categories command handler
 */
export async function handleCategoriesCommand(ctx: Ctx["Command"]): Promise<void> {
  const telegramId = ctx.from?.id;

  if (!telegramId) {
    await ctx.send('Error: Unable to identify user');
    return;
  }

  const user = database.users.findByTelegramId(telegramId);

  if (!user) {
    await ctx.send('Пожалуйста, начни с команды /start');
    return;
  }

  // Get categories
  const categories = database.categories.findByUserId(user.id);

  if (categories.length === 0) {
    await ctx.send(
      '📋 У тебя пока нет категорий.\n\n' +
      'Категории создаются автоматически при добавлении расходов.'
    );
    return;
  }

  let message = '📋 **Твои категории:**\n\n';

  for (const category of categories) {
    const expenseCount = database.expenses.findByCategory(user.id, category.name).length;
    message += `• ${category.name} (${expenseCount} ${expenseCount === 1 ? 'расход' : 'расходов'})\n`;
  }

  message += '\n_Категории создаются автоматически из первого слова после суммы._';

  await ctx.send(message, { parse_mode: 'Markdown' });
}
