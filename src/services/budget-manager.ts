// Single entry point for ALL budget write operations (DB + optional Google Sheets sync)

import type { CurrencyCode } from '../config/constants';
import { database } from '../database';
import { createLogger } from '../utils/logger.ts';
import { monthAbbrFromYYYYMM } from './google/month-abbr';
import { googleConn, writeMonthBudgetRow } from './google/sheets';

const logger = createLogger('budget-manager');

export interface SetBudgetParams {
  groupId: number;
  category: string;
  month: string; // YYYY-MM
  amount: number;
  currency: CurrencyCode;
}

export interface DeleteBudgetParams {
  groupId: number;
  category: string;
  month: string; // YYYY-MM
}

export interface BudgetWriteResult {
  sheetsSynced: boolean;
}

/**
 * Single entry point for ALL budget write operations.
 *
 * User-facing: set() / delete() — DB + Sheets sync
 * Sync from Sheets: importFromSheet() / deleteLocal() — DB only (data came from Sheets)
 *
 * database.budgets exposes read-only interface. Write methods are only accessible
 * through database.budgetWriter, which this class uses internally.
 */
export class BudgetManager {
  /** Set or update a budget. Writes to DB, then syncs to Sheets. */
  async set(params: SetBudgetParams): Promise<BudgetWriteResult> {
    const { groupId, category, month, amount, currency } = params;

    // 1. Always write to DB first (atomic, never fails silently)
    database.budgetWriter.setBudget({
      group_id: groupId,
      category,
      month,
      limit_amount: amount,
      currency,
    });

    // 2. Best-effort sync to Sheets
    const sheetsSynced = await this.syncToSheets(groupId, month, {
      category,
      limit: amount,
      currency,
    });

    return { sheetsSynced };
  }

  /** Delete a budget. Removes from DB, then zeros out in Sheets. */
  async delete(params: DeleteBudgetParams): Promise<BudgetWriteResult> {
    const { groupId, category, month } = params;

    // 1. Delete from DB
    database.budgetWriter.deleteByGroupCategoryMonth(groupId, category, month);

    // 2. Zero out in Sheets (row stays with amount=0)
    const group = database.groups.findById(groupId);
    const currency = group?.default_currency ?? ('EUR' as CurrencyCode);

    const sheetsSynced = await this.syncToSheets(groupId, month, {
      category,
      limit: 0,
      currency,
    });

    return { sheetsSynced };
  }

  /**
   * Import a budget from Google Sheets into DB. No Sheets write-back.
   * Used by budget-sync, reconnect, and rollback operations.
   */
  importFromSheet(params: SetBudgetParams): void {
    const { groupId, category, month, amount, currency } = params;
    database.budgetWriter.setBudget({
      group_id: groupId,
      category,
      month,
      limit_amount: amount,
      currency,
    });
  }

  /**
   * Delete a budget by id from DB only. No Sheets sync.
   * Used when Sheets→DB sync detects a removed budget row.
   */
  deleteLocal(id: number): void {
    database.budgetWriter.delete(id);
  }

  /**
   * Write a budget row to Google Sheets.
   * Returns true if synced, false if skipped or failed.
   */
  private async syncToSheets(
    groupId: number,
    month: string,
    row: { category: string; limit: number; currency: CurrencyCode },
  ): Promise<boolean> {
    const group = database.groups.findById(groupId);
    if (!group?.google_refresh_token) return false;

    const year = Number.parseInt(month.slice(0, 4), 10);
    const spreadsheetId =
      database.groupSpreadsheets.getByYear(groupId, year) ?? group.spreadsheet_id;
    if (!spreadsheetId) return false;

    try {
      const conn = googleConn(group);
      const monthAbbr = monthAbbrFromYYYYMM(month);
      await writeMonthBudgetRow(conn, spreadsheetId, monthAbbr, row);
      return true;
    } catch (err) {
      logger.error({ err }, `[BUDGET] Failed to sync to Sheets: ${row.category} for ${month}`);
      return false;
    }
  }
}

// ── Singleton ──────────────────────────────────────────────────────────────

let _instance: BudgetManager | null = null;

/** Get the singleton BudgetManager instance */
export function getBudgetManager(): BudgetManager {
  if (!_instance) {
    _instance = new BudgetManager();
  }
  return _instance;
}
