/** /sync command handler — imports expenses from Google Sheets into the local database */
import { SQLiteError } from 'bun:sqlite';
import type { CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import type { Expense } from '../../database/types';
import { sendMessage, withChatContext } from '../../services/bank/telegram-sender';
import { getBudgetManager } from '../../services/budget-manager';
import {
  type EurMismatchWarning,
  type GoogleConn,
  googleConn,
  type MultiCurrencyRowError,
  readExpensesFromSheet,
  type SheetRow,
} from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';
import { pluralize } from '../../utils/pluralize';
import { formatErrorForUser } from '../bot-error-formatter';
import type { GoogleConnectedGroup } from '../guards';
import type { Ctx } from '../types';

const logger = createLogger('sync');

/** Key for matching sheet rows to DB expenses */
function makeKey(date: string, category: string, amount: number, currency: string): string {
  return `${date}|${category}|${amount}|${currency}`;
}

function sheetRowToKey(row: SheetRow): ParsedSheetRow | null {
  for (const [curr, amt] of Object.entries(row.amounts) as [string, number][]) {
    return {
      key: makeKey(row.date, row.category, amt, curr),
      amount: amt,
      currency: curr as CurrencyCode,
    };
  }
  return null;
}

function dbExpenseToKey(e: Expense): string {
  return makeKey(e.date, e.category, e.amount, e.currency);
}

function fmtExpense(
  date: string,
  amount: number,
  currency: string,
  category: string,
  comment: string,
): string {
  const cmnt = comment ? ` ${comment}` : '';
  return `${date} ${amount} ${currency} ${category}${cmnt}`;
}

interface SyncedExpense {
  date: string;
  amount: number;
  currency: string;
  category: string;
  comment: string;
}

export interface SyncResult {
  unchanged: number;
  added: SyncedExpense[];
  deleted: SyncedExpense[];
  updated: Array<SyncedExpense & { field: string }>;
  /** Sheet rows left unwritten because they reference a missing user or group (logged). */
  skipped: SyncedExpense[];
  createdCategories: string[];
  errors: MultiCurrencyRowError[];
  eurMismatches: EurMismatchWarning[];
}

interface ParsedSheetRow {
  key: string;
  amount: number;
  currency: CurrencyCode;
}

interface UnmatchedSheetRow {
  row: SheetRow;
  parsed: ParsedSheetRow;
}

/** Shared state for applying one sync run's writes. */
interface SyncRun {
  groupId: number;
  defaultUserId: number | undefined;
  dbPool: Map<string, Expense[]>;
  result: SyncResult;
}

/** Create categories referenced by the sheet that the group does not have yet. */
function createMissingCategories(
  groupId: number,
  sheetExpenses: SheetRow[],
  createdCategories: string[],
): void {
  for (const expense of sheetExpenses) {
    if (expense.category && expense.category !== 'Без категории') {
      if (!database.categories.exists(groupId, expense.category)) {
        database.categories.create({ group_id: groupId, name: expense.category });
        createdCategories.push(expense.category);
      }
    }
  }
}

/** Multimap from DB: shortKey → [Expense]. */
function buildDbPool(dbExpenses: Expense[]): Map<string, Expense[]> {
  const dbPool = new Map<string, Expense[]>();
  for (const e of dbExpenses) {
    const key = dbExpenseToKey(e);
    const arr = dbPool.get(key);
    if (arr) {
      arr.push(e);
    } else {
      dbPool.set(key, [e]);
    }
  }
  return dbPool;
}

/** Pass 1: consume exact matches (key + comment + eurAmount) from the pool. */
function matchExactRows(
  sheetExpenses: SheetRow[],
  dbPool: Map<string, Expense[]>,
  result: SyncResult,
): { unmatchedSheetRows: UnmatchedSheetRow[]; exactMatched: Set<number> } {
  const exactMatched = new Set<number>(); // DB expense IDs that matched exactly
  const unmatchedSheetRows: UnmatchedSheetRow[] = [];

  for (const row of sheetExpenses) {
    const parsed = sheetRowToKey(row);
    if (!parsed) continue;

    const candidates = dbPool.get(parsed.key);
    if (!candidates || candidates.length === 0) {
      unmatchedSheetRows.push({ row, parsed });
      continue;
    }

    // Find exact match
    const exactIdx = candidates.findIndex(
      (e) => e.comment === row.comment && Math.abs(e.eur_amount - row.eurAmount) <= 0.01,
    );

    if (exactIdx !== -1) {
      const matched = candidates.splice(exactIdx, 1)[0];
      if (matched) exactMatched.add(matched.id);
      result.unchanged++;
    } else {
      unmatchedSheetRows.push({ row, parsed });
    }
  }
  return { unmatchedSheetRows, exactMatched };
}

/**
 * Applies one sheet row's writes atomically. A row that violates a foreign key (e.g. its
 * expense belongs to a user row that no longer exists) is skipped and logged, so one bad row
 * cannot abort the sync of every other row; the rollback keeps the DB row it would replace.
 */
function writeRow(run: SyncRun, expense: SyncedExpense, write: () => void): boolean {
  try {
    database.transaction(write);
    return true;
  } catch (error) {
    // SQLite's error for a write referencing a missing parent row (user, group, receipt).
    if (!(error instanceof SQLiteError && error.code === 'SQLITE_CONSTRAINT_FOREIGNKEY')) {
      throw error;
    }
    logger.warn(
      { err: error, groupId: run.groupId, expense },
      '[SYNC] Sheet row skipped: foreign key violation (missing user or group)',
    );
    run.result.skipped.push(expense);
    return false;
  }
}

/** Partial match — replace the DB row with the sheet's version and record the update. */
function applyPartialMatch(
  run: SyncRun,
  existing: Expense,
  { row, parsed }: UnmatchedSheetRow,
  expense: SyncedExpense,
): void {
  const changes: string[] = [];
  if (Math.abs(existing.eur_amount - row.eurAmount) > 0.01) {
    changes.push(`EUR: ${existing.eur_amount}→${row.eurAmount}`);
  }
  if (existing.comment !== row.comment) {
    changes.push(`"${existing.comment || ''}"→"${row.comment || ''}"`);
  }

  const written = writeRow(run, expense, () => {
    database.expenses.delete(existing.id);
    database.expenses.create({
      group_id: run.groupId,
      user_id: existing.user_id,
      date: row.date,
      category: row.category,
      comment: row.comment,
      amount: parsed.amount,
      currency: parsed.currency,
      eur_amount: row.eurAmount,
    });
  });
  if (written) run.result.updated.push({ ...expense, field: changes.join(', ') });
}

/** No match at all — new expense owned by the group's default user. */
function applyNewRow(
  run: SyncRun,
  { row, parsed }: UnmatchedSheetRow,
  expense: SyncedExpense,
): void {
  const { defaultUserId } = run;
  if (defaultUserId === undefined) {
    logger.warn(
      { groupId: run.groupId, expense },
      '[SYNC] Sheet row skipped: the group has no user to own it',
    );
    run.result.skipped.push(expense);
    return;
  }
  const written = writeRow(run, expense, () => {
    database.expenses.create({
      group_id: run.groupId,
      user_id: defaultUserId,
      date: row.date,
      category: row.category,
      comment: row.comment,
      amount: parsed.amount,
      currency: parsed.currency,
      eur_amount: row.eurAmount,
    });
  });
  if (written) run.result.added.push(expense);
}

/** Pass 2: unmatched sheet rows — try partial match (update) or add. */
function applyUnmatchedRows(run: SyncRun, unmatchedSheetRows: UnmatchedSheetRow[]): void {
  for (const unmatched of unmatchedSheetRows) {
    const { row, parsed } = unmatched;
    const candidates = run.dbPool.get(parsed.key);
    const expense: SyncedExpense = {
      date: row.date,
      amount: parsed.amount,
      currency: parsed.currency,
      category: row.category,
      comment: row.comment,
    };

    if (candidates && candidates.length > 0) {
      const existing = candidates.shift();
      if (!existing) continue;
      applyPartialMatch(run, existing, unmatched, expense);
    } else {
      applyNewRow(run, unmatched, expense);
    }
  }
}

/** Pass 3: remaining unmatched DB expenses — deleted from sheet. */
function deleteOrphanedExpenses(
  dbPool: Map<string, Expense[]>,
  exactMatched: Set<number>,
  result: SyncResult,
): void {
  for (const candidates of dbPool.values()) {
    for (const expense of candidates) {
      if (exactMatched.has(expense.id)) continue;
      database.expenses.delete(expense.id);
      result.deleted.push({
        date: expense.date,
        amount: expense.amount,
        currency: expense.currency,
        category: expense.category,
        comment: expense.comment,
      });
    }
  }
}

/**
 * Core sync logic — compare sheet with DB and apply diff.
 * Uses greedy matching: first exact match (including comment+EUR),
 * then partial match (key only) to detect updates.
 */
export async function syncExpenses(groupId: number): Promise<SyncResult> {
  const group = database.groups.findById(groupId);
  if (!group?.spreadsheet_id || !group?.google_refresh_token) {
    throw new Error('Group not configured for Google Sheets');
  }

  const {
    expenses: sheetExpenses,
    errors,
    eurMismatches,
  } = await readExpensesFromSheet(googleConn(group), group.spreadsheet_id);

  logger.info(`[SYNC] Sheet: ${sheetExpenses.length} expenses, ${errors.length} errors`);

  // Snapshot current state before destructive sync (deletes + updates)
  const allExpenses = database.expenses.findByGroupId(groupId, 100000);
  const allBudgets = database.budgets.findByGroupId(groupId);
  database.syncSnapshots.saveSnapshot(groupId, allExpenses, allBudgets);

  // Determine the year this spreadsheet covers so we only compare DB expenses
  // from that year. Without this, syncing a 2026-only sheet would delete all
  // prior-year DB expenses that don't appear in it.
  const spreadsheetYear =
    database.groupSpreadsheets
      .listAll(groupId)
      .find((s) => s.spreadsheetId === group.spreadsheet_id)?.year ?? null;

  const allDbExpenses = database.expenses.findByGroupId(groupId, 100000);
  const dbExpenses = spreadsheetYear
    ? allDbExpenses.filter((e) => e.date.startsWith(`${spreadsheetYear}-`))
    : allDbExpenses;
  const users = database.users.findByGroupId ? database.users.findByGroupId(groupId) : [];
  // No fallback id: users.id is global, so any constant would hand rows to another group's user.
  const defaultUserId = users[0]?.id;

  const result: SyncResult = {
    unchanged: 0,
    added: [],
    deleted: [],
    updated: [],
    skipped: [],
    createdCategories: [],
    errors,
    eurMismatches,
  };

  createMissingCategories(groupId, sheetExpenses, result.createdCategories);

  const dbPool = buildDbPool(dbExpenses);
  const { unmatchedSheetRows, exactMatched } = matchExactRows(sheetExpenses, dbPool, result);

  applyUnmatchedRows({ groupId, defaultUserId, dbPool, result }, unmatchedSheetRows);
  deleteOrphanedExpenses(dbPool, exactMatched, result);

  logger.info(
    `[SYNC] Done: +${result.added.length} -${result.deleted.length} ~${result.updated.length} =${result.unchanged} skipped:${result.skipped.length}`,
  );

  return result;
}

/** Format sync result as Telegram message */
function formatSyncResult(result: SyncResult): string {
  const lines: string[] = ['✅ Синхронизация завершена!\n'];

  const total = result.unchanged + result.added.length + result.updated.length;
  lines.push(`💾 Всего в БД: ${total}`);
  lines.push(`✓ Без изменений: ${result.unchanged}`);

  appendResultSection(lines, `➕ Добавлено`, result.added, fmtResultItem);
  appendResultSection(lines, `🗑 Удалено`, result.deleted, fmtResultItem);
  appendResultSection(
    lines,
    `✏️ Обновлено`,
    result.updated,
    (e) => `${fmtResultItem(e)} (${e.field})`,
  );

  lines.push(...formatSkippedRows(result.skipped));

  if (result.createdCategories.length > 0) {
    lines.push(`\n📁 Новые категории: ${result.createdCategories.join(', ')}`);
  }

  return lines.join('\n');
}

function fmtResultItem(e: SyncedExpense): string {
  return `  ${fmtExpense(e.date, e.amount, e.currency, e.category, e.comment)}`;
}

/** Heading with count, first 10 items, and a "...и ещё N" tail; nothing when empty. */
function appendResultSection<T>(
  lines: string[],
  heading: string,
  items: T[],
  fmt: (item: T) => string,
): void {
  if (items.length === 0) return;
  lines.push(`\n${heading}: ${items.length}`);
  for (const e of items.slice(0, 10)) lines.push(fmt(e));
  if (items.length > 10) lines.push(`  ...и ещё ${items.length - 10}`);
}

/**
 * One-directional import: read expenses from an arbitrary spreadsheet and add any
 * that are missing from the DB. Never deletes. Returns the number of inserted rows.
 * Safe to call repeatedly — deduplicates by date|category|amount|currency key.
 */
export async function importExpensesFromSheet(
  groupId: number,
  conn: GoogleConn,
  spreadsheetId: string,
): Promise<number> {
  const { expenses: sheetExpenses } = await readExpensesFromSheet(conn, spreadsheetId);
  if (sheetExpenses.length === 0) return 0;

  const dbExpenses = database.expenses.findByGroupId(groupId, 100000);
  const existingKeys = new Set(dbExpenses.map((e) => dbExpenseToKey(e)));

  const users = database.users.findByGroupId ? database.users.findByGroupId(groupId) : [];
  const defaultUserId = users[0]?.id ?? 1;

  let inserted = 0;
  for (const row of sheetExpenses) {
    const parsed = sheetRowToKey(row);
    if (!parsed) continue;
    if (existingKeys.has(parsed.key)) continue;

    database.expenses.create({
      group_id: groupId,
      user_id: defaultUserId,
      date: row.date,
      category: row.category,
      comment: row.comment,
      amount: parsed.amount,
      currency: parsed.currency,
      eur_amount: row.eurAmount,
    });
    existingKeys.add(parsed.key); // guard against within-loop duplicates
    inserted++;
  }
  return inserted;
}

// ── Auto-sync with cooldown ──

const lastExpenseSyncByGroup = new Map<number, number>();
const SYNC_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// ── Notify cache for pagination buttons ──

const NOTIFY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const syncNotifyCache = new Map<string, { result: SyncResult; expires: number }>();
const SYNC_PAGE_SIZE = 10;

function cleanSyncCache(): void {
  const now = Date.now();
  for (const [k, v] of syncNotifyCache) {
    if (v.expires < now) syncNotifyCache.delete(k);
  }
}

export function getSyncCachedResult(key: string): SyncResult | null {
  const entry = syncNotifyCache.get(key);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.result;
}

function fmtSyncItem(e: {
  date: string;
  amount: number;
  currency: string;
  category: string;
  comment: string;
}): string {
  return `${e.date} ${e.amount} ${e.currency} ${e.category}${e.comment ? ` ${e.comment}` : ''}`;
}

type SyncNotifyMessage = {
  text: string;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
};

/** Report lines for sheet rows skipped on a foreign-key violation; empty when there are none. */
function formatSkippedRows(skipped: SyncedExpense[]): string[] {
  if (skipped.length === 0) return [];
  const lines = [`\n⚠️ Пропущено (нет автора в базе): ${skipped.length}`];
  // N+2 rule: show all if ≤12, otherwise 10 + "ещё N" (N≥3)
  const maxVisible = skipped.length <= 12 ? skipped.length : 10;
  for (const e of skipped.slice(0, maxVisible)) {
    lines.push(`  ${fmtExpense(e.date, e.amount, e.currency, e.category, e.comment)}`);
  }
  if (skipped.length > maxVisible) lines.push(`  ...и ещё ${skipped.length - maxVisible}`);
  return lines;
}

interface SyncSection {
  items: Array<SyncedExpense & { field?: string }>;
  heading: string;
  moreLabel: (n: number) => string;
  suffix: string;
  withField: boolean;
}

function renderSyncSection(
  section: SyncSection,
  cacheKey: string,
  lines: string[],
  buttons: Array<{ text: string; callback_data: string }>,
): void {
  const { items } = section;
  if (items.length === 0) return;
  lines.push(`\n${section.heading}: ${items.length}`);
  for (const e of items.slice(0, SYNC_PAGE_SIZE)) {
    const field = section.withField && e.field ? ` (${e.field})` : '';
    lines.push(`  ${fmtSyncItem(e)}${field}`);
  }
  if (items.length > SYNC_PAGE_SIZE) {
    buttons.push({
      text: section.moreLabel(items.length - SYNC_PAGE_SIZE),
      callback_data: `sync_more:${cacheKey}:${section.suffix}`,
    });
  }
}

function buildAutoSyncExpensesMessage(result: SyncResult, cacheKey: string): SyncNotifyMessage {
  const counts: string[] = [];
  if (result.added.length > 0) counts.push(`+${result.added.length}`);
  if (result.deleted.length > 0) counts.push(`-${result.deleted.length}`);
  if (result.updated.length > 0) counts.push(`~${result.updated.length}`);

  const lines: string[] = [`🔄 Авто-синк расходов: ${counts.join(', ')}`];
  const buttons: Array<{ text: string; callback_data: string }> = [];

  const sections: SyncSection[] = [
    {
      items: result.added,
      heading: '➕ Добавлено',
      moreLabel: (n) => `➕ ещё ${n} добавлено`,
      suffix: 'a',
      withField: false,
    },
    {
      items: result.deleted,
      heading: '🗑 Удалено',
      moreLabel: (n) => `🗑 ещё ${n} удалено`,
      suffix: 'd',
      withField: false,
    },
    {
      items: result.updated,
      heading: '✏️ Обновлено',
      moreLabel: (n) => `✏️ ещё ${n} обновлено`,
      suffix: 'u',
      withField: true,
    },
  ];
  for (const section of sections) renderSyncSection(section, cacheKey, lines, buttons);

  // Skipped rows alone never trigger a notice (ensureFreshExpenses): they recur on every sync.
  lines.push(...formatSkippedRows(result.skipped));

  const text = lines.join('\n');
  if (buttons.length > 0) {
    return { text, reply_markup: { inline_keyboard: buttons.map((b) => [b]) } };
  }
  return { text };
}

/**
 * Sync expenses if stale. Blocking — caller awaits fresh data.
 * Sends notification to chat only if there were changes.
 */
export async function ensureFreshExpenses(
  groupId: number,
  telegramGroupId?: number,
): Promise<void> {
  const last = lastExpenseSyncByGroup.get(groupId) || 0;
  if (Date.now() - last < SYNC_COOLDOWN_MS) return;

  try {
    lastExpenseSyncByGroup.set(groupId, Date.now());
    const result = await syncExpenses(groupId);
    const hasChanges =
      result.added.length > 0 || result.deleted.length > 0 || result.updated.length > 0;

    if (hasChanges && telegramGroupId) {
      cleanSyncCache();
      const cacheKey = Math.random().toString(36).slice(2, 10);
      syncNotifyCache.set(cacheKey, { result, expires: Date.now() + NOTIFY_CACHE_TTL_MS });
      const msgData = buildAutoSyncExpensesMessage(result, cacheKey);
      const group = database.groups.findById(groupId);
      const threadId = group?.active_topic_id ?? null;
      await withChatContext(telegramGroupId, threadId, () =>
        sendMessage(
          msgData.text,
          msgData.reply_markup ? { reply_markup: msgData.reply_markup } : {},
        ),
      );
    }
  } catch (err) {
    logger.error({ err }, `[AUTO-SYNC] Expenses failed for group ${groupId}`);
  }
}

/**
 * /sync command handler - sync expenses from Google Sheet to database.
 * Usage: /sync — pull from sheet, /sync rollback — restore last snapshot.
 */
export async function handleSyncCommand(
  ctx: Ctx['Command'],
  group: GoogleConnectedGroup,
): Promise<void> {
  // Check for "rollback" argument
  const commandText = ctx.text || '';
  const args = commandText.split(/\s+/).slice(1).join(' ').trim();

  if (args.toLowerCase() === 'rollback') {
    await handleSyncRollback(group.id);
    return;
  }

  await sendMessage('🔄 Синхронизирую...');

  try {
    // Save snapshot of current expenses + budgets BEFORE sync (enables rollback)
    const currentExpenses = database.expenses.findByGroupId(group.id);
    const currentBudgets = database.budgets.findByGroupId(group.id);
    let snapshotId: string | null = null;
    if (currentExpenses.length > 0 || currentBudgets.length > 0) {
      snapshotId = database.syncSnapshots.saveSnapshot(group.id, currentExpenses, currentBudgets);
      logger.info(
        `[SYNC] Saved snapshot ${snapshotId}: ${currentExpenses.length} expenses, ${currentBudgets.length} budgets`,
      );
    }

    const result = await syncExpenses(group.id);
    lastExpenseSyncByGroup.set(group.id, Date.now());

    if (result.errors.length > 0) {
      const errorLines = result.errors.map(
        (e) => `• Строка ${e.row}: ${e.date} ${e.category} — валюты: ${e.currencies.join(', ')}`,
      );
      await sendMessage(
        `⚠️ Строки с суммами в нескольких валютах (пропущены):\n${errorLines.join('\n')}`,
      );
    }

    if (result.eurMismatches.length > 0) {
      // N+2 rule: show all if ≤7, otherwise show 5 + "ещё N" (N≥3)
      const maxVisible = result.eurMismatches.length <= 7 ? result.eurMismatches.length : 5;
      const lines = result.eurMismatches
        .slice(0, maxVisible)
        .map(
          (m) =>
            `• Строка ${m.row}: ${m.date} ${m.category} — таблица: ${m.sheetEur}€, пересчёт: ${m.recalcEur}€`,
        );
      const extra =
        result.eurMismatches.length > maxVisible
          ? `\n...и ещё ${result.eurMismatches.length - maxVisible}`
          : '';
      await sendMessage(
        `⚠️ EUR формулы в таблице расходились с Rate (в БД используются пересчитанные значения):\n${lines.join('\n')}${extra}`,
      );
    }

    const msg = formatSyncResult(result);
    const suffix =
      currentExpenses.length > 0 ? '\n\n<i>Если что-то пошло не так — /sync rollback</i>' : '';
    await sendMessage(msg + suffix);
  } catch (error) {
    logger.error({ err: error }, '[SYNC] Sync failed');
    await sendMessage(formatErrorForUser(error));
  }
}

/**
 * Handle /sync rollback — restore expenses from the latest snapshot
 */
async function handleSyncRollback(groupId: number): Promise<void> {
  const snapshots = database.syncSnapshots.listSnapshots(groupId);

  if (snapshots.length === 0) {
    await sendMessage('❌ Нет сохранённых снимков для отката. Откат доступен после /sync.');
    return;
  }

  // Safe: length > 0 checked above
  const latest = snapshots[0];
  if (!latest) return;
  const snapshotDate = new Date(latest.createdAt).toLocaleString('ru-RU');

  await sendMessage(
    `🔄 Восстанавливаю ${latest.expenseCount} ${pluralize(latest.expenseCount, 'расход', 'расхода', 'расходов')} и ${latest.budgetCount} ${pluralize(latest.budgetCount, 'бюджет', 'бюджета', 'бюджетов')} из снимка от ${snapshotDate}...`,
  );

  try {
    const expenses = database.syncSnapshots.getExpenseSnapshots(latest.snapshotId);
    const budgets = database.syncSnapshots.getBudgetSnapshots(latest.snapshotId);

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

      const mgr = getBudgetManager();
      for (const budget of budgets) {
        mgr.importFromSheet({
          groupId: budget.group_id,
          category: budget.category,
          month: budget.month,
          amount: budget.limit_amount,
          currency: budget.currency as CurrencyCode,
        });
      }
    });

    await sendMessage(
      `✅ Откат завершён! Восстановлено ${expenses.length} ${pluralize(expenses.length, 'расход', 'расхода', 'расходов')} и ${budgets.length} ${pluralize(budgets.length, 'бюджет', 'бюджета', 'бюджетов')}.`,
    );

    logger.info(
      `[SYNC] Rollback complete for group ${groupId}: ${expenses.length} expenses, ${budgets.length} budgets restored`,
    );
  } catch (error) {
    logger.error({ err: error }, '[SYNC] Rollback failed');
    await sendMessage('❌ Ошибка при откате. Попробуй ещё раз.');
  }
}
