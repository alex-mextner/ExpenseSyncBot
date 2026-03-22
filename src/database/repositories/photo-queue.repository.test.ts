// Tests for PhotoQueueRepository — all public methods

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb } from '../../test-utils/db';
import { PhotoQueueRepository } from './photo-queue.repository';

let db: Database;
let repo: PhotoQueueRepository;
let groupId: number;
let userId: number;

beforeAll(() => {
  db = createTestDb();
  repo = new PhotoQueueRepository(db);
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec(`
    DELETE FROM receipt_items;
    DELETE FROM photo_processing_queue;
    DELETE FROM users;
    DELETE FROM groups;
  `);
  const gResult = db
    .prepare(
      `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, 'EUR', '["EUR"]')`,
    )
    .run(500100);
  groupId = gResult.lastInsertRowid as number;

  const uResult = db
    .prepare(`INSERT INTO users (telegram_id, group_id) VALUES (?, ?)`)
    .run(88001, groupId);
  userId = uResult.lastInsertRowid as number;
});

function makeItem(overrides: Partial<Parameters<typeof repo.create>[0]> = {}) {
  return repo.create({
    group_id: groupId,
    user_id: userId,
    message_id: 10001,
    file_id: 'file_test123',
    status: 'pending',
    ...overrides,
  });
}

describe('PhotoQueueRepository', () => {
  describe('create', () => {
    it('creates and returns item with id', () => {
      const item = makeItem();
      expect(item.id).toBeGreaterThan(0);
      expect(item.group_id).toBe(groupId);
      expect(item.user_id).toBe(userId);
      expect(item.message_id).toBe(10001);
      expect(item.file_id).toBe('file_test123');
      expect(item.status).toBe('pending');
    });

    it('creates item with message_thread_id null by default', () => {
      const item = makeItem();
      expect(item.message_thread_id).toBeNull();
    });

    it('creates item with explicit message_thread_id', () => {
      const item = makeItem({ message_thread_id: 42 });
      expect(item.message_thread_id).toBe(42);
    });

    it('creates item with processing status', () => {
      const item = makeItem({ status: 'processing' });
      expect(item.status).toBe('processing');
    });

    it('creates item with done status', () => {
      const item = makeItem({ status: 'done' });
      expect(item.status).toBe('done');
    });

    it('creates item with error status', () => {
      const item = makeItem({ status: 'error' });
      expect(item.status).toBe('error');
    });

    it('error_message is null by default', () => {
      const item = makeItem();
      expect(item.error_message).toBeNull();
    });

    it('summary_mode defaults to 0', () => {
      const item = makeItem();
      expect(item.summary_mode).toBe(0);
    });

    it('waiting_for_bulk_correction defaults to 0', () => {
      const item = makeItem();
      expect(item.waiting_for_bulk_correction).toBe(0);
    });
  });

  describe('findById', () => {
    it('returns item by id', () => {
      const created = makeItem();
      const found = repo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    it('returns null for non-existent id', () => {
      expect(repo.findById(999999)).toBeNull();
    });
  });

  describe('findPending', () => {
    it('returns only pending items', () => {
      makeItem({ status: 'pending' });
      makeItem({ status: 'processing' });
      makeItem({ status: 'done' });
      const pending = repo.findPending();
      expect(pending).toHaveLength(1);
      expect(pending.at(0)?.status).toBe('pending');
    });

    it('returns empty array when no pending items', () => {
      makeItem({ status: 'done' });
      expect(repo.findPending()).toEqual([]);
    });

    it('returns multiple pending items', () => {
      makeItem({ status: 'pending', message_id: 20001 });
      makeItem({ status: 'pending', message_id: 20002 });
      const pending = repo.findPending();
      expect(pending).toHaveLength(2);
    });
  });

  describe('findByGroupAndUser', () => {
    it('returns items for specific group and user', () => {
      makeItem({ message_id: 30001 });
      makeItem({ message_id: 30002 });
      const items = repo.findByGroupAndUser(groupId, userId);
      expect(items).toHaveLength(2);
    });

    it('does not return items from other groups', () => {
      const gResult2 = db
        .prepare(
          `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, 'EUR', '["EUR"]')`,
        )
        .run(600200);
      const groupId2 = gResult2.lastInsertRowid as number;
      const uResult2 = db
        .prepare(`INSERT INTO users (telegram_id, group_id) VALUES (?, ?)`)
        .run(99002, groupId2);
      const userId2 = uResult2.lastInsertRowid as number;

      makeItem({ message_id: 40001 });
      repo.create({
        group_id: groupId2,
        user_id: userId2,
        message_id: 40002,
        file_id: 'file_g2',
        status: 'pending',
      });

      const items = repo.findByGroupAndUser(groupId, userId);
      expect(items).toHaveLength(1);
    });

    it('does not return items from other users in same group', () => {
      const uResult2 = db
        .prepare(`INSERT INTO users (telegram_id, group_id) VALUES (?, ?)`)
        .run(99003, groupId);
      const userId2 = uResult2.lastInsertRowid as number;

      makeItem({ message_id: 50001 });
      repo.create({
        group_id: groupId,
        user_id: userId2,
        message_id: 50002,
        file_id: 'file_u2',
        status: 'pending',
      });

      const items = repo.findByGroupAndUser(groupId, userId);
      expect(items).toHaveLength(1);
      expect(items.at(0)?.message_id).toBe(50001);
    });

    it('returns empty array for no matches', () => {
      const items = repo.findByGroupAndUser(groupId, userId);
      expect(items).toEqual([]);
    });
  });

  describe('update', () => {
    it('updates status to processing', () => {
      const item = makeItem();
      const updated = repo.update(item.id, { status: 'processing' });
      expect(updated.status).toBe('processing');
    });

    it('updates status to done', () => {
      const item = makeItem();
      const updated = repo.update(item.id, { status: 'done' });
      expect(updated.status).toBe('done');
    });

    it('updates status to error with error_message', () => {
      const item = makeItem();
      const updated = repo.update(item.id, { status: 'error', error_message: 'OCR failed' });
      expect(updated.status).toBe('error');
      expect(updated.error_message).toBe('OCR failed');
    });

    it('updates summary_mode', () => {
      const item = makeItem();
      const updated = repo.update(item.id, { summary_mode: 1 });
      expect(updated.summary_mode).toBe(1);
    });

    it('updates ai_summary', () => {
      const item = makeItem();
      const summary = '{"total":100,"items":5}';
      const updated = repo.update(item.id, { ai_summary: summary });
      expect(updated.ai_summary).toBe(summary);
    });

    it('updates correction_history', () => {
      const item = makeItem();
      const history = '[{"action":"edit","old":"x","new":"y"}]';
      const updated = repo.update(item.id, { correction_history: history });
      expect(updated.correction_history).toBe(history);
    });

    it('updates waiting_for_bulk_correction flag', () => {
      const item = makeItem();
      const updated = repo.update(item.id, { waiting_for_bulk_correction: 1 });
      expect(updated.waiting_for_bulk_correction).toBe(1);
    });

    it('updates summary_message_id', () => {
      const item = makeItem();
      const updated = repo.update(item.id, { summary_message_id: 9999 });
      expect(updated.summary_message_id).toBe(9999);
    });

    it('throws when no fields provided', () => {
      const item = makeItem();
      expect(() => repo.update(item.id, {})).toThrow();
    });
  });

  describe('findWaitingForBulkCorrection', () => {
    it('returns item waiting for bulk correction in group', () => {
      const item = makeItem();
      repo.update(item.id, { waiting_for_bulk_correction: 1 });
      const found = repo.findWaitingForBulkCorrection(groupId);
      expect(found).not.toBeNull();
      expect(found?.waiting_for_bulk_correction).toBe(1);
    });

    it('returns null when no items waiting', () => {
      makeItem();
      const found = repo.findWaitingForBulkCorrection(groupId);
      expect(found).toBeNull();
    });

    it('does not return items from other groups', () => {
      const gResult2 = db
        .prepare(
          `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, 'EUR', '["EUR"]')`,
        )
        .run(700300);
      const groupId2 = gResult2.lastInsertRowid as number;
      const uResult2 = db
        .prepare(`INSERT INTO users (telegram_id, group_id) VALUES (?, ?)`)
        .run(111004, groupId2);
      const userId2 = uResult2.lastInsertRowid as number;
      const item2 = repo.create({
        group_id: groupId2,
        user_id: userId2,
        message_id: 60001,
        file_id: 'file_g2_bulk',
        status: 'pending',
      });
      repo.update(item2.id, { waiting_for_bulk_correction: 1 });

      const found = repo.findWaitingForBulkCorrection(groupId);
      expect(found).toBeNull();
    });
  });

  describe('delete', () => {
    it('deletes item by id and returns true', () => {
      const item = makeItem();
      const result = repo.delete(item.id);
      expect(result).toBe(true);
      expect(repo.findById(item.id)).toBeNull();
    });

    it('returns true for non-existent id (no-op)', () => {
      expect(repo.delete(999999)).toBe(true);
    });
  });

  describe('deleteOldDoneItems', () => {
    it('returns 0 when no done items exist', () => {
      makeItem({ status: 'pending' });
      const count = repo.deleteOldDoneItems(7);
      expect(count).toBe(0);
    });

    it('does not delete recent done items', () => {
      makeItem({ status: 'done' });
      // Item was just created, so it's not older than 7 days
      const count = repo.deleteOldDoneItems(7);
      expect(count).toBe(0);
      // Item still exists
      const items = repo.findByGroupAndUser(groupId, userId);
      expect(items).toHaveLength(1);
    });
  });
});
