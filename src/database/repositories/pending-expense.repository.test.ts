// Tests for PendingExpenseRepository — all public methods

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb } from '../../test-utils/db';
import { PendingExpenseRepository } from './pending-expense.repository';

let db: Database;
let repo: PendingExpenseRepository;

let groupId: number;
let userId: number;

beforeAll(() => {
  db = createTestDb();
  repo = new PendingExpenseRepository(db);
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec(`
    DELETE FROM pending_expenses;
    DELETE FROM users;
    DELETE FROM groups;
  `);
  const gResult = db
    .prepare(
      `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, 'EUR', '["EUR"]')`,
    )
    .run(100500);
  groupId = gResult.lastInsertRowid as number;

  const uResult = db
    .prepare(`INSERT INTO users (telegram_id, group_id) VALUES (?, ?)`)
    .run(55001, groupId);
  userId = uResult.lastInsertRowid as number;
});

describe('PendingExpenseRepository', () => {
  describe('create', () => {
    it('creates and returns a pending expense with id', () => {
      const pe = repo.create({
        user_id: userId,
        message_id: 1001,
        parsed_amount: 50,
        parsed_currency: 'EUR',
        detected_category: null,
        comment: 'lunch',
        status: 'pending_category',
      });
      expect(pe.id).toBeGreaterThan(0);
      expect(pe.user_id).toBe(userId);
      expect(pe.message_id).toBe(1001);
      expect(pe.parsed_amount).toBe(50);
      expect(pe.parsed_currency).toBe('EUR');
      expect(pe.detected_category).toBeNull();
      expect(pe.comment).toBe('lunch');
      expect(pe.status).toBe('pending_category');
    });

    it('creates with detected_category set', () => {
      const pe = repo.create({
        user_id: userId,
        message_id: 1002,
        parsed_amount: 100,
        parsed_currency: 'USD',
        detected_category: 'Food',
        comment: 'supermarket',
        status: 'pending_category',
      });
      expect(pe.detected_category).toBe('Food');
    });

    it('creates with status confirmed', () => {
      const pe = repo.create({
        user_id: userId,
        message_id: 1003,
        parsed_amount: 25,
        parsed_currency: 'EUR',
        detected_category: 'Transport',
        comment: 'taxi',
        status: 'confirmed',
      });
      expect(pe.status).toBe('confirmed');
    });

    it('creates multiple expenses for same user', () => {
      repo.create({
        user_id: userId,
        message_id: 2001,
        parsed_amount: 10,
        parsed_currency: 'EUR',
        detected_category: null,
        comment: 'coffee',
        status: 'pending_category',
      });
      repo.create({
        user_id: userId,
        message_id: 2002,
        parsed_amount: 20,
        parsed_currency: 'EUR',
        detected_category: null,
        comment: 'tea',
        status: 'pending_category',
      });
      const all = repo.findByUserId(userId);
      expect(all).toHaveLength(2);
    });
  });

  describe('findById', () => {
    it('returns expense by id', () => {
      const created = repo.create({
        user_id: userId,
        message_id: 3001,
        parsed_amount: 15,
        parsed_currency: 'EUR',
        detected_category: null,
        comment: 'test',
        status: 'pending_category',
      });
      const found = repo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    it('returns null for non-existent id', () => {
      const found = repo.findById(999999);
      expect(found).toBeNull();
    });
  });

  describe('findByMessageId', () => {
    it('returns expense by message id', () => {
      repo.create({
        user_id: userId,
        message_id: 4001,
        parsed_amount: 30,
        parsed_currency: 'EUR',
        detected_category: null,
        comment: 'bus',
        status: 'pending_category',
      });
      const found = repo.findByMessageId(4001);
      expect(found).not.toBeNull();
      expect(found?.message_id).toBe(4001);
    });

    it('returns null for unknown message id', () => {
      const found = repo.findByMessageId(999888);
      expect(found).toBeNull();
    });
  });

  describe('findByUserId', () => {
    it('returns all expenses for user', () => {
      repo.create({
        user_id: userId,
        message_id: 5001,
        parsed_amount: 5,
        parsed_currency: 'EUR',
        detected_category: null,
        comment: 'a',
        status: 'pending_category',
      });
      repo.create({
        user_id: userId,
        message_id: 5002,
        parsed_amount: 10,
        parsed_currency: 'EUR',
        detected_category: null,
        comment: 'b',
        status: 'pending_category',
      });
      const all = repo.findByUserId(userId);
      expect(all).toHaveLength(2);
      // Both message_ids present (order may tie at same timestamp)
      const msgIds = all.map((e) => e.message_id);
      expect(msgIds).toContain(5001);
      expect(msgIds).toContain(5002);
    });

    it('returns empty array for user with no expenses', () => {
      const uResult2 = db
        .prepare(`INSERT INTO users (telegram_id, group_id) VALUES (?, ?)`)
        .run(77002, groupId);
      const userId2 = uResult2.lastInsertRowid as number;
      const all = repo.findByUserId(userId2);
      expect(all).toEqual([]);
    });
  });

  describe('findConfirmed', () => {
    it('returns only confirmed expenses for user', () => {
      repo.create({
        user_id: userId,
        message_id: 6001,
        parsed_amount: 40,
        parsed_currency: 'EUR',
        detected_category: 'Food',
        comment: 'dinner',
        status: 'confirmed',
      });
      repo.create({
        user_id: userId,
        message_id: 6002,
        parsed_amount: 8,
        parsed_currency: 'EUR',
        detected_category: null,
        comment: 'snack',
        status: 'pending_category',
      });
      const confirmed = repo.findConfirmed(userId);
      expect(confirmed).toHaveLength(1);
      expect(confirmed.at(0)?.status).toBe('confirmed');
    });

    it('returns empty when no confirmed expenses', () => {
      repo.create({
        user_id: userId,
        message_id: 6003,
        parsed_amount: 12,
        parsed_currency: 'EUR',
        detected_category: null,
        comment: 'drink',
        status: 'pending_category',
      });
      const confirmed = repo.findConfirmed(userId);
      expect(confirmed).toEqual([]);
    });
  });

  describe('update', () => {
    it('updates status to confirmed', () => {
      const pe = repo.create({
        user_id: userId,
        message_id: 7001,
        parsed_amount: 60,
        parsed_currency: 'EUR',
        detected_category: null,
        comment: 'gym',
        status: 'pending_category',
      });
      const updated = repo.update(pe.id, { status: 'confirmed' });
      expect(updated).not.toBeNull();
      expect(updated?.status).toBe('confirmed');
    });

    it('updates detected_category', () => {
      const pe = repo.create({
        user_id: userId,
        message_id: 7002,
        parsed_amount: 45,
        parsed_currency: 'EUR',
        detected_category: null,
        comment: 'taxi',
        status: 'pending_category',
      });
      const updated = repo.update(pe.id, { detected_category: 'Transport' });
      expect(updated?.detected_category).toBe('Transport');
    });

    it('returns original when no fields provided', () => {
      const pe = repo.create({
        user_id: userId,
        message_id: 7003,
        parsed_amount: 20,
        parsed_currency: 'EUR',
        detected_category: null,
        comment: 'misc',
        status: 'pending_category',
      });
      const updated = repo.update(pe.id, {});
      expect(updated).not.toBeNull();
      expect(updated?.id).toBe(pe.id);
    });

    it('returns null for non-existent id', () => {
      const updated = repo.update(999999, { status: 'confirmed' });
      expect(updated).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes expense by id and returns true', () => {
      const pe = repo.create({
        user_id: userId,
        message_id: 8001,
        parsed_amount: 5,
        parsed_currency: 'EUR',
        detected_category: null,
        comment: 'del',
        status: 'pending_category',
      });
      const result = repo.delete(pe.id);
      expect(result).toBe(true);
      expect(repo.findById(pe.id)).toBeNull();
    });

    it('returns true even for non-existent id (no-op)', () => {
      expect(repo.delete(999999)).toBe(true);
    });
  });

  describe('deleteByMessageId', () => {
    it('deletes expense by message id and returns true', () => {
      repo.create({
        user_id: userId,
        message_id: 9001,
        parsed_amount: 7,
        parsed_currency: 'EUR',
        detected_category: null,
        comment: 'del-msg',
        status: 'pending_category',
      });
      const result = repo.deleteByMessageId(9001);
      expect(result).toBe(true);
      expect(repo.findByMessageId(9001)).toBeNull();
    });

    it('returns true for non-existent message id', () => {
      expect(repo.deleteByMessageId(999999)).toBe(true);
    });
  });
});
