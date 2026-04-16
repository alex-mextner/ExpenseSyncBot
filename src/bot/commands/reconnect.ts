// /reconnect command — re-authorize Google account, ensure spreadsheets exist, full bidirectional sync

import { format } from 'date-fns';
import { google } from 'googleapis';
import { InlineKeyboard } from 'gramio';
import { database } from '../../database';
import type { Expense, Group } from '../../database/types';
import { sendMessage } from '../../services/bank/telegram-sender';
import { getBudgetManager } from '../../services/budget-manager';
import { getExchangeRate } from '../../services/currency/converter';
import { getExpenseRecorder } from '../../services/expense-recorder';
import { MONTH_ABBREVS, type MonthAbbr, monthAbbrFromDate } from '../../services/google/month-abbr';
import { generateAuthUrl, getAuthenticatedClient } from '../../services/google/oauth';
import {
  appendExpenseRows,
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
import {
  type AuditEntry,
  auditAllYears,
  type RecreateResult,
  recreateLostSpreadsheets,
} from '../../services/google/spreadsheet-repair';
import { createLogger } from '../../utils/logger.ts';
import { pluralize } from '../../utils/pluralize';
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
    await sendMessage('❌ Эта команда работает только в группах.');
    return;
  }

  const group = database.groups.findByTelegramGroupId(chatId);
  if (!group) {
    await sendMessage('❌ Группа не настроена. Используй /connect');
    return;
  }

  if (!group.spreadsheet_id) {
    await sendMessage('❌ Таблица не создана. Используй /connect для первоначальной настройки.');
    return;
  }

  logger.info(`[CMD] /reconnect for group ${group.id} (chat ${chatId})`);

  const authUrl = generateAuthUrl(group.id);
  const authKeyboard = new InlineKeyboard().url('🔐 Переподключить Google', authUrl);

  // Critical send: if this fails the user has no way to recover.
  // sendMessage returns null on error (telegram-sender swallows + logs).
  const sent = await sendMessage(
    '🔄 <b>Переподключение Google аккаунта</b>\n\n' +
      'Таблица и данные сохранятся — обновится только авторизация.\n\n' +
      '1. Нажми на кнопку ниже\n' +
      '2. Разреши доступ к Google Sheets\n' +
      '3. Вернись сюда — бот синхронизирует данные',
    { reply_markup: authKeyboard },
  );

  if (!sent) {
    logger.error(`[CMD] Failed to deliver /reconnect OAuth prompt for group ${group.id}`);
    return;
  }

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
  audit: AuditEntry[];
  recreated: RecreateResult[];
}

/**
 * Probe a single spreadsheet via spreadsheets.get to test access. Throws on
 * any failure (404, 403, network, etc.) so the surrounding `auditAllYears`
 * can classify it.
 */
async function probeSpreadsheetAccess(conn: GoogleConn, spreadsheetId: string): Promise<void> {
  const auth = getAuthenticatedClient(conn.refreshToken, conn.oauthClient);
  const sheets = google.sheets({ version: 'v4', auth });
  await sheets.spreadsheets.get({ spreadsheetId });
}

/**
 * Audit every spreadsheet registered for the group and recreate any that the
 * bot can no longer reach (404 / 403). Each recreated spreadsheet is freshly
 * created with the new OAuth token, so `drive.file` scope owns it
 * unambiguously. Data is repopulated from the local DB.
 *
 * Returns the audit + recreate results so the caller can include them in a
 * user-facing report.
 */
export async function auditAndRepairSpreadsheets(
  group: Group,
): Promise<{ audit: AuditEntry[]; recreated: RecreateResult[] }> {
  if (!group.google_refresh_token) {
    return { audit: [], recreated: [] };
  }

  const conn = googleConn(group);
  const registered = database.groupSpreadsheets.listAll(group.id);
  if (registered.length === 0) {
    return { audit: [], recreated: [] };
  }

  const audit = await auditAllYears(probeSpreadsheetAccess, conn, registered);
  const lost = audit.filter((a) => a.status === 'not_found' || a.status === 'forbidden');
  if (lost.length === 0) {
    return { audit, recreated: [] };
  }

  logger.warn(
    { groupId: group.id, lost: lost.map((a) => ({ year: a.year, status: a.status })) },
    '[REPAIR] Lost spreadsheets detected — recreating',
  );

  const recreated = await recreateLostSpreadsheets(
    {
      createExpenseSpreadsheet,
      appendExpenseRows,
      writeMonthBudgetRow,
      loadExpensesForYear: (groupId, year) =>
        database.expenses
          .findByGroupId(groupId, 100000)
          .filter((e) => e.date.startsWith(`${year}-`)),
      loadBudgetsForYear: (groupId, year) =>
        database.budgets.findByGroupId(groupId).filter((b) => b.month.startsWith(`${year}-`)),
      setSpreadsheetIdForYear: (groupId, year, spreadsheetId) =>
        database.groupSpreadsheets.setYear(groupId, year, spreadsheetId),
      getExchangeRate,
    },
    conn,
    group,
    audit,
  );

  return { audit, recreated };
}

/**
 * Full bidirectional sync after reconnect. Runs from the OAuth callback
 * once the new refresh token has been persisted. Reads chatId/threadId
 * from the surrounding chatStorage context (caller must wrap in
 * withChatContext).
 *
 * 1. Ensure current-year spreadsheet exists
 * 2. Sheet → DB expenses (import only, never deletes)
 * 3. DB → Sheet expenses (push missing)
 * 4. Sheet → DB budgets (import from all month tabs)
 * 5. DB → Sheet budgets (ensure tabs + write rows)
 */
export async function fullSyncAfterReconnect(groupId: number): Promise<void> {
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
    audit: [],
    recreated: [],
  };

  try {
    await sendMessage('🔄 Полная синхронизация...');

    let freshGroup = database.groups.findById(groupId);
    if (!freshGroup?.google_refresh_token) {
      await sendMessage('❌ Токен не найден. Попробуй /reconnect ещё раз.');
      return;
    }

    // Step -1: Snapshot DB state BEFORE any spreadsheet changes. This is NOT
    // auto-rollback — we never restore automatically because we can't
    // distinguish "bad sync corrupted DB" from "user added expenses between
    // snapshot and failure". Instead the snapshot is a manual recovery point:
    // if the user sees data loss after /reconnect, they run `/sync rollback`
    // (handled in sync.ts) to restore from the latest snapshot.
    //
    // Limit bump: findByGroupId caps the result. 1M is effectively unbounded
    // for realistic group sizes while still defending against runaway queries.
    const snapshotExpenses = database.expenses.findByGroupId(freshGroup.id, 1_000_000);
    const snapshotBudgets = database.budgets.findByGroupId(freshGroup.id);
    report.snapshotId = database.syncSnapshots.saveSnapshot(
      freshGroup.id,
      snapshotExpenses,
      snapshotBudgets,
    );
    report.snapshotExpenses = snapshotExpenses.length;
    report.snapshotBudgets = snapshotBudgets.length;

    // Step 0: Audit all year spreadsheets for access. If any are unreachable
    // (file deleted, scope downgraded, permissions revoked) — recreate them
    // BEFORE any backup/sync attempts that would just fail with the same 404.
    const { audit, recreated } = await auditAndRepairSpreadsheets(freshGroup);
    report.audit = audit;
    report.recreated = recreated;

    if (recreated.length > 0) {
      // Reload group — recreate updated group_spreadsheets, so the JOIN result
      // (group.spreadsheet_id) for the current year is now the new ID.
      const reloaded = database.groups.findById(groupId);
      if (reloaded) freshGroup = reloaded;
    }

    if (!freshGroup.spreadsheet_id) {
      await sendMessage(
        formatFullSyncReport(report) +
          '\n\n❌ После проверки таблиц активной таблицы нет. Используй /connect.',
      );
      return;
    }

    const conn = googleConn(freshGroup);

    // Step 1: Backup current-year spreadsheet — but only if it wasn't just
    // recreated (the new sheet has only DB data, nothing to back up).
    const currentYear = new Date().getFullYear();
    const wasRecreatedThisYear = recreated.some((r) => r.year === currentYear);
    if (!wasRecreatedThisYear) {
      report.sheetBackupUrl = await backupSpreadsheet(conn, freshGroup.spreadsheet_id);
    }

    // Step 2: Ensure current-year spreadsheet exists (no-op if recreate or
    // legacy setYear already wrote a row for this year).
    report.yearCreated = await ensureCurrentYearSpreadsheet(freshGroup);

    // Step 3: Sheet → DB expenses (add-only, never deletes)
    report.sheetToDbExpenses = await importExpensesFromSheet(
      freshGroup.id,
      conn,
      freshGroup.spreadsheet_id,
    );

    // Step 4: DB → Sheet expenses (push missing)
    report.dbToSheetExpenses = await pushMissingExpensesToSheet(freshGroup);

    // Step 5: Sheet → DB budgets (import from all month tabs)
    report.sheetToDbBudgets = await importBudgetsFromSheet(freshGroup);

    // Step 6: DB → Sheet budgets (ensure tabs + write rows)
    const budgetResult = await syncBudgetsToSheet(freshGroup);
    report.budgetTabsCreated = budgetResult.tabsCreated;
    report.budgetRowsWritten = budgetResult.rowsWritten;

    await sendMessage(formatFullSyncReport(report));
  } catch (err) {
    logger.error({ err }, '[RECONNECT] Full sync failed');
    await sendMessage(
      '⚠️ Аккаунт подключён, но синхронизация не удалась.\n' +
        'Попробуй /repair (проверка таблиц) или /sync позже.\n' +
        'Если заметишь потерю данных — /sync rollback откатит последний снэпшот.',
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

  // Audit + recreate report
  if (report.recreated.length > 0) {
    const lostStatuses = new Set(
      report.audit.filter((a) => a.status !== 'ok').map((a) => a.status),
    );
    const reasonHints: string[] = [];
    if (lostStatuses.has('not_found')) {
      reasonHints.push(
        '• таблица удалена/в Корзине',
        '• новый набор разрешений Google не видит старую таблицу',
      );
    }
    if (lostStatuses.has('forbidden')) {
      reasonHints.push('• бот лишился доступа (отозван в Google Account)');
    }

    lines.push('🔧 <b>Восстановление таблиц</b>');
    if (reasonHints.length > 0) {
      lines.push('Возможные причины:');
      for (const h of reasonHints) lines.push(h);
    }
    lines.push('');
    for (const r of report.recreated) {
      lines.push(
        `🆕 ${r.year}: новая таблица создана\n` +
          `   ${r.newSpreadsheetUrl}\n` +
          `   Залито: ${r.expensesCopied} ${pluralize(r.expensesCopied, 'расход', 'расхода', 'расходов')}, ${r.budgetsCopied} ${pluralize(r.budgetsCopied, 'бюджет', 'бюджета', 'бюджетов')}`,
      );
    }
    lines.push('');
    lines.push('ℹ️ Старые таблицы остались в твоём Google Drive — удали их вручную, если нужно.');
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
