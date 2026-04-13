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
import { getExpenseRecorder, type RecordReceiptItem } from '../../services/expense-recorder';
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
 * Save all confirmed receipt items as expenses. Delegates the write to
 * `ExpenseRecorder.recordReceipt` so the bot and Mini App flows share one
 * batched write path.
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

  // Skip items with no confirmed category (defensive — shouldn't happen)
  const itemsWithCategory = confirmedItems.filter((i) => i.confirmed_category);

  // Convert DB rows to the recorder's input shape
  const recordItems: RecordReceiptItem[] = itemsWithCategory.map((i) => ({
    name: i.name_ru,
    nameOriginal: i.name_original ?? null,
    quantity: i.quantity,
    price: i.price,
    total: i.total,
    currency: i.currency as CurrencyCode,
    // confirmed_category is guaranteed non-null by the filter above
    category: i.confirmed_category as string,
  }));

  // Use the receipt's actual date if available, fall back to today
  const receipt = database.receipts.findByPhotoQueueId(photoQueueId);
  const date = receipt?.date ?? format(new Date(), 'yyyy-MM-dd');

  const recorder = getExpenseRecorder();

  let result: Awaited<ReturnType<typeof recorder.recordReceipt>>;
  try {
    result = await recorder.recordReceipt(groupId, userId, {
      date,
      items: recordItems,
      receiptId: receipt?.id ?? null,
    });
  } catch (error) {
    logger.error({ err: error }, '[RECEIPT] Failed to write to Google Sheet — receipt items kept');
    await sendMessage(getSheetErrorMessage(error));
    return;
  }

  // Delete all processed receipt items (confirmed + skipped)
  database.receiptItems.deleteProcessedByPhotoQueueId(photoQueueId);

  // Check budgets for affected categories
  for (const category of result.categoriesAffected) {
    await checkBudgetLimit(groupId, category, date);
  }

  // Notify user
  const totalItems = itemsWithCategory.length;
  const totalCategories = result.categoriesAffected.length;

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
