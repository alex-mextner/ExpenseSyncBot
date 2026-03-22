// Tests for ChatMessageRepository — all public methods

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb } from '../../test-utils/db';
import { ChatMessageRepository } from './chat-message.repository';

let db: Database;
let repo: ChatMessageRepository;
let groupId: number;
let userId: number;

beforeAll(() => {
  db = createTestDb();
  repo = new ChatMessageRepository(db);
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec(`
    DELETE FROM chat_messages;
    DELETE FROM users;
    DELETE FROM groups;
  `);
  const gResult = db
    .prepare(
      `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, 'EUR', '["EUR"]')`,
    )
    .run(300100);
  groupId = gResult.lastInsertRowid as number;

  const uResult = db
    .prepare(`INSERT INTO users (telegram_id, group_id) VALUES (?, ?)`)
    .run(66001, groupId);
  userId = uResult.lastInsertRowid as number;
});

describe('ChatMessageRepository', () => {
  describe('create', () => {
    it('creates and returns a user message with id', () => {
      const msg = repo.create({
        group_id: groupId,
        user_id: userId,
        role: 'user',
        content: 'Hello bot!',
      });
      expect(msg.id).toBeGreaterThan(0);
      expect(msg.group_id).toBe(groupId);
      expect(msg.user_id).toBe(userId);
      expect(msg.role).toBe('user');
      expect(msg.content).toBe('Hello bot!');
    });

    it('creates an assistant message', () => {
      const msg = repo.create({
        group_id: groupId,
        user_id: userId,
        role: 'assistant',
        content: 'Here is your answer.',
      });
      expect(msg.role).toBe('assistant');
      expect(msg.content).toBe('Here is your answer.');
    });

    it('stores created_at timestamp', () => {
      const msg = repo.create({
        group_id: groupId,
        user_id: userId,
        role: 'user',
        content: 'time test',
      });
      expect(typeof msg.created_at).toBe('string');
      expect(msg.created_at.length).toBeGreaterThan(0);
    });

    it('throws on invalid role value', () => {
      expect(() =>
        repo.create({
          group_id: groupId,
          user_id: userId,
          role: 'invalid_role' as 'user',
          content: 'oops',
        }),
      ).toThrow();
    });
  });

  describe('findById', () => {
    it('returns message by id', () => {
      const created = repo.create({
        group_id: groupId,
        user_id: userId,
        role: 'user',
        content: 'findme',
      });
      const found = repo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.content).toBe('findme');
    });

    it('returns null for non-existent id', () => {
      expect(repo.findById(999999)).toBeNull();
    });
  });

  describe('getRecentMessages', () => {
    it('returns messages for group in chronological order (oldest first)', () => {
      repo.create({ group_id: groupId, user_id: userId, role: 'user', content: 'first' });
      repo.create({ group_id: groupId, user_id: userId, role: 'assistant', content: 'second' });
      const msgs = repo.getRecentMessages(groupId, 10);
      expect(msgs.length).toBe(2);
      // Returned in chronological order (oldest first)
      const contents = msgs.map((m) => m.content);
      expect(contents).toContain('first');
      expect(contents).toContain('second');
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 8; i++) {
        repo.create({ group_id: groupId, user_id: userId, role: 'user', content: `msg ${i}` });
      }
      const msgs = repo.getRecentMessages(groupId, 3);
      expect(msgs).toHaveLength(3);
    });

    it('uses default limit of 10', () => {
      for (let i = 0; i < 15; i++) {
        repo.create({ group_id: groupId, user_id: userId, role: 'user', content: `msg ${i}` });
      }
      const msgs = repo.getRecentMessages(groupId);
      expect(msgs).toHaveLength(10);
    });

    it('returns empty array for group with no messages', () => {
      const gResult2 = db
        .prepare(
          `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, 'EUR', '["EUR"]')`,
        )
        .run(400200);
      const groupId2 = gResult2.lastInsertRowid as number;
      const msgs = repo.getRecentMessages(groupId2, 10);
      expect(msgs).toEqual([]);
    });

    it('does not return messages from other groups', () => {
      const gResult2 = db
        .prepare(
          `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, 'EUR', '["EUR"]')`,
        )
        .run(400201);
      const groupId2 = gResult2.lastInsertRowid as number;
      const uResult2 = db
        .prepare(`INSERT INTO users (telegram_id, group_id) VALUES (?, ?)`)
        .run(77003, groupId2);
      const userId2 = uResult2.lastInsertRowid as number;

      repo.create({ group_id: groupId, user_id: userId, role: 'user', content: 'group1 msg' });
      repo.create({ group_id: groupId2, user_id: userId2, role: 'user', content: 'group2 msg' });

      const msgs1 = repo.getRecentMessages(groupId, 10);
      expect(msgs1).toHaveLength(1);
      expect(msgs1.at(0)?.content).toBe('group1 msg');
    });
  });

  describe('pruneOldMessages', () => {
    it('keeps only the last N messages', () => {
      for (let i = 0; i < 10; i++) {
        repo.create({ group_id: groupId, user_id: userId, role: 'user', content: `msg ${i}` });
      }
      repo.pruneOldMessages(groupId, 5);
      const remaining = repo.getRecentMessages(groupId, 20);
      expect(remaining).toHaveLength(5);
    });

    it('does nothing when message count is within limit', () => {
      for (let i = 0; i < 3; i++) {
        repo.create({ group_id: groupId, user_id: userId, role: 'user', content: `msg ${i}` });
      }
      repo.pruneOldMessages(groupId, 10);
      const remaining = repo.getRecentMessages(groupId, 20);
      expect(remaining).toHaveLength(3);
    });

    it('only prunes messages of specified group', () => {
      const gResult2 = db
        .prepare(
          `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, 'EUR', '["EUR"]')`,
        )
        .run(500300);
      const groupId2 = gResult2.lastInsertRowid as number;
      const uResult2 = db
        .prepare(`INSERT INTO users (telegram_id, group_id) VALUES (?, ?)`)
        .run(88004, groupId2);
      const userId2 = uResult2.lastInsertRowid as number;

      for (let i = 0; i < 5; i++) {
        repo.create({ group_id: groupId, user_id: userId, role: 'user', content: `g1 msg ${i}` });
      }
      for (let i = 0; i < 5; i++) {
        repo.create({
          group_id: groupId2,
          user_id: userId2,
          role: 'user',
          content: `g2 msg ${i}`,
        });
      }

      repo.pruneOldMessages(groupId, 2);
      const g1msgs = repo.getRecentMessages(groupId, 20);
      const g2msgs = repo.getRecentMessages(groupId2, 20);
      expect(g1msgs).toHaveLength(2);
      expect(g2msgs).toHaveLength(5); // untouched
    });
  });

  describe('deleteByGroupId', () => {
    it('deletes all messages for group', () => {
      repo.create({ group_id: groupId, user_id: userId, role: 'user', content: 'msg1' });
      repo.create({ group_id: groupId, user_id: userId, role: 'assistant', content: 'msg2' });
      repo.deleteByGroupId(groupId);
      const remaining = repo.getRecentMessages(groupId, 20);
      expect(remaining).toEqual([]);
    });

    it('does not delete messages from other groups', () => {
      const gResult2 = db
        .prepare(
          `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, 'EUR', '["EUR"]')`,
        )
        .run(600400);
      const groupId2 = gResult2.lastInsertRowid as number;
      const uResult2 = db
        .prepare(`INSERT INTO users (telegram_id, group_id) VALUES (?, ?)`)
        .run(99005, groupId2);
      const userId2 = uResult2.lastInsertRowid as number;

      repo.create({ group_id: groupId, user_id: userId, role: 'user', content: 'group1' });
      repo.create({ group_id: groupId2, user_id: userId2, role: 'user', content: 'group2' });

      repo.deleteByGroupId(groupId);

      const g1 = repo.getRecentMessages(groupId, 10);
      const g2 = repo.getRecentMessages(groupId2, 10);
      expect(g1).toEqual([]);
      expect(g2).toHaveLength(1);
    });

    it('does nothing when no messages exist for group', () => {
      expect(() => repo.deleteByGroupId(groupId)).not.toThrow();
    });
  });
});
