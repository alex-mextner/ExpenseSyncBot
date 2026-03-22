// Tests for CategoryRepository — CRUD, normalization, uniqueness, cascade

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { Database } from 'bun:sqlite';
import { createTestDb, clearTestDb } from '../../test-utils/db';
import { GroupRepository } from './group.repository';
import { CategoryRepository } from './category.repository';

let db: Database;
let categoryRepo: CategoryRepository;
let groupRepo: GroupRepository;
let groupId: number;

beforeAll(() => {
  db = createTestDb();
  categoryRepo = new CategoryRepository(db);
  groupRepo = new GroupRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
  // Create a fresh group for each test
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  groupId = group.id;
});

describe('CategoryRepository', () => {
  describe('create', () => {
    test('creates category and returns it with id', () => {
      const cat = categoryRepo.create({ group_id: groupId, name: 'Food' });
      expect(cat.id).toBeGreaterThan(0);
      expect(cat.name).toBe('Food');
      expect(cat.group_id).toBe(groupId);
    });

    test('created_at is populated', () => {
      const cat = categoryRepo.create({ group_id: groupId, name: 'Transport' });
      expect(cat.created_at).toBeTruthy();
    });

    test('normalizes name: capitalizes first letter, lowercases rest', () => {
      const cat = categoryRepo.create({ group_id: groupId, name: 'fOOD' });
      expect(cat.name).toBe('Food');
    });

    test('normalizes all-caps name', () => {
      const cat = categoryRepo.create({ group_id: groupId, name: 'TRANSPORT' });
      expect(cat.name).toBe('Transport');
    });

    test('normalizes all-lowercase name', () => {
      const cat = categoryRepo.create({ group_id: groupId, name: 'groceries' });
      expect(cat.name).toBe('Groceries');
    });

    test('trims whitespace before normalizing', () => {
      const cat = categoryRepo.create({ group_id: groupId, name: '  rent  ' });
      expect(cat.name).toBe('Rent');
    });

    test('returns existing category when duplicate name (case-insensitive)', () => {
      const first = categoryRepo.create({ group_id: groupId, name: 'Food' });
      const second = categoryRepo.create({ group_id: groupId, name: 'food' });
      expect(second.id).toBe(first.id);
    });

    test('same name allowed for different groups', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 1 });
      const cat1 = categoryRepo.create({ group_id: groupId, name: 'Food' });
      const cat2 = categoryRepo.create({ group_id: group2.id, name: 'Food' });
      expect(cat1.id).not.toBe(cat2.id);
    });
  });

  describe('findByGroupId', () => {
    test('returns all categories for group ordered alphabetically', () => {
      categoryRepo.create({ group_id: groupId, name: 'Rent' });
      categoryRepo.create({ group_id: groupId, name: 'Food' });
      categoryRepo.create({ group_id: groupId, name: 'Taxi' });

      const cats = categoryRepo.findByGroupId(groupId);
      expect(cats).toHaveLength(3);
      expect(cats[0]!.name).toBe('Food');
      expect(cats[1]!.name).toBe('Rent');
      expect(cats[2]!.name).toBe('Taxi');
    });

    test('returns empty array for group with no categories', () => {
      expect(categoryRepo.findByGroupId(groupId)).toEqual([]);
    });

    test('does not return categories from other groups', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 2 });
      categoryRepo.create({ group_id: groupId, name: 'Food' });
      categoryRepo.create({ group_id: group2.id, name: 'Rent' });

      const cats = categoryRepo.findByGroupId(groupId);
      expect(cats).toHaveLength(1);
      expect(cats[0]!.name).toBe('Food');
    });
  });

  describe('findByName', () => {
    test('returns category by exact name', () => {
      categoryRepo.create({ group_id: groupId, name: 'Food' });
      const found = categoryRepo.findByName(groupId, 'Food');
      expect(found).not.toBeNull();
      expect(found!.name).toBe('Food');
    });

    test('case-insensitive lookup', () => {
      categoryRepo.create({ group_id: groupId, name: 'Food' });
      expect(categoryRepo.findByName(groupId, 'food')).not.toBeNull();
      expect(categoryRepo.findByName(groupId, 'FOOD')).not.toBeNull();
      expect(categoryRepo.findByName(groupId, 'FoOd')).not.toBeNull();
    });

    test('returns null for non-existent category', () => {
      expect(categoryRepo.findByName(groupId, 'NonExistent')).toBeNull();
    });

    test('scoped to group', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 3 });
      categoryRepo.create({ group_id: group2.id, name: 'Food' });
      // Should not find in groupId
      expect(categoryRepo.findByName(groupId, 'Food')).toBeNull();
    });
  });

  describe('findById', () => {
    test('returns category by id', () => {
      const created = categoryRepo.create({ group_id: groupId, name: 'Utilities' });
      const found = categoryRepo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found!.id).toBe(created.id);
    });

    test('returns null for non-existent id', () => {
      expect(categoryRepo.findById(999999)).toBeNull();
    });
  });

  describe('delete', () => {
    test('removes category from database', () => {
      const cat = categoryRepo.create({ group_id: groupId, name: 'DeleteMe' });
      categoryRepo.delete(cat.id);
      expect(categoryRepo.findById(cat.id)).toBeNull();
    });

    test('returns true', () => {
      const cat = categoryRepo.create({ group_id: groupId, name: 'DeleteMe2' });
      expect(categoryRepo.delete(cat.id)).toBe(true);
    });

    test('does not affect other categories', () => {
      const cat1 = categoryRepo.create({ group_id: groupId, name: 'Keep' });
      const cat2 = categoryRepo.create({ group_id: groupId, name: 'Remove' });
      categoryRepo.delete(cat2.id);
      expect(categoryRepo.findById(cat1.id)).not.toBeNull();
    });
  });

  describe('exists', () => {
    test('returns true when category exists', () => {
      categoryRepo.create({ group_id: groupId, name: 'Food' });
      expect(categoryRepo.exists(groupId, 'Food')).toBe(true);
    });

    test('case-insensitive exists check', () => {
      categoryRepo.create({ group_id: groupId, name: 'Food' });
      expect(categoryRepo.exists(groupId, 'food')).toBe(true);
      expect(categoryRepo.exists(groupId, 'FOOD')).toBe(true);
    });

    test('returns false when category does not exist', () => {
      expect(categoryRepo.exists(groupId, 'NoSuchCategory')).toBe(false);
    });

    test('scoped to group', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 4 });
      categoryRepo.create({ group_id: group2.id, name: 'Food' });
      expect(categoryRepo.exists(groupId, 'Food')).toBe(false);
    });
  });

  describe('getCategoryNames', () => {
    test('returns list of category name strings', () => {
      categoryRepo.create({ group_id: groupId, name: 'Food' });
      categoryRepo.create({ group_id: groupId, name: 'Rent' });
      const names = categoryRepo.getCategoryNames(groupId);
      expect(names).toContain('Food');
      expect(names).toContain('Rent');
    });

    test('returns empty array for group with no categories', () => {
      expect(categoryRepo.getCategoryNames(groupId)).toEqual([]);
    });

    test('returns strings only', () => {
      categoryRepo.create({ group_id: groupId, name: 'Transport' });
      const names = categoryRepo.getCategoryNames(groupId);
      for (const n of names) {
        expect(typeof n).toBe('string');
      }
    });

    test('ordered alphabetically', () => {
      categoryRepo.create({ group_id: groupId, name: 'Rent' });
      categoryRepo.create({ group_id: groupId, name: 'Amusement' });
      categoryRepo.create({ group_id: groupId, name: 'Food' });
      const names = categoryRepo.getCategoryNames(groupId);
      expect(names).toEqual(['Amusement', 'Food', 'Rent']);
    });
  });

  describe('foreign key cascade', () => {
    test('categories deleted when group is deleted', () => {
      const cat = categoryRepo.create({ group_id: groupId, name: 'Food' });
      // Get the telegram_group_id of the group
      const group = groupRepo.findById(groupId);
      groupRepo.delete(group!.telegram_group_id);
      expect(categoryRepo.findById(cat.id)).toBeNull();
    });
  });
});
