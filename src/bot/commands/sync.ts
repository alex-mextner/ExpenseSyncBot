import type { Ctx } from '../types';
import { database } from '../../database';
import { convertToEUR } from '../../services/currency/converter';
import { SPREADSHEET_CONFIG } from '../../config/constants';
import { getAuthenticatedClient } from '../../services/google/oauth';
import { google } from 'googleapis';
import type { CurrencyCode } from '../../config/constants';

interface SheetRow {
  date: string;
  amounts: Record<string, number>; // currency -> amount
  eurAmount: number;
  category: string;
  comment: string;
}

/**
 * Read all expenses from Google Sheet
 */
async function readExpensesFromSheet(
  refreshToken: string,
  spreadsheetId: string
): Promise<SheetRow[]> {
  const auth = getAuthenticatedClient(refreshToken);
  const sheets = google.sheets({ version: 'v4', auth });

  // Read all data from sheet
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${SPREADSHEET_CONFIG.sheetName}!A:Z`,
  });

  const rows = response.data.values || [];

  if (rows.length === 0) {
    return [];
  }

  // First row is headers
  const headers = rows[0] as string[];
  console.log(`[SYNC] Headers:`, headers);

  // Find column indices
  const dateCol = headers.indexOf(SPREADSHEET_CONFIG.headers[0]!); // Дата
  const categoryCol = headers.indexOf(SPREADSHEET_CONFIG.headers[1]!); // Категория
  const commentCol = headers.indexOf(SPREADSHEET_CONFIG.headers[2]!); // Комментарий
  const eurCol = headers.indexOf(SPREADSHEET_CONFIG.eurColumnHeader); // EUR (calc)

  if (dateCol === -1 || categoryCol === -1 || commentCol === -1) {
    throw new Error('Required columns not found in spreadsheet');
  }

  // Find currency columns (e.g., "USD ($)", "RSD (RSD)")
  const currencyColumns: Array<{ index: number; currency: string }> = [];
  for (let i = 0; i < headers.length; i++) {
    const header = headers[i];
    if (header && header !== SPREADSHEET_CONFIG.headers[0] &&
        header !== SPREADSHEET_CONFIG.headers[1] &&
        header !== SPREADSHEET_CONFIG.headers[2] &&
        header !== SPREADSHEET_CONFIG.eurColumnHeader) {
      // Extract currency code from "USD ($)" -> "USD"
      const match = header.match(/^([A-Z]{3})\s*\(/);
      if (match) {
        currencyColumns.push({ index: i, currency: match[1]! });
      }
    }
  }

  console.log(`[SYNC] Currency columns:`, currencyColumns);

  // Parse data rows (skip header)
  const expenses: SheetRow[] = [];

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as string[];

    // Skip empty rows
    if (!row || row.length === 0 || !row[dateCol]) {
      continue;
    }

    const date = row[dateCol];
    const category = row[categoryCol] || 'Без категории';
    const comment = row[commentCol] || '';
    const eurAmountStr = eurCol !== -1 ? row[eurCol] : null;

    // Parse amounts for each currency
    const amounts: Record<string, number> = {};
    let foundAmount = false;

    for (const { index, currency } of currencyColumns) {
      const value = row[index];
      if (value && value.trim() !== '') {
        const parsed = parseFloat(value);
        if (!isNaN(parsed) && parsed > 0) {
          amounts[currency] = parsed;
          foundAmount = true;
        }
      }
    }

    // Skip rows without any amounts
    if (!foundAmount) {
      continue;
    }

    // Use EUR amount from sheet if available, otherwise calculate
    let eurAmount: number;

    if (eurAmountStr && eurAmountStr.trim() !== '') {
      const parsed = parseFloat(eurAmountStr);
      eurAmount = !isNaN(parsed) ? parsed : 0;
    } else {
      // Calculate EUR amount from the first non-null currency
      eurAmount = 0;
      for (const [curr, amt] of Object.entries(amounts)) {
        eurAmount = convertToEUR(amt, curr as CurrencyCode);
        break;
      }
    }

    expenses.push({
      date,
      amounts,
      eurAmount,
      category,
      comment,
    });
  }

  return expenses;
}

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
