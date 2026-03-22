// Tests for ExpenseItemsRepository — CRUD, bulk create, cascade delete

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import type { CreateExpenseItemData } from '../types';
import { ExpenseRepository } from './expense.repository';
import { ExpenseItemsRepository } from './expense-items.repository';
import { GroupRepository } from './group.repository';
import { UserRepository } from './user.repository';

let db: Database;
let itemsRepo: ExpenseItemsRepository;
let expenseRepo: ExpenseRepository;
let groupRepo: GroupRepository;
let userRepo: UserRepository;
let expenseId: number;

beforeAll(() => {
  db = createTestDb();
  itemsRepo = new ExpenseItemsRepository(db);
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
  const user = userRepo.create({ telegram_id: Date.now(), group_id: group.id });
  const expense = expenseRepo.create({
    group_id: group.id,
    user_id: user.id,
    date: '2024-01-15',
    category: 'Groceries',
    comment: 'Supermarket',
    amount: 50.0,
    currency: 'EUR',
    eur_amount: 50.0,
  });
  expenseId = expense.id;
});

function makeItem(overrides: Partial<CreateExpenseItemData> = {}): CreateExpenseItemData {
  return {
    expense_id: expenseId,
    name_ru: 'Молоко',
    name_original: 'Milk',
    quantity: 1,
    price: 1.5,
    total: 1.5,
    ...overrides,
  };
}

describe('ExpenseItemsRepository', () => {
  describe('create', () => {
    test('creates item and returns it with id', () => {
      const item = itemsRepo.create(makeItem());
      expect(item.id).toBeGreaterThan(0);
    });

    test('all fields stored correctly', () => {
      const item = itemsRepo.create(
        makeItem({
          name_ru: 'Хлеб',
          name_original: 'Bread',
          quantity: 2,
          price: 0.99,
          total: 1.98,
        }),
      );
      expect(item.expense_id).toBe(expenseId);
      expect(item.name_ru).toBe('Хлеб');
      expect(item.name_original).toBe('Bread');
      expect(item.quantity).toBe(2);
      expect(item.price).toBe(0.99);
      expect(item.total).toBe(1.98);
    });

    test('name_original can be null', () => {
      const item = itemsRepo.create(makeItem({ name_original: undefined }));
      expect(item.name_original).toBeNull();
    });

    test('created_at is populated', () => {
      const item = itemsRepo.create(makeItem());
      expect(item.created_at).toBeTruthy();
    });

    test('fractional quantity stored correctly', () => {
      const item = itemsRepo.create(makeItem({ quantity: 0.5, price: 10.0, total: 5.0 }));
      expect(item.quantity).toBe(0.5);
    });
  });

  describe('findById', () => {
    test('returns item for existing id', () => {
      const created = itemsRepo.create(makeItem());
      const found = itemsRepo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    test('returns null for non-existent id', () => {
      expect(itemsRepo.findById(999999)).toBeNull();
    });
  });

  describe('findByExpenseId', () => {
    test('returns all items for an expense ordered by created_at asc', () => {
      itemsRepo.create(makeItem({ name_ru: 'Первый' }));
      itemsRepo.create(makeItem({ name_ru: 'Второй' }));
      itemsRepo.create(makeItem({ name_ru: 'Третий' }));

      const items = itemsRepo.findByExpenseId(expenseId);
      expect(items).toHaveLength(3);
      expect(items[0]?.name_ru).toBe('Первый');
    });

    test('returns empty array for expense with no items', () => {
      expect(itemsRepo.findByExpenseId(expenseId)).toEqual([]);
    });

    test('does not return items from other expenses', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 1 });
      const user2 = userRepo.create({ telegram_id: Date.now() + 1, group_id: group2.id });
      const expense2 = expenseRepo.create({
        group_id: group2.id,
        user_id: user2.id,
        date: '2024-01-15',
        category: 'Food',
        comment: 'Other',
        amount: 10,
        currency: 'EUR',
        eur_amount: 10,
      });

      itemsRepo.create(makeItem({ expense_id: expense2.id, name_ru: 'Чужой' }));
      expect(itemsRepo.findByExpenseId(expenseId)).toEqual([]);
    });
  });

  describe('createMany', () => {
    test('creates multiple items and returns them all', () => {
      const items = [
        makeItem({ name_ru: 'Item A', quantity: 1, price: 5, total: 5 }),
        makeItem({ name_ru: 'Item B', quantity: 2, price: 3, total: 6 }),
        makeItem({ name_ru: 'Item C', quantity: 1, price: 10, total: 10 }),
      ];

      const created = itemsRepo.createMany(items);
      expect(created).toHaveLength(3);
      expect(created[0]?.name_ru).toBe('Item A');
      expect(created[1]?.name_ru).toBe('Item B');
      expect(created[2]?.name_ru).toBe('Item C');
    });

    test('returns empty array for empty input', () => {
      expect(itemsRepo.createMany([])).toEqual([]);
    });

    test('each created item has an id', () => {
      const items = [makeItem(), makeItem()];
      const created = itemsRepo.createMany(items);
      for (const item of created) {
        expect(item.id).toBeGreaterThan(0);
      }
    });

    test('items are stored and retrievable', () => {
      itemsRepo.createMany([makeItem({ name_ru: 'A' }), makeItem({ name_ru: 'B' })]);
      const all = itemsRepo.findByExpenseId(expenseId);
      expect(all).toHaveLength(2);
    });
  });

  describe('delete', () => {
    test('removes item from database', () => {
      const item = itemsRepo.create(makeItem());
      itemsRepo.delete(item.id);
      expect(itemsRepo.findById(item.id)).toBeNull();
    });

    test('returns true', () => {
      const item = itemsRepo.create(makeItem());
      expect(itemsRepo.delete(item.id)).toBe(true);
    });

    test('does not affect other items', () => {
      const item1 = itemsRepo.create(makeItem({ name_ru: 'Keep' }));
      const item2 = itemsRepo.create(makeItem({ name_ru: 'Delete' }));
      itemsRepo.delete(item2.id);
      expect(itemsRepo.findById(item1.id)).not.toBeNull();
    });
  });

  describe('deleteByExpenseId', () => {
    test('deletes all items for expense and returns count', () => {
      itemsRepo.create(makeItem());
      itemsRepo.create(makeItem());
      itemsRepo.create(makeItem());

      const count = itemsRepo.deleteByExpenseId(expenseId);
      expect(count).toBe(3);
      expect(itemsRepo.findByExpenseId(expenseId)).toEqual([]);
    });

    test('returns 0 when expense has no items', () => {
      expect(itemsRepo.deleteByExpenseId(expenseId)).toBe(0);
    });

    test('does not delete items from other expenses', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 2 });
      const user2 = userRepo.create({ telegram_id: Date.now() + 2, group_id: group2.id });
      const expense2 = expenseRepo.create({
        group_id: group2.id,
        user_id: user2.id,
        date: '2024-01-15',
        category: 'Other',
        comment: '',
        amount: 5,
        currency: 'EUR',
        eur_amount: 5,
      });
      const item2 = itemsRepo.create(makeItem({ expense_id: expense2.id }));

      itemsRepo.create(makeItem());
      itemsRepo.deleteByExpenseId(expenseId);

      expect(itemsRepo.findById(item2.id)).not.toBeNull();
    });
  });

  describe('foreign key cascade', () => {
    test('items deleted when parent expense is deleted', () => {
      const item = itemsRepo.create(makeItem());
      expenseRepo.delete(expenseId);
      expect(itemsRepo.findById(item.id)).toBeNull();
    });
  });
});
