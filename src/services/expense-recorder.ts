// Single entry point for writing expenses to Google Sheets + local database

import { format } from 'date-fns';
import type { CurrencyCode } from '../config/constants';
import type { ExpenseRepository } from '../database/repositories/expense.repository';
import type { ExpenseItemsRepository } from '../database/repositories/expense-items.repository';
import type { GroupRepository } from '../database/repositories/group.repository';
import type { Expense } from '../database/types';
import { createLogger } from '../utils/logger.ts';

let _instance: ExpenseRecorder | null = null;

/**
 * Get the singleton ExpenseRecorder wired with real production deps.
 * Lazily created on first call to avoid import-order issues.
 */
export function getExpenseRecorder(): ExpenseRecorder {
  if (!_instance) {
    // Lazy-import to break circular dependency chains
    const { database } = require('../database');
    const { appendExpenseRow } = require('./google/sheets');
    const { convertToEUR, getExchangeRate } = require('./currency/converter');

    _instance = new ExpenseRecorder({
      groups: database.groups,
      expenses: database.expenses,
      expenseItems: database.expenseItems,
      sheetWriter: { appendExpenseRow },
      eurConverter: { convertToEUR, getExchangeRate },
    });
  }
  return _instance;
}

const logger = createLogger('expense-recorder');

/**
 * Abstraction over Google Sheets append — injected for testability
 */
export interface SheetWriter {
  appendExpenseRow(
    refreshToken: string,
    spreadsheetId: string,
    data: {
      date: string;
      category: string;
      comment: string;
      amounts: Record<string, number | null>;
      eurAmount: number;
      rate?: number;
    },
  ): Promise<void>;
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
 * Input for recording a receipt item (batch mode)
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
 * Result of recording an expense
 */
export interface RecordExpenseResult {
  expense: Expense;
  eurAmount: number;
}

interface ExpenseRecorderDeps {
  groups: GroupRepository;
  expenses: ExpenseRepository;
  expenseItems: ExpenseItemsRepository;
  sheetWriter: SheetWriter;
  eurConverter: EurConverter;
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
 * Consolidates all expense writing: EUR conversion, sheet append, DB insert.
 * All callers (message handler, receipt handler, push) go through this service.
 */
export class ExpenseRecorder {
  private groups: GroupRepository;
  private expenses: ExpenseRepository;
  private expenseItems: ExpenseItemsRepository;
  private sheetWriter: SheetWriter;
  private eurConverter: EurConverter;

  constructor(deps: ExpenseRecorderDeps) {
    this.groups = deps.groups;
    this.expenses = deps.expenses;
    this.expenseItems = deps.expenseItems;
    this.sheetWriter = deps.sheetWriter;
    this.eurConverter = deps.eurConverter;
  }

  /**
   * Record a single expense to Google Sheets + local DB
   */
  async record(
    groupId: number,
    userId: number,
    data: RecordExpenseData,
  ): Promise<RecordExpenseResult> {
    const { refreshToken, spreadsheetId, enabledCurrencies } = this.getGroupConfig(groupId);

    const rate = this.eurConverter.getExchangeRate(data.currency);
    const eurAmount = this.eurConverter.convertToEUR(data.amount, data.currency);
    const amounts = buildAmountsRecord(data.amount, data.currency, enabledCurrencies);

    logger.info({ data: { ...data, eurAmount, rate } }, `[RECORD] Writing expense to sheet`);

    // Sheet write first — if it fails, no DB entry is created
    await this.sheetWriter.appendExpenseRow(refreshToken, spreadsheetId, {
      date: data.date,
      category: data.category,
      comment: data.comment,
      amounts,
      eurAmount,
      rate,
    });

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
   * Record a batch of receipt items — groups by category, one expense per category
   */
  async recordBatch(
    groupId: number,
    userId: number,
    items: RecordReceiptItem[],
  ): Promise<RecordExpenseResult[]> {
    if (items.length === 0) return [];

    const { refreshToken, spreadsheetId, enabledCurrencies } = this.getGroupConfig(groupId);

    // Group items by category
    const byCategory = new Map<string, RecordReceiptItem[]>();
    for (const item of items) {
      const existing = byCategory.get(item.category);
      if (existing) {
        existing.push(item);
      } else {
        byCategory.set(item.category, [item]);
      }
    }

    const currentDate = format(new Date(), 'yyyy-MM-dd');
    const results: RecordExpenseResult[] = [];

    for (const [category, categoryItems] of byCategory.entries()) {
      if (categoryItems.length === 0) continue;

      const totalAmount = categoryItems.reduce((sum, item) => sum + item.total, 0);
      const firstItem = categoryItems[0];
      if (!firstItem) continue;
      const currency = firstItem.currency;
      const rate = this.eurConverter.getExchangeRate(currency);
      const eurAmount = this.eurConverter.convertToEUR(totalAmount, currency);

      const comment = `Чек: ${categoryItems.map((i) => `${i.name} (${i.quantity}x${i.price})`).join(', ')}`;
      const amounts = buildAmountsRecord(totalAmount, currency, enabledCurrencies);

      // Sheet write first
      await this.sheetWriter.appendExpenseRow(refreshToken, spreadsheetId, {
        date: currentDate,
        category,
        comment,
        amounts,
        eurAmount,
        rate,
      });

      const expense = this.expenses.create({
        group_id: groupId,
        user_id: userId,
        date: currentDate,
        category,
        comment,
        amount: totalAmount,
        currency,
        eur_amount: eurAmount,
      });

      // Create expense items
      for (const item of categoryItems) {
        this.expenseItems.create({
          expense_id: expense.id,
          name_ru: item.name,
          name_original: item.nameOriginal || null,
          quantity: item.quantity,
          price: item.price,
          total: item.total,
        });
      }

      results.push({ expense, eurAmount });
    }

    logger.info(
      `[RECORD_BATCH] Recorded ${results.length} category expenses from ${items.length} items`,
    );
    return results;
  }

  /**
   * Push existing DB expenses to sheet (no new DB entries)
   */
  async pushToSheet(groupId: number, expenseList: Expense[]): Promise<void> {
    const { refreshToken, spreadsheetId, enabledCurrencies } = this.getGroupConfig(groupId);

    for (const expense of expenseList) {
      const amounts = buildAmountsRecord(expense.amount, expense.currency, enabledCurrencies);

      // Rate omitted: DB expenses store eur_amount but not the original rate.
      // Re-deriving rate from eur_amount/amount would give a stale approximation.
      await this.sheetWriter.appendExpenseRow(refreshToken, spreadsheetId, {
        date: expense.date,
        category: expense.category,
        comment: expense.comment,
        amounts,
        eurAmount: expense.eur_amount,
      });
    }

    logger.info(`[PUSH] Pushed ${expenseList.length} expenses to sheet`);
  }

  private getGroupConfig(groupId: number): {
    refreshToken: string;
    spreadsheetId: string;
    enabledCurrencies: CurrencyCode[];
  } {
    const group = this.groups.findById(groupId);
    if (!group) {
      throw new Error(`Group ${groupId} not found`);
    }
    if (!group.google_refresh_token || !group.spreadsheet_id) {
      throw new Error(`Group ${groupId} not configured for Google Sheets`);
    }
    return {
      refreshToken: group.google_refresh_token,
      spreadsheetId: group.spreadsheet_id,
      enabledCurrencies: group.enabled_currencies,
    };
  }
}
