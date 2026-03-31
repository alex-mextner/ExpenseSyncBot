/** /push command handler — writes local expenses to Google Sheets and reconciles missing rows */
import { database } from '../../database';
import type { Expense } from '../../database/types';
import { getExpenseRecorder } from '../../services/expense-recorder';
import { readExpensesFromSheet, type SheetRow } from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import type { GoogleConnectedGroup } from '../guards';
import { sendToChat } from '../send';
import type { Ctx } from '../types';

const logger = createLogger('push');

/**
 * Create unique key for expense comparison
 * Key: date|category|amount|currency
 */
function makeExpenseKey(date: string, category: string, amount: number, currency: string): string {
  return `${date}|${category}|${amount}|${currency}`;
}

/**
 * Extract key from SheetRow (uses first currency found)
 */
function makeSheetRowKey(row: SheetRow): string | null {
  for (const [currency, amount] of Object.entries(row.amounts)) {
    return makeExpenseKey(row.date, row.category, amount, currency);
  }
  return null;
}

/**
 * Extract key from DB Expense
 */
function makeDbExpenseKey(expense: Expense): string {
  return makeExpenseKey(expense.date, expense.category, expense.amount, expense.currency);
}

/**
 * /push command handler - push expenses from database to Google Sheet
 */
export async function handlePushCommand(
  ctx: Ctx['Command'],
  group: GoogleConnectedGroup,
): Promise<void> {
  void ctx;
  await sendToChat('🔄 Читаю данные из БД и Google Sheets...');

  try {
    logger.info(`[PUSH] Reading expenses from database for group ${group.id}`);

    // Read all expenses from DB (use large limit to get all)
    const dbExpenses = database.expenses.findByGroupId(group.id, 100000);
    logger.info(`[PUSH] Found ${dbExpenses.length} expenses in database`);

    // Read all expenses from sheet
    logger.info(`[PUSH] Reading expenses from Google Sheet`);
    const sheetExpenses = await readExpensesFromSheet(
      group.google_refresh_token,
      group.spreadsheet_id,
    );
    logger.info(`[PUSH] Found ${sheetExpenses.expenses.length} expenses in sheet`);

    if (sheetExpenses.errors.length > 0) {
      logger.warn(`[PUSH] ${sheetExpenses.errors.length} rows with multi-currency amounts skipped`);
    }

    // Create set of existing keys in sheet
    const existingKeys = new Set<string>();
    for (const row of sheetExpenses.expenses) {
      const key = makeSheetRowKey(row);
      if (key) {
        existingKeys.add(key);
      }
    }

    // Filter DB expenses that don't exist in sheet
    const expensesToAdd: Expense[] = [];
    for (const expense of dbExpenses) {
      const key = makeDbExpenseKey(expense);
      if (!existingKeys.has(key)) {
        expensesToAdd.push(expense);
      }
    }

    logger.info(
      `[PUSH] ${expensesToAdd.length} expenses to add (${dbExpenses.length - expensesToAdd.length} already in sheet)`,
    );

    if (expensesToAdd.length === 0) {
      await sendToChat(
        `✅ Все данные уже синхронизированы!\n\n` +
          `📊 В БД: ${dbExpenses.length}\n` +
          `📋 В таблице: ${sheetExpenses.expenses.length}\n` +
          `➕ Добавлено: 0`,
      );
      return;
    }

    await sendToChat(`📤 Добавляю ${expensesToAdd.length} записей в таблицу...`);

    // Push expenses to sheet via ExpenseRecorder
    const recorder = getExpenseRecorder();
    let addedCount = 0;
    let errorCount = 0;

    for (const expense of expensesToAdd) {
      try {
        await recorder.pushToSheet(group.id, [expense]);
        addedCount++;

        // Log progress every 10 items
        if (addedCount % 10 === 0) {
          logger.info(`[PUSH] Progress: ${addedCount}/${expensesToAdd.length}`);
        }
      } catch (err) {
        errorCount++;
        logger.error({ err: err }, `[PUSH] Failed to add expense ${expense.id}`);
      }
    }

    logger.info(`[PUSH] ✅ Push completed: ${addedCount} added, ${errorCount} errors`);

    let message =
      `✅ Push завершён!\n\n` +
      `📊 В БД: ${dbExpenses.length}\n` +
      `📋 Было в таблице: ${sheetExpenses.expenses.length}\n` +
      `➕ Добавлено: ${addedCount}`;

    if (errorCount > 0) {
      message += `\n⚠️ Ошибок: ${errorCount}`;
    }

    await sendToChat(message);
  } catch (error) {
    logger.error({ err: error }, '[PUSH] ❌ Push failed');
    await sendToChat(`❌ Ошибка push: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
