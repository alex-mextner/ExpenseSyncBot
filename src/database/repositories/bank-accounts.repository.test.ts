// Tests for BankAccountsRepository — balance storage updated after each scrape cycle

import type { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { BankAccountsRepository } from './bank-accounts.repository';
import { BankConnectionsRepository } from './bank-connections.repository';
import { GroupRepository } from './group.repository';

let db: Database;
let repo: BankAccountsRepository;
let connectionId: number;
let groupId: number;

db = createTestDb();
repo = new BankAccountsRepository(db);
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

describe('BankAccountsRepository', () => {
  test('upsert inserts new account', () => {
    const acc = repo.upsert({
      connection_id: connectionId,
      account_id: 'acc1',
      title: 'Main',
      balance: 100,
      currency: 'GEL',
    });
    expect(acc.id).toBeGreaterThan(0);
    expect(acc.balance).toBe(100);
  });

  test('upsert updates balance on conflict', () => {
    repo.upsert({
      connection_id: connectionId,
      account_id: 'acc1',
      title: 'Main',
      balance: 100,
      currency: 'GEL',
    });
    repo.upsert({
      connection_id: connectionId,
      account_id: 'acc1',
      title: 'Main',
      balance: 250,
      currency: 'GEL',
    });
    const accounts = repo.findByConnectionId(connectionId);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]?.balance).toBe(250);
  });

  test('findByConnectionId returns accounts for connection', () => {
    repo.upsert({
      connection_id: connectionId,
      account_id: 'acc1',
      title: 'Main',
      balance: 100,
      currency: 'GEL',
    });
    repo.upsert({
      connection_id: connectionId,
      account_id: 'acc2',
      title: 'Savings',
      balance: 500,
      currency: 'GEL',
    });
    expect(repo.findByConnectionId(connectionId)).toHaveLength(2);
  });

  test('findByGroupId returns accounts across all connections for group', () => {
    const conn2 = connRepo.create({
      group_id: groupId,
      bank_name: 'kaspi',
      display_name: 'Kaspi',
      status: 'active',
    }).id;
    repo.upsert({
      connection_id: connectionId,
      account_id: 'acc1',
      title: 'Main',
      balance: 100,
      currency: 'GEL',
    });
    repo.upsert({
      connection_id: conn2,
      account_id: 'acc2',
      title: 'Main',
      balance: 200,
      currency: 'KZT',
    });
    expect(repo.findByGroupId(groupId)).toHaveLength(2);
  });
});
