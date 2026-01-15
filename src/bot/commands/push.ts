import type { CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import type { Expense } from '../../database/types';
import { appendExpenseRow, readExpensesFromSheet, type SheetRow } from '../../services/google/sheets';
import type { Ctx } from '../types';

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
export async function handlePushCommand(ctx: Ctx["Command"]): Promise<void> {
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

  await ctx.send('🔄 Читаю данные из БД и Google Sheets...');

  try {
    console.log(`[PUSH] Reading expenses from database for group ${group.id}`);

    // Read all expenses from DB (use large limit to get all)
    const dbExpenses = database.expenses.findByGroupId(group.id, 100000);
    console.log(`[PUSH] Found ${dbExpenses.length} expenses in database`);

    // Read all expenses from sheet
    console.log(`[PUSH] Reading expenses from Google Sheet`);
    const sheetExpenses = await readExpensesFromSheet(
      group.google_refresh_token,
      group.spreadsheet_id
    );
    console.log(`[PUSH] Found ${sheetExpenses.length} expenses in sheet`);

    // Create set of existing keys in sheet
    const existingKeys = new Set<string>();
    for (const row of sheetExpenses) {
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

    console.log(`[PUSH] ${expensesToAdd.length} expenses to add (${dbExpenses.length - expensesToAdd.length} already in sheet)`);

    if (expensesToAdd.length === 0) {
      await ctx.send(
        `✅ Все данные уже синхронизированы!\n\n` +
        `📊 В БД: ${dbExpenses.length}\n` +
        `📋 В таблице: ${sheetExpenses.length}\n` +
        `➕ Добавлено: 0`
      );
      return;
    }

    await ctx.send(`📤 Добавляю ${expensesToAdd.length} записей в таблицу...`);

    // Add expenses to sheet
    let addedCount = 0;
    let errorCount = 0;

    for (const expense of expensesToAdd) {
      try {
        // Build amounts record for appendExpenseRow
        const amounts: Record<CurrencyCode, number | null> = {
          USD: null,
          EUR: null,
          RUB: null,
          RSD: null,
          GBP: null,
          CHF: null,
          JPY: null,
          CNY: null,
          INR: null,
          LKR: null,
          AED: null,
        };
        amounts[expense.currency as CurrencyCode] = expense.amount;

        await appendExpenseRow(
          group.google_refresh_token,
          group.spreadsheet_id,
          {
            date: expense.date,
            category: expense.category,
            comment: expense.comment,
            amounts,
            eurAmount: expense.eur_amount,
          }
        );

        addedCount++;

        // Log progress every 10 items
        if (addedCount % 10 === 0) {
          console.log(`[PUSH] Progress: ${addedCount}/${expensesToAdd.length}`);
        }
      } catch (err) {
        errorCount++;
        console.error(`[PUSH] Failed to add expense ${expense.id}:`, err);
      }
    }

    console.log(`[PUSH] ✅ Push completed: ${addedCount} added, ${errorCount} errors`);

    let message = `✅ Push завершён!\n\n` +
      `📊 В БД: ${dbExpenses.length}\n` +
      `📋 Было в таблице: ${sheetExpenses.length}\n` +
      `➕ Добавлено: ${addedCount}`;

    if (errorCount > 0) {
      message += `\n⚠️ Ошибок: ${errorCount}`;
    }

    await ctx.send(message);

  } catch (error) {
    console.error('[PUSH] ❌ Push failed:', error);
    await ctx.send(`❌ Ошибка push: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}
