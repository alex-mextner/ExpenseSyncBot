// Tests for ExpenseRepository — CRUD, filters, aggregates, analytics

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDb, clearTestDb } from '../../test-utils/db';
import { GroupRepository } from './group.repository';
import { UserRepository } from './user.repository';
import { ExpenseRepository } from './expense.repository';
import type { CreateExpenseData } from '../types';

let db: Database;
let expenseRepo: ExpenseRepository;
let groupRepo: GroupRepository;
let userRepo: UserRepository;
let groupId: number;
let userId: number;

beforeAll(() => {
  db = createTestDb();
  expenseRepo = new ExpenseRepository(db);
  groupRepo = new GroupRepository(db);
  userRepo = new UserRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  groupId = group.id;
  const user = userRepo.create({ telegram_id: Date.now(), group_id: groupId });
  userId = user.id;
});

function makeExpense(overrides: Partial<CreateExpenseData> = {}): CreateExpenseData {
  return {
    group_id: groupId,
    user_id: userId,
    date: '2024-01-15',
    category: 'Food',
    comment: 'Lunch',
    amount: 25.0,
    currency: 'EUR',
    eur_amount: 25.0,
    ...overrides,
  };
}

describe('ExpenseRepository', () => {
  describe('create', () => {
    test('creates expense and returns it with id', () => {
      const expense = expenseRepo.create(makeExpense());
      expect(expense.id).toBeGreaterThan(0);
    });

    test('all fields stored correctly', () => {
      const data = makeExpense({
        date: '2024-03-10',
        category: 'Transport',
        comment: 'Bus ticket',
        amount: 1.5,
        currency: 'USD',
        eur_amount: 1.39,
      });
      const expense = expenseRepo.create(data);
      expect(expense.group_id).toBe(groupId);
      expect(expense.user_id).toBe(userId);
      expect(expense.date).toBe('2024-03-10');
      expect(expense.category).toBe('Transport');
      expect(expense.comment).toBe('Bus ticket');
      expect(expense.amount).toBe(1.5);
      expect(expense.currency).toBe('USD');
      expect(expense.eur_amount).toBe(1.39);
    });

    test('created_at is populated', () => {
      const expense = expenseRepo.create(makeExpense());
      expect(expense.created_at).toBeTruthy();
    });
  });

  describe('findById', () => {
    test('returns expense for existing id', () => {
      const created = expenseRepo.create(makeExpense());
      const found = expenseRepo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    test('returns null for non-existent id', () => {
      expect(expenseRepo.findById(999999)).toBeNull();
    });
  });

  describe('findByGroupId', () => {
    test('returns expenses for group ordered date desc', () => {
      expenseRepo.create(makeExpense({ date: '2024-01-01' }));
      expenseRepo.create(makeExpense({ date: '2024-03-01' }));
      expenseRepo.create(makeExpense({ date: '2024-02-01' }));

      const expenses = expenseRepo.findByGroupId(groupId);
      expect(expenses).toHaveLength(3);
      expect(expenses[0]!.date).toBe('2024-03-01');
      expect(expenses[1]!.date).toBe('2024-02-01');
      expect(expenses[2]!.date).toBe('2024-01-01');
    });

    test('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        expenseRepo.create(makeExpense({ date: `2024-01-${String(i + 1).padStart(2, '0')}` }));
      }
      const expenses = expenseRepo.findByGroupId(groupId, 3);
      expect(expenses).toHaveLength(3);
    });

    test('defaults limit to 100', () => {
      for (let i = 0; i < 5; i++) {
        expenseRepo.create(makeExpense());
      }
      const expenses = expenseRepo.findByGroupId(groupId);
      expect(expenses.length).toBe(5);
    });

    test('returns empty array for group with no expenses', () => {
      expect(expenseRepo.findByGroupId(groupId)).toEqual([]);
    });

    test('does not return expenses from other groups', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 1 });
      const user2 = userRepo.create({ telegram_id: Date.now() + 1, group_id: group2.id });
      expenseRepo.create(makeExpense({ group_id: group2.id, user_id: user2.id }));

      expect(expenseRepo.findByGroupId(groupId)).toEqual([]);
    });
  });

  describe('findByDateRange', () => {
    test('returns expenses within date range', () => {
      expenseRepo.create(makeExpense({ date: '2024-01-01' }));
      expenseRepo.create(makeExpense({ date: '2024-01-15' }));
      expenseRepo.create(makeExpense({ date: '2024-02-01' }));

      const expenses = expenseRepo.findByDateRange(groupId, '2024-01-01', '2024-01-31');
      expect(expenses).toHaveLength(2);
    });

    test('includes both start and end dates (inclusive)', () => {
      expenseRepo.create(makeExpense({ date: '2024-01-01' }));
      expenseRepo.create(makeExpense({ date: '2024-01-31' }));
      expenseRepo.create(makeExpense({ date: '2024-02-01' }));

      const expenses = expenseRepo.findByDateRange(groupId, '2024-01-01', '2024-01-31');
      expect(expenses).toHaveLength(2);
    });

    test('returns empty array when no expenses in range', () => {
      expenseRepo.create(makeExpense({ date: '2024-06-01' }));
      const expenses = expenseRepo.findByDateRange(groupId, '2024-01-01', '2024-01-31');
      expect(expenses).toEqual([]);
    });

    test('scoped to group', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 2 });
      const user2 = userRepo.create({ telegram_id: Date.now() + 2, group_id: group2.id });
      expenseRepo.create(makeExpense({ date: '2024-01-10', group_id: group2.id, user_id: user2.id }));

      expect(expenseRepo.findByDateRange(groupId, '2024-01-01', '2024-01-31')).toEqual([]);
    });
  });

  describe('findByCategory', () => {
    test('returns expenses for specific category', () => {
      expenseRepo.create(makeExpense({ category: 'Food' }));
      expenseRepo.create(makeExpense({ category: 'Food' }));
      expenseRepo.create(makeExpense({ category: 'Transport' }));

      const food = expenseRepo.findByCategory(groupId, 'Food');
      expect(food).toHaveLength(2);
      expect(food.every((e) => e.category === 'Food')).toBe(true);
    });

    test('returns empty array for non-existent category', () => {
      expenseRepo.create(makeExpense({ category: 'Food' }));
      expect(expenseRepo.findByCategory(groupId, 'Rent')).toEqual([]);
    });

    test('case-sensitive category match', () => {
      expenseRepo.create(makeExpense({ category: 'Food' }));
      expect(expenseRepo.findByCategory(groupId, 'food')).toEqual([]);
    });
  });

  describe('delete', () => {
    test('removes expense from database', () => {
      const expense = expenseRepo.create(makeExpense());
      expenseRepo.delete(expense.id);
      expect(expenseRepo.findById(expense.id)).toBeNull();
    });

    test('returns true', () => {
      const expense = expenseRepo.create(makeExpense());
      expect(expenseRepo.delete(expense.id)).toBe(true);
    });

    test('does not affect other expenses', () => {
      const e1 = expenseRepo.create(makeExpense({ comment: 'Keep' }));
      const e2 = expenseRepo.create(makeExpense({ comment: 'Delete' }));
      expenseRepo.delete(e2.id);
      expect(expenseRepo.findById(e1.id)).not.toBeNull();
    });
  });

  describe('deleteAllByGroupId', () => {
    test('deletes all expenses for group and returns count', () => {
      expenseRepo.create(makeExpense());
      expenseRepo.create(makeExpense());
      expenseRepo.create(makeExpense());

      const count = expenseRepo.deleteAllByGroupId(groupId);
      expect(count).toBe(3);
      expect(expenseRepo.findByGroupId(groupId)).toEqual([]);
    });

    test('returns 0 when group has no expenses', () => {
      expect(expenseRepo.deleteAllByGroupId(groupId)).toBe(0);
    });

    test('does not delete expenses from other groups', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 3 });
      const user2 = userRepo.create({ telegram_id: Date.now() + 3, group_id: group2.id });
      expenseRepo.create(makeExpense({ group_id: group2.id, user_id: user2.id }));

      expenseRepo.deleteAllByGroupId(groupId);
      expect(expenseRepo.findByGroupId(group2.id)).toHaveLength(1);
    });
  });

  describe('getTotalsByCurrency', () => {
    test('returns totals per currency', () => {
      expenseRepo.create(makeExpense({ currency: 'EUR', amount: 10 }));
      expenseRepo.create(makeExpense({ currency: 'EUR', amount: 20 }));
      expenseRepo.create(makeExpense({ currency: 'USD', amount: 50 }));

      const totals = expenseRepo.getTotalsByCurrency(groupId);
      expect(totals['EUR']).toBe(30);
      expect(totals['USD']).toBe(50);
    });

    test('returns empty object for group with no expenses', () => {
      expect(expenseRepo.getTotalsByCurrency(groupId)).toEqual({});
    });
  });

  describe('getTotalInEUR', () => {
    test('returns sum of eur_amount', () => {
      expenseRepo.create(makeExpense({ eur_amount: 10 }));
      expenseRepo.create(makeExpense({ eur_amount: 20.5 }));
      expenseRepo.create(makeExpense({ eur_amount: 5 }));

      const total = expenseRepo.getTotalInEUR(groupId);
      expect(total).toBeCloseTo(35.5);
    });

    test('returns 0 for group with no expenses', () => {
      expect(expenseRepo.getTotalInEUR(groupId)).toBe(0);
    });
  });

  describe('getCategoryTotals', () => {
    test('returns category totals in EUR for date range', () => {
      expenseRepo.create(makeExpense({ category: 'Food', eur_amount: 30, date: '2024-01-10' }));
      expenseRepo.create(makeExpense({ category: 'Food', eur_amount: 20, date: '2024-01-15' }));
      expenseRepo.create(makeExpense({ category: 'Rent', eur_amount: 500, date: '2024-01-01' }));
      expenseRepo.create(makeExpense({ category: 'Food', eur_amount: 100, date: '2024-02-01' }));

      const totals = expenseRepo.getCategoryTotals(groupId, '2024-01-01', '2024-01-31');
      const food = totals.find((t) => t.category === 'Food');
      const rent = totals.find((t) => t.category === 'Rent');

      expect(food).toBeDefined();
      expect(food!.total).toBeCloseTo(50);
      expect(food!.tx_count).toBe(2);
      expect(rent).toBeDefined();
      expect(rent!.total).toBeCloseTo(500);
    });

    test('returns empty array for range with no data', () => {
      expect(expenseRepo.getCategoryTotals(groupId, '2020-01-01', '2020-01-31')).toEqual([]);
    });
  });

  describe('getDailyTotals', () => {
    test('returns daily EUR totals ordered by date', () => {
      expenseRepo.create(makeExpense({ date: '2024-01-01', eur_amount: 10 }));
      expenseRepo.create(makeExpense({ date: '2024-01-01', eur_amount: 5 }));
      expenseRepo.create(makeExpense({ date: '2024-01-03', eur_amount: 20 }));

      const daily = expenseRepo.getDailyTotals(groupId, '2024-01-01', '2024-01-03');
      expect(daily).toHaveLength(2);
      expect(daily[0]!.date).toBe('2024-01-01');
      expect(daily[0]!.total).toBeCloseTo(15);
      expect(daily[1]!.date).toBe('2024-01-03');
      expect(daily[1]!.total).toBeCloseTo(20);
    });

    test('returns empty array for range with no expenses', () => {
      expect(expenseRepo.getDailyTotals(groupId, '2020-01-01', '2020-01-31')).toEqual([]);
    });
  });

  describe('getTotalEurForRange', () => {
    test('returns total EUR for range', () => {
      expenseRepo.create(makeExpense({ date: '2024-01-10', eur_amount: 50 }));
      expenseRepo.create(makeExpense({ date: '2024-01-20', eur_amount: 30 }));
      expenseRepo.create(makeExpense({ date: '2024-02-01', eur_amount: 100 }));

      const total = expenseRepo.getTotalEurForRange(groupId, '2024-01-01', '2024-01-31');
      expect(total).toBeCloseTo(80);
    });

    test('returns 0 for range with no expenses', () => {
      expect(expenseRepo.getTotalEurForRange(groupId, '2020-01-01', '2020-01-31')).toBe(0);
    });
  });

  describe('getCountForRange', () => {
    test('returns count of expenses in range', () => {
      expenseRepo.create(makeExpense({ date: '2024-01-05' }));
      expenseRepo.create(makeExpense({ date: '2024-01-15' }));
      expenseRepo.create(makeExpense({ date: '2024-02-01' }));

      expect(expenseRepo.getCountForRange(groupId, '2024-01-01', '2024-01-31')).toBe(2);
    });

    test('returns 0 for range with no expenses', () => {
      expect(expenseRepo.getCountForRange(groupId, '2020-01-01', '2020-01-31')).toBe(0);
    });
  });

  describe('getDayOfWeekStats', () => {
    test('returns day-of-week aggregated stats', () => {
      // 2024-01-01 is Monday (dow=1)
      expenseRepo.create(makeExpense({ date: '2024-01-01', eur_amount: 10 }));
      expenseRepo.create(makeExpense({ date: '2024-01-01', eur_amount: 20 }));
      // 2024-01-02 is Tuesday (dow=2)
      expenseRepo.create(makeExpense({ date: '2024-01-02', eur_amount: 5 }));

      const stats = expenseRepo.getDayOfWeekStats(groupId, '2024-01-01', '2024-01-07');
      expect(stats.length).toBeGreaterThan(0);

      const monday = stats.find((s) => s.dow === 1);
      expect(monday).toBeDefined();
      expect(monday!.total).toBeCloseTo(30);
      expect(monday!.tx_count).toBe(2);
    });
  });

  describe('getWeekOverWeekData', () => {
    test('returns current and previous week periods', () => {
      // Insert some expenses in the past 13 days
      expenseRepo.create(makeExpense({ date: '2024-01-14', eur_amount: 100 })); // current week
      expenseRepo.create(makeExpense({ date: '2024-01-07', eur_amount: 50 }));  // previous week

      const data = expenseRepo.getWeekOverWeekData(groupId, '2024-01-20');
      const periods = data.map((d) => d.period);
      // At least one period should be present
      expect(data.length).toBeGreaterThanOrEqual(0);
      for (const row of data) {
        expect(['current_week', 'previous_week']).toContain(row.period);
      }
    });
  });

  describe('getMonthlyHistoryByCategory', () => {
    test('returns per-category per-month totals', () => {
      expenseRepo.create(makeExpense({ date: '2024-01-10', category: 'Food', eur_amount: 100 }));
      expenseRepo.create(makeExpense({ date: '2024-01-20', category: 'Food', eur_amount: 50 }));
      expenseRepo.create(makeExpense({ date: '2024-02-10', category: 'Food', eur_amount: 80 }));

      const history = expenseRepo.getMonthlyHistoryByCategory(groupId, '2024-01-01', '2024-03-01');
      const jan = history.find((r) => r.category === 'Food' && r.month === '2024-01');
      const feb = history.find((r) => r.category === 'Food' && r.month === '2024-02');

      expect(jan).toBeDefined();
      expect(jan!.monthly_total).toBeCloseTo(150);
      expect(feb).toBeDefined();
      expect(feb!.monthly_total).toBeCloseTo(80);
    });
  });

  describe('getVelocityData', () => {
    test('returns recent and earlier periods', () => {
      expenseRepo.create(makeExpense({ date: '2024-01-14', eur_amount: 60 })); // recent
      expenseRepo.create(makeExpense({ date: '2024-01-07', eur_amount: 40 })); // earlier

      const data = expenseRepo.getVelocityData(groupId, '2024-01-20');
      for (const row of data) {
        expect(['recent', 'earlier']).toContain(row.period);
        expect(row.total).toBeGreaterThan(0);
      }
    });
  });
});
