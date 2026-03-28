// Tests for OTP manager — pending request lifecycle.
// Uses an in-memory SQLite so bank-sync and bot processes can be tested in isolation.

import { Database } from 'bun:sqlite';
import { afterEach, describe, expect, mock, test } from 'bun:test';

const testDb = new Database(':memory:');
testDb.exec(`
  CREATE TABLE IF NOT EXISTS bank_otp_requests (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL UNIQUE,
    group_telegram_id INTEGER NOT NULL,
    code TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL
  )
`);

// Must mock before importing otp-manager (dynamic import below ensures order)
mock.module('../../database', () => ({ database: { db: testDb } }));

const { cancelOtpRequest, registerOtpRequest, resolveOtpForGroup } = await import('./otp-manager');

afterEach(() => {
  testDb.exec('DELETE FROM bank_otp_requests');
});

describe('registerOtpRequest / resolveOtpForGroup', () => {
  test('resolves promise when code sent to matching group', async () => {
    const promise = registerOtpRequest(1, 100);
    const resolved = resolveOtpForGroup(100, '123456');
    expect(resolved).toBe(true);
    expect(await promise).toBe('123456');
  });

  test('returns false when no pending OTP for group', () => {
    expect(resolveOtpForGroup(999, 'code')).toBe(false);
  });

  test('does not resolve for wrong group', async () => {
    const promise = registerOtpRequest(1, 100);
    const resolved = resolveOtpForGroup(200, 'code');
    expect(resolved).toBe(false);
    cancelOtpRequest(1);
    await promise.catch(() => {});
  });
});

describe('cancelOtpRequest', () => {
  test('rejects pending promise', async () => {
    const promise = registerOtpRequest(1, 100);
    cancelOtpRequest(1);
    await expect(promise).rejects.toThrow('OTP запрос отменён');
  });

  test('is a no-op when no pending request', () => {
    expect(() => cancelOtpRequest(999)).not.toThrow();
  });
});
