import type { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { BankConnectionsRepository } from '../../database/repositories/bank-connections.repository';
import { GroupRepository } from '../../database/repositories/group.repository';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { createZenMoneyShim } from './runtime';

let db: Database;
let connectionId: number;

db = createTestDb();
const groupRepo = new GroupRepository(db);
const connRepo = new BankConnectionsRepository(db);

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  connectionId = connRepo.create({ group_id: group.id, bank_name: 'tbc', display_name: 'TBC' }).id;
});

describe('ZenMoney runtime shim', () => {
  test('saveData then getData round-trips values', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.saveData('sessionToken', { token: 'abc123', expiry: 999 });
    const loaded = shim.getData('sessionToken') as { token: string };
    expect(loaded.token).toBe('abc123');
  });

  test('getData returns undefined for missing key', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    expect(shim.getData('nonexistent')).toBeUndefined();
  });

  test('getPreferences returns passed preferences', () => {
    const shim = createZenMoneyShim(connectionId, db, { username: 'user', password: 'pass' });
    expect(shim.getPreferences()).toEqual({ username: 'user', password: 'pass' });
  });

  test('addAccount/addTransaction accumulate in internal state', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.addAccount({ id: 'acc1', title: 'Main', balance: 100, currency: 'GEL' });
    shim.addTransaction({ id: 'tx1', sum: -50, date: '2026-03-27', currency: 'GEL' });
    expect(shim._getCollectedAccounts()).toHaveLength(1);
    expect(shim._getCollectedTransactions()).toHaveLength(1);
  });

  test('clearData removes plugin state for connection', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.saveData('key1', 'value1');
    shim.saveData('key2', 'value2');
    shim.clearData();
    expect(shim.getData('key1')).toBeUndefined();
    expect(shim.getData('key2')).toBeUndefined();
  });

  test('setResult and _getSetResult', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.setResult({ accounts: [], transactions: [{ id: 'tx', sum: -10 }] });
    const result = shim._getSetResult() as { transactions: unknown[] };
    expect(result.transactions).toHaveLength(1);
  });

  test('saveData is isolated per connection_id', () => {
    const group = groupRepo.create({ telegram_group_id: Date.now() + 1 });
    const conn2 = connRepo.create({
      group_id: group.id,
      bank_name: 'kaspi',
      display_name: 'Kaspi',
    }).id;

    const shim1 = createZenMoneyShim(connectionId, db, {});
    const shim2 = createZenMoneyShim(conn2, db, {});

    shim1.saveData('token', 'conn1-token');
    shim2.saveData('token', 'conn2-token');

    expect(shim1.getData('token')).toBe('conn1-token');
    expect(shim2.getData('token')).toBe('conn2-token');
  });
});
