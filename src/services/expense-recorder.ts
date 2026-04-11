// Single entry point for writing expenses to Google Sheets + local database

import type { CurrencyCode } from '../config/constants';
import type { ExpenseRepository } from '../database/repositories/expense.repository';
import type { ExpenseItemsRepository } from '../database/repositories/expense-items.repository';
import type { GroupRepository } from '../database/repositories/group.repository';
import type { Expense } from '../database/types';
import { createLogger } from '../utils/logger.ts';
import type { ExpenseRowData, GoogleConn } from './google/sheets';

let _instance: ExpenseRecorder | null = null;

/**
 * Get the singleton ExpenseRecorder wired with real production deps.
 * Lazily created on first call to avoid import-order issues.
 */
export function getExpenseRecorder(): RecorderApi {
  if (!_instance) {
    // Lazy-import to break circular dependency chains
    const { database } = require('../database');
    const { appendExpenseRow, appendExpenseRows } = require('./google/sheets');
    const { convertToEUR, getExchangeRate } = require('./currency/converter');

    _instance = new ExpenseRecorder({
      groups: database.groups,
      expenses: database.expenses,
      expenseItems: database.expenseItems,
      sheetWriter: { appendExpenseRow, appendExpenseRows },
      eurConverter: { convertToEUR, getExchangeRate },
      runInTransaction: (fn: () => void) => database.transaction(fn),
    });
  }
  return _instance;
}

const logger = createLogger('expense-recorder');

/**
 * Abstraction over Google Sheets append — injected for testability.
 * `appendExpenseRow` is used for single-row writes (manual expenses).
 * `appendExpenseRows` is used for multi-row batch writes (receipts) — one API call
 * regardless of row count, so the Google Sheets 60 writes/min/user quota isn't
 * exhausted by large receipts.
 */
export interface SheetWriter {
  appendExpenseRow(conn: GoogleConn, spreadsheetId: string, data: ExpenseRowData): Promise<void>;
  appendExpenseRows(conn: GoogleConn, spreadsheetId: string, rows: ExpenseRowData[]): Promise<void>;
}

/**
 * Abstraction over EUR conversion — injected for testability
 */
export interface EurConverter {
  convertToEUR(amount: number, fromCurrency: CurrencyCode): number;
  getExchangeRate(currency: CurrencyCode): number;
}

/**
 * Input for recording a single expense
 */
export interface RecordExpenseData {
  date: string;
  category: string;
  comment: string;
  amount: number;
  currency: CurrencyCode;
}

/**
 * Input for recording a receipt item (one physical line on the receipt)
 */
export interface RecordReceiptItem {
  name: string;
  nameOriginal?: string | null;
  quantity: number;
  price: number;
  total: number;
  currency: CurrencyCode;
  category: string;
}

/**
 * Input for recording a full receipt. Receipt items are grouped by category
 * into one expense per category. The `date` is the receipt date (from the
 * receipt itself, not today) and applies to every created expense.
 *
 * Exactly one of `receiptId` or `receiptFileId` may be passed — they target
 * different linking strategies (`receipts` table row vs Telegram `file_id`
 * directly). Both may also be null for anonymous flows.
 */
export interface RecordReceiptData {
  date: string;
  items: RecordReceiptItem[];
  receiptId?: number | null;
  receiptFileId?: string | null;
}

/**
 * Result of recording an expense
 */
export interface RecordExpenseResult {
  expense: Expense;
  eurAmount: number;
}

/**
 * Result of recording a receipt. `expenses` contains one row per category
 * that had items (aligned with sheet writes). `categoriesAffected` is a
 * deduplicated list of categories — convenient for downstream budget checks.
 */
export interface RecordReceiptResult {
  expenses: RecordExpenseResult[];
  categoriesAffected: string[];
}

interface ExpenseRecorderDeps {
  groups: GroupRepository;
  expenses: ExpenseRepository;
  expenseItems: ExpenseItemsRepository;
  sheetWriter: SheetWriter;
  eurConverter: EurConverter;
  /**
   * Synchronous transaction wrapper. Production passes `database.transaction`;
   * tests pass a no-op that just invokes the callback (bun:sqlite in-memory
   * DBs support transactions but tests already create isolated DBs per file).
   */
  runInTransaction: (fn: () => void) => void;
}

/**
 * Build amounts record mapping each enabled currency to amount or null
 */
export function buildAmountsRecord(
  amount: number,
  currency: CurrencyCode,
  enabledCurrencies: CurrencyCode[],
): Record<string, number | null> {
  const amounts: Record<string, number | null> = {};
  for (const code of enabledCurrencies) {
    amounts[code] = code === currency ? amount : null;
  }
  return amounts;
}

/**
 * Build the full comment string for a receipt-derived expense. All items
 * for the category are listed with quantity and price. No truncation —
 * callers are responsible for truncating when displaying in Telegram.
 */
export function buildReceiptComment(items: RecordReceiptItem[]): string {
  const parts = items.map((i) => `${i.name} (${i.quantity}x${i.price})`);
  return `Чек: ${parts.join(', ')}`;
}

/**
 * Public API surface of ExpenseRecorder — use this interface for DI and testing
 */
export interface RecorderApi {
  record(groupId: number, userId: number, data: RecordExpenseData): Promise<RecordExpenseResult>;
  recordReceipt(
    groupId: number,
    userId: number,
    data: RecordReceiptData,
  ): Promise<RecordReceiptResult>;
  pushToSheet(groupId: number, expenseList: Expense[]): Promise<void>;
}

/**
 * Consolidates all expense writing: EUR conversion, sheet append, DB insert.
 * All callers (message handler, receipt handler, push) go through this service.
 */
export class ExpenseRecorder implements RecorderApi {
  private groups: GroupRepository;
  private expenses: ExpenseRepository;
  private expenseItems: ExpenseItemsRepository;
  private sheetWriter: SheetWriter;
  private eurConverter: EurConverter;
  private runInTransaction: (fn: () => void) => void;

  constructor(deps: ExpenseRecorderDeps) {
    this.groups = deps.groups;
    this.expenses = deps.expenses;
    this.expenseItems = deps.expenseItems;
    this.sheetWriter = deps.sheetWriter;
    this.eurConverter = deps.eurConverter;
    this.runInTransaction = deps.runInTransaction;
  }

  /**
   * Record a single expense to Google Sheets + local DB
   */
  async record(
    groupId: number,
    userId: number,
    data: RecordExpenseData,
  ): Promise<RecordExpenseResult> {
    const { conn, spreadsheetId, enabledCurrencies } = this.getGroupConfig(groupId);

    const rate = this.eurConverter.getExchangeRate(data.currency);
    const eurAmount = this.eurConverter.convertToEUR(data.amount, data.currency);
    const amounts = buildAmountsRecord(data.amount, data.currency, enabledCurrencies);

    // Write to Google Sheets if connected
    if (conn && spreadsheetId) {
      logger.info({ data: { ...data, eurAmount, rate } }, `[RECORD] Writing expense to sheet`);

      await this.sheetWriter.appendExpenseRow(conn, spreadsheetId, {
        date: data.date,
        category: data.category,
        comment: data.comment,
        amounts,
        eurAmount,
        rate,
      });
    } else {
      logger.info(
        { data: { ...data, eurAmount, rate } },
        `[RECORD] Saving expense locally (no Google Sheets)`,
      );
    }

    const expense = this.expenses.create({
      group_id: groupId,
      user_id: userId,
      date: data.date,
      category: data.category,
      comment: data.comment,
      amount: data.amount,
      currency: data.currency,
      eur_amount: eurAmount,
    });

    logger.info(
      `[RECORD] Expense ${expense.id} saved (${data.amount} ${data.currency} → ${eurAmount} EUR)`,
    );

    return { expense, eurAmount };
  }

  /**
   * Record a receipt: groups items by category, one expense per category,
   * one batched sheet write for all categories, one DB transaction.
   *
   * This is the sole entry point for receipt writes — both the bot's
   * `saveReceiptExpenses` and the Mini App's `/api/receipt/confirm` endpoint
   * route through it so both paths write to the sheet identically.
   *
   * Atomicity: the sheet write is issued first. If it throws (429, network,
   * auth), the DB transaction never runs — no partial state. If the sheet
   * write succeeds and the DB insert then fails, we have orphan sheet rows,
   * but that's the same behaviour as `record()` today (DB insert is extremely
   * unlikely to fail for valid inputs, and atomicity is a best-effort guarantee
   * at this layer).
   */
  async recordReceipt(
    groupId: number,
    userId: number,
    data: RecordReceiptData,
  ): Promise<RecordReceiptResult> {
    if (data.items.length === 0) {
      return { expenses: [], categoriesAffected: [] };
    }

    const { conn, spreadsheetId, enabledCurrencies } = this.getGroupConfig(groupId);

    // Group items by category, preserving first-seen order
    const byCategory = new Map<string, RecordReceiptItem[]>();
    for (const item of data.items) {
      const existing = byCategory.get(item.category);
      if (existing) {
        existing.push(item);
      } else {
        byCategory.set(item.category, [item]);
      }
    }

    // Build per-category batches (pure computation, no I/O)
    interface CategoryBatch {
      category: string;
      items: RecordReceiptItem[];
      totalAmount: number;
      currency: CurrencyCode;
      comment: string;
      eurAmount: number;
      rate: number;
      row: ExpenseRowData;
    }

    const batches: CategoryBatch[] = [];
    for (const [category, items] of byCategory.entries()) {
      const first = items[0];
      if (!first) continue;
      const currency = first.currency;
      const totalAmount = items.reduce((sum, i) => sum + i.total, 0);
      const comment = buildReceiptComment(items);
      const rate = this.eurConverter.getExchangeRate(currency);
      const eurAmount = this.eurConverter.convertToEUR(totalAmount, currency);
      const amounts = buildAmountsRecord(totalAmount, currency, enabledCurrencies);

      batches.push({
        category,
        items,
        totalAmount,
        currency,
        comment,
        eurAmount,
        rate,
        row: {
          date: data.date,
          category,
          comment,
          amounts,
          eurAmount,
          rate,
        },
      });
    }

    if (batches.length === 0) {
      return { expenses: [], categoriesAffected: [] };
    }

    // One batched sheet write for all category rows
    if (conn && spreadsheetId) {
      logger.info(
        { rowCount: batches.length, itemCount: data.items.length, date: data.date },
        '[RECORD_RECEIPT] Writing receipt to sheet',
      );
      await this.sheetWriter.appendExpenseRows(
        conn,
        spreadsheetId,
        batches.map((b) => b.row),
      );
    } else {
      logger.info(
        { rowCount: batches.length, itemCount: data.items.length },
        '[RECORD_RECEIPT] Saving receipt locally (no Google Sheets)',
      );
    }

    // Single DB transaction: one expense per category + all expense items
    const results: RecordExpenseResult[] = [];
    this.runInTransaction(() => {
      for (const batch of batches) {
        const expense = this.expenses.create({
          group_id: groupId,
          user_id: userId,
          date: data.date,
          category: batch.category,
          comment: batch.comment,
          amount: batch.totalAmount,
          currency: batch.currency,
          eur_amount: batch.eurAmount,
          receipt_id: data.receiptId ?? null,
          receipt_file_id: data.receiptFileId ?? null,
        });

        for (const item of batch.items) {
          this.expenseItems.create({
            expense_id: expense.id,
            name_ru: item.name,
            name_original: item.nameOriginal ?? null,
            quantity: item.quantity,
            price: item.price,
            total: item.total,
          });
        }

        results.push({ expense, eurAmount: batch.eurAmount });
      }
    });

    const categoriesAffected = batches.map((b) => b.category);

    logger.info(
      `[RECORD_RECEIPT] Recorded ${results.length} category expenses from ${data.items.length} items`,
    );

    return { expenses: results, categoriesAffected };
  }

  /**
   * Push existing DB expenses to sheet (no new DB entries)
   */
  async pushToSheet(groupId: number, expenseList: Expense[]): Promise<void> {
    const { conn, spreadsheetId, enabledCurrencies } = this.getGroupConfig(groupId);

    if (!conn || !spreadsheetId) {
      throw new Error(`Group ${groupId} not connected to Google Sheets`);
    }

    for (const expense of expenseList) {
      const amounts = buildAmountsRecord(expense.amount, expense.currency, enabledCurrencies);
      const rate = this.eurConverter.getExchangeRate(expense.currency as CurrencyCode);

      await this.sheetWriter.appendExpenseRow(conn, spreadsheetId, {
        date: expense.date,
        category: expense.category,
        comment: expense.comment,
        amounts,
        eurAmount: expense.eur_amount,
        rate,
      });
    }

    logger.info(`[PUSH] Pushed ${expenseList.length} expenses to sheet`);
  }

  private getGroupConfig(groupId: number): {
    conn: GoogleConn | null;
    spreadsheetId: string | null;
    enabledCurrencies: CurrencyCode[];
  } {
    const group = this.groups.findById(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }
    return {
      conn: group.google_refresh_token
        ? {
            refreshToken: group.google_refresh_token,
            oauthClient: group.oauth_client,
          }
        : null,
      spreadsheetId: group.spreadsheet_id,
      enabledCurrencies: group.enabled_currencies,
    };
  }
}
