// Tests for sync snapshot repository — verifies save, restore, list, and cleanup

import type { Database as SqliteDb } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { BudgetRepository } from './budget.repository';
import { ExpenseRepository } from './expense.repository';
import { GroupRepository } from './group.repository';
import { SyncSnapshotRepository } from './sync-snapshot.repository';
import { UserRepository } from './user.repository';

let db: SqliteDb;
let snapshots: SyncSnapshotRepository;
let groups: GroupRepository;
let expenses: ExpenseRepository;
let budgets: BudgetRepository;
let users: UserRepository;

beforeAll(() => {
  db = createTestDb();
  snapshots = new SyncSnapshotRepository(db);
  groups = new GroupRepository(db);
  expenses = new ExpenseRepository(db);
  budgets = new BudgetRepository(db);
  users = new UserRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
});

function createGroupWithData() {
  const group = groups.create({ telegram_group_id: -1001234 });
  const user = users.create({ telegram_id: 111, group_id: group.id });

  const e1 = expenses.create({
    group_id: group.id,
    user_id: user.id,
    date: '2026-03-01',
    category: 'Food',
    comment: 'lunch',
    amount: 100,
    currency: 'EUR',
    eur_amount: 100,
  });
  const e2 = expenses.create({
    group_id: group.id,
    user_id: user.id,
    date: '2026-03-02',
    category: 'Transport',
    comment: 'taxi',
    amount: 50,
    currency: 'EUR',
    eur_amount: 50,
  });

  budgets.setBudget({
    group_id: group.id,
    category: 'Food',
    month: '2026-03',
    limit_amount: 500,
    currency: 'EUR',
  });
  budgets.setBudget({
    group_id: group.id,
    category: 'Transport',
    month: '2026-03',
    limit_amount: 200,
    currency: 'EUR',
  });

  return { group, user, expenses: [e1, e2] };
}

describe('saveSnapshot', () => {
  test('saves expenses and budgets atomically', () => {
    const { group } = createGroupWithData();
    const allExpenses = expenses.findByGroupId(group.id, 100);
    const allBudgets = budgets.findByGroupId(group.id);

    const snapshotId = snapshots.saveSnapshot(group.id, allExpenses, allBudgets);

    expect(snapshotId).toBeString();
    expect(snapshotId.length).toBeGreaterThan(0);

    const savedExpenses = snapshots.getExpenseSnapshots(snapshotId);
    expect(savedExpenses).toHaveLength(2);
    expect(savedExpenses[0]?.category).toBe('Food');
    expect(savedExpenses[0]?.amount).toBe(100);
    expect(savedExpenses[1]?.category).toBe('Transport');

    const savedBudgets = snapshots.getBudgetSnapshots(snapshotId);
    expect(savedBudgets).toHaveLength(2);
    const foodBudget = savedBudgets.find((b) => b.category === 'Food');
    const transportBudget = savedBudgets.find((b) => b.category === 'Transport');
    expect(foodBudget?.limit_amount).toBe(500);
    expect(transportBudget?.limit_amount).toBe(200);
  });

  test('returns unique snapshot IDs', () => {
    const { group } = createGroupWithData();
    const allExpenses = expenses.findByGroupId(group.id, 100);
    const allBudgets = budgets.findByGroupId(group.id);

    const id1 = snapshots.saveSnapshot(group.id, allExpenses, allBudgets);
    const id2 = snapshots.saveSnapshot(group.id, allExpenses, allBudgets);

    expect(id1).not.toBe(id2);
  });

  test('handles empty expenses and budgets', () => {
    const group = groups.create({ telegram_group_id: -1001234 });

    const snapshotId = snapshots.saveSnapshot(group.id, [], []);

    expect(snapshotId).toBeString();
    expect(snapshots.getExpenseSnapshots(snapshotId)).toHaveLength(0);
    expect(snapshots.getBudgetSnapshots(snapshotId)).toHaveLength(0);
  });
});

describe('getExpenseSnapshots', () => {
  test('returns empty array for unknown snapshot ID', () => {
    expect(snapshots.getExpenseSnapshots('nonexistent')).toHaveLength(0);
  });

  test('preserves all expense fields', () => {
    const { group } = createGroupWithData();
    const allExpenses = expenses.findByGroupId(group.id, 100);
    const snapshotId = snapshots.saveSnapshot(group.id, allExpenses, []);

    const saved = snapshots.getExpenseSnapshots(snapshotId);
    const first = saved.find((s) => s.category === 'Food');

    expect(first?.group_id).toBe(group.id);
    expect(first?.date).toBe('2026-03-01');
    expect(first?.comment).toBe('lunch');
    expect(first?.amount).toBe(100);
    expect(first?.currency).toBe('EUR');
    expect(first?.eur_amount).toBe(100);
  });
});

describe('listSnapshots', () => {
  test('lists snapshots newest first', () => {
    const { group } = createGroupWithData();
    const allExpenses = expenses.findByGroupId(group.id, 100);
    const allBudgets = budgets.findByGroupId(group.id);

    const id1 = snapshots.saveSnapshot(group.id, allExpenses, allBudgets);
    const id2 = snapshots.saveSnapshot(group.id, allExpenses, []);

    const list = snapshots.listSnapshots(group.id);
    expect(list).toHaveLength(2);
    const snapshotIds = list.map((s) => s.snapshotId);
    expect(snapshotIds).toContain(id1);
    expect(snapshotIds).toContain(id2);
    const first = list.find((s) => s.snapshotId === id1);
    const second = list.find((s) => s.snapshotId === id2);
    expect(first?.expenseCount).toBe(2);
    expect(first?.budgetCount).toBe(2);
    expect(second?.expenseCount).toBe(2);
    expect(second?.budgetCount).toBe(0);
  });

  test('returns empty for group with no snapshots', () => {
    expect(snapshots.listSnapshots(9999)).toHaveLength(0);
  });
});

describe('cleanOldSnapshots', () => {
  test('does not delete recent snapshots', () => {
    const { group } = createGroupWithData();
    const allExpenses = expenses.findByGroupId(group.id, 100);
    const snapshotId = snapshots.saveSnapshot(group.id, allExpenses, []);

    const deleted = snapshots.cleanOldSnapshots(30);
    expect(deleted).toBe(0);

    expect(snapshots.getExpenseSnapshots(snapshotId)).toHaveLength(2);
  });
});
