// Tests for ReceiptRepository — CRUD and duplicate matching

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import type { CreateReceiptData } from '../types';
import { ExpenseRepository } from './expense.repository';
import { GroupRepository } from './group.repository';
import { ReceiptRepository } from './receipt.repository';
import { UserRepository } from './user.repository';

let db: Database;
let receiptRepo: ReceiptRepository;
let expenseRepo: ExpenseRepository;
let groupRepo: GroupRepository;
let userRepo: UserRepository;
let groupId: number;
let userId: number;

beforeAll(() => {
  db = createTestDb();
  receiptRepo = new ReceiptRepository(db);
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
  groupId = group.id;
  const user = userRepo.create({ telegram_id: Date.now(), group_id: groupId });
  userId = user.id;
});

function makeReceipt(overrides: Partial<CreateReceiptData> = {}): CreateReceiptData {
  return {
    group_id: groupId,
    image_path: 'data/receipts/test-receipt.jpg',
    total_amount: 2500,
    currency: 'RSD',
    date: '2024-06-15',
    ...overrides,
  };
}

describe('ReceiptRepository', () => {
  describe('create', () => {
    test('creates receipt and returns it with id', () => {
      const receipt = receiptRepo.create(makeReceipt());
      expect(receipt.id).toBeGreaterThan(0);
      expect(receipt.group_id).toBe(groupId);
      expect(receipt.total_amount).toBe(2500);
      expect(receipt.currency).toBe('RSD');
      expect(receipt.date).toBe('2024-06-15');
      expect(receipt.image_path).toBe('data/receipts/test-receipt.jpg');
    });

    test('photo_queue_id defaults to null', () => {
      const receipt = receiptRepo.create(makeReceipt());
      expect(receipt.photo_queue_id).toBeNull();
    });

    test('stores photo_queue_id when provided', () => {
      // Insert a photo_processing_queue row so FK is satisfied
      db.exec(
        `INSERT INTO photo_processing_queue (group_id, user_id, message_id, file_id, status) VALUES (${groupId}, ${userId}, 1, 'test_file', 'done')`,
      );
      const row = db.query<{ id: number }, []>('SELECT last_insert_rowid() as id').get();
      const queueId = row ? row.id : 0;

      const receipt = receiptRepo.create(makeReceipt({ photo_queue_id: queueId }));
      expect(receipt.photo_queue_id).toBe(queueId);
    });

    test('created_at is populated', () => {
      const receipt = receiptRepo.create(makeReceipt());
      expect(receipt.created_at).toBeTruthy();
    });
  });

  describe('findById', () => {
    test('returns receipt by id', () => {
      const created = receiptRepo.create(makeReceipt());
      const found = receiptRepo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    test('returns null for non-existent id', () => {
      expect(receiptRepo.findById(99999)).toBeNull();
    });
  });

  describe('findByPhotoQueueId', () => {
    test('returns receipt by photo_queue_id', () => {
      db.exec(
        `INSERT INTO photo_processing_queue (group_id, user_id, message_id, file_id, status) VALUES (${groupId}, ${userId}, 1, 'test_file', 'done')`,
      );
      const row = db.query<{ id: number }, []>('SELECT last_insert_rowid() as id').get();
      const queueId = row ? row.id : 0;

      const created = receiptRepo.create(makeReceipt({ photo_queue_id: queueId }));
      const found = receiptRepo.findByPhotoQueueId(queueId);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    test('returns null when no receipt matches', () => {
      expect(receiptRepo.findByPhotoQueueId(99999)).toBeNull();
    });
  });

  describe('delete', () => {
    test('deletes receipt', () => {
      const receipt = receiptRepo.create(makeReceipt());
      receiptRepo.delete(receipt.id);
      expect(receiptRepo.findById(receipt.id)).toBeNull();
    });
  });

  describe('findPotentialMatches', () => {
    test('exact match — same date, amount within 5%, same currency', () => {
      receiptRepo.create(makeReceipt({ total_amount: 2500, date: '2024-06-15' }));
      const result = receiptRepo.findPotentialMatches(groupId, '2024-06-15', 2500, 'RSD');
      expect(result.exact).toHaveLength(1);
      expect(result.fuzzy).toHaveLength(0);
    });

    test('exact match — amount within 5% tolerance', () => {
      receiptRepo.create(makeReceipt({ total_amount: 2500 }));
      // 2400 is 4% off from 2500, and 2500 is 4.17% off from 2400 — within 5%
      const result = receiptRepo.findPotentialMatches(groupId, '2024-06-15', 2400, 'RSD');
      expect(result.exact).toHaveLength(1);
    });

    test('no match — amount outside 5% tolerance', () => {
      receiptRepo.create(makeReceipt({ total_amount: 2500 }));
      // 2350 is 6% off from 2500; tolerance from 2350 is 117.5, diff is 150
      const result = receiptRepo.findPotentialMatches(groupId, '2024-06-15', 2350, 'RSD');
      expect(result.exact).toHaveLength(0);
      expect(result.fuzzy).toHaveLength(0);
    });

    test('fuzzy match — adjacent day', () => {
      receiptRepo.create(makeReceipt({ total_amount: 2500, date: '2024-06-14' }));
      const result = receiptRepo.findPotentialMatches(groupId, '2024-06-15', 2500, 'RSD');
      expect(result.exact).toHaveLength(0);
      expect(result.fuzzy).toHaveLength(1);
    });

    test('no match — different currency', () => {
      receiptRepo.create(makeReceipt({ total_amount: 2500, currency: 'EUR' }));
      const result = receiptRepo.findPotentialMatches(groupId, '2024-06-15', 2500, 'RSD');
      expect(result.exact).toHaveLength(0);
      expect(result.fuzzy).toHaveLength(0);
    });

    test('no match — different group', () => {
      const otherGroup = groupRepo.create({ telegram_group_id: Date.now() + 1 });
      receiptRepo.create(makeReceipt({ group_id: otherGroup.id }));
      const result = receiptRepo.findPotentialMatches(groupId, '2024-06-15', 2500, 'RSD');
      expect(result.exact).toHaveLength(0);
      expect(result.fuzzy).toHaveLength(0);
    });

    test('no match — date more than 1 day away', () => {
      receiptRepo.create(makeReceipt({ total_amount: 2500, date: '2024-06-12' }));
      const result = receiptRepo.findPotentialMatches(groupId, '2024-06-15', 2500, 'RSD');
      expect(result.exact).toHaveLength(0);
      expect(result.fuzzy).toHaveLength(0);
    });

    test('excludes receipt already linked to a confirmed bank transaction', () => {
      const receipt = receiptRepo.create(makeReceipt({ total_amount: 2500, date: '2024-06-15' }));

      // Create an expense linked to this receipt
      const expense = expenseRepo.create({
        group_id: groupId,
        user_id: userId,
        date: '2024-06-15',
        category: 'Food',
        comment: 'Grocery',
        amount: 2500,
        currency: 'RSD',
        eur_amount: 21.3,
        receipt_id: receipt.id,
      });

      // Create a bank_connection + confirmed bank_transaction matched to that expense
      db.exec(
        `INSERT INTO bank_connections (group_id, bank_name, display_name, status) VALUES (${groupId}, 'test', 'Test Bank', 'active')`,
      );
      const connId = db.query<{ id: number }, []>('SELECT last_insert_rowid() as id').get();
      db.exec(
        `INSERT INTO bank_transactions (connection_id, external_id, date, amount, currency, raw_data, status, matched_expense_id)
         VALUES (${connId?.id ?? 0}, 'ext-1', '2024-06-15', 2500, 'RSD', '{}', 'confirmed', ${expense.id})`,
      );

      const result = receiptRepo.findPotentialMatches(groupId, '2024-06-15', 2500, 'RSD');
      expect(result.exact).toHaveLength(0);
      expect(result.fuzzy).toHaveLength(0);
    });

    test('includes receipt when bank transaction is still pending', () => {
      const receipt = receiptRepo.create(makeReceipt({ total_amount: 2500, date: '2024-06-15' }));

      const expense = expenseRepo.create({
        group_id: groupId,
        user_id: userId,
        date: '2024-06-15',
        category: 'Food',
        comment: 'Grocery',
        amount: 2500,
        currency: 'RSD',
        eur_amount: 21.3,
        receipt_id: receipt.id,
      });

      db.exec(
        `INSERT INTO bank_connections (group_id, bank_name, display_name, status) VALUES (${groupId}, 'test', 'Test Bank', 'active')`,
      );
      const connId = db.query<{ id: number }, []>('SELECT last_insert_rowid() as id').get();
      db.exec(
        `INSERT INTO bank_transactions (connection_id, external_id, date, amount, currency, raw_data, status, matched_expense_id)
         VALUES (${connId?.id ?? 0}, 'ext-2', '2024-06-15', 2500, 'RSD', '{}', 'pending', ${expense.id})`,
      );

      const result = receiptRepo.findPotentialMatches(groupId, '2024-06-15', 2500, 'RSD');
      expect(result.exact).toHaveLength(1);
    });

    test('exact and fuzzy are separated — no duplicates', () => {
      // Exact: same date
      receiptRepo.create(makeReceipt({ total_amount: 2500, date: '2024-06-15' }));
      // Fuzzy: adjacent date
      receiptRepo.create(makeReceipt({ total_amount: 2500, date: '2024-06-16' }));

      const result = receiptRepo.findPotentialMatches(groupId, '2024-06-15', 2500, 'RSD');
      expect(result.exact).toHaveLength(1);
      expect(result.fuzzy).toHaveLength(1);
    });
  });

  describe('findExpensesByReceiptId', () => {
    test('returns expenses linked to receipt', () => {
      const receipt = receiptRepo.create(makeReceipt());
      expenseRepo.create({
        group_id: groupId,
        user_id: userId,
        date: '2024-06-15',
        category: 'Food',
        comment: 'Grocery store',
        amount: 2500,
        currency: 'RSD',
        eur_amount: 21.3,
        receipt_id: receipt.id,
      });

      const expenses = receiptRepo.findExpensesByReceiptId(receipt.id);
      expect(expenses).toHaveLength(1);
      expect(expenses[0]?.category).toBe('Food');
      expect(expenses[0]?.amount).toBe(2500);
    });

    test('returns empty array when no expenses linked', () => {
      const receipt = receiptRepo.create(makeReceipt());
      expect(receiptRepo.findExpensesByReceiptId(receipt.id)).toHaveLength(0);
    });

    test('returns multiple linked expenses', () => {
      const receipt = receiptRepo.create(makeReceipt());
      expenseRepo.create({
        group_id: groupId,
        user_id: userId,
        date: '2024-06-15',
        category: 'Food',
        comment: 'Meat',
        amount: 1500,
        currency: 'RSD',
        eur_amount: 12.8,
        receipt_id: receipt.id,
      });
      expenseRepo.create({
        group_id: groupId,
        user_id: userId,
        date: '2024-06-15',
        category: 'Household',
        comment: 'Soap',
        amount: 1000,
        currency: 'RSD',
        eur_amount: 8.5,
        receipt_id: receipt.id,
      });

      const expenses = receiptRepo.findExpensesByReceiptId(receipt.id);
      expect(expenses).toHaveLength(2);
    });
  });
});
