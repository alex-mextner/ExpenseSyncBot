// Tests for ExpenseRecorder — single entry point for writing expenses to sheet + DB

import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { CurrencyCode } from '../config/constants';
import { ExpenseRepository } from '../database/repositories/expense.repository';
import { ExpenseItemsRepository } from '../database/repositories/expense-items.repository';
import { GroupRepository } from '../database/repositories/group.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { clearTestDb, createTestDb } from '../test-utils/db';
import {
  buildAmountsRecord,
  type EurConverter,
  ExpenseRecorder,
  type SheetWriter,
} from './expense-recorder';

describe('buildAmountsRecord', () => {
  it('maps currency amount to correct slot, others null', () => {
    const result = buildAmountsRecord(4500, 'RSD', ['USD', 'EUR', 'RSD']);
    expect(result).toEqual({ USD: null, EUR: null, RSD: 4500 });
  });

  it('handles single enabled currency', () => {
    const result = buildAmountsRecord(100, 'EUR', ['EUR']);
    expect(result).toEqual({ EUR: 100 });
  });

  it('returns all nulls when currency not in enabled list', () => {
    const result = buildAmountsRecord(50, 'GBP', ['USD', 'EUR', 'RSD']);
    expect(result).toEqual({ USD: null, EUR: null, RSD: null });
  });

  it('handles all supported currencies', () => {
    const all: CurrencyCode[] = [
      'USD',
      'EUR',
      'RUB',
      'RSD',
      'GBP',
      'BYN',
      'CHF',
      'JPY',
      'CNY',
      'INR',
      'LKR',
      'AED',
    ];
    const result = buildAmountsRecord(999, 'CHF', all);
    for (const code of all) {
      expect(result[code]).toBe(code === 'CHF' ? 999 : null);
    }
  });
});

describe('ExpenseRecorder', () => {
  let db: Database;
  let groups: GroupRepository;
  let users: UserRepository;
  let expenses: ExpenseRepository;
  let expenseItems: ExpenseItemsRepository;
  let mockSheetWriter: SheetWriter;
  let mockConverter: EurConverter;
  let recorder: ExpenseRecorder;

  beforeEach(() => {
    db = createTestDb();
    groups = new GroupRepository(db);
    users = new UserRepository(db);
    expenses = new ExpenseRepository(db);
    expenseItems = new ExpenseItemsRepository(db);

    mockSheetWriter = {
      appendExpenseRow: mock(() => Promise.resolve()),
      appendExpenseRows: mock(() => Promise.resolve()),
    };

    const testRates: Record<string, number> = { EUR: 1, USD: 0.86, RSD: 0.0085, RUB: 0.01 };
    mockConverter = {
      convertToEUR: mock((amount: number, _currency: CurrencyCode) => {
        return Math.round(amount * (testRates[_currency] || 1) * 100) / 100;
      }),
      getExchangeRate: mock((currency: CurrencyCode) => {
        return testRates[currency] || 1;
      }),
    };

    recorder = new ExpenseRecorder({
      groups,
      expenses,
      expenseItems,
      sheetWriter: mockSheetWriter,
      eurConverter: mockConverter,
      // Tests run on a single in-memory DB per file; identity wrapper is fine.
      // bun:sqlite `db.transaction` would also work but adds noise.
      runInTransaction: (fn) => fn(),
    });
  });

  afterEach(() => {
    clearTestDb(db);
    db.close();
  });

  /** Create a group with Google Sheets connected */
  function seedGroup(overrides?: Partial<{ enabled_currencies: CurrencyCode[] }>): {
    groupId: number;
    userId: number;
  } {
    const group = groups.create({ telegram_group_id: -100123 });
    groups.update(-100123, {
      google_refresh_token: 'token-abc',
      spreadsheet_id: 'sheet-123',
      enabled_currencies: overrides?.enabled_currencies || ['USD', 'EUR', 'RSD'],
    });
    const user = users.create({ telegram_id: 111, group_id: group.id });
    return { groupId: group.id, userId: user.id };
  }

  /** Create a group without Google Sheets (no refresh token / spreadsheet) */
  function seedGroupWithoutGoogle(): { groupId: number; userId: number } {
    const group = groups.create({ telegram_group_id: -100456 });
    // No google_refresh_token or spreadsheet_id set — they default to null
    const user = users.create({ telegram_id: 222, group_id: group.id });
    return { groupId: group.id, userId: user.id };
  }

  describe('record()', () => {
    it('writes expense to sheet and DB when Google is connected', async () => {
      const { groupId, userId } = seedGroup();

      const result = await recorder.record(groupId, userId, {
        date: '2026-03-24',
        category: 'Еда',
        comment: 'Пицца',
        amount: 4500,
        currency: 'RSD',
      });

      // EUR conversion called
      expect(mockConverter.convertToEUR).toHaveBeenCalledWith(4500, 'RSD');
      expect(result.eurAmount).toBe(38.25); // 4500 * 0.0085

      // Sheet write called with correct data
      expect(mockSheetWriter.appendExpenseRow).toHaveBeenCalledTimes(1);
      const sheetCall = (mockSheetWriter.appendExpenseRow as ReturnType<typeof mock>).mock.calls[0];
      if (!sheetCall) throw new Error('Expected sheet write call');
      expect(sheetCall[0]).toEqual({ refreshToken: 'token-abc', oauthClient: 'legacy' });
      expect(sheetCall[1]).toBe('sheet-123');
      expect(sheetCall[2]).toEqual({
        date: '2026-03-24',
        category: 'Еда',
        comment: 'Пицца',
        amounts: { USD: null, EUR: null, RSD: 4500 },
        eurAmount: 38.25,
        rate: 0.0085,
      });

      // DB expense created
      expect(result.expense.group_id).toBe(groupId);
      expect(result.expense.user_id).toBe(userId);
      expect(result.expense.amount).toBe(4500);
      expect(result.expense.currency).toBe('RSD');
      expect(result.expense.eur_amount).toBe(38.25);
      expect(result.expense.category).toBe('Еда');

      // Verify in DB
      const dbExpense = expenses.findById(result.expense.id);
      expect(dbExpense).toBeTruthy();
      if (!dbExpense) throw new Error('unreachable');
      expect(dbExpense.eur_amount).toBe(38.25);
    });

    it('handles EUR currency (no conversion needed)', async () => {
      const { groupId, userId } = seedGroup();

      const result = await recorder.record(groupId, userId, {
        date: '2026-03-24',
        category: 'Квартира',
        comment: '',
        amount: 700,
        currency: 'EUR',
      });

      expect(result.eurAmount).toBe(700);
      expect(result.expense.eur_amount).toBe(700);
    });

    it('records expense to DB only when no Google connection (refreshToken null)', async () => {
      const { groupId, userId } = seedGroupWithoutGoogle();

      const result = await recorder.record(groupId, userId, {
        date: '2026-03-24',
        category: 'Еда',
        comment: 'Пицца',
        amount: 4500,
        currency: 'RSD',
      });

      // Sheet was NOT called
      expect(mockSheetWriter.appendExpenseRow).toHaveBeenCalledTimes(0);

      // DB expense still created
      expect(result.expense.group_id).toBe(groupId);
      expect(result.expense.user_id).toBe(userId);
      expect(result.expense.amount).toBe(4500);
      expect(result.expense.currency).toBe('RSD');
      expect(result.eurAmount).toBe(38.25);

      // Verify in DB
      const dbExpense = expenses.findById(result.expense.id);
      expect(dbExpense).toBeTruthy();
    });

    it('records expense to DB only when spreadsheetId is null', async () => {
      // Create group with token but no spreadsheet
      const group = groups.create({ telegram_group_id: -100789 });
      groups.update(-100789, { google_refresh_token: 'token-only' });
      const user = users.create({ telegram_id: 333, group_id: group.id });

      const result = await recorder.record(group.id, user.id, {
        date: '2026-03-24',
        category: 'Test',
        comment: '',
        amount: 100,
        currency: 'EUR',
      });

      // Sheet was NOT called (spreadsheetId is null)
      expect(mockSheetWriter.appendExpenseRow).toHaveBeenCalledTimes(0);

      // DB expense still created
      expect(result.expense.amount).toBe(100);
    });

    it('throws if group not found', async () => {
      await expect(
        recorder.record(999, 1, {
          date: '2026-03-24',
          category: 'Test',
          comment: '',
          amount: 100,
          currency: 'EUR',
        }),
      ).rejects.toThrow('not found');
    });

    it('does NOT create DB expense if sheet write fails', async () => {
      const { groupId, userId } = seedGroup();
      (mockSheetWriter.appendExpenseRow as ReturnType<typeof mock>).mockImplementation(() => {
        throw new Error('Google API error');
      });

      await expect(
        recorder.record(groupId, userId, {
          date: '2026-03-24',
          category: 'Еда',
          comment: '',
          amount: 100,
          currency: 'RSD',
        }),
      ).rejects.toThrow('Google API error');

      // No expense in DB
      const all = expenses.findByGroupId(groupId);
      expect(all).toHaveLength(0);
    });
  });

  describe('recordReceipt()', () => {
    it('writes 70 items in one category with ONE appendExpenseRows call (regression)', async () => {
      const { groupId, userId } = seedGroup();

      // Simulate the 2026-04-11 Maxi receipt that caused the 429 incident
      const items = Array.from({ length: 70 }, (_, i) => ({
        name: `Item ${i}`,
        quantity: 1,
        price: 100,
        total: 100,
        currency: 'RSD' as const,
        category: 'Продукты',
      }));

      const result = await recorder.recordReceipt(groupId, userId, {
        date: '2026-04-11',
        items,
      });

      // Exactly ONE batched sheet call (not 70)
      expect(mockSheetWriter.appendExpenseRows).toHaveBeenCalledTimes(1);
      expect(mockSheetWriter.appendExpenseRow).not.toHaveBeenCalled();

      // The call receives a single-row payload (one row per category)
      const call = (mockSheetWriter.appendExpenseRows as ReturnType<typeof mock>).mock.calls[0];
      if (!call) throw new Error('Expected batch sheet call');
      const rows = call[2] as unknown[];
      expect(rows).toHaveLength(1);

      // One expense, 70 × 100 = 7000 RSD
      expect(result.expenses).toHaveLength(1);
      const first = result.expenses[0];
      if (!first) throw new Error('no result');
      expect(first.expense.amount).toBe(7000);
      expect(first.expense.category).toBe('Продукты');
      expect(result.categoriesAffected).toEqual(['Продукты']);

      // 70 expense items linked to the expense
      const linkedItems = expenseItems.findByExpenseId(first.expense.id);
      expect(linkedItems).toHaveLength(70);
    });

    it('groups items by category: one sheet row per category, one API call', async () => {
      const { groupId, userId } = seedGroup();

      const result = await recorder.recordReceipt(groupId, userId, {
        date: '2026-04-11',
        items: [
          { name: 'Хлеб', quantity: 1, price: 80, total: 80, currency: 'RSD', category: 'Еда' },
          {
            name: 'Молоко',
            quantity: 2,
            price: 100,
            total: 200,
            currency: 'RSD',
            category: 'Еда',
          },
          { name: 'Мыло', quantity: 1, price: 150, total: 150, currency: 'RSD', category: 'Дом' },
        ],
      });

      expect(result.expenses).toHaveLength(2);
      expect(result.categoriesAffected).toEqual(['Еда', 'Дом']);

      // ONE batched call with 2 rows
      expect(mockSheetWriter.appendExpenseRows).toHaveBeenCalledTimes(1);
      const call = (mockSheetWriter.appendExpenseRows as ReturnType<typeof mock>).mock.calls[0];
      if (!call) throw new Error('no call');
      const rows = call[2] as { category: string; comment: string }[];
      expect(rows).toHaveLength(2);
      expect(rows[0]?.category).toBe('Еда');
      expect(rows[0]?.comment).toContain('Хлеб');
      expect(rows[0]?.comment).toContain('Молоко');
      expect(rows[1]?.category).toBe('Дом');

      // DB: 2 expenses, each with linked items
      const food = result.expenses.find((r) => r.expense.category === 'Еда');
      if (!food) throw new Error('no food');
      expect(food.expense.amount).toBe(280); // 80 + 200
      const foodItems = expenseItems.findByExpenseId(food.expense.id);
      expect(foodItems).toHaveLength(2);
    });

    it('uses the receipt date, not today', async () => {
      const { groupId, userId } = seedGroup();
      const receiptDate = '2025-01-15'; // definitely not today

      const result = await recorder.recordReceipt(groupId, userId, {
        date: receiptDate,
        items: [{ name: 'X', quantity: 1, price: 10, total: 10, currency: 'EUR', category: 'A' }],
      });

      // Sheet row uses receipt date
      const call = (mockSheetWriter.appendExpenseRows as ReturnType<typeof mock>).mock.calls[0];
      if (!call) throw new Error('no call');
      const rows = call[2] as { date: string }[];
      expect(rows[0]?.date).toBe(receiptDate);

      // DB row uses receipt date
      expect(result.expenses[0]?.expense.date).toBe(receiptDate);
    });

    it('links expenses to receiptId (bot flow)', async () => {
      const { groupId, userId } = seedGroup();

      // Seed a receipt row so the FK is satisfied
      const seeded = db
        .query<{ id: number }, [number, number, string, string]>(
          `INSERT INTO receipts (group_id, total_amount, currency, date) VALUES (?, ?, ?, ?) RETURNING id`,
        )
        .get(groupId, 30, 'EUR', '2026-04-11');
      if (!seeded) throw new Error('failed to seed receipt');
      const receiptId = seeded.id;

      const result = await recorder.recordReceipt(groupId, userId, {
        date: '2026-04-11',
        receiptId,
        items: [
          { name: 'X', quantity: 1, price: 10, total: 10, currency: 'EUR', category: 'A' },
          { name: 'Y', quantity: 1, price: 20, total: 20, currency: 'EUR', category: 'B' },
        ],
      });

      for (const r of result.expenses) {
        expect(r.expense.receipt_id).toBe(receiptId);
        expect(r.expense.receipt_file_id).toBeNull();
      }
    });

    it('links expenses to receiptFileId (Mini App flow)', async () => {
      const { groupId, userId } = seedGroup();

      const result = await recorder.recordReceipt(groupId, userId, {
        date: '2026-04-11',
        receiptFileId: 'BAADBAAD_telegram_file_id',
        items: [{ name: 'X', quantity: 1, price: 10, total: 10, currency: 'EUR', category: 'A' }],
      });

      const exp = result.expenses[0]?.expense;
      if (!exp) throw new Error('no expense');
      expect(exp.receipt_file_id).toBe('BAADBAAD_telegram_file_id');
      expect(exp.receipt_id).toBeNull();
    });

    it('saves to DB only when Google is not connected', async () => {
      const { groupId, userId } = seedGroupWithoutGoogle();

      const result = await recorder.recordReceipt(groupId, userId, {
        date: '2026-04-11',
        items: [
          { name: 'Хлеб', quantity: 1, price: 80, total: 80, currency: 'RSD', category: 'Еда' },
          { name: 'Мыло', quantity: 1, price: 150, total: 150, currency: 'RSD', category: 'Дом' },
        ],
      });

      expect(mockSheetWriter.appendExpenseRows).not.toHaveBeenCalled();
      expect(mockSheetWriter.appendExpenseRow).not.toHaveBeenCalled();

      expect(result.expenses).toHaveLength(2);
      const all = expenses.findByGroupId(groupId);
      expect(all).toHaveLength(2);
    });

    it('does NOT create DB expenses if sheet write fails', async () => {
      const { groupId, userId } = seedGroup();
      (mockSheetWriter.appendExpenseRows as ReturnType<typeof mock>).mockImplementation(() => {
        throw new Error('429 quota exceeded');
      });

      await expect(
        recorder.recordReceipt(groupId, userId, {
          date: '2026-04-11',
          items: [
            { name: 'X', quantity: 1, price: 10, total: 10, currency: 'EUR', category: 'A' },
            { name: 'Y', quantity: 1, price: 20, total: 20, currency: 'EUR', category: 'B' },
          ],
        }),
      ).rejects.toThrow('429 quota exceeded');

      // No partial state in DB
      const all = expenses.findByGroupId(groupId);
      expect(all).toHaveLength(0);
    });

    it('preserves duplicate items as separate expense_items', async () => {
      const { groupId, userId } = seedGroup();

      const result = await recorder.recordReceipt(groupId, userId, {
        date: '2026-04-11',
        items: [
          {
            name: 'Куриное бедро',
            quantity: 1,
            price: 279.99,
            total: 279.99,
            currency: 'RSD',
            category: 'Продукты',
          },
          {
            name: 'Куриное бедро',
            quantity: 1,
            price: 279.99,
            total: 279.99,
            currency: 'RSD',
            category: 'Продукты',
          },
          {
            name: 'Куриное бедро',
            quantity: 1,
            price: 279.99,
            total: 279.99,
            currency: 'RSD',
            category: 'Продукты',
          },
        ],
      });

      expect(result.expenses).toHaveLength(1);
      const exp = result.expenses[0];
      if (!exp) throw new Error('no exp');
      expect(exp.expense.amount).toBeCloseTo(839.97, 2);

      const items = expenseItems.findByExpenseId(exp.expense.id);
      expect(items).toHaveLength(3);
    });

    it('returns empty result for empty input', async () => {
      const { groupId, userId } = seedGroup();
      const result = await recorder.recordReceipt(groupId, userId, {
        date: '2026-04-11',
        items: [],
      });
      expect(result.expenses).toHaveLength(0);
      expect(result.categoriesAffected).toEqual([]);
      expect(mockSheetWriter.appendExpenseRows).not.toHaveBeenCalled();
    });

    it('throws if group not found', async () => {
      await expect(
        recorder.recordReceipt(999, 1, {
          date: '2026-04-11',
          items: [
            { name: 'X', quantity: 1, price: 10, total: 10, currency: 'EUR', category: 'Test' },
          ],
        }),
      ).rejects.toThrow('not found');
    });
  });

  describe('pushToSheet()', () => {
    it('writes existing DB expenses to sheet without creating new DB entries', async () => {
      const { groupId, userId } = seedGroup();

      // Pre-create expenses in DB (simulating push scenario)
      const e1 = expenses.create({
        group_id: groupId,
        user_id: userId,
        date: '2026-03-20',
        category: 'Еда',
        comment: 'Pizza',
        amount: 1000,
        currency: 'RSD',
        eur_amount: 8.5,
      });
      const e2 = expenses.create({
        group_id: groupId,
        user_id: userId,
        date: '2026-03-21',
        category: 'Транспорт',
        comment: 'Taxi',
        amount: 50,
        currency: 'USD',
        eur_amount: 43,
      });

      await recorder.pushToSheet(groupId, [e1, e2]);

      // Sheet write called 2 times
      expect(mockSheetWriter.appendExpenseRow).toHaveBeenCalledTimes(2);

      // Uses eurAmount from expense, NOT recalculated
      const call1 = (mockSheetWriter.appendExpenseRow as ReturnType<typeof mock>).mock.calls[0];
      if (!call1) throw new Error('Expected sheet write call');
      expect(call1[2].eurAmount).toBe(8.5); // From DB, not recalculated

      // DB count unchanged (still 2)
      const all = expenses.findByGroupId(groupId);
      expect(all).toHaveLength(2);
    });

    it('throws when no Google connection (refreshToken null)', async () => {
      const { groupId } = seedGroupWithoutGoogle();

      await expect(recorder.pushToSheet(groupId, [])).rejects.toThrow(
        'not connected to Google Sheets',
      );
    });

    it('throws when spreadsheetId is null', async () => {
      const group = groups.create({ telegram_group_id: -100777 });
      groups.update(-100777, { google_refresh_token: 'token-only' });

      await expect(recorder.pushToSheet(group.id, [])).rejects.toThrow(
        'not connected to Google Sheets',
      );
    });

    it('throws if group not found', async () => {
      await expect(recorder.pushToSheet(999, [])).rejects.toThrow('not found');
    });
  });
});
