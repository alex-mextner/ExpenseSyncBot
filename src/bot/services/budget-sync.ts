/** Budget sync service — sync budgets between Google Sheets and database */
import { format } from 'date-fns';
import type { CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import { sendMessage, withChatContext } from '../../services/bank/telegram-sender';
import { getBudgetManager } from '../../services/budget-manager';
import { monthAbbrFromDate } from '../../services/google/month-abbr';
import {
  type GoogleConn,
  googleConn,
  monthTabExists,
  readMonthBudget,
} from '../../services/google/sheets';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('budget-sync');

const EMPTY_SYNC_RESULT: BudgetSyncResult = {
  unchanged: 0,
  added: [],
  updated: [],
  deleted: [],
  createdCategories: [],
  multiWordWarnings: [],
};

// ── Auto-sync budgets with cooldown ──

const lastBudgetSyncByGroup = new Map<number, number>();
const BUDGET_SYNC_COOLDOWN_MS = 10 * 60 * 1000; // 10 minutes

// ── Notify cache for pagination buttons ──

const BUDGET_NOTIFY_CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const budgetNotifyCache = new Map<string, { result: BudgetSyncResult; expires: number }>();
const BUDGET_PAGE_SIZE = 10;
let cacheKeyCounter = 0;

function cleanBudgetCache(): void {
  const now = Date.now();
  for (const [k, v] of budgetNotifyCache) {
    if (v.expires < now) budgetNotifyCache.delete(k);
  }
}

export function getBudgetSyncCachedResult(key: string): BudgetSyncResult | null {
  const entry = budgetNotifyCache.get(key);
  if (!entry || entry.expires < Date.now()) return null;
  return entry.result;
}

function fmtBudgetItem(e: {
  category: string;
  limit: number;
  currency: CurrencyCode;
  oldLimit?: number;
}): string {
  const change = e.oldLimit !== undefined ? ` (было ${e.oldLimit})` : '';
  return `${e.category}: ${e.limit} ${e.currency}${change}`;
}

type BudgetNotifyMessage = {
  text: string;
  reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
};

interface BudgetSection {
  items: Array<{ category: string; limit: number; currency: CurrencyCode; oldLimit?: number }>;
  heading: string;
  moreLabel: (n: number) => string;
  suffix: string;
}

function renderBudgetSection(
  section: BudgetSection,
  cacheKey: string,
  lines: string[],
  buttons: Array<{ text: string; callback_data: string }>,
): void {
  const { items } = section;
  if (items.length === 0) return;
  lines.push(`\n${section.heading}: ${items.length}`);
  for (const e of items.slice(0, BUDGET_PAGE_SIZE)) {
    lines.push(`  ${fmtBudgetItem(e)}`);
  }
  if (items.length > BUDGET_PAGE_SIZE) {
    buttons.push({
      text: section.moreLabel(items.length - BUDGET_PAGE_SIZE),
      callback_data: `bsync_more:${cacheKey}:${section.suffix}`,
    });
  }
}

function buildAutoSyncBudgetsMessage(
  result: BudgetSyncResult,
  cacheKey: string,
): BudgetNotifyMessage {
  const counts: string[] = [];
  if (result.added.length > 0) counts.push(`+${result.added.length}`);
  if (result.deleted.length > 0) counts.push(`-${result.deleted.length}`);
  if (result.updated.length > 0) counts.push(`~${result.updated.length}`);

  const lines: string[] = [`🔄 Авто-синк бюджетов: ${counts.join(', ')}`];
  const buttons: Array<{ text: string; callback_data: string }> = [];

  const sections: BudgetSection[] = [
    {
      items: result.added,
      heading: '➕ Добавлено',
      moreLabel: (n) => `➕ ещё ${n} добавлено`,
      suffix: 'a',
    },
    {
      items: result.deleted,
      heading: '🗑 Удалено',
      moreLabel: (n) => `🗑 ещё ${n} удалено`,
      suffix: 'd',
    },
    {
      items: result.updated,
      heading: '✏️ Обновлено',
      moreLabel: (n) => `✏️ ещё ${n} обновлено`,
      suffix: 'u',
    },
  ];
  for (const section of sections) renderBudgetSection(section, cacheKey, lines, buttons);

  if (result.multiWordWarnings.length > 0) {
    lines.push('\n⚠️ Категории с пробелами:');
    for (const w of result.multiWordWarnings) {
      lines.push(`  ${w}`);
    }
    lines.push(
      '\nБот записывает только первое слово как категорию. Переименуй в таблице на одно слово без пробелов.',
    );
  }

  const text = lines.join('\n');
  if (buttons.length > 0) {
    return { text, reply_markup: { inline_keyboard: buttons.map((b) => [b]) } };
  }
  return { text };
}

export interface BudgetSyncResult {
  unchanged: number;
  added: Array<{ month: string; category: string; limit: number; currency: CurrencyCode }>;
  updated: Array<{
    month: string;
    category: string;
    limit: number;
    currency: CurrencyCode;
    oldLimit: number;
  }>;
  deleted: Array<{ month: string; category: string; limit: number; currency: CurrencyCode }>;
  createdCategories: string[];
  /** Warnings about multi-word categories found in sheet */
  multiWordWarnings: string[];
}

/** Import one sheet budget row: create category/budget when missing, update when changed. */
function applySheetBudget(
  groupId: number,
  currentMonth: string,
  b: { category: string; limit: number; currency: CurrencyCode },
  result: BudgetSyncResult,
): void {
  const mgr = getBudgetManager();
  if (!database.categories.exists(groupId, b.category)) {
    database.categories.create({ group_id: groupId, name: b.category });
    result.createdCategories.push(b.category);
  }

  const existing = database.budgets.findByGroupCategoryMonth(groupId, b.category, currentMonth);
  const changed =
    existing && (existing.limit_amount !== b.limit || existing.currency !== b.currency);
  if (existing && !changed) {
    result.unchanged++;
    return;
  }

  const { multiWordWarning } = mgr.importFromSheet({
    groupId,
    category: b.category,
    month: currentMonth,
    amount: b.limit,
    currency: b.currency,
  });
  if (multiWordWarning) result.multiWordWarnings.push(multiWordWarning);
  const added = { month: currentMonth, category: b.category, limit: b.limit, currency: b.currency };
  if (existing) {
    result.updated.push({ ...added, oldLimit: existing.limit_amount });
  } else {
    result.added.push(added);
  }
}

/** Delete local budgets for the month whose category no longer appears in the sheet. */
function deleteBudgetsMissingFromSheet(
  groupId: number,
  currentMonth: string,
  sheetCategories: Set<string>,
  result: BudgetSyncResult,
): void {
  const mgr = getBudgetManager();
  const dbBudgets = database.budgets.getAllBudgetsForMonth(groupId, currentMonth);
  for (const db of dbBudgets) {
    if (!sheetCategories.has(db.category)) {
      mgr.deleteLocal(db.id);
      result.deleted.push({
        month: db.month,
        category: db.category,
        limit: db.limit_amount,
        currency: db.currency,
      });
    }
  }
}

/**
 * Diff-based budget sync — compare sheet budgets with DB and apply changes.
 */
export async function syncBudgetsDiff(groupId: number): Promise<BudgetSyncResult> {
  const group = database.groups.findById(groupId);
  if (!group?.google_refresh_token) {
    throw new Error('Group not configured for Google Sheets');
  }

  const now = new Date();
  const currentYear = now.getFullYear();
  const currentMonth = format(now, 'yyyy-MM');
  const currentMonthAbbr = monthAbbrFromDate(now);

  const spreadsheetId = database.groupSpreadsheets.getByYear(groupId, currentYear);
  if (!spreadsheetId) {
    return { ...EMPTY_SYNC_RESULT };
  }

  const conn = googleConn(group);

  const tabExists = await monthTabExists(conn, spreadsheetId, currentMonthAbbr);
  if (!tabExists) {
    return { ...EMPTY_SYNC_RESULT };
  }

  const sheetBudgets = await readMonthBudget(conn, spreadsheetId, currentMonthAbbr);

  const result: BudgetSyncResult = {
    ...EMPTY_SYNC_RESULT,
    added: [],
    updated: [],
    deleted: [],
    createdCategories: [],
    multiWordWarnings: [],
  };

  const sheetCategories = new Set<string>(sheetBudgets.map((b) => b.category));

  // Wrap all DB reads+writes in a transaction for atomicity
  database.transaction(() => {
    for (const b of sheetBudgets) {
      applySheetBudget(groupId, currentMonth, b, result);
    }
    deleteBudgetsMissingFromSheet(groupId, currentMonth, sheetCategories, result);
  });

  logger.info(
    `[BUDGET-SYNC] +${result.added.length} -${result.deleted.length} ~${result.updated.length} =${result.unchanged}`,
  );

  return result;
}

/**
 * Sync budgets if stale. Blocking. Notifies chat only if changes detected.
 */
export async function ensureFreshBudgets(groupId: number, telegramGroupId?: number): Promise<void> {
  const last = lastBudgetSyncByGroup.get(groupId) || 0;
  if (Date.now() - last < BUDGET_SYNC_COOLDOWN_MS) return;

  try {
    lastBudgetSyncByGroup.set(groupId, Date.now());
    const result = await syncBudgetsDiff(groupId);
    const hasChanges =
      result.added.length > 0 || result.deleted.length > 0 || result.updated.length > 0;

    if (hasChanges && telegramGroupId) {
      cleanBudgetCache();
      const cacheKey = `bs_${Date.now()}_${cacheKeyCounter++}`;
      budgetNotifyCache.set(cacheKey, { result, expires: Date.now() + BUDGET_NOTIFY_CACHE_TTL_MS });
      const msgData = buildAutoSyncBudgetsMessage(result, cacheKey);
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
    logger.error({ err }, `[AUTO-SYNC] Budgets failed for group ${groupId}`);
  }
}

/**
 * Silently sync budgets from Google Sheets to database.
 * Returns number of synced budgets.
 */
export async function silentSyncBudgets(conn: GoogleConn, groupId: number): Promise<number> {
  try {
    const now = new Date();
    const currentYear = now.getFullYear();
    const currentMonth = format(now, 'yyyy-MM');
    const currentMonthAbbr = monthAbbrFromDate(now);

    const spreadsheetId = database.groupSpreadsheets.getByYear(groupId, currentYear);
    if (!spreadsheetId) return 0;

    const tabExists = await monthTabExists(conn, spreadsheetId, currentMonthAbbr);
    if (!tabExists) return 0;

    const budgetsFromSheet = await readMonthBudget(conn, spreadsheetId, currentMonthAbbr);
    if (budgetsFromSheet.length === 0) return 0;

    const mgr = getBudgetManager();

    // Wrap all DB writes in a transaction for atomicity
    const syncedCount = database.transaction(() => {
      let count = 0;

      for (const b of budgetsFromSheet) {
        if (!database.categories.exists(groupId, b.category)) {
          database.categories.create({ group_id: groupId, name: b.category });
        }

        const existing = database.budgets.findByGroupCategoryMonth(
          groupId,
          b.category,
          currentMonth,
        );
        const hasChanged =
          !existing || existing.limit_amount !== b.limit || existing.currency !== b.currency;

        if (hasChanged) {
          mgr.importFromSheet({
            groupId,
            category: b.category,
            month: currentMonth,
            amount: b.limit,
            currency: b.currency,
          });
          count++;
        }
      }

      return count;
    });

    return syncedCount;
  } catch (err) {
    logger.error({ err }, '[BUDGET] Silent sync failed');
    return 0;
  }
}
