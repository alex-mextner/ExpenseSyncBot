// /reconnect command — re-authorize Google account, ensure spreadsheets exist, full bidirectional sync

import { InlineKeyboard } from 'gramio';
import { database } from '../../database';
import type { Expense, Group } from '../../database/types';
import { getExpenseRecorder } from '../../services/expense-recorder';
import { type MonthAbbr, monthAbbrFromDate } from '../../services/google/month-abbr';
import { generateAuthUrl } from '../../services/google/oauth';
import {
  createEmptyMonthTab,
  createExpenseSpreadsheet,
  monthTabExists,
  readExpensesFromSheet,
  type SheetRow,
  writeMonthBudgetRow,
} from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import { registerOAuthState, unregisterOAuthState } from '../../web/oauth-callback';
import type { Ctx } from '../types';
import { syncExpenses } from './sync';

const logger = createLogger('reconnect');

/**
 * /reconnect command handler — re-authorize Google without recreating the spreadsheet,
 * then run full bidirectional sync: Sheet → DB, DB → Sheet, budgets → Sheet.
 */
export async function handleReconnectCommand(ctx: Ctx['Command']): Promise<void> {
  const chatId = ctx.chat?.id;
  const chatType = ctx.chat?.type;
  const isGroup = chatType === 'group' || chatType === 'supergroup';

  if (!chatId || !isGroup) {
    await ctx.send('❌ Эта команда работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await ctx.send('❌ Группа не настроена. Используй /connect');
    return;
  }

  if (!group.spreadsheet_id) {
    await ctx.send('❌ Таблица не создана. Используй /connect для первоначальной настройки.');
    return;
  }

  logger.info(`[CMD] /reconnect for group ${group.id} (chat ${chatId})`);

  const authUrl = generateAuthUrl(group.id);
  const authKeyboard = new InlineKeyboard().url('🔐 Переподключить Google', authUrl);

  await ctx.send(
    '🔄 <b>Переподключение Google аккаунта</b>\n\n' +
      'Таблица и данные сохранятся — обновится только авторизация.\n\n' +
      '1. Нажми на кнопку ниже\n' +
      '2. Разреши доступ к Google Sheets\n' +
      '3. Вернись сюда — бот синхронизирует данные',
    { parse_mode: 'HTML', reply_markup: authKeyboard },
  );

  const refreshToken = await new Promise<string>((resolve, reject) => {
    registerOAuthState(group.id, resolve, reject);

    setTimeout(
      () => {
        unregisterOAuthState(group.id);
        reject(new Error('OAuth timeout'));
      },
      5 * 60 * 1000,
    );
  }).catch((err) => {
    logger.error({ err }, '[CMD] OAuth error during reconnect');
    return null;
  });

  if (!refreshToken) {
    // Check if token was saved to DB by the callback anyway (race condition)
    const updatedGroup = database.groups.findByTelegramGroupId(chatId);
    if (updatedGroup?.google_refresh_token) {
      logger.info(`[CMD] OAuth timeout but token found in DB for group ${group.id}`);
      await fullSyncAfterReconnect(ctx, group.id);
      return;
    }
    await ctx.send('❌ Не удалось переподключить Google аккаунт. Попробуй ещё раз: /reconnect');
    return;
  }

  logger.info(`[CMD] ✅ Reconnect OAuth successful for group ${group.id}`);
  await ctx.send('✅ Google аккаунт переподключён!');
  await fullSyncAfterReconnect(ctx, group.id);
}

// ── Full bidirectional sync ──

interface FullSyncReport {
  yearCreated: number | null;
  sheetToDb: { added: number; deleted: number; updated: number; unchanged: number };
  dbToSheet: number;
  budgetTabsCreated: string[];
  budgetRowsWritten: number;
}

/**
 * Full bidirectional sync after reconnect:
 * 1. Ensure current-year spreadsheet exists
 * 2. Sheet → DB (syncExpenses)
 * 3. DB → Sheet (push missing expenses)
 * 4. Ensure budget month tabs and push DB budgets to sheet
 */
async function fullSyncAfterReconnect(ctx: Ctx['Command'], groupId: number): Promise<void> {
  const report: FullSyncReport = {
    yearCreated: null,
    sheetToDb: { added: 0, deleted: 0, updated: 0, unchanged: 0 },
    dbToSheet: 0,
    budgetTabsCreated: [],
    budgetRowsWritten: 0,
  };

  try {
    await ctx.send('🔄 Полная синхронизация...');

    const freshGroup = database.groups.findById(groupId);
    if (!freshGroup?.google_refresh_token) {
      await ctx.send('❌ Токен не найден. Попробуй /reconnect ещё раз.');
      return;
    }

    // Step 1: Ensure current-year spreadsheet exists
    report.yearCreated = await ensureCurrentYearSpreadsheet(freshGroup);

    // Step 2: Sheet → DB
    const syncResult = await syncExpenses(groupId);
    report.sheetToDb = {
      added: syncResult.added.length,
      deleted: syncResult.deleted.length,
      updated: syncResult.updated.length,
      unchanged: syncResult.unchanged,
    };

    // Step 3: DB → Sheet (push missing expenses)
    report.dbToSheet = await pushMissingExpensesToSheet(freshGroup);

    // Step 4: Budget tabs + rows
    const budgetResult = await syncBudgetsToSheet(freshGroup);
    report.budgetTabsCreated = budgetResult.tabsCreated;
    report.budgetRowsWritten = budgetResult.rowsWritten;

    await ctx.send(formatFullSyncReport(report));
  } catch (err) {
    logger.error({ err }, '[RECONNECT] Full sync failed');
    await ctx.send(
      '⚠️ Аккаунт подключён, но синхронизация не удалась.\n' + 'Попробуй /sync вручную позже.',
    );
  }
}

/**
 * If the current year has no spreadsheet, create one and register it.
 * Returns the year if created, null otherwise.
 */
async function ensureCurrentYearSpreadsheet(group: Group): Promise<number | null> {
  const currentYear = new Date().getFullYear();
  const existing = database.groupSpreadsheets.getByYear(group.id, currentYear);
  if (existing) return null;

  if (!group.google_refresh_token) return null;

  logger.info(`[RECONNECT] Creating ${currentYear} spreadsheet for group ${group.id}`);
  const { spreadsheetId } = await createExpenseSpreadsheet(
    group.google_refresh_token,
    group.default_currency,
    group.enabled_currencies,
  );

  database.groupSpreadsheets.setYear(group.id, currentYear, spreadsheetId);

  // Update group's active spreadsheet_id to the new one
  database.groups.update(group.telegram_group_id, { spreadsheet_id: spreadsheetId });

  logger.info(`[RECONNECT] Created ${currentYear} spreadsheet: ${spreadsheetId}`);
  return currentYear;
}

/**
 * Push DB expenses missing from the current spreadsheet.
 * Returns count of pushed expenses.
 */
async function pushMissingExpensesToSheet(group: Group): Promise<number> {
  if (!group.google_refresh_token || !group.spreadsheet_id) return 0;

  const dbExpenses = database.expenses.findByGroupId(group.id, 100000);
  if (dbExpenses.length === 0) return 0;

  const { expenses: sheetExpenses } = await readExpensesFromSheet(
    group.google_refresh_token,
    group.spreadsheet_id,
  );

  const sheetKeys = new Set<string>();
  for (const row of sheetExpenses) {
    const key = sheetRowKey(row);
    if (key) sheetKeys.add(key);
  }

  const missing: Expense[] = [];
  for (const expense of dbExpenses) {
    const key = `${expense.date}|${expense.category}|${expense.amount}|${expense.currency}`;
    if (!sheetKeys.has(key)) {
      missing.push(expense);
    }
  }

  if (missing.length === 0) return 0;

  logger.info(`[RECONNECT] Pushing ${missing.length} missing expenses to sheet`);
  const recorder = getExpenseRecorder();
  let pushed = 0;
  for (const expense of missing) {
    try {
      await recorder.pushToSheet(group.id, [expense]);
      pushed++;
    } catch (err) {
      logger.error({ err }, `[RECONNECT] Failed to push expense ${expense.id}`);
    }
  }
  return pushed;
}

function sheetRowKey(row: SheetRow): string | null {
  for (const [currency, amount] of Object.entries(row.amounts)) {
    return `${row.date}|${row.category}|${amount}|${currency}`;
  }
  return null;
}

/**
 * Ensure budget month tabs exist in the current-year spreadsheet and push DB budgets.
 */
async function syncBudgetsToSheet(
  group: Group,
): Promise<{ tabsCreated: string[]; rowsWritten: number }> {
  if (!group.google_refresh_token || !group.spreadsheet_id) {
    return { tabsCreated: [], rowsWritten: 0 };
  }

  const currentYear = new Date().getFullYear();
  const spreadsheetId =
    database.groupSpreadsheets.getByYear(group.id, currentYear) ?? group.spreadsheet_id;

  // Get all DB budgets for current year
  const allBudgets = database.budgets.findByGroupId(group.id);
  const currentYearBudgets = allBudgets.filter((b) => b.month.startsWith(`${currentYear}-`));
  if (currentYearBudgets.length === 0) return { tabsCreated: [], rowsWritten: 0 };

  // Group budgets by month abbreviation
  const budgetsByMonth = new Map<MonthAbbr, typeof currentYearBudgets>();
  for (const budget of currentYearBudgets) {
    const monthIndex = Number.parseInt(budget.month.slice(5, 7), 10) - 1;
    const monthDate = new Date(currentYear, monthIndex, 1);
    const abbr = monthAbbrFromDate(monthDate);
    const arr = budgetsByMonth.get(abbr);
    if (arr) {
      arr.push(budget);
    } else {
      budgetsByMonth.set(abbr, [budget]);
    }
  }

  const tabsCreated: string[] = [];
  let rowsWritten = 0;

  for (const [monthAbbr, budgets] of budgetsByMonth) {
    // Create tab if missing
    const exists = await monthTabExists(group.google_refresh_token, spreadsheetId, monthAbbr);
    if (!exists) {
      await createEmptyMonthTab(group.google_refresh_token, spreadsheetId, monthAbbr);
      tabsCreated.push(monthAbbr);
      logger.info(`[RECONNECT] Created budget tab ${monthAbbr} for group ${group.id}`);
    }

    // Write each budget row (upserts by category)
    for (const budget of budgets) {
      try {
        await writeMonthBudgetRow(group.google_refresh_token, spreadsheetId, monthAbbr, {
          category: budget.category,
          limit: budget.limit_amount,
          currency: budget.currency,
        });
        rowsWritten++;
      } catch (err) {
        logger.error({ err }, `[RECONNECT] Failed to write budget ${budget.category}/${monthAbbr}`);
      }
    }
  }

  return { tabsCreated, rowsWritten };
}

function formatFullSyncReport(report: FullSyncReport): string {
  const lines: string[] = ['✅ Синхронизация завершена!\n'];

  if (report.yearCreated) {
    lines.push(`📅 Создана таблица за ${report.yearCreated}`);
  }

  // Sheet → DB
  const s = report.sheetToDb;
  const total = s.unchanged + s.added + s.updated;
  lines.push(`\n📥 Таблица → БД: ${total} расходов`);
  if (s.added > 0) lines.push(`  +${s.added} добавлено`);
  if (s.deleted > 0) lines.push(`  -${s.deleted} удалено`);
  if (s.updated > 0) lines.push(`  ~${s.updated} обновлено`);

  // DB → Sheet
  if (report.dbToSheet > 0) {
    lines.push(`\n📤 БД → Таблица: +${report.dbToSheet} расходов добавлено`);
  } else {
    lines.push('\n📤 БД → Таблица: всё синхронизировано');
  }

  // Budgets
  if (report.budgetTabsCreated.length > 0 || report.budgetRowsWritten > 0) {
    lines.push('\n💰 Бюджеты:');
    if (report.budgetTabsCreated.length > 0) {
      lines.push(`  Созданы вкладки: ${report.budgetTabsCreated.join(', ')}`);
    }
    if (report.budgetRowsWritten > 0) {
      lines.push(`  Записано: ${report.budgetRowsWritten} записей`);
    }
  }

  lines.push('\nВсё готово! Бот снова синхронизирует расходы с таблицей.');

  return lines.join('\n');
}
