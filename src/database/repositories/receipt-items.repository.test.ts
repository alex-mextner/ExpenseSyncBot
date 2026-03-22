// Tests for ReceiptItemsRepository — all public methods

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb } from '../../test-utils/db';
import { ReceiptItemsRepository } from './receipt-items.repository';

let db: Database;
let repo: ReceiptItemsRepository;
let groupId: number;
let userId: number;
let photoQueueId: number;

beforeAll(() => {
  db = createTestDb();
  repo = new ReceiptItemsRepository(db);
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
    .run(400100);
  groupId = gResult.lastInsertRowid as number;

  const uResult = db
    .prepare(`INSERT INTO users (telegram_id, group_id) VALUES (?, ?)`)
    .run(77001, groupId);
  userId = uResult.lastInsertRowid as number;

  const pResult = db
    .prepare(
      `INSERT INTO photo_processing_queue (group_id, user_id, message_id, file_id, status) VALUES (?, ?, ?, ?, ?)`,
    )
    .run(groupId, userId, 10001, 'file_abc123', 'pending');
  photoQueueId = pResult.lastInsertRowid as number;
});

function makeItem(overrides: Partial<Parameters<typeof repo.create>[0]> = {}) {
  return repo.create({
    photo_queue_id: photoQueueId,
    name_ru: 'Молоко',
    name_original: 'Milk',
    quantity: 2,
    price: 1.5,
    total: 3.0,
    currency: 'EUR',
    suggested_category: 'Food',
    possible_categories: ['Food', 'Groceries'],
    status: 'pending',
    ...overrides,
  });
}

describe('ReceiptItemsRepository', () => {
  describe('create', () => {
    it('creates and returns item with id', () => {
      const item = makeItem();
      expect(item.id).toBeGreaterThan(0);
      expect(item.photo_queue_id).toBe(photoQueueId);
      expect(item.name_ru).toBe('Молоко');
      expect(item.name_original).toBe('Milk');
      expect(item.quantity).toBe(2);
      expect(item.price).toBe(1.5);
      expect(item.total).toBe(3.0);
      expect(item.currency).toBe('EUR');
      expect(item.suggested_category).toBe('Food');
      expect(item.status).toBe('pending');
    });

    it('deserializes possible_categories as array', () => {
      const item = makeItem({ possible_categories: ['Food', 'Groceries', 'Household'] });
      expect(Array.isArray(item.possible_categories)).toBe(true);
      expect(item.possible_categories).toContain('Food');
      expect(item.possible_categories).toContain('Groceries');
      expect(item.possible_categories).toHaveLength(3);
    });

    it('creates item without name_original (null)', () => {
      const item = makeItem({ name_original: undefined });
      expect(item.name_original).toBeNull();
    });

    it('creates item with confirmed status', () => {
      const item = makeItem({ status: 'confirmed' });
      expect(item.status).toBe('confirmed');
    });

    it('creates item with skipped status', () => {
      const item = makeItem({ status: 'skipped' });
      expect(item.status).toBe('skipped');
    });

    it('confirmed_category is null by default', () => {
      const item = makeItem();
      expect(item.confirmed_category).toBeNull();
    });

    it('waiting_for_category_input defaults to 0', () => {
      const item = makeItem();
      expect(item.waiting_for_category_input).toBe(0);
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

    it('parses possible_categories from JSON', () => {
      const created = makeItem({ possible_categories: ['A', 'B'] });
      const found = repo.findById(created.id);
      expect(Array.isArray(found?.possible_categories)).toBe(true);
      expect(found?.possible_categories).toEqual(['A', 'B']);
    });
  });

  describe('findByPhotoQueueId', () => {
    it('returns all items for a queue', () => {
      makeItem({ name_ru: 'Item1' });
      makeItem({ name_ru: 'Item2' });
      const items = repo.findByPhotoQueueId(photoQueueId);
      expect(items).toHaveLength(2);
    });

    it('returns empty array for queue with no items', () => {
      const pResult2 = db
        .prepare(
          `INSERT INTO photo_processing_queue (group_id, user_id, message_id, file_id, status) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(groupId, userId, 10002, 'file_xyz', 'pending');
      const queueId2 = pResult2.lastInsertRowid as number;
      const items = repo.findByPhotoQueueId(queueId2);
      expect(items).toEqual([]);
    });

    it('does not return items from other queues', () => {
      const pResult2 = db
        .prepare(
          `INSERT INTO photo_processing_queue (group_id, user_id, message_id, file_id, status) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(groupId, userId, 10003, 'file_def', 'pending');
      const queueId2 = pResult2.lastInsertRowid as number;

      makeItem({ name_ru: 'Queue1Item' });
      repo.create({
        photo_queue_id: queueId2,
        name_ru: 'Queue2Item',
        quantity: 1,
        price: 5,
        total: 5,
        currency: 'EUR',
        suggested_category: 'Food',
        possible_categories: ['Food'],
        status: 'pending',
      });

      const items = repo.findByPhotoQueueId(photoQueueId);
      expect(items).toHaveLength(1);
      expect(items.at(0)?.name_ru).toBe('Queue1Item');
    });
  });

  describe('findPending', () => {
    it('returns only pending items across all queues', () => {
      makeItem({ status: 'pending' });
      makeItem({ status: 'confirmed' });
      makeItem({ status: 'skipped' });
      const pending = repo.findPending();
      expect(pending).toHaveLength(1);
      expect(pending.at(0)?.status).toBe('pending');
    });

    it('returns empty array when no pending items', () => {
      makeItem({ status: 'confirmed' });
      expect(repo.findPending()).toEqual([]);
    });
  });

  describe('findNextPending', () => {
    it('returns the oldest pending item', () => {
      makeItem({ name_ru: 'First' });
      makeItem({ name_ru: 'Second' });
      const next = repo.findNextPending();
      expect(next).not.toBeNull();
      expect(next?.status).toBe('pending');
    });

    it('returns null when no pending items', () => {
      makeItem({ status: 'confirmed' });
      expect(repo.findNextPending()).toBeNull();
    });
  });

  describe('update', () => {
    it('updates status to confirmed', () => {
      const item = makeItem();
      const updated = repo.update(item.id, { status: 'confirmed' });
      expect(updated.status).toBe('confirmed');
    });

    it('updates status to skipped', () => {
      const item = makeItem();
      const updated = repo.update(item.id, { status: 'skipped' });
      expect(updated.status).toBe('skipped');
    });

    it('updates confirmed_category', () => {
      const item = makeItem();
      const updated = repo.update(item.id, {
        status: 'confirmed',
        confirmed_category: 'Groceries',
      });
      expect(updated.confirmed_category).toBe('Groceries');
    });

    it('updates waiting_for_category_input flag', () => {
      const item = makeItem();
      const updated = repo.update(item.id, { waiting_for_category_input: 1 });
      expect(updated.waiting_for_category_input).toBe(1);
    });

    it('updates possible_categories as JSON string', () => {
      const item = makeItem();
      const newCats = JSON.stringify(['NewCat', 'OtherCat']);
      const updated = repo.update(item.id, { possible_categories: newCats });
      expect(Array.isArray(updated.possible_categories)).toBe(true);
      expect(updated.possible_categories).toContain('NewCat');
    });

    it('throws when no fields provided', () => {
      const item = makeItem();
      expect(() => repo.update(item.id, {})).toThrow();
    });
  });

  describe('findWaitingForCategoryInput', () => {
    it('returns item waiting for input in group', () => {
      const item = makeItem();
      repo.update(item.id, { waiting_for_category_input: 1 });
      const found = repo.findWaitingForCategoryInput(groupId);
      expect(found).not.toBeNull();
      expect(found?.waiting_for_category_input).toBe(1);
    });

    it('returns null when no items waiting', () => {
      makeItem();
      const found = repo.findWaitingForCategoryInput(groupId);
      expect(found).toBeNull();
    });

    it('does not return items from other groups', () => {
      const gResult2 = db
        .prepare(
          `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, 'EUR', '["EUR"]')`,
        )
        .run(500200);
      const groupId2 = gResult2.lastInsertRowid as number;
      const uResult2 = db
        .prepare(`INSERT INTO users (telegram_id, group_id) VALUES (?, ?)`)
        .run(88002, groupId2);
      const userId2 = uResult2.lastInsertRowid as number;
      const pResult2 = db
        .prepare(
          `INSERT INTO photo_processing_queue (group_id, user_id, message_id, file_id, status) VALUES (?, ?, ?, ?, ?)`,
        )
        .run(groupId2, userId2, 20001, 'file_g2', 'pending');
      const queueId2 = pResult2.lastInsertRowid as number;

      const item = repo.create({
        photo_queue_id: queueId2,
        name_ru: 'G2 item',
        quantity: 1,
        price: 1,
        total: 1,
        currency: 'EUR',
        suggested_category: 'Food',
        possible_categories: ['Food'],
        status: 'pending',
      });
      repo.update(item.id, { waiting_for_category_input: 1 });

      const found = repo.findWaitingForCategoryInput(groupId);
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

    it('returns true even for non-existent id', () => {
      expect(repo.delete(999999)).toBe(true);
    });
  });

  describe('deleteConfirmedByPhotoQueueId', () => {
    it('deletes confirmed items and returns count', () => {
      makeItem({ status: 'confirmed' });
      makeItem({ status: 'confirmed' });
      makeItem({ status: 'pending' });
      const count = repo.deleteConfirmedByPhotoQueueId(photoQueueId);
      expect(count).toBe(2);
      const remaining = repo.findByPhotoQueueId(photoQueueId);
      expect(remaining).toHaveLength(1);
      expect(remaining.at(0)?.status).toBe('pending');
    });

    it('returns 0 when no confirmed items', () => {
      makeItem({ status: 'pending' });
      const count = repo.deleteConfirmedByPhotoQueueId(photoQueueId);
      expect(count).toBe(0);
    });
  });

  describe('deleteProcessedByPhotoQueueId', () => {
    it('deletes confirmed and skipped items, returns count', () => {
      makeItem({ status: 'confirmed' });
      makeItem({ status: 'skipped' });
      makeItem({ status: 'pending' });
      const count = repo.deleteProcessedByPhotoQueueId(photoQueueId);
      expect(count).toBe(2);
      const remaining = repo.findByPhotoQueueId(photoQueueId);
      expect(remaining).toHaveLength(1);
      expect(remaining.at(0)?.status).toBe('pending');
    });

    it('returns 0 when nothing to delete', () => {
      makeItem({ status: 'pending' });
      const count = repo.deleteProcessedByPhotoQueueId(photoQueueId);
      expect(count).toBe(0);
    });
  });

  describe('findConfirmedByPhotoQueueId', () => {
    it('returns only confirmed items for queue', () => {
      makeItem({ status: 'confirmed' });
      makeItem({ status: 'pending' });
      makeItem({ status: 'skipped' });
      const confirmed = repo.findConfirmedByPhotoQueueId(photoQueueId);
      expect(confirmed).toHaveLength(1);
      expect(confirmed.at(0)?.status).toBe('confirmed');
    });

    it('returns empty array when no confirmed items', () => {
      makeItem({ status: 'pending' });
      const confirmed = repo.findConfirmedByPhotoQueueId(photoQueueId);
      expect(confirmed).toEqual([]);
    });

    it('cascade delete: items removed when photo queue deleted', () => {
      makeItem({ status: 'confirmed' });
      db.prepare(`DELETE FROM photo_processing_queue WHERE id = ?`).run(photoQueueId);
      const items = repo.findByPhotoQueueId(photoQueueId);
      expect(items).toEqual([]);
    });
  });
});
