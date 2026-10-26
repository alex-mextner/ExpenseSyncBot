// Migrations 036-045: recurring patterns, refresh-token encryption, sync snapshots, composite indexes, dashboard widgets, oauth client, currency and EUR amount repairs.
// Split out of schema.ts so no single file carries the whole migration history. List order and
// migration names are the contract with already-migrated databases and must not change.

import { env } from '../../config/env';
import { encryptToken, isEncryptedToken } from '../../services/google/token-encryption';
import { migrationLogger as logger } from './migration-logger';
import type { Migration } from './types';

export const snapshotAndDataFixMigrations: Migration[] = [
  {
    name: '036_create_recurring_patterns',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS recurring_patterns (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            category TEXT NOT NULL,
            expected_amount REAL NOT NULL,
            currency TEXT NOT NULL DEFAULT 'EUR',
            interval_days INTEGER NOT NULL DEFAULT 30,
            expected_day INTEGER,
            tolerance_days INTEGER NOT NULL DEFAULT 5,
            last_seen_date TEXT,
            next_expected_date TEXT,
            status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'paused', 'dismissed')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_recurring_patterns_group
          ON recurring_patterns(group_id, status);
        `);
      logger.info('✓ Created recurring_patterns table');
    },
  },
  {
    name: '037_encrypt_existing_refresh_tokens',
    up: (db) => {
      if (!env.ENCRYPTION_KEY) {
        logger.warn(
          'ENCRYPTION_KEY not set — skipping migration 037, refresh tokens remain unencrypted',
        );
        return;
      }

      const rows = db
        .query<{ id: number; google_refresh_token: string | null }, []>(
          'SELECT id, google_refresh_token FROM groups WHERE google_refresh_token IS NOT NULL',
        )
        .all();

      let encrypted = 0;
      for (const row of rows) {
        if (!row.google_refresh_token) continue;
        // Skip already-encrypted tokens
        if (isEncryptedToken(row.google_refresh_token)) continue;

        const encryptedValue = encryptToken(row.google_refresh_token, env.ENCRYPTION_KEY);
        db.query('UPDATE groups SET google_refresh_token = ? WHERE id = ?').run(
          encryptedValue,
          row.id,
        );
        encrypted++;
      }

      logger.info(`Encrypted ${encrypted} plaintext refresh tokens`);
    },
  },
  {
    name: '038_create_sync_snapshots',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS expense_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id TEXT NOT NULL,
            group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            expense_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            category TEXT NOT NULL,
            comment TEXT NOT NULL,
            amount REAL NOT NULL,
            currency TEXT NOT NULL,
            eur_amount REAL NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_expense_snapshots_snapshot
          ON expense_snapshots(snapshot_id);
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_expense_snapshots_group
          ON expense_snapshots(group_id);
        `);

      db.exec(`
          CREATE TABLE IF NOT EXISTS budget_snapshots (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            snapshot_id TEXT NOT NULL,
            group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            budget_id INTEGER NOT NULL,
            category TEXT NOT NULL,
            month TEXT NOT NULL,
            limit_amount REAL NOT NULL,
            currency TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_budget_snapshots_snapshot
          ON budget_snapshots(snapshot_id);
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_budget_snapshots_group
          ON budget_snapshots(group_id);
        `);

      logger.info('✓ Created expense_snapshots and budget_snapshots tables');
    },
  },
  {
    name: '039_add_composite_indexes',
    up: (db) => {
      db.exec(
        'CREATE INDEX IF NOT EXISTS idx_expenses_group_category ON expenses(group_id, category);',
      );
      db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_group_date ON expenses(group_id, date);');
      logger.info('✓ Added composite indexes on expenses');
    },
  },
  {
    name: '040_create_dashboard_widgets',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS dashboard_widgets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
            config TEXT NOT NULL,
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);
      db.exec(`
          CREATE UNIQUE INDEX IF NOT EXISTS idx_dashboard_widgets_user_group
          ON dashboard_widgets(group_id, user_id);
        `);
      logger.info('✓ Created dashboard_widgets table');
    },
  },
  {
    name: '041_add_receipt_file_id_to_expenses',
    up: (db) => {
      const cols = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count FROM pragma_table_info('expenses')
          WHERE name = 'receipt_file_id'
        `);
      if (cols.get()?.count === 0) {
        db.exec(`ALTER TABLE expenses ADD COLUMN receipt_file_id TEXT`);
        logger.info('✓ Added receipt_file_id to expenses');
      }
    },
  },
  {
    name: '042_add_oauth_client_to_groups',
    up: (db) => {
      const exists = db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) as count FROM pragma_table_info('groups') WHERE name = 'oauth_client'`,
        )
        .get();
      if (exists?.count === 0) {
        db.exec(`ALTER TABLE groups ADD COLUMN oauth_client TEXT NOT NULL DEFAULT 'legacy'`);
      }
      logger.info('✓ Added oauth_client column to groups (default: legacy)');
    },
  },
  {
    name: '043_fix_default_enabled_currencies',
    up: (db) => {
      db.exec(
        `UPDATE groups SET enabled_currencies = '[]' WHERE enabled_currencies = '["USD"]' AND default_currency = 'USD' AND id NOT IN (SELECT DISTINCT group_id FROM expenses WHERE group_id IS NOT NULL)`,
      );
      logger.info('✓ Reset default enabled_currencies from ["USD"] to [] for unconfigured groups');
    },
  },
  {
    name: '044_add_invoice_to_bank_transactions',
    up: (db) => {
      const hasInvoiceAmount = db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) as count FROM pragma_table_info('bank_transactions') WHERE name = 'invoice_amount'`,
        )
        .get();
      if (hasInvoiceAmount?.count === 0) {
        db.exec(`ALTER TABLE bank_transactions ADD COLUMN invoice_amount REAL`);
        db.exec(`ALTER TABLE bank_transactions ADD COLUMN invoice_currency TEXT`);
        logger.info('✓ Added invoice_amount/invoice_currency to bank_transactions');
      }
    },
  },
  {
    name: '045_fix_corrupted_eur_amounts',
    up: (db) => {
      // Race condition in appendExpenseRow wrote EUR formulas referencing wrong rows.
      // Sync then imported those wrong EUR values into eur_amount.
      // Fix: recalculate eur_amount from amount + currency using approximate fallback rates.
      // These are recovery rates, not the exact rates used at transaction time.
      const rates: Record<string, number> = {
        EUR: 1,
        USD: 0.92,
        RUB: 0.0093,
        RSD: 0.0086,
        GBP: 1.18,
        BYN: 0.28,
        CHF: 1.05,
      };

      // Guard: skip if expenses table doesn't have eur_amount (test DBs with partial schema)
      const hasEurCol = db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) as count FROM pragma_table_info('expenses') WHERE name = 'eur_amount'`,
        )
        .get();
      if (!hasEurCol?.count) {
        logger.info('✓ expenses.eur_amount column not found, skipping');
        return;
      }

      // Find expenses where eur_amount is suspiciously constant (the bug marker)
      // or zero for non-EUR currencies
      const buggyConst = db
        .query<{ id: number; amount: number; currency: string; eur_amount: number }, []>(
          `SELECT id, amount, currency, eur_amount FROM expenses
             WHERE (ABS(eur_amount - 2.197105278) < 0.001 AND ABS(amount - 258) > 1)
                OR (eur_amount = 0 AND currency != 'EUR')`,
        )
        .all();

      if (buggyConst.length === 0) {
        logger.info('✓ No corrupted eur_amounts found');
        return;
      }

      const updateStmt = db.query<void, [number, number]>(
        `UPDATE expenses SET eur_amount = ? WHERE id = ?`,
      );

      let fixed = 0;
      for (const row of buggyConst) {
        const rate = rates[row.currency];
        if (!rate) {
          logger.warn(`[MIGRATION] No rate for ${row.currency}, skipping expense ${row.id}`);
          continue;
        }
        const correctEur = Math.round(row.amount * rate * 100) / 100;
        updateStmt.run(correctEur, row.id);
        fixed++;
      }

      logger.info(`✓ Fixed ${fixed} corrupted eur_amounts (of ${buggyConst.length} found)`);
    },
  },
];
