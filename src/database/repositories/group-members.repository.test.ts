// Tests for GroupMembersRepository — upsert, multi-group membership, removal

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { GroupRepository } from './group.repository';
import { GroupMembersRepository } from './group-members.repository';

let db: Database;
let groupMembers: GroupMembersRepository;
let groups: GroupRepository;

beforeAll(() => {
  db = createTestDb();
  groupMembers = new GroupMembersRepository(db);
  groups = new GroupRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
});

describe('GroupMembersRepository', () => {
  describe('upsert', () => {
    test('adds a membership record', () => {
      const group = groups.create({ telegram_group_id: -1001 });
      groupMembers.upsert(111, group.id);

      const result = groupMembers.findGroupsByTelegramId(111);
      expect(result).toHaveLength(1);
      expect(result[0]?.groupId).toBe(group.id);
    });

    test('idempotent — second upsert does not duplicate', () => {
      const group = groups.create({ telegram_group_id: -1002 });
      groupMembers.upsert(222, group.id);
      groupMembers.upsert(222, group.id);

      const result = groupMembers.findGroupsByTelegramId(222);
      expect(result).toHaveLength(1);
    });
  });

  describe('findGroupsByTelegramId', () => {
    test('returns empty array for unknown user', () => {
      const result = groupMembers.findGroupsByTelegramId(999);
      expect(result).toEqual([]);
    });

    test('returns all groups for a user in multiple groups', () => {
      const g1 = groups.create({ telegram_group_id: -1003 });
      const g2 = groups.create({ telegram_group_id: -1004 });
      groups.update(-1003, { title: 'Семья' });
      groups.update(-1004, { title: 'Работа' });

      groupMembers.upsert(333, g1.id);
      groupMembers.upsert(333, g2.id);

      const result = groupMembers.findGroupsByTelegramId(333);
      expect(result).toHaveLength(2);

      const titles = result.map((r) => r.title);
      expect(titles).toContain('Семья');
      expect(titles).toContain('Работа');
    });

    test('includes telegramGroupId for building deep links', () => {
      const group = groups.create({ telegram_group_id: -100123456 });
      groupMembers.upsert(444, group.id);

      const result = groupMembers.findGroupsByTelegramId(444);
      expect(result[0]?.telegramGroupId).toBe(-100123456);
    });

    test('returns null title when group has no title', () => {
      const group = groups.create({ telegram_group_id: -1005 });
      groupMembers.upsert(555, group.id);

      const result = groupMembers.findGroupsByTelegramId(555);
      expect(result[0]?.title).toBeNull();
    });

    test('returns invite_link when stored on group', () => {
      const group = groups.create({ telegram_group_id: -1008 });
      groups.update(-1008, { invite_link: 'https://t.me/+abc' });
      groupMembers.upsert(999, group.id);

      const result = groupMembers.findGroupsByTelegramId(999);
      expect(result[0]?.inviteLink).toBe('https://t.me/+abc');
    });

    test('returns null inviteLink when not set', () => {
      const group = groups.create({ telegram_group_id: -1009 });
      groupMembers.upsert(998, group.id);

      const result = groupMembers.findGroupsByTelegramId(998);
      expect(result[0]?.inviteLink).toBeNull();
    });
  });

  describe('remove', () => {
    test('removes a membership', () => {
      const group = groups.create({ telegram_group_id: -1006 });
      groupMembers.upsert(666, group.id);
      expect(groupMembers.findGroupsByTelegramId(666)).toHaveLength(1);

      groupMembers.remove(666, group.id);
      expect(groupMembers.findGroupsByTelegramId(666)).toHaveLength(0);
    });

    test('remove is idempotent — no error if membership does not exist', () => {
      groupMembers.remove(777, 999);
      // No error thrown
    });
  });

  describe('cascade delete', () => {
    test('deleting a group removes its memberships', () => {
      const group = groups.create({ telegram_group_id: -1007 });
      groupMembers.upsert(888, group.id);
      expect(groupMembers.findGroupsByTelegramId(888)).toHaveLength(1);

      groups.delete(-1007);
      expect(groupMembers.findGroupsByTelegramId(888)).toHaveLength(0);
    });
  });

  describe('migration backfill', () => {
    test('group_members table exists after migration', () => {
      const row = db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) as count FROM sqlite_master WHERE type='table' AND name='group_members'`,
        )
        .get();
      expect(row?.count).toBe(1);
    });
  });
});
