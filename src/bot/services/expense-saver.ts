/** Saving expenses (manual and receipt) to Google Sheets and local DB */
import { endOfMonth, format, startOfMonth } from 'date-fns';
import { InlineKeyboard } from 'gramio';
import { getCategoryEmoji } from '../../config/category-emojis';
import type { CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import type { Group, PendingExpense } from '../../database/types';
import { sendMessage } from '../../services/bank/telegram-sender';
import {
  convertCurrency,
  convertToEUR,
  formatAmount,
  getExchangeRate,
} from '../../services/currency/converter';
import { appendExpenseRows, type ExpenseRowData, googleConn } from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import { buildMiniAppUrl } from '../../utils/miniapp-url';
import { silentSyncBudgets } from './budget-sync';
import { getSheetErrorMessage } from './sheet-errors';

const logger = createLogger('expense-saver');

// ── Internal types ──────────────────────────────────────────────────────────

interface ExpenseWriteData {
  pendingExpenseId: number;
  date: string;
  category: string;
  comment: string;
  amount: number;
  currency: CurrencyCode;
  eurAmount: number;
}

// ── Core: prepare row data (no I/O) ─────────────────────────────────────────

/** Build row data and DB write data from a pending expense. Pure computation. */
function prepareExpenseRow(
  group: Group,
  pendingExpense: PendingExpense,
  currentDate: string,
): { row: ExpenseRowData; write: ExpenseWriteData } {
  const eurAmount = convertToEUR(pendingExpense.parsed_amount, pendingExpense.parsed_currency);
  const category = pendingExpense.detected_category || 'Без категории';
  const rate = getExchangeRate(pendingExpense.parsed_currency);

  const amounts: Record<string, number | null> = {};
  for (const currency of group.enabled_currencies) {
    amounts[currency] =
      currency === pendingExpense.parsed_currency ? pendingExpense.parsed_amount : null;
  }

  return {
    row: { date: currentDate, category, comment: pendingExpense.comment, amounts, eurAmount, rate },
    write: {
      pendingExpenseId: pendingExpense.id,
      date: currentDate,
      category,
      comment: pendingExpense.comment,
      amount: pendingExpense.parsed_amount,
      currency: pendingExpense.parsed_currency,
      eurAmount,
    },
  };
}

// ── Core: DB commit ─────────────────────────────────────────────────────────

/** Commit written expenses to local DB in a single transaction */
function commitExpensesToDb(groupId: number, userId: number, expenses: ExpenseWriteData[]): void {
  database.transaction(() => {
    for (const e of expenses) {
      database.expenses.create({
        group_id: groupId,
        user_id: userId,
        date: e.date,
        category: e.category,
        comment: e.comment,
        amount: e.amount,
        currency: e.currency,
        eur_amount: e.eurAmount,
      });
      database.pendingExpenses.delete(e.pendingExpenseId);
    }
  });
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Save a single expense to Google Sheets + local DB.
 * Used by callback handler for one-off expense confirmations.
 */
export async function saveExpenseToSheet(
  userId: number,
  groupId: number,
  pendingExpenseId: number,
): Promise<void> {
  return saveExpenseBatch(userId, groupId, [pendingExpenseId]);
}

/**
 * Save batch of expenses atomically:
 * 1. Sync budgets once
 * 2. Write all rows to Google Sheets
 * 3. If all succeed → commit to local DB in one transaction
 * 4. If any fails → throw, nothing committed to DB
 */
export async function saveExpenseBatch(
  userId: number,
  groupId: number,
  pendingExpenseIds: number[],
): Promise<void> {
  if (pendingExpenseIds.length === 0) return;

  const groupRaw = database.groups.findById(groupId);
  if (!groupRaw?.spreadsheet_id || !groupRaw.google_refresh_token) {
    throw new Error('Group not configured for Google Sheets');
  }
  const group = groupRaw as typeof groupRaw & { spreadsheet_id: string };

  // Sync budgets once before the batch
  await silentSyncBudgets(googleConn(group), group.id);

  // Compute date once — all rows in a batch share the same timestamp
  const currentDate = format(new Date(), 'yyyy-MM-dd');

  // Prepare all rows (pure computation, no I/O)
  const rows: ExpenseRowData[] = [];
  const writes: ExpenseWriteData[] = [];

  for (const id of pendingExpenseIds) {
    const pendingExpense = database.pendingExpenses.findById(id);
    if (!pendingExpense) {
      throw new Error(`Pending expense ${id} not found`);
    }

    const { row, write } = prepareExpenseRow(group, pendingExpense, currentDate);
    rows.push(row);
    writes.push(write);
  }

  // Write all rows to sheet in one API call (or throw)
  logger.info(`[SAVE] Writing ${rows.length} expenses to Google Sheet`);
  await appendExpenseRows(googleConn(group), group.spreadsheet_id, rows);
  logger.info('[SAVE] ✅ All rows written to Google Sheet');

  // All sheets writes succeeded — commit to DB atomically
  commitExpensesToDb(groupId, userId, writes);
  logger.info(`[SAVE] ✅ Committed ${writes.length} expenses to DB`);

  // Check budgets for affected categories (deduplicated)
  const checkedCategories = new Set<string>();
  for (const e of writes) {
    if (!checkedCategories.has(e.category)) {
      checkedCategories.add(e.category);
      await checkBudgetLimit(groupId, e.category, e.date);
    }
  }
}

/**
 * Check if budget limit is exceeded or approaching for a category
 */
async function checkBudgetLimit(
  groupId: number,
  category: string,
  currentDate: string,
): Promise<void> {
  const now = new Date(currentDate);
  const currentMonth = format(now, 'yyyy-MM');
  const monthStart = format(startOfMonth(now), 'yyyy-MM-dd');
  const monthEnd = format(endOfMonth(now), 'yyyy-MM-dd');

  const budget = database.budgets.getBudgetForMonth(groupId, category, currentMonth);

  if (!budget) {
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
      await sendMessage(message);
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

  const currentDate = format(new Date(), 'yyyy-MM-dd');

  // Prepare per-category data for sheet writes
  interface CategoryBatch {
    category: string;
    items: typeof confirmedItems;
    totalAmount: number;
    currency: CurrencyCode;
    eurAmount: number;
    comment: string;
    amounts: Record<string, number | null>;
    rate: number;
  }
  const batches: CategoryBatch[] = [];

  for (const [category, items] of itemsByCategory.entries()) {
    if (items.length === 0) continue;

    const totalAmount = items.reduce((sum, item) => sum + item.total, 0);
    const firstItem = items[0];
    if (!firstItem) continue;
    const currency = firstItem.currency;

    const eurAmount = convertToEUR(totalAmount, currency);
    const rate = getExchangeRate(currency as CurrencyCode);

    const itemNames = items.map((item) => `${item.name_ru} (${item.quantity}x${item.price})`);
    const comment = `Чек: ${itemNames.join(', ')}`;

    const amounts: Record<string, number | null> = {};
    for (const curr of group.enabled_currencies) {
      amounts[curr] = curr === currency ? totalAmount : null;
    }

    batches.push({ category, items, totalAmount, currency, eurAmount, comment, amounts, rate });
  }

  // Write all categories to sheet in one API call — if fails, nothing is committed to DB
  const sheetRows: ExpenseRowData[] = batches.map((batch) => ({
    date: currentDate,
    category: batch.category,
    comment: batch.comment,
    amounts: batch.amounts,
    eurAmount: batch.eurAmount,
    rate: batch.rate,
  }));

  try {
    await appendExpenseRows(googleConn(group), group.spreadsheet_id, sheetRows);
  } catch (error) {
    logger.error({ err: error }, '[RECEIPT] Failed to write to Google Sheet — receipt items kept');
    await sendMessage(getSheetErrorMessage(error));
    return;
  }

  // All sheet writes succeeded — commit all to DB in one transaction
  database.transaction(() => {
    for (const batch of batches) {
      const expense = database.expenses.create({
        group_id: groupId,
        user_id: userId,
        date: currentDate,
        category: batch.category,
        comment: batch.comment,
        amount: batch.totalAmount,
        currency: batch.currency,
        eur_amount: batch.eurAmount,
      });

      for (const item of batch.items) {
        database.expenseItems.create({
          expense_id: expense.id,
          name_ru: item.name_ru,
          name_original: item.name_original || null,
          quantity: item.quantity,
          price: item.price,
          total: item.total,
        });
      }
    }
  });

  // Check budgets for affected categories
  for (const batch of batches) {
    await checkBudgetLimit(groupId, batch.category, currentDate);
  }

  // Delete all processed receipt items (confirmed + skipped)
  database.receiptItems.deleteProcessedByPhotoQueueId(photoQueueId);

  // Notify user
  const totalItems = confirmedItems.length;
  const totalCategories = itemsByCategory.size;

  const miniAppUrl = buildMiniAppUrl('scanner', group.telegram_group_id);
  const scanButton = miniAppUrl
    ? new InlineKeyboard().url('📷 Сканировать чек', miniAppUrl)
    : undefined;

  await sendMessage(
    `✅ Чек обработан!\n📦 Товаров: ${totalItems}\n📂 Категорий: ${totalCategories}`,
    scanButton ? { reply_markup: scanButton } : undefined,
  );

  logger.info(`[RECEIPT] Saved ${totalItems} items from receipt (${totalCategories} categories)`);
}
