// Pins the migration runner against a golden captured from the pre-split schema.ts: a fresh
// database must end with the same objects in the same creation order and the same migration
// ledger, and the migrations that rewrite existing rows must keep their exact data semantics.

import { mock } from 'bun:test';

const ENCRYPTION_KEY = 'ab'.repeat(32);

mock.module('../config/env', () => ({
  env: { DATABASE_PATH: ':memory:', ENCRYPTION_KEY },
}));

import { Database } from 'bun:sqlite';
import { beforeEach, describe, expect, test } from 'bun:test';
import { env } from '../config/env';
import { decryptToken, encryptToken, isEncryptedToken } from '../services/google/token-encryption';
import { runMigrations } from './schema';
import golden from './schema-migrations.golden.json';

interface SchemaObject {
  type: string;
  name: string;
  tbl_name: string;
  sql: string | null;
}

function freshDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}

function schemaObjects(db: Database): SchemaObject[] {
  return db
    .query<SchemaObject, []>('SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY rowid')
    .all();
}

function ledgerNames(db: Database): string[] {
  return db
    .query<{ name: string }, []>('SELECT name FROM migrations ORDER BY id')
    .all()
    .map((row) => row.name);
}

/** Forget that a migration ran so the next runMigrations() applies it again. */
function forgetMigration(db: Database, name: string): void {
  db.query('DELETE FROM migrations WHERE name = ?').run(name);
}

describe('fresh database', () => {
  test('ends with exactly the schema objects, in creation order, of the original migrations', () => {
    expect(schemaObjects(freshDb())).toEqual(golden.objects);
  });

  test('records every migration in the original order (028 intentionally before 027)', () => {
    const names = ledgerNames(freshDb());
    expect(names).toEqual(golden.migrations);
    expect(names.indexOf('028_add_prefill_to_bank_transactions')).toBeLessThan(
      names.indexOf('027_add_bank_panel_summary_to_groups'),
    );
  });

  test('a second run applies nothing and leaves the schema untouched', () => {
    const db = freshDb();
    const before = schemaObjects(db);
    runMigrations(db);
    expect(schemaObjects(db)).toEqual(before);
    expect(ledgerNames(db)).toEqual(golden.migrations);
  });
});

describe('data-rewriting migrations', () => {
  let db: Database;
  let groupId: number;
  let userId: number;

  beforeEach(() => {
    db = freshDb();
    groupId = Number(
      db.query('INSERT INTO groups (telegram_group_id) VALUES (?)').run(-1001).lastInsertRowid,
    );
    userId = Number(db.query('INSERT INTO users (telegram_id) VALUES (1)').run().lastInsertRowid);
  });

  function insertBankTransactions(
    rows: { externalId: string; rawData: string; accountId: string | null }[],
  ) {
    const connectionId = Number(
      db
        .query(
          `INSERT INTO bank_connections (group_id, bank_name, display_name) VALUES (?, 'zen', 'Bank')`,
        )
        .run(groupId).lastInsertRowid,
    );
    const insert = db.query(
      `INSERT INTO bank_transactions (connection_id, external_id, date, amount, currency, raw_data, account_id)
       VALUES (?, ?, '2025-01-01', 10, 'EUR', ?, ?)`,
    );
    for (const row of rows) {
      insert.run(connectionId, row.externalId, row.rawData, row.accountId);
    }
  }

  function accountIdOf(externalId: string): string | null {
    const row = db
      .query<{ account_id: string | null }, [string]>(
        'SELECT account_id FROM bank_transactions WHERE external_id = ?',
      )
      .get(externalId);
    return row?.account_id ?? null;
  }

  function tokenOfGroup(telegramGroupId: number): string | null {
    const row = db
      .query<{ google_refresh_token: string | null }, [number]>(
        'SELECT google_refresh_token FROM groups WHERE telegram_group_id = ?',
      )
      .get(telegramGroupId);
    return row?.google_refresh_token ?? null;
  }

  function enabledCurrenciesOf(id: number): string | undefined {
    return db
      .query<{ enabled_currencies: string }, [number]>(
        'SELECT enabled_currencies FROM groups WHERE id = ?',
      )
      .get(id)?.enabled_currencies;
  }

  function eurAmountOf(id: number): number | undefined {
    return db
      .query<{ eur_amount: number }, [number]>('SELECT eur_amount FROM expenses WHERE id = ?')
      .get(id)?.eur_amount;
  }

  test('035 backfills account_id only where it is NULL and raw_data carries an account', () => {
    insertBankTransactions([
      { externalId: 'has-account', rawData: '{"account":"acc-1"}', accountId: null },
      { externalId: 'no-account', rawData: '{"other":1}', accountId: null },
      { externalId: 'already-set', rawData: '{"account":"acc-2"}', accountId: 'keep-me' },
    ]);

    forgetMigration(db, '035_backfill_account_id_in_bank_transactions');
    runMigrations(db);

    expect(accountIdOf('has-account')).toBe('acc-1');
    expect(accountIdOf('no-account')).toBeNull();
    expect(accountIdOf('already-set')).toBe('keep-me');
  });

  test('037 encrypts plaintext refresh tokens and leaves encrypted and NULL ones alone', () => {
    const alreadyEncrypted = encryptToken('other-token', ENCRYPTION_KEY);
    db.query('UPDATE groups SET google_refresh_token = ? WHERE id = ?').run('plain-token', groupId);
    db.query('INSERT INTO groups (telegram_group_id, google_refresh_token) VALUES (-1002, ?)').run(
      alreadyEncrypted,
    );
    db.query('INSERT INTO groups (telegram_group_id) VALUES (-1003)').run();

    forgetMigration(db, '037_encrypt_existing_refresh_tokens');
    runMigrations(db);

    const migrated = tokenOfGroup(-1001);
    expect(migrated).not.toBeNull();
    expect(isEncryptedToken(migrated as string)).toBe(true);
    expect(decryptToken(migrated as string, ENCRYPTION_KEY)).toBe('plain-token');
    expect(tokenOfGroup(-1002)).toBe(alreadyEncrypted);
    expect(tokenOfGroup(-1003)).toBeNull();
  });

  test('037 is skipped without ENCRYPTION_KEY: tokens stay plaintext but the migration is recorded', () => {
    db.query('UPDATE groups SET google_refresh_token = ? WHERE id = ?').run('plain-token', groupId);
    forgetMigration(db, '037_encrypt_existing_refresh_tokens');

    const originalKey = env.ENCRYPTION_KEY;
    env.ENCRYPTION_KEY = '';
    try {
      runMigrations(db);
    } finally {
      env.ENCRYPTION_KEY = originalKey;
    }

    expect(tokenOfGroup(-1001)).toBe('plain-token');
    expect(ledgerNames(db)).toContain('037_encrypt_existing_refresh_tokens');
  });

  test('043 resets the default ["USD"] currencies only for groups without expenses', () => {
    const insertGroup = db.query(
      'INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, ?, ?)',
    );
    const unconfigured = Number(insertGroup.run(-2001, 'USD', '["USD"]').lastInsertRowid);
    const withExpenses = Number(insertGroup.run(-2002, 'USD', '["USD"]').lastInsertRowid);
    const otherDefault = Number(insertGroup.run(-2003, 'EUR', '["USD"]').lastInsertRowid);
    const customized = Number(insertGroup.run(-2004, 'USD', '["USD","EUR"]').lastInsertRowid);
    db.query(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
       VALUES (?, ?, '2025-01-01', 'Food', '', 1, 'EUR', 1)`,
    ).run(withExpenses, userId);

    forgetMigration(db, '043_fix_default_enabled_currencies');
    runMigrations(db);

    expect(enabledCurrenciesOf(unconfigured)).toBe('[]');
    expect(enabledCurrenciesOf(withExpenses)).toBe('["USD"]');
    expect(enabledCurrenciesOf(otherDefault)).toBe('["USD"]');
    expect(enabledCurrenciesOf(customized)).toBe('["USD","EUR"]');
  });

  test('045 recomputes corrupted eur_amounts with rounded fallback rates and skips unknown currencies', () => {
    const insertExpense = db.query(
      `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
       VALUES (?, ?, '2025-01-01', 'Food', ?, ?, ?, ?)`,
    );
    const insert = (comment: string, amount: number, currency: string, eur: number): number =>
      Number(insertExpense.run(groupId, userId, comment, amount, currency, eur).lastInsertRowid);
    const constantMarker = insert('marker', 1000, 'RSD', 2.197105278);
    const zeroNonEur = insert('zero', 12.345, 'USD', 0);
    const markerWithAmount258 = insert('legit', 258, 'RSD', 2.197105278);
    const zeroEur = insert('eur', 5, 'EUR', 0);
    const unknownCurrency = insert('jpy', 100, 'JPY', 0);

    forgetMigration(db, '045_fix_corrupted_eur_amounts');
    runMigrations(db);

    expect(eurAmountOf(constantMarker)).toBe(8.6);
    expect(eurAmountOf(zeroNonEur)).toBe(11.36);
    expect(eurAmountOf(markerWithAmount258)).toBe(2.197105278);
    expect(eurAmountOf(zeroEur)).toBe(0);
    expect(eurAmountOf(unknownCurrency)).toBe(0);
  });
});
