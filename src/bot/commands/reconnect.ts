// /reconnect command — re-authorize Google account, ensure spreadsheets exist, full bidirectional sync

import { format } from 'date-fns';
import { google } from 'googleapis';
import { InlineKeyboard } from 'gramio';
import { database } from '../../database';
import type { Expense, Group } from '../../database/types';
import { getBudgetManager } from '../../services/budget-manager';
import { getExpenseRecorder } from '../../services/expense-recorder';
import { MONTH_ABBREVS, type MonthAbbr, monthAbbrFromDate } from '../../services/google/month-abbr';
import { generateAuthUrl, getAuthenticatedClient } from '../../services/google/oauth';
import {
  createEmptyMonthTab,
  createExpenseSpreadsheet,
  type GoogleConn,
  googleConn,
  monthTabExists,
  readExpensesFromSheet,
  readMonthBudget,
  type SheetRow,
  writeMonthBudgetRow,
} from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import { pluralize } from '../../utils/pluralize';
import { sendToChat } from '../send';
import type { Ctx } from '../types';
import { importExpensesFromSheet } from './sync';

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
    await sendToChat('❌ Эта команда работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await sendToChat('❌ Группа не настроена. Используй /connect');
    return;
  }

  if (!group.spreadsheet_id) {
    await sendToChat('❌ Таблица не создана. Используй /connect для первоначальной настройки.');
    return;
  }

  logger.info(`[CMD] /reconnect for group ${group.id} (chat ${chatId})`);

  const authUrl = generateAuthUrl(group.id);
  const authKeyboard = new InlineKeyboard().url('🔐 Переподключить Google', authUrl);

  await sendToChat(
    '🔄 <b>Переподключение Google аккаунта</b>\n\n' +
      'Таблица и данные сохранятся — обновится только авторизация.\n\n' +
      '1. Нажми на кнопку ниже\n' +
      '2. Разреши доступ к Google Sheets\n' +
      '3. Вернись сюда — бот синхронизирует данные',
    { reply_markup: authKeyboard },
  );

  // OAuth flow continues asynchronously: the callback server saves the token to DB,
  // then notifies the group. After that, fullSyncAfterReconnect can be triggered
  // manually via /sync or automatically by the callback handler.
  logger.info(`[CMD] OAuth URL sent for reconnect, group ${group.id}`);
}

// ── Full bidirectional sync ──

interface FullSyncReport {
  snapshotId: string | null;
  snapshotExpenses: number;
  snapshotBudgets: number;
  sheetBackupUrl: string | null;
  yearCreated: number | null;
  sheetToDbExpenses: number;
  dbToSheetExpenses: number;
  sheetToDbBudgets: number;
  budgetTabsCreated: string[];
  budgetRowsWritten: number;
}

/**
 * Full bidirectional sync after reconnect:
 * 1. Ensure current-year spreadsheet exists
 * 2. Sheet → DB expenses (import only, never deletes)
 * 3. DB → Sheet expenses (push missing)
 * 4. Sheet → DB budgets (import from all month tabs)
 * 5. DB → Sheet budgets (ensure tabs + write rows)
 */
export async function fullSyncAfterReconnect(ctx: Ctx['Command'], groupId: number): Promise<void> {
  void ctx;
  const report: FullSyncReport = {
    snapshotId: null,
    snapshotExpenses: 0,
    snapshotBudgets: 0,
    sheetBackupUrl: null,
    yearCreated: null,
    sheetToDbExpenses: 0,
    dbToSheetExpenses: 0,
    sheetToDbBudgets: 0,
    budgetTabsCreated: [],
    budgetRowsWritten: 0,
  };

  try {
    await sendToChat('🔄 Полная синхронизация...');

    const freshGroup = database.groups.findById(groupId);
    if (!freshGroup?.google_refresh_token || !freshGroup.spreadsheet_id) {
      await sendToChat('❌ Токен или таблица не найдены. Попробуй /reconnect ещё раз.');
      return;
    }

    const conn = googleConn(freshGroup);

    // Step 0: Create backups before any modifications
    const expenses = database.expenses.findByGroupId(freshGroup.id, 100000);
    const budgets = database.budgets.findByGroupId(freshGroup.id);
    report.snapshotId = database.syncSnapshots.saveSnapshot(freshGroup.id, expenses, budgets);
    report.snapshotExpenses = expenses.length;
    report.snapshotBudgets = budgets.length;
    report.sheetBackupUrl = await backupSpreadsheet(conn, freshGroup.spreadsheet_id);

    // Step 1: Ensure current-year spreadsheet exists
    report.yearCreated = await ensureCurrentYearSpreadsheet(freshGroup);

    // Step 2: Sheet → DB expenses (add-only, never deletes)
    report.sheetToDbExpenses = await importExpensesFromSheet(
      freshGroup.id,
      conn,
      freshGroup.spreadsheet_id,
    );

    // Step 3: DB → Sheet expenses (push missing)
    report.dbToSheetExpenses = await pushMissingExpensesToSheet(freshGroup);

    // Step 4: Sheet → DB budgets (import from all month tabs)
    report.sheetToDbBudgets = await importBudgetsFromSheet(freshGroup);

    // Step 5: DB → Sheet budgets (ensure tabs + write rows)
    const budgetResult = await syncBudgetsToSheet(freshGroup);
    report.budgetTabsCreated = budgetResult.tabsCreated;
    report.budgetRowsWritten = budgetResult.rowsWritten;

    await sendToChat(formatFullSyncReport(report));
  } catch (err) {
    logger.error({ err }, '[RECONNECT] Full sync failed');
    await sendToChat(
      '⚠️ Аккаунт подключён, но синхронизация не удалась.\n' + 'Попробуй /sync вручную позже.',
    );
  }
}

// ── Backups ──

const BACKUP_NAME_PREFIX = 'Expenses Tracker — backup';

/** Copy the Google spreadsheet via Drive API. Deletes previous backups first (recoverable from trash). */
async function backupSpreadsheet(conn: GoogleConn, spreadsheetId: string): Promise<string | null> {
  try {
    const auth = getAuthenticatedClient(conn.refreshToken, conn.oauthClient);
    const drive = google.drive({ version: 'v3', auth });

    // Delete previous backups (they go to trash, recoverable for 30 days)
    await deletePreviousBackups(drive);

    const timestamp = format(new Date(), 'yyyy-MM-dd HH:mm');
    const copy = await drive.files.copy({
      fileId: spreadsheetId,
      requestBody: { name: `${BACKUP_NAME_PREFIX} ${timestamp}` },
    });
    const backupId = copy.data.id;
    if (!backupId) {
      logger.error('[RECONNECT] Drive backup returned no file ID');
      return null;
    }
    const url = `https://docs.google.com/spreadsheets/d/${backupId}`;
    logger.info(`[RECONNECT] Sheet backup created: ${url}`);
    return url;
  } catch (err) {
    logger.error({ err }, '[RECONNECT] Sheet backup failed');
    return null;
  }
}

/** Find and trash previous backup spreadsheets by name prefix. */
async function deletePreviousBackups(drive: ReturnType<typeof google.drive>): Promise<void> {
  try {
    const res = await drive.files.list({
      q: `name contains '${BACKUP_NAME_PREFIX}' and mimeType = 'application/vnd.google-apps.spreadsheet' and trashed = false`,
      fields: 'files(id, name)',
      pageSize: 50,
    });
    const files = res.data.files ?? [];
    for (const file of files) {
      if (file.id) {
        await drive.files.update({ fileId: file.id, requestBody: { trashed: true } });
        logger.info(`[RECONNECT] Trashed old backup: ${file.name} (${file.id})`);
      }
    }
  } catch (err) {
    logger.error({ err }, '[RECONNECT] Failed to clean old backups');
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
    googleConn(group),
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
    googleConn(group),
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
  try {
    await recorder.pushToSheet(group.id, missing);
  } catch (err) {
    logger.error({ err }, '[RECONNECT] Failed to push missing expenses to sheet');
    return 0;
  }
  return missing.length;
}

/** Build dedup key from first currency in the row (multi-currency rows are filtered upstream) */
function sheetRowKey(row: SheetRow): string | null {
  for (const [currency, amount] of Object.entries(row.amounts)) {
    return `${row.date}|${row.category}|${amount}|${currency}`;
  }
  return null;
}

/**
 * Import budgets from all month tabs in the current-year spreadsheet into DB.
 * Only adds/updates, never deletes. Returns count of imported/updated budgets.
 */
async function importBudgetsFromSheet(group: Group): Promise<number> {
  if (!group.google_refresh_token || !group.spreadsheet_id) return 0;

  const conn = googleConn(group);
  const currentYear = new Date().getFullYear();
  const spreadsheetId =
    database.groupSpreadsheets.getByYear(group.id, currentYear) ?? group.spreadsheet_id;

  let imported = 0;

  for (const monthAbbr of MONTH_ABBREVS) {
    const exists = await monthTabExists(conn, spreadsheetId, monthAbbr);
    if (!exists) continue;

    const budgetsFromSheet = await readMonthBudget(conn, spreadsheetId, monthAbbr);
    if (budgetsFromSheet.length === 0) continue;

    const monthIndex = MONTH_ABBREVS.indexOf(monthAbbr) + 1;
    const monthStr = `${currentYear}-${String(monthIndex).padStart(2, '0')}`;

    for (const b of budgetsFromSheet) {
      if (!database.categories.exists(group.id, b.category)) {
        database.categories.create({ group_id: group.id, name: b.category });
      }

      const existing = database.budgets.findByGroupCategoryMonth(group.id, b.category, monthStr);
      const hasChanged =
        !existing || existing.limit_amount !== b.limit || existing.currency !== b.currency;

      if (hasChanged) {
        getBudgetManager().importFromSheet({
          groupId: group.id,
          category: b.category,
          month: monthStr,
          amount: b.limit,
          currency: b.currency,
        });
        imported++;
      }
    }
  }

  logger.info(`[RECONNECT] Imported ${imported} budgets from sheet for group ${group.id}`);
  return imported;
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

  const conn = googleConn(group);
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
    const exists = await monthTabExists(conn, spreadsheetId, monthAbbr);
    if (!exists) {
      await createEmptyMonthTab(conn, spreadsheetId, monthAbbr);
      tabsCreated.push(monthAbbr);
      logger.info(`[RECONNECT] Created budget tab ${monthAbbr} for group ${group.id}`);
    }

    // Write each budget row (upserts by category)
    for (const budget of budgets) {
      try {
        await writeMonthBudgetRow(conn, spreadsheetId, monthAbbr, {
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

  // Backup info
  if (report.snapshotId || report.sheetBackupUrl) {
    lines.push('💾 Бекапы:');
    if (report.snapshotId) {
      lines.push(
        `  БД: ${report.snapshotExpenses} ${pluralize(report.snapshotExpenses, 'расход', 'расхода', 'расходов')} + ${report.snapshotBudgets} ${pluralize(report.snapshotBudgets, 'бюджет', 'бюджета', 'бюджетов')}`,
      );
    }
    if (report.sheetBackupUrl) lines.push(`  Таблица: ${report.sheetBackupUrl}`);
    lines.push('');
  }

  if (report.yearCreated) {
    lines.push(`📅 Создана таблица за ${report.yearCreated}`);
  }

  // Sheet → DB expenses
  if (report.sheetToDbExpenses > 0) {
    lines.push(
      `\n📥 Таблица → БД: +${report.sheetToDbExpenses} ${pluralize(report.sheetToDbExpenses, 'расход добавлен', 'расхода добавлено', 'расходов добавлено')}`,
    );
  } else {
    lines.push('\n📥 Таблица → БД: расходы синхронизированы');
  }

  // DB → Sheet expenses
  if (report.dbToSheetExpenses > 0) {
    lines.push(
      `📤 БД → Таблица: +${report.dbToSheetExpenses} ${pluralize(report.dbToSheetExpenses, 'расход добавлен', 'расхода добавлено', 'расходов добавлено')}`,
    );
  } else {
    lines.push('📤 БД → Таблица: всё синхронизировано');
  }

  // Budgets Sheet → DB
  if (report.sheetToDbBudgets > 0) {
    lines.push(`\n📥 Бюджеты из таблицы: +${report.sheetToDbBudgets} импортировано`);
  }

  // Budgets DB → Sheet
  if (report.budgetTabsCreated.length > 0 || report.budgetRowsWritten > 0) {
    lines.push('📤 Бюджеты в таблицу:');
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
