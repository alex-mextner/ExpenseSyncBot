/** Saving expenses (manual and receipt) to Google Sheets and local DB */
import { format } from 'date-fns';
import { InlineKeyboard } from 'gramio';
import type { CurrencyCode } from '../../config/constants';
import { env } from '../../config/env';
import { database } from '../../database';
import { convertCurrency, formatAmount } from '../../services/currency/converter';
import { createLogger } from '../../utils/logger.ts';
import { silentSyncBudgets } from '../commands/budget';
import type { BotInstance } from '../types';

const logger = createLogger('expense-saver');

/**
 * Save expense to Google Sheet
 */
export async function saveExpenseToSheet(
  userId: number,
  groupId: number,
  pendingExpenseId: number,
  telegramGroupId?: number,
  bot?: BotInstance,
): Promise<void> {
  logger.info('[SAVE] Starting save to sheet...');

  const user = database.users.findById(userId);
  const group = database.groups.findById(groupId);
  const pendingExpense = database.pendingExpenses.findById(pendingExpenseId);

  if (!user || !group || !pendingExpense || !group.spreadsheet_id || !group.google_refresh_token) {
    logger.error(
      {
        data: {
          user: !!user,
          group: !!group,
          pendingExpense: !!pendingExpense,
          spreadsheet_id: !!group?.spreadsheet_id,
          refresh_token: !!group?.google_refresh_token,
        },
      },
      `[SAVE] ❌ Validation failed`,
    );
    throw new Error('Invalid user, group or pending expense');
  }

  const { convertToEUR } = await import('../../services/currency/converter');
  const { appendExpenseRow } = await import('../../services/google/sheets');

  // Silent sync budgets from Google Sheets
  await silentSyncBudgets(group.google_refresh_token, group.id);

  // Calculate EUR amount
  const eurAmount = convertToEUR(pendingExpense.parsed_amount, pendingExpense.parsed_currency);

  logger.info(
    `[SAVE] Converted ${pendingExpense.parsed_amount} ${pendingExpense.parsed_currency} → ${eurAmount} EUR`,
  );

  // Prepare amounts for each currency
  const amounts: Record<string, number | null> = {};
  for (const currency of group.enabled_currencies) {
    amounts[currency] =
      currency === pendingExpense.parsed_currency ? pendingExpense.parsed_amount : null;
  }

  // Append to sheet
  const currentDate = format(new Date(), 'yyyy-MM-dd');
  const category = pendingExpense.detected_category || 'Без категории';

  logger.info(
    { data: { date: currentDate, category, comment: pendingExpense.comment, amounts, eurAmount } },
    `[SAVE] Writing to Google Sheet`,
  );

  try {
    await appendExpenseRow(group.google_refresh_token, group.spreadsheet_id, {
      date: currentDate,
      category,
      comment: pendingExpense.comment,
      amounts,
      eurAmount,
    });

    logger.info('[SAVE] ✅ Successfully wrote to Google Sheet');
  } catch (error) {
    logger.error({ err: error }, '[SAVE] ❌ Failed to write to Google Sheet');
    throw error;
  }

  // Save to expenses table and delete pending — atomic
  logger.info('[SAVE] Saving to local database...');
  database.transaction(() => {
    database.expenses.create({
      group_id: groupId,
      user_id: userId,
      date: currentDate,
      category,
      comment: pendingExpense.comment,
      amount: pendingExpense.parsed_amount,
      currency: pendingExpense.parsed_currency,
      eur_amount: eurAmount,
    });

    // Delete pending expense
    database.pendingExpenses.delete(pendingExpenseId);
  });
  logger.info(`[SAVE] ✅ Deleted pending expense ${pendingExpenseId}`);

  // Check budget limits
  if (telegramGroupId && bot) {
    await checkBudgetLimit(groupId, category, currentDate, telegramGroupId, bot);
  }
}

/**
 * Check if budget limit is exceeded or approaching for a category
 */
async function checkBudgetLimit(
  groupId: number,
  category: string,
  currentDate: string,
  telegramGroupId: number,
  bot: BotInstance,
): Promise<void> {
  const { startOfMonth, endOfMonth, format } = await import('date-fns');
  const { getCategoryEmoji } = await import('../../config/category-emojis');

  const now = new Date(currentDate);
  const currentMonth = format(now, 'yyyy-MM');
  const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
  const monthEnd = format(endOfMonth(now), 'yyyy-MM-dd');

  // Get budget for category
  const budget = database.budgets.getBudgetForMonth(groupId, category, currentMonth);

  if (!budget) {
    // No budget set for this category
    return;
  }

  // sumByCategory returns EUR amounts — convert to budget currency for comparison and display
  const spentEur = database.expenses.sumByCategory(groupId, category, monthStart, monthEnd);
  const budgetCurrency = budget.currency as CurrencyCode;
  const spentInCurrency = convertCurrency(spentEur, 'EUR', budgetCurrency);

  const percentage =
    budget.limit_amount > 0 ? Math.round((spentInCurrency / budget.limit_amount) * 100) : 0;

  const isExceeded = spentInCurrency > budget.limit_amount;
  const isWarning = percentage >= 90 && !isExceeded;

  if (isExceeded || isWarning) {
    const emoji = getCategoryEmoji(category);
    const progress = `${formatAmount(spentInCurrency, budgetCurrency)} / ${formatAmount(budget.limit_amount, budgetCurrency)} (${percentage}%)`;
    let message = '';

    if (isExceeded) {
      message = `🔴 ПРЕВЫШЕН БЮДЖЕТ!\n`;
      message += `${emoji} ${category}: ${progress}`;
    } else if (isWarning) {
      message = `⚠️ Внимание! Приближение к лимиту бюджета:\n`;
      message += `${emoji} ${category}: ${progress}`;
    }

    try {
      await bot.api.sendMessage({
        chat_id: telegramGroupId,
        text: message,
      });
      logger.info(`[BUDGET] Sent warning for category "${category}": ${percentage}%`);
    } catch (error) {
      logger.error({ err: error }, '[BUDGET] Failed to send warning');
    }
  }
}

/**
 * Save all confirmed receipt items as expenses
 */
export async function saveReceiptExpenses(
  photoQueueId: number,
  groupId: number,
  userId: number,
  bot: BotInstance,
): Promise<void> {
  const confirmedItems = database.receiptItems.findConfirmedByPhotoQueueId(photoQueueId);

  if (confirmedItems.length === 0) {
    return;
  }

  const group = database.groups.findById(groupId);

  if (!group || !group.spreadsheet_id || !group.google_refresh_token) {
    logger.error('[RECEIPT] Group not configured for Google Sheets');
    return;
  }

  // Group items by category
  const itemsByCategory: Map<string, typeof confirmedItems> = new Map();

  for (const item of confirmedItems) {
    const category = item.confirmed_category;
    if (!category) {
      continue;
    }
    if (!itemsByCategory.has(category)) {
      itemsByCategory.set(category, []);
    }
    const categoryItems = itemsByCategory.get(category);
    if (categoryItems) {
      categoryItems.push(item);
    }
  }

  const { convertToEUR } = await import('../../services/currency/converter');
  const { appendExpenseRow } = await import('../../services/google/sheets');

  const currentDate = format(new Date(), 'yyyy-MM-dd');

  // For each category, create one expense with multiple items
  for (const [category, items] of itemsByCategory.entries()) {
    if (items.length === 0) {
      continue;
    }

    // Calculate total amount for this category
    const totalAmount = items.reduce((sum, item) => sum + item.total, 0);
    const firstItem = items[0];
    if (!firstItem) {
      continue;
    }
    const currency = firstItem.currency; // All items should have same currency

    // Convert to EUR
    const eurAmount = convertToEUR(totalAmount, currency);

    // Build comment with item details
    const itemNames = items.map((item) => `${item.name_ru} (${item.quantity}x${item.price})`);
    const comment = `Чек: ${itemNames.join(', ')}`;

    // Prepare amounts for each enabled currency
    const amounts: Record<string, number | null> = {};
    for (const curr of group.enabled_currencies) {
      amounts[curr] = curr === currency ? totalAmount : null;
    }

    // Append to Google Sheet
    try {
      await appendExpenseRow(group.google_refresh_token, group.spreadsheet_id, {
        date: currentDate,
        category,
        comment,
        amounts,
        eurAmount,
      });
    } catch (error) {
      logger.error({ err: error }, '[RECEIPT] Failed to write to Google Sheet');
      continue;
    }

    // Create expense + items atomically in a transaction
    database.transaction(() => {
      const expense = database.expenses.create({
        group_id: groupId,
        user_id: userId,
        date: currentDate,
        category,
        comment,
        amount: totalAmount,
        currency,
        eur_amount: eurAmount,
      });

      for (const item of items) {
        database.expenseItems.create({
          expense_id: expense.id,
          name_ru: item.name_ru,
          name_original: item.name_original || null,
          quantity: item.quantity,
          price: item.price,
          total: item.total,
        });
      }
    });
  }

  // Delete all processed receipt items (confirmed + skipped)
  database.receiptItems.deleteProcessedByPhotoQueueId(photoQueueId);

  // Notify user
  const totalItems = confirmedItems.length;
  const totalCategories = itemsByCategory.size;

  const scanButton = env.MINIAPP_URL
    ? new InlineKeyboard().webApp(
        '📷 Сканировать чек',
        `${env.MINIAPP_URL}?groupId=${group.telegram_group_id}&tab=scanner`,
      )
    : undefined;

  await bot.api.sendMessage({
    chat_id: group.telegram_group_id,
    text: `✅ Чек обработан!\n📦 Товаров: ${totalItems}\n📂 Категорий: ${totalCategories}`,
    parse_mode: 'HTML',
    ...(scanButton ? { reply_markup: scanButton } : {}),
  });

  logger.info(`[RECEIPT] Saved ${totalItems} items from receipt (${totalCategories} categories)`);
}
