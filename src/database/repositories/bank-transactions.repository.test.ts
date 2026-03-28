// Tests for BankTransactionsRepository — covers insert deduplication, filtering, and group_id security.
import type { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { BankConnectionsRepository } from './bank-connections.repository';
import { BankTransactionsRepository } from './bank-transactions.repository';
import { GroupRepository } from './group.repository';

let db: Database;
let repo: BankTransactionsRepository;
let connectionId: number;
let groupId: number;

db = createTestDb();
repo = new BankTransactionsRepository(db);
const connRepo = new BankConnectionsRepository(db);
const groupRepo = new GroupRepository(db);

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  groupId = group.id;
  connectionId = connRepo.create({
    group_id: group.id,
    bank_name: 'tbc',
    display_name: 'TBC',
    status: 'active',
  }).id;
});

const baseTx = {
  connection_id: 0, // set in tests
  external_id: 'ext-001',
  date: '2026-03-27',
  amount: 45.0,
  sign_type: 'debit' as const,
  currency: 'GEL',
  raw_data: '{}',
  status: 'pending' as const,
};

describe('BankTransactionsRepository', () => {
  test('insertIgnore inserts new transaction', () => {
    const tx = repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    expect(tx).not.toBeNull();
    expect(tx?.amount).toBe(45.0);
    expect(tx?.status).toBe('pending');
  });

  test('insertIgnore returns null on duplicate external_id', () => {
    repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    const duplicate = repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    expect(duplicate).toBeNull();
  });

  test('findPendingByConnectionId returns only pending', () => {
    repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    repo.insertIgnore({
      ...baseTx,
      connection_id: connectionId,
      external_id: 'ext-002',
      status: 'confirmed',
    });
    const pending = repo.findPendingByConnectionId(connectionId);
    expect(pending).toHaveLength(1);
    expect(pending.at(0)?.external_id).toBe('ext-001');
  });

  test('findById requires correct groupId (security)', () => {
    const tx = repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    expect(tx).not.toBeNull();
    if (!tx) return;
    expect(repo.findById(tx.id, groupId)).not.toBeNull();
    expect(repo.findById(tx.id, groupId + 999)).toBeNull();
  });

  test('findByGroupId scopes to group', () => {
    repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    const results = repo.findByGroupId(groupId, {});
    expect(results).toHaveLength(1);
  });

  test('findByGroupId filters by status', () => {
    repo.insertIgnore({
      ...baseTx,
      connection_id: connectionId,
      external_id: 'e1',
      status: 'pending',
    });
    repo.insertIgnore({
      ...baseTx,
      connection_id: connectionId,
      external_id: 'e2',
      status: 'confirmed',
    });
    const pending = repo.findByGroupId(groupId, { status: 'pending' });
    expect(pending).toHaveLength(1);
  });

  test('updateStatus changes status', () => {
    const tx = repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    expect(tx).not.toBeNull();
    if (!tx) return;
    repo.updateStatus(tx.id, groupId, 'confirmed');
    expect(repo.findById(tx.id, groupId)?.status).toBe('confirmed');
  });

  test('setTelegramMessageId stores message id', () => {
    const tx = repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    expect(tx).not.toBeNull();
    if (!tx) return;
    repo.setTelegramMessageId(tx.id, 12345);
    expect(repo.findById(tx.id, groupId)?.telegram_message_id).toBe(12345);
  });

  test('setEditInProgress toggles flag', () => {
    const tx = repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    expect(tx).not.toBeNull();
    if (!tx) return;
    repo.setEditInProgress(tx.id, true);
    expect(repo.findById(tx.id, groupId)?.edit_in_progress).toBe(1);
    repo.setEditInProgress(tx.id, false);
    expect(repo.findById(tx.id, groupId)?.edit_in_progress).toBe(0);
  });

  test('confirm-claim transaction prevents duplicate expense on concurrent calls (TOCTOU)', () => {
    const tx = repo.insertIgnore({ ...baseTx, connection_id: connectionId });
    expect(tx).not.toBeNull();
    if (!tx) return;

    // Mirrors the handleBankConfirmCallback atomic claim pattern.
    const claimTx = db.transaction(() => {
      const freshTx = repo.findById(tx.id, groupId);
      if (!freshTx) return null;
      if (freshTx.status !== 'pending') return false as const;
      repo.updateStatus(tx.id, groupId, 'confirmed');
      return freshTx;
    });

    // First caller claims the transaction successfully.
    const first = claimTx();
    expect(first).not.toBeNull();
    expect(first).not.toBe(false);
    expect(first !== null && first !== false && first.id).toBe(tx.id);

    // Second caller sees status='confirmed' — returns false, no duplicate.
    const second = claimTx();
    expect(second).toBe(false);
  });

  test('confirm-claim transaction returns null for nonexistent tx', () => {
    const claimTx = db.transaction(() => {
      const freshTx = repo.findById(999999, groupId);
      if (!freshTx) return null;
      if (freshTx.status !== 'pending') return false as const;
      repo.updateStatus(999999, groupId, 'confirmed');
      return freshTx;
    });

    expect(claimTx()).toBeNull();
  });
});
