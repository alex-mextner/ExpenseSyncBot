// Tests for database schema initialization — PRAGMA settings

import { describe, expect, test } from 'bun:test';
import { initDatabase } from './schema';

describe('initDatabase PRAGMAs', () => {
  test('busy_timeout is set to 5000', () => {
    process.env['DATABASE_PATH'] = ':memory:';
    const db = initDatabase();
    const row = db.query<{ timeout: number }, []>('PRAGMA busy_timeout;').get();
    expect(row?.timeout).toBe(5000);
    db.close();
  });

  test('WAL journal mode is enabled', () => {
    process.env['DATABASE_PATH'] = ':memory:';
    const db = initDatabase();
    const row = db.query<{ journal_mode: string }, []>('PRAGMA journal_mode;').get();
    expect(row?.journal_mode).toBe('wal');
    db.close();
  });

  test('foreign keys are enabled', () => {
    process.env['DATABASE_PATH'] = ':memory:';
    const db = initDatabase();
    const row = db.query<{ foreign_keys: number }, []>('PRAGMA foreign_keys;').get();
    expect(row?.foreign_keys).toBe(1);
    db.close();
  });
});
