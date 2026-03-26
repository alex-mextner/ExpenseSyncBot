/** /sync command handler — imports expenses from Google Sheets into the local database */
import type { CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import { readExpensesFromSheet } from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import { formatErrorForUser } from '../bot-error-formatter';
import type { Ctx } from '../types';

const logger = createLogger('sync');

/**
 * /sync command handler - sync expenses from Google Sheet to database.
 * Usage: /sync — pull from sheet, /sync rollback — restore last snapshot.
 */
export async function handleSyncCommand(ctx: Ctx['Command']): Promise<void> {
  try {
    const chatId = ctx.chat?.id;
    const chatType = ctx.chat?.type;

    if (!chatId) {
      await ctx.send('❌ Не удалось определить чат');
      return;
    }

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

    // Check for "rollback" argument
    const commandText = ctx.text || '';
    const args = commandText.split(/\s+/).slice(1).join(' ').trim();

    if (args.toLowerCase() === 'rollback') {
      await handleSyncRollback(ctx, group.id);
      return;
    }

    if (!group.spreadsheet_id || !group.google_refresh_token) {
      await ctx.send('❌ Google таблица не подключена. Используй /connect');
      return;
    }

    await ctx.send('🔄 Начинаю синхронизацию...');

    logger.info(`[SYNC] Reading expenses from Google Sheet for group ${group.id}`);

    const sheetExpenses = await readExpensesFromSheet(
      group.google_refresh_token,
      group.spreadsheet_id,
    );

    logger.info(`[SYNC] Found ${sheetExpenses.length} expenses in sheet`);

    // Save snapshot of current expenses BEFORE deleting
    const currentExpenses = database.expenses.findByGroupId(group.id);
    if (currentExpenses.length > 0) {
      database.syncSnapshots.create(group.id, currentExpenses, currentExpenses.length);
      logger.info(`[SYNC] Saved snapshot of ${currentExpenses.length} expenses`);
    }

    // Delete + re-insert in a transaction
    database.transaction(() => {
      const deletedCount = database.expenses.deleteAllByGroupId(group.id);
      logger.info(`[SYNC] Deleted ${deletedCount} existing expenses from database`);

      const users = database.users.findByGroupId ? database.users.findByGroupId(group.id) : [];
      const defaultUserId = users[0]?.id ?? 1;

      // Collect and create unique categories
      const categoriesInSheet = new Set<string>();
      for (const expense of sheetExpenses) {
        if (expense.category && expense.category !== 'Без категории') {
          categoriesInSheet.add(expense.category);
        }
      }

      let createdCategoriesCount = 0;
      for (const categoryName of categoriesInSheet) {
        if (!database.categories.exists(group.id, categoryName)) {
          database.categories.create({ group_id: group.id, name: categoryName });
          createdCategoriesCount++;
        }
      }

      // Insert all expenses from sheet
      let syncedCount = 0;
      for (const expense of sheetExpenses) {
        let amount = 0;
        let currency: CurrencyCode = 'EUR';

        for (const [curr, amt] of Object.entries(expense.amounts)) {
          amount = amt;
          currency = curr as CurrencyCode;
          break;
        }

        if (amount === 0) continue;

        database.expenses.create({
          group_id: group.id,
          user_id: defaultUserId,
          date: expense.date,
          category: expense.category,
          comment: expense.comment,
          amount,
          currency,
          eur_amount: expense.eurAmount,
        });

        syncedCount++;
      }

      logger.info(`[SYNC] ✅ Synced ${syncedCount} expenses, ${createdCategoriesCount} categories`);

      ctx
        .send(
          `✅ Синхронизация завершена!\n\n` +
            `📥 Загружено расходов: ${syncedCount}\n` +
            `📁 Создано категорий: ${createdCategoriesCount}\n\n` +
            `<i>Если что-то пошло не так — /sync rollback</i>`,
          { parse_mode: 'HTML' },
        )
        .catch((err) => logger.error({ err }, '[SYNC] Failed to send success message'));
    });
  } catch (error) {
    logger.error({ err: error }, '[SYNC] ❌ Sync failed');
    await ctx.send(formatErrorForUser(error));
  }
}

/**
 * Handle /sync rollback — restore expenses from the latest snapshot
 */
async function handleSyncRollback(ctx: Ctx['Command'], groupId: number): Promise<void> {
  const snapshot = database.syncSnapshots.getLatest(groupId);

  if (!snapshot) {
    await ctx.send('❌ Нет сохранённых снимков для отката. Откат доступен после /sync.');
    return;
  }

  const snapshotDate = new Date(snapshot.created_at).toLocaleString('ru-RU');

  await ctx.send(
    `🔄 Восстанавливаю ${snapshot.expense_count} расходов из снимка от ${snapshotDate}...`,
  );

  try {
    const expenses = JSON.parse(snapshot.snapshot_data) as Array<{
      group_id: number;
      user_id: number;
      date: string;
      category: string;
      comment: string;
      amount: number;
      currency: CurrencyCode;
      eur_amount: number;
    }>;

    database.transaction(() => {
      database.expenses.deleteAllByGroupId(groupId);

      for (const expense of expenses) {
        database.expenses.create({
          group_id: expense.group_id,
          user_id: expense.user_id,
          date: expense.date,
          category: expense.category,
          comment: expense.comment || '',
          amount: expense.amount,
          currency: expense.currency,
          eur_amount: expense.eur_amount,
        });
      }
    });

    await ctx.send(
      `✅ Откат завершён! Восстановлено ${expenses.length} расходов.`,
    );

    logger.info(`[SYNC] Rollback complete for group ${groupId}: ${expenses.length} expenses restored`);
  } catch (error) {
    logger.error({ err: error }, '[SYNC] Rollback failed');
    await ctx.send('❌ Ошибка при откате. Попробуй ещё раз.');
  }
}
