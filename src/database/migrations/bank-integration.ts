// Migrations 021-035: bank connections, accounts, transactions, merchant rules, bank column additions and backfills (028 runs before 027, as originally shipped).
// Split out of schema.ts so no single file carries the whole migration history. List order and
// migration names are the contract with already-migrated databases and must not change.

import { migrationLogger as logger } from './migration-logger';
import type { Migration } from './types';

export const bankIntegrationMigrations: Migration[] = [
  {
    name: '021_create_bank_connections',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS bank_connections (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            bank_name TEXT NOT NULL,
            display_name TEXT NOT NULL,
            status TEXT NOT NULL DEFAULT 'setup'
              CHECK(status IN ('setup', 'active', 'disconnected')),
            consecutive_failures INTEGER NOT NULL DEFAULT 0,
            last_sync_at TEXT,
            last_error TEXT,
            panel_message_id INTEGER,
            panel_message_thread_id INTEGER,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(group_id, bank_name)
          );
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bank_connections_group_id
          ON bank_connections(group_id);
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bank_connections_status
          ON bank_connections(status);
        `);
      logger.info('✓ Created bank_connections table');
    },
  },
  {
    name: '022_create_bank_credentials',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS bank_credentials (
            connection_id INTEGER PRIMARY KEY
              REFERENCES bank_connections(id) ON DELETE CASCADE,
            encrypted_data TEXT NOT NULL
          );
        `);
      logger.info('✓ Created bank_credentials table');
    },
  },
  {
    name: '023_create_bank_plugin_state',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS bank_plugin_state (
            connection_id INTEGER NOT NULL
              REFERENCES bank_connections(id) ON DELETE CASCADE,
            key TEXT NOT NULL,
            value TEXT NOT NULL,
            PRIMARY KEY(connection_id, key)
          );
        `);
      logger.info('✓ Created bank_plugin_state table');
    },
  },
  {
    name: '024_create_bank_accounts',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS bank_accounts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id INTEGER NOT NULL
              REFERENCES bank_connections(id) ON DELETE CASCADE,
            account_id TEXT NOT NULL,
            title TEXT NOT NULL,
            balance REAL NOT NULL,
            currency TEXT NOT NULL,
            type TEXT,
            updated_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(connection_id, account_id)
          );
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bank_accounts_connection_id
          ON bank_accounts(connection_id);
        `);
      logger.info('✓ Created bank_accounts table');
    },
  },
  {
    name: '025_create_bank_transactions',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS bank_transactions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id INTEGER NOT NULL
              REFERENCES bank_connections(id) ON DELETE CASCADE,
            external_id TEXT NOT NULL,
            date TEXT NOT NULL,
            amount REAL NOT NULL,
            sign_type TEXT NOT NULL DEFAULT 'debit'
              CHECK(sign_type IN ('debit', 'credit', 'reversal')),
            currency TEXT NOT NULL,
            merchant TEXT,
            merchant_normalized TEXT,
            mcc INTEGER,
            raw_data TEXT NOT NULL,
            matched_expense_id INTEGER REFERENCES expenses(id) ON DELETE SET NULL,
            telegram_message_id INTEGER,
            edit_in_progress INTEGER NOT NULL DEFAULT 0,
            status TEXT NOT NULL DEFAULT 'pending'
              CHECK(status IN ('pending', 'confirmed', 'skipped', 'skipped_reversal')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(connection_id, external_id)
          );
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bank_transactions_connection_id
          ON bank_transactions(connection_id);
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bank_transactions_status
          ON bank_transactions(status);
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_bank_transactions_date
          ON bank_transactions(date);
        `);
      logger.info('✓ Created bank_transactions table');
    },
  },
  {
    name: '026_create_merchant_tables',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS merchant_rules (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            pattern TEXT NOT NULL,
            flags TEXT NOT NULL DEFAULT 'i',
            replacement TEXT NOT NULL,
            category TEXT,
            confidence REAL NOT NULL DEFAULT 1.0,
            status TEXT NOT NULL DEFAULT 'pending_review'
              CHECK(status IN ('pending_review', 'approved', 'rejected')),
            source TEXT NOT NULL DEFAULT 'ai'
              CHECK(source IN ('ai', 'manual')),
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            updated_at TEXT NOT NULL DEFAULT (datetime('now'))
          );
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_merchant_rules_status
          ON merchant_rules(status);
        `);
      db.exec(`
          CREATE TABLE IF NOT EXISTS merchant_rule_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            merchant_raw TEXT NOT NULL,
            mcc INTEGER,
            group_id INTEGER REFERENCES groups(id) ON DELETE SET NULL,
            user_category TEXT,
            user_comment TEXT,
            processed INTEGER NOT NULL DEFAULT 0,
            created_at TEXT NOT NULL DEFAULT (datetime('now')),
            UNIQUE(merchant_raw)
          );
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_merchant_rule_requests_processed
          ON merchant_rule_requests(processed);
        `);
      logger.info('✓ Created merchant_rules and merchant_rule_requests tables');
    },
  },
  {
    name: '028_add_prefill_to_bank_transactions',
    up: (db) => {
      const cols = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count FROM pragma_table_info('bank_transactions')
          WHERE name = 'prefill_category'
        `);
      if (cols.get()?.count === 0) {
        db.exec(`
            ALTER TABLE bank_transactions ADD COLUMN prefill_category TEXT;
            ALTER TABLE bank_transactions ADD COLUMN prefill_comment TEXT;
          `);
        logger.info('✓ Added prefill_category/prefill_comment to bank_transactions');
      }
    },
  },
  {
    name: '027_add_bank_panel_summary_to_groups',
    up: (db) => {
      const check = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count FROM pragma_table_info('groups')
          WHERE name = 'bank_panel_summary_message_id'
        `);
      if (check.get()?.count === 0) {
        db.exec(`
            ALTER TABLE groups ADD COLUMN bank_panel_summary_message_id INTEGER;
          `);
        logger.info('✓ Added bank_panel_summary_message_id to groups');
      }
    },
  },
  {
    name: '029_create_group_spreadsheets',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS group_spreadsheets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL REFERENCES groups(id),
            year INTEGER NOT NULL,
            spreadsheet_id TEXT NOT NULL,
            UNIQUE(group_id, year)
          );
        `);

      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_group_spreadsheets_group_year
          ON group_spreadsheets(group_id, year);
        `);

      // Only migrate if groups.spreadsheet_id still exists (skip on dbs that ran the old 021).
      const hasSpreadsheetCol = db
        .query<{ count: number }, []>(`
          SELECT COUNT(*) as count FROM pragma_table_info('groups') WHERE name = 'spreadsheet_id'
        `)
        .get();

      if (hasSpreadsheetCol?.count) {
        // Migrate existing spreadsheet_id to the year of the group's earliest expense.
        // Fallback: current_year - 1 (for groups with no expenses yet).
        db.exec(`
            INSERT OR IGNORE INTO group_spreadsheets (group_id, year, spreadsheet_id)
            SELECT
              g.id,
              COALESCE(
                (SELECT MIN(CAST(strftime('%Y', e.date) AS INTEGER)) FROM expenses e WHERE e.group_id = g.id),
                CAST(strftime('%Y', 'now') AS INTEGER) - 1
              ),
              g.spreadsheet_id
            FROM groups g
            WHERE g.spreadsheet_id IS NOT NULL;
          `);

        // Drop the now-redundant column from groups
        db.exec(`ALTER TABLE groups DROP COLUMN spreadsheet_id;`);
      }

      logger.info('✓ Created group_spreadsheets table, migrated existing spreadsheet_ids');
    },
  },
  {
    name: '030_create_bank_otp_requests',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS bank_otp_requests (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            connection_id INTEGER NOT NULL UNIQUE,
            group_telegram_id INTEGER NOT NULL,
            code TEXT,
            status TEXT NOT NULL DEFAULT 'pending',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            expires_at TEXT NOT NULL
          );
        `);
      logger.info('✓ Created bank_otp_requests table');
    },
  },
  {
    name: '031_add_awaiting_comment_to_bank_transactions',
    up: (db) => {
      const cols = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count FROM pragma_table_info('bank_transactions')
          WHERE name = 'awaiting_comment'
        `);
      if (cols.get()?.count === 0) {
        db.exec(
          `ALTER TABLE bank_transactions ADD COLUMN awaiting_comment INTEGER NOT NULL DEFAULT 0`,
        );
        logger.info('✓ Added awaiting_comment to bank_transactions');
      }
    },
  },
  {
    name: '032_add_time_to_bank_transactions',
    up: (db) => {
      const cols = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count FROM pragma_table_info('bank_transactions')
          WHERE name = 'time'
        `);
      if (cols.get()?.count === 0) {
        db.exec(`ALTER TABLE bank_transactions ADD COLUMN time TEXT`);
        logger.info('✓ Added time to bank_transactions');
      }
    },
  },
  {
    name: '033_add_is_excluded_to_bank_accounts',
    up: (db) => {
      const cols = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count FROM pragma_table_info('bank_accounts')
          WHERE name = 'is_excluded'
        `);
      if (cols.get()?.count === 0) {
        db.exec(`ALTER TABLE bank_accounts ADD COLUMN is_excluded INTEGER NOT NULL DEFAULT 0`);
        logger.info('✓ Added is_excluded to bank_accounts');
      }
    },
  },
  {
    name: '034_add_account_id_to_bank_transactions',
    up: (db) => {
      const cols = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count FROM pragma_table_info('bank_transactions')
          WHERE name = 'account_id'
        `);
      if (cols.get()?.count === 0) {
        db.exec(`ALTER TABLE bank_transactions ADD COLUMN account_id TEXT`);
        logger.info('✓ Added account_id to bank_transactions');
      }
    },
  },
  {
    name: '035_backfill_account_id_in_bank_transactions',
    up: (db) => {
      // Populate account_id from raw_data JSON for existing transactions.
      // raw_data stores the ZenTransaction object; the 'account' field (if present)
      // is the ZenPlugins account id that maps to bank_accounts.account_id.
      const result = db.exec(`
          UPDATE bank_transactions
          SET account_id = json_extract(raw_data, '$.account')
          WHERE account_id IS NULL
            AND json_extract(raw_data, '$.account') IS NOT NULL
        `);
      logger.info({ changes: result }, '✓ Backfilled account_id from raw_data');
    },
  },
];
