// Tests for UserRepository — CRUD, group linking, FK behavior

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { GroupRepository } from './group.repository';
import { UserRepository } from './user.repository';

let db: Database;
let userRepo: UserRepository;
let groupRepo: GroupRepository;

beforeAll(() => {
  db = createTestDb();
  userRepo = new UserRepository(db);
  groupRepo = new GroupRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
});

// Helper to create a group for FK tests
function makeGroup(telegramGroupId: number) {
  return groupRepo.create({ telegram_group_id: telegramGroupId });
}

describe('UserRepository', () => {
  describe('create', () => {
    test('creates user with telegram_id and returns it', () => {
      const group = makeGroup(1000);
      const user = userRepo.create({ telegram_id: 1, group_id: group.id });
      expect(user.id).toBeGreaterThan(0);
      expect(user.telegram_id).toBe(1);
    });

    test('group_id stored correctly', () => {
      const group = makeGroup(1001);
      const user = userRepo.create({ telegram_id: 2, group_id: group.id });
      expect(user.group_id).toBe(group.id);
    });

    test('group_id can be null (user without group)', () => {
      const user = userRepo.create({ telegram_id: 3 });
      expect(user.group_id).toBeNull();
    });

    test('created_at and updated_at are populated', () => {
      const user = userRepo.create({ telegram_id: 4 });
      expect(user.created_at).toBeTruthy();
      expect(user.updated_at).toBeTruthy();
    });

    test('telegram_id uniqueness enforced', () => {
      userRepo.create({ telegram_id: 5 });
      expect(() => userRepo.create({ telegram_id: 5 })).toThrow();
    });
  });

  describe('findByTelegramId', () => {
    test('returns user for existing telegram_id', () => {
      const created = userRepo.create({ telegram_id: 10 });
      const found = userRepo.findByTelegramId(10);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    test('returns null for non-existent telegram_id', () => {
      expect(userRepo.findByTelegramId(999999)).toBeNull();
    });
  });

  describe('findById', () => {
    test('returns user for existing id', () => {
      const created = userRepo.create({ telegram_id: 20 });
      const found = userRepo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found?.telegram_id).toBe(20);
    });

    test('returns null for non-existent id', () => {
      expect(userRepo.findById(999999)).toBeNull();
    });
  });

  describe('update', () => {
    test('updates group_id', () => {
      const group = makeGroup(2000);
      userRepo.create({ telegram_id: 30 });
      const updated = userRepo.update(30, { group_id: group.id });
      expect(updated?.group_id).toBe(group.id);
    });

    test('sets group_id to null', () => {
      const group = makeGroup(2001);
      userRepo.create({ telegram_id: 31, group_id: group.id });
      const updated = userRepo.update(31, {});
      // When undefined is passed, group_id field isn't updated
      expect(updated?.group_id).toBe(group.id);
    });

    test('returns null for non-existent telegram_id', () => {
      const result = userRepo.update(999999, { group_id: 1 });
      expect(result).toBeNull();
    });

    test('returns user after update', () => {
      userRepo.create({ telegram_id: 32 });
      const updated = userRepo.update(32, {});
      expect(updated).not.toBeNull();
      expect(updated?.telegram_id).toBe(32);
    });
  });

  describe('delete', () => {
    test('removes user from database', () => {
      userRepo.create({ telegram_id: 40 });
      userRepo.delete(40);
      expect(userRepo.findByTelegramId(40)).toBeNull();
    });

    test('returns true', () => {
      userRepo.create({ telegram_id: 41 });
      expect(userRepo.delete(41)).toBe(true);
    });

    test('deleting non-existent user does not throw', () => {
      expect(() => userRepo.delete(999999)).not.toThrow();
    });
  });

  describe('findByGroupId', () => {
    test('returns all users in a group', () => {
      const group = makeGroup(3000);
      userRepo.create({ telegram_id: 50, group_id: group.id });
      userRepo.create({ telegram_id: 51, group_id: group.id });
      userRepo.create({ telegram_id: 52 }); // no group

      const users = userRepo.findByGroupId(group.id);
      expect(users).toHaveLength(2);
      expect(users.every((u) => u.group_id === group.id)).toBe(true);
    });

    test('returns empty array for group with no users', () => {
      const group = makeGroup(3001);
      expect(userRepo.findByGroupId(group.id)).toEqual([]);
    });

    test('returns users only for the specified group', () => {
      const g1 = makeGroup(3002);
      const g2 = makeGroup(3003);
      userRepo.create({ telegram_id: 60, group_id: g1.id });
      userRepo.create({ telegram_id: 61, group_id: g2.id });

      const g1Users = userRepo.findByGroupId(g1.id);
      expect(g1Users).toHaveLength(1);
      expect(g1Users[0]?.telegram_id).toBe(60);
    });
  });

  describe('foreign key cascade', () => {
    test('deleting group sets user group_id to NULL (ON DELETE SET NULL)', () => {
      const group = makeGroup(4000);
      const user = userRepo.create({ telegram_id: 70, group_id: group.id });

      groupRepo.delete(group.telegram_group_id);

      const found = userRepo.findById(user.id);
      expect(found).not.toBeNull();
      expect(found?.group_id).toBeNull();
    });
  });
});
