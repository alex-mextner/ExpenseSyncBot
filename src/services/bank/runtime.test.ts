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

  test('setData is immediately readable (behaves like saveData)', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.setData('key', { x: 1 });
    expect(shim.getData('key')).toEqual({ x: 1 });
  });

  test('saveData without args is a no-op (does not throw)', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.saveData('persist', 'yes');
    expect(() => shim.saveData()).not.toThrow();
    // Previous value remains readable.
    expect(shim.getData('persist')).toBe('yes');
  });

  test('overwriting an existing key replaces the value (ON CONFLICT upsert)', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.saveData('k', 'first');
    shim.saveData('k', 'second');
    expect(shim.getData('k')).toBe('second');
  });

  test('getData survives corrupted (non-JSON) row by returning raw string', () => {
    // Insert a non-JSON payload directly to simulate legacy data.
    db.run('INSERT INTO bank_plugin_state (connection_id, key, value) VALUES (?, ?, ?)', [
      connectionId,
      'legacyKey',
      'not-json-{',
    ]);
    const shim = createZenMoneyShim(connectionId, db, {});
    expect(shim.getData('legacyKey')).toBe('not-json-{');
  });

  test('saveData round-trips primitive types', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.saveData('num', 42);
    shim.saveData('bool', true);
    shim.saveData('str', 'hi');
    shim.saveData('nil', null);
    shim.saveData('arr', [1, 2, 3]);
    expect(shim.getData('num')).toBe(42);
    expect(shim.getData('bool')).toBe(true);
    expect(shim.getData('str')).toBe('hi');
    expect(shim.getData('nil')).toBeNull();
    expect(shim.getData('arr')).toEqual([1, 2, 3]);
  });

  test('clearData only wipes state for the target connection', () => {
    const group = groupRepo.create({ telegram_group_id: Date.now() + 2 });
    const otherConn = connRepo.create({
      group_id: group.id,
      bank_name: 'other',
      display_name: 'Other',
    }).id;

    const shim1 = createZenMoneyShim(connectionId, db, {});
    const shim2 = createZenMoneyShim(otherConn, db, {});
    shim1.saveData('a', 1);
    shim2.saveData('a', 2);

    shim1.clearData();

    expect(shim1.getData('a')).toBeUndefined();
    expect(shim2.getData('a')).toBe(2);
  });

  test('readLine resolves via injected readLineImpl', async () => {
    const impl = (prompt: string) => Promise.resolve(`answer:${prompt}`);
    const shim = createZenMoneyShim(connectionId, db, {}, impl);
    await expect(shim.readLine('enter OTP')).resolves.toBe('answer:enter OTP');
  });

  test('readLine without handler resolves to empty string (and warns)', async () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    await expect(shim.readLine('prompt')).resolves.toBe('');
  });

  test('getPreferences returns empty object when none supplied', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    expect(shim.getPreferences()).toEqual({});
  });

  test('addAccount collects in declaration order and preserves items', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.addAccount({ id: 'a' });
    shim.addAccount({ id: 'b' });
    shim.addAccount({ id: 'c' });
    const accounts = shim._getCollectedAccounts() as Array<{ id: string }>;
    expect(accounts.map((a) => a.id)).toEqual(['a', 'b', 'c']);
  });

  test('setResult overwrites on successive calls', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.setResult('first');
    shim.setResult({ final: true });
    expect(shim._getSetResult()).toEqual({ final: true });
  });

  test('_getSetResult defaults to undefined before any setResult', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    expect(shim._getSetResult()).toBeUndefined();
  });

  test('cookie stubs resolve without errors', async () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    await expect(shim.getCookies()).resolves.toEqual([]);
    await expect(shim.setCookie('d', 'n', 'v')).resolves.toBeUndefined();
    await expect(shim.clearCookies()).resolves.toBeUndefined();
    await expect(shim.saveCookies()).resolves.toBeUndefined();
    await expect(shim.restoreCookies()).resolves.toBeUndefined();
  });

  test('sync stub methods do not throw', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    expect(() => shim.trustCertificates()).not.toThrow();
    expect(() => shim.setClientPfx(null, 'example.com')).not.toThrow();
    expect(() => shim.setClientPfx(new Uint8Array([1, 2, 3]), 'example.com')).not.toThrow();
    expect(() => shim.logEvent('test', { a: 1 })).not.toThrow();
    expect(() => shim.logEvent('test')).not.toThrow();
  });

  test('isAccountSkipped always returns false (stub)', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    expect(shim.isAccountSkipped('anything')).toBe(false);
    expect(shim.isAccountSkipped('')).toBe(false);
  });

  test('static metadata: locale / application / device surfaces', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    expect(shim.locale).toBe('en');
    expect(shim.application.platform).toBe('Android');
    expect(shim.device.os.name).toBe('Android');
    expect(typeof shim.device.id).toBe('string');
    expect(shim.device.id.length).toBeGreaterThan(0);
  });

  test('getPreferences returns the same object reference handed in (by design)', () => {
    const prefs = { a: '1' };
    const shim = createZenMoneyShim(connectionId, db, prefs);
    expect(shim.getPreferences()).toBe(prefs);
  });

  test('clearData on empty connection state is a no-op (does not throw)', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    expect(() => shim.clearData()).not.toThrow();
    expect(shim.getData('anything')).toBeUndefined();
  });

  test('_getCollectedTransactions preserves insertion order and item shape', () => {
    const shim = createZenMoneyShim(connectionId, db, {});
    shim.addTransaction({ id: 'tx1', sum: -10 });
    shim.addTransaction({ id: 'tx2', sum: -20 });
    const txs = shim._getCollectedTransactions() as Array<{ id: string; sum: number }>;
    expect(txs).toHaveLength(2);
    expect(txs[0]?.id).toBe('tx1');
    expect(txs[1]?.sum).toBe(-20);
  });
});
