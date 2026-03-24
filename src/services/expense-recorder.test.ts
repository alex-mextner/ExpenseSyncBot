// Tests for ExpenseRecorder — single entry point for writing expenses to sheet + DB

import type { Database } from 'bun:sqlite';
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { CurrencyCode } from '../config/constants';
import { ExpenseRepository } from '../database/repositories/expense.repository';
// CategoryRepository not needed — recorder doesn't manage categories
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
    });
  });

  afterEach(() => {
    clearTestDb(db);
    db.close();
  });

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

  describe('record()', () => {
    it('writes expense to sheet and DB, returns expense with eurAmount', async () => {
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
      expect(sheetCall[0]).toBe('token-abc');
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

    it('throws if group has no spreadsheet', async () => {
      const group = groups.create({ telegram_group_id: -100999 });
      const user = users.create({ telegram_id: 222, group_id: group.id });

      await expect(
        recorder.record(group.id, user.id, {
          date: '2026-03-24',
          category: 'Test',
          comment: '',
          amount: 100,
          currency: 'EUR',
        }),
      ).rejects.toThrow('not configured');
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

  describe('recordBatch()', () => {
    it('groups items by category and creates one expense per category', async () => {
      const { groupId, userId } = seedGroup();

      const results = await recorder.recordBatch(groupId, userId, [
        { name: 'Хлеб', quantity: 1, price: 80, total: 80, currency: 'RSD', category: 'Еда' },
        { name: 'Молоко', quantity: 2, price: 100, total: 200, currency: 'RSD', category: 'Еда' },
        { name: 'Мыло', quantity: 1, price: 150, total: 150, currency: 'RSD', category: 'Дом' },
      ]);

      expect(results).toHaveLength(2); // 2 categories: Еда, Дом

      // Еда: 80 + 200 = 280 RSD
      const food = results.find((r) => r.expense.category === 'Еда');
      if (!food) throw new Error('Expected Еда result');
      expect(food.expense.amount).toBe(280);
      expect(food.expense.comment).toContain('Хлеб');
      expect(food.expense.comment).toContain('Молоко');

      // Дом: 150 RSD
      const home = results.find((r) => r.expense.category === 'Дом');
      if (!home) throw new Error('Expected Дом result');
      expect(home.expense.amount).toBe(150);

      // Sheet writes: 2 calls
      expect(mockSheetWriter.appendExpenseRow).toHaveBeenCalledTimes(2);

      // DB: 2 expenses
      const all = expenses.findByGroupId(groupId);
      expect(all).toHaveLength(2);
    });

    it('creates expense items linked to expenses', async () => {
      const { groupId, userId } = seedGroup();

      const results = await recorder.recordBatch(groupId, userId, [
        { name: 'Хлеб', quantity: 1, price: 80, total: 80, currency: 'RSD', category: 'Еда' },
        { name: 'Молоко', quantity: 2, price: 100, total: 200, currency: 'RSD', category: 'Еда' },
      ]);

      const firstResult = results[0];
      if (!firstResult) throw new Error('Expected at least one result');
      const items = expenseItems.findByExpenseId(firstResult.expense.id);
      expect(items).toHaveLength(2);
      expect(items[0]?.name_ru).toBe('Хлеб');
      expect(items[1]?.name_ru).toBe('Молоко');
    });

    it('returns empty array for empty input', async () => {
      const { groupId, userId } = seedGroup();
      const results = await recorder.recordBatch(groupId, userId, []);
      expect(results).toHaveLength(0);
      expect(mockSheetWriter.appendExpenseRow).not.toHaveBeenCalled();
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

    it('throws if group not configured', async () => {
      const group = groups.create({ telegram_group_id: -100777 });

      await expect(recorder.pushToSheet(group.id, [])).rejects.toThrow('not configured');
    });
  });
});
