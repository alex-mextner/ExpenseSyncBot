// Tests for BudgetRepository — setBudget upsert, filters, progress, cascade

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { BudgetRepository } from './budget.repository';
import { GroupRepository } from './group.repository';

let db: Database;
let budgetRepo: BudgetRepository;
let groupRepo: GroupRepository;
let groupId: number;

beforeAll(() => {
  db = createTestDb();
  budgetRepo = new BudgetRepository(db);
  groupRepo = new GroupRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  groupId = group.id;
});

describe('BudgetRepository', () => {
  describe('setBudget (upsert)', () => {
    test('creates new budget when none exists', () => {
      const budget = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 500,
      });
      expect(budget.id).toBeGreaterThan(0);
      expect(budget.category).toBe('Food');
      expect(budget.month).toBe('2024-01');
      expect(budget.limit_amount).toBe(500);
    });

    test('defaults currency to EUR', () => {
      const budget = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Rent',
        month: '2024-01',
        limit_amount: 1000,
      });
      expect(budget.currency).toBe('EUR');
    });

    test('respects custom currency', () => {
      const budget = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Groceries',
        month: '2024-01',
        limit_amount: 300,
        currency: 'USD',
      });
      expect(budget.currency).toBe('USD');
    });

    test('updates existing budget (same group+category+month)', () => {
      const first = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      const updated = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 600,
      });
      expect(updated.id).toBe(first.id);
      expect(updated.limit_amount).toBe(600);
    });

    test('updates currency on existing budget', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      const updated = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
        currency: 'USD',
      });
      expect(updated.currency).toBe('USD');
    });

    test('different months are separate budgets', () => {
      const b1 = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      const b2 = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-02',
        limit_amount: 350,
      });
      expect(b1.id).not.toBe(b2.id);
    });

    test('different categories are separate budgets', () => {
      const b1 = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      const b2 = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Rent',
        month: '2024-01',
        limit_amount: 1000,
      });
      expect(b1.id).not.toBe(b2.id);
    });
  });

  describe('findById', () => {
    test('returns budget for existing id', () => {
      const created = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      const found = budgetRepo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    test('returns null for non-existent id', () => {
      expect(budgetRepo.findById(999999)).toBeNull();
    });
  });

  describe('findByGroupCategoryMonth', () => {
    test('finds exact match', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      const found = budgetRepo.findByGroupCategoryMonth(groupId, 'Food', '2024-01');
      expect(found).not.toBeNull();
      expect(found?.category).toBe('Food');
      expect(found?.month).toBe('2024-01');
    });

    test('returns null for non-existent combination', () => {
      expect(budgetRepo.findByGroupCategoryMonth(groupId, 'Food', '2024-01')).toBeNull();
    });

    test('scoped to group', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 1 });
      budgetRepo.setBudget({
        group_id: group2.id,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      expect(budgetRepo.findByGroupCategoryMonth(groupId, 'Food', '2024-01')).toBeNull();
    });
  });

  describe('getBudgetForMonth', () => {
    test('returns exact month match', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      const budget = budgetRepo.getBudgetForMonth(groupId, 'Food', '2024-01');
      expect(budget).not.toBeNull();
      expect(budget?.month).toBe('2024-01');
    });

    test('falls back to latest when exact month not found', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      const budget = budgetRepo.getBudgetForMonth(groupId, 'Food', '2024-03');
      expect(budget).not.toBeNull();
      expect(budget?.month).toBe('2024-01');
    });

    test('returns null when no budget exists for category', () => {
      expect(budgetRepo.getBudgetForMonth(groupId, 'NoCategory', '2024-01')).toBeNull();
    });
  });

  describe('getLatestBudget', () => {
    test('returns most recent budget by month', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-03',
        limit_amount: 350,
      });
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-02',
        limit_amount: 320,
      });

      const latest = budgetRepo.getLatestBudget(groupId, 'Food');
      expect(latest).not.toBeNull();
      expect(latest?.month).toBe('2024-03');
    });

    test('returns null for non-existent category', () => {
      expect(budgetRepo.getLatestBudget(groupId, 'NoSuch')).toBeNull();
    });
  });

  describe('findByGroupId', () => {
    test('returns all budgets for group ordered month desc, category asc', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Rent',
        month: '2024-01',
        limit_amount: 1000,
      });
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-02',
        limit_amount: 300,
      });
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 250,
      });

      const budgets = budgetRepo.findByGroupId(groupId);
      expect(budgets).toHaveLength(3);
      // First should be 2024-02
      expect(budgets[0]?.month).toBe('2024-02');
    });

    test('returns empty array for group with no budgets', () => {
      expect(budgetRepo.findByGroupId(groupId)).toEqual([]);
    });

    test('does not include budgets from other groups', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 2 });
      budgetRepo.setBudget({
        group_id: group2.id,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      expect(budgetRepo.findByGroupId(groupId)).toEqual([]);
    });
  });

  describe('getAllBudgetsForMonth', () => {
    test('returns budgets for all categories for specified month', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Rent',
        month: '2024-01',
        limit_amount: 1000,
      });

      const budgets = budgetRepo.getAllBudgetsForMonth(groupId, '2024-01');
      expect(budgets).toHaveLength(2);
    });

    test('uses fallback when month not available', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      // No budget for 2024-03, should fall back to 2024-01
      const budgets = budgetRepo.getAllBudgetsForMonth(groupId, '2024-03');
      expect(budgets).toHaveLength(1);
      expect(budgets[0]?.category).toBe('Food');
    });

    test('returns empty array for group with no budgets', () => {
      expect(budgetRepo.getAllBudgetsForMonth(groupId, '2024-01')).toEqual([]);
    });
  });

  describe('delete', () => {
    test('removes budget from database', () => {
      const budget = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      budgetRepo.delete(budget.id);
      expect(budgetRepo.findById(budget.id)).toBeNull();
    });

    test('returns true', () => {
      const budget = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      expect(budgetRepo.delete(budget.id)).toBe(true);
    });
  });

  describe('deleteByGroupCategoryMonth', () => {
    test('deletes matching budget', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      budgetRepo.deleteByGroupCategoryMonth(groupId, 'Food', '2024-01');
      expect(budgetRepo.findByGroupCategoryMonth(groupId, 'Food', '2024-01')).toBeNull();
    });

    test('returns true even if no row found', () => {
      expect(budgetRepo.deleteByGroupCategoryMonth(groupId, 'NoCategory', '2024-01')).toBe(true);
    });
  });

  describe('update', () => {
    test('updates limit_amount', () => {
      const budget = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      const updated = budgetRepo.update(budget.id, { limit_amount: 450 });
      expect(updated?.limit_amount).toBe(450);
    });

    test('updates currency', () => {
      const budget = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      const updated = budgetRepo.update(budget.id, { currency: 'USD' });
      expect(updated?.currency).toBe('USD');
    });

    test('returns existing budget when no fields provided', () => {
      const budget = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      const result = budgetRepo.update(budget.id, {});
      expect(result).not.toBeNull();
      expect(result?.id).toBe(budget.id);
      expect(result?.limit_amount).toBe(300);
    });

    test('returns null for non-existent id', () => {
      const result = budgetRepo.update(999999, { limit_amount: 100 });
      expect(result).toBeNull();
    });
  });

  describe('getBudgetProgress', () => {
    test('returns progress with correct percentage', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 200,
      });
      const progress = budgetRepo.getBudgetProgress(groupId, 'Food', '2024-01', 100);

      expect(progress).not.toBeNull();
      expect(progress?.percentage).toBe(50);
      expect(progress?.spent_amount).toBe(100);
      expect(progress?.limit_amount).toBe(200);
      expect(progress?.is_exceeded).toBe(false);
      expect(progress?.is_warning).toBe(false);
    });

    test('is_exceeded true when spent > limit', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 100,
      });
      const progress = budgetRepo.getBudgetProgress(groupId, 'Food', '2024-01', 150);
      expect(progress?.is_exceeded).toBe(true);
      expect(progress?.percentage).toBe(150);
    });

    test('is_warning true at >= 90%', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 100,
      });
      const progress = budgetRepo.getBudgetProgress(groupId, 'Food', '2024-01', 90);
      expect(progress?.is_warning).toBe(true);
      expect(progress?.is_exceeded).toBe(false);
    });

    test('is_warning false at 89%', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 100,
      });
      const progress = budgetRepo.getBudgetProgress(groupId, 'Food', '2024-01', 89);
      expect(progress?.is_warning).toBe(false);
    });

    test('returns null when no budget exists', () => {
      expect(budgetRepo.getBudgetProgress(groupId, 'NoCategory', '2024-01', 50)).toBeNull();
    });

    test('percentage is 0 when limit_amount is 0', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Zero',
        month: '2024-01',
        limit_amount: 0,
      });
      const progress = budgetRepo.getBudgetProgress(groupId, 'Zero', '2024-01', 50);
      expect(progress?.percentage).toBe(0);
    });
  });

  describe('hasBudget', () => {
    test('returns true when budget exists for category', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      expect(budgetRepo.hasBudget(groupId, 'Food')).toBe(true);
    });

    test('returns false when no budget for category', () => {
      expect(budgetRepo.hasBudget(groupId, 'NoCategory')).toBe(false);
    });

    test('scoped to group', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 3 });
      budgetRepo.setBudget({
        group_id: group2.id,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      expect(budgetRepo.hasBudget(groupId, 'Food')).toBe(false);
    });

    test('true even if budget is from an older month', () => {
      budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2023-01',
        limit_amount: 300,
      });
      expect(budgetRepo.hasBudget(groupId, 'Food')).toBe(true);
    });
  });

  describe('foreign key cascade', () => {
    test('budgets deleted when group is deleted', () => {
      const budget = budgetRepo.setBudget({
        group_id: groupId,
        category: 'Food',
        month: '2024-01',
        limit_amount: 300,
      });
      const group = groupRepo.findById(groupId);
      groupRepo.delete(group!.telegram_group_id);
      expect(budgetRepo.findById(budget.id)).toBeNull();
    });
  });
});
