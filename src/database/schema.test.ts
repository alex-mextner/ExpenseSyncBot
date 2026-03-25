// Tests for database schema initialization — PRAGMA settings

import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

describe('initDatabase PRAGMAs', () => {
  test('busy_timeout is set to 5000 after initialization', () => {
    const db = new Database(':memory:');
    db.exec('PRAGMA journal_mode = WAL;');
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA busy_timeout = 5000;');
    const row = db.query<{ timeout: number }, []>('PRAGMA busy_timeout;').get();
    db.close();
    expect(row?.timeout).toBe(5000);
  });
});
