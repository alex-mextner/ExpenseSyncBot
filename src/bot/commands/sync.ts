import type { Ctx } from '../types';
import { database } from '../../database';
import type { CurrencyCode } from '../../config/constants';
import { readExpensesFromSheet } from '../../services/google/sheets';

/**
 * /sync command handler - sync expenses from Google Sheet to database
 */
export async function handleSyncCommand(ctx: Ctx["Command"]): Promise<void> {
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
    console.log(`[SYNC] Reading expenses from Google Sheet for group ${group.id}`);

    // Read all expenses from sheet
    const sheetExpenses = await readExpensesFromSheet(
      group.google_refresh_token,
      group.spreadsheet_id
    );

    console.log(`[SYNC] Found ${sheetExpenses.length} expenses in sheet`);

    // Delete all existing expenses for this group
    const deletedCount = database.expenses.deleteAllByGroupId(group.id);
    console.log(`[SYNC] Deleted ${deletedCount} existing expenses from database`);

    // Get the first user from this group (for user_id field)
    const users = database.users.findByGroupId ? database.users.findByGroupId(group.id) : [];
    const defaultUserId = users.length > 0 ? users[0]!.id : 1;

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
        console.log(`[SYNC] Created category: "${categoryName}"`);
      }
    }

    console.log(`[SYNC] Created ${createdCategoriesCount} new categories`);

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

    console.log(`[SYNC] ✅ Synced ${syncedCount} expenses`);

    await ctx.send(
      `✅ Синхронизация завершена!\n\n` +
      `📊 Удалено расходов: ${deletedCount}\n` +
      `📥 Загружено расходов: ${syncedCount}\n` +
      `📁 Создано категорий: ${createdCategoriesCount}\n` +
      `💾 Всего в БД: ${syncedCount}`
    );

  } catch (error) {
    console.error('[SYNC] ❌ Sync failed:', error);
    await ctx.send(`❌ Ошибка синхронизации: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
