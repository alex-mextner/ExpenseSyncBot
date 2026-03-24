import type { CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import { readExpensesFromSheet } from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import type { Ctx } from '../types';

const logger = createLogger('sync');

/**
 * /sync command handler - sync expenses from Google Sheet to database
 */
export async function handleSyncCommand(ctx: Ctx['Command']): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;

  if (!chatId) {
    await ctx.send('Error: Unable to identify chat');
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

  if (!group.spreadsheet_id || !group.google_refresh_token) {
    await ctx.send('❌ Google таблица не подключена. Используй /connect');
    return;
  }

  await ctx.send('🔄 Начинаю синхронизацию...');

  try {
    logger.info(`[SYNC] Reading expenses from Google Sheet for group ${group.id}`);

    // Read all expenses from sheet
    const { expenses: sheetExpenses, errors: multiCurrencyErrors } = await readExpensesFromSheet(
      group.google_refresh_token,
      group.spreadsheet_id,
    );

    logger.info(`[SYNC] Found ${sheetExpenses.length} expenses in sheet`);

    // Report multi-currency errors
    if (multiCurrencyErrors.length > 0) {
      const errorLines = multiCurrencyErrors.map(
        (e) => `• Строка ${e.row}: ${e.date} ${e.category} — валюты: ${e.currencies.join(', ')}`,
      );
      await ctx.send(
        `⚠️ Найдены строки с суммами в нескольких валютах одновременно:\n${errorLines.join('\n')}\n\n` +
          `Поправь в таблице — в каждой строке сумма должна быть только в одном столбце валюты. Эти строки пропущены.`,
      );
    }

    // Delete all existing expenses for this group
    const deletedCount = database.expenses.deleteAllByGroupId(group.id);
    logger.info(`[SYNC] Deleted ${deletedCount} existing expenses from database`);

    // Get the first user from this group (for user_id field)
    const users = database.users.findByGroupId ? database.users.findByGroupId(group.id) : [];
    const defaultUserId = users[0]?.id ?? 1;

    // Collect unique categories from sheet
    const categoriesInSheet = new Set<string>();
    for (const expense of sheetExpenses) {
      if (expense.category && expense.category !== 'Без категории') {
        categoriesInSheet.add(expense.category);
      }
    }

    // Create missing categories
    let createdCategoriesCount = 0;
    for (const categoryName of categoriesInSheet) {
      if (!database.categories.exists(group.id, categoryName)) {
        database.categories.create({
          group_id: group.id,
          name: categoryName,
        });
        createdCategoriesCount++;
        logger.info(`[SYNC] Created category: "${categoryName}"`);
      }
    }

    logger.info(`[SYNC] Created ${createdCategoriesCount} new categories`);

    // Insert all expenses from sheet
    let syncedCount = 0;
    for (const expense of sheetExpenses) {
      // Find the first non-null currency and amount
      let amount = 0;
      let currency: CurrencyCode = 'EUR';

      for (const [curr, amt] of Object.entries(expense.amounts)) {
        amount = amt;
        currency = curr as CurrencyCode;
        break;
      }

      if (amount === 0) {
        continue;
      }

      database.expenses.create({
        group_id: group.id,
        user_id: defaultUserId,
        date: expense.date,
        category: expense.category,
        comment: expense.comment,
        amount: amount,
        currency: currency,
        eur_amount: expense.eurAmount,
      });

      syncedCount++;
    }

    logger.info(`[SYNC] ✅ Synced ${syncedCount} expenses`);

    await ctx.send(
      `✅ Синхронизация завершена!\n\n` +
        `📊 Удалено расходов: ${deletedCount}\n` +
        `📥 Загружено расходов: ${syncedCount}\n` +
        `📁 Создано категорий: ${createdCategoriesCount}\n` +
        `💾 Всего в БД: ${syncedCount}`,
    );
  } catch (error) {
    logger.error({ err: error }, '[SYNC] ❌ Sync failed');
    await ctx.send(
      `❌ Ошибка синхронизации: ${error instanceof Error ? error.message : 'Unknown error'}`,
    );
  }
}
