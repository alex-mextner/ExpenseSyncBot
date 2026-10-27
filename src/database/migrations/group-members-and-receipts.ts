// Migrations 046-051: group members, receipts table and links, bank card flag, topic-scoped chat history.
// Split out of schema.ts so no single file carries the whole migration history. List order and
// migration names are the contract with already-migrated databases and must not change.

import { migrationLogger as logger } from './migration-logger';
import type { Migration } from './types';

export const groupMemberAndReceiptMigrations: Migration[] = [
  {
    name: '046_create_group_members',
    up: (db) => {
      // Add title column to groups table
      const hasTitle = db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) as count FROM pragma_table_info('groups') WHERE name = 'title'`,
        )
        .get();
      if (hasTitle?.count === 0) {
        db.exec(`ALTER TABLE groups ADD COLUMN title TEXT`);
        logger.info('✓ Added title column to groups');
      }

      // Add invite_link column to groups table for Telegram-native buttons
      const hasInviteLink = db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) as count FROM pragma_table_info('groups') WHERE name = 'invite_link'`,
        )
        .get();
      if (hasInviteLink?.count === 0) {
        db.exec(`ALTER TABLE groups ADD COLUMN invite_link TEXT`);
        logger.info('✓ Added invite_link column to groups');
      }

      // Create group_members junction table for tracking all user-group memberships
      db.exec(`
          CREATE TABLE IF NOT EXISTS group_members (
            id INTEGER PRIMARY KEY,
            telegram_id INTEGER NOT NULL,
            group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            joined_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(telegram_id, group_id)
          )
        `);
      db.exec(
        `CREATE INDEX IF NOT EXISTS idx_group_members_telegram_id ON group_members(telegram_id)`,
      );

      // Backfill from existing users
      db.exec(`
          INSERT OR IGNORE INTO group_members (telegram_id, group_id)
          SELECT telegram_id, group_id FROM users WHERE group_id IS NOT NULL
        `);

      logger.info('✓ Created group_members table');
    },
  },
  {
    name: '047_create_receipts_table',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS receipts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL REFERENCES groups(id) ON DELETE CASCADE,
            photo_queue_id INTEGER REFERENCES photo_processing_queue(id) ON DELETE SET NULL,
            image_path TEXT,
            total_amount REAL NOT NULL,
            currency TEXT NOT NULL,
            date TEXT NOT NULL,
            created_at TEXT NOT NULL DEFAULT (datetime('now'))
          )
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_receipts_group_date
          ON receipts(group_id, date)
        `);
      logger.info('✓ Created receipts table');

      // Add receipt_id FK to expenses
      const hasReceiptId = db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) as count FROM pragma_table_info('expenses') WHERE name = 'receipt_id'`,
        )
        .get();
      if (hasReceiptId?.count === 0) {
        db.exec(
          `ALTER TABLE expenses ADD COLUMN receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL`,
        );
        logger.info('✓ Added receipt_id to expenses');
      }
    },
  },
  {
    name: '048_add_expenses_receipt_id_index',
    up: (db) => {
      db.exec('CREATE INDEX IF NOT EXISTS idx_expenses_receipt_id ON expenses(receipt_id)');
      logger.info('✓ Created index on expenses.receipt_id');
    },
  },
  {
    name: '049_add_bank_transactions_matched_receipt_id',
    up: (db) => {
      const hasColumn = db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) as count FROM pragma_table_info('bank_transactions') WHERE name = 'matched_receipt_id'`,
        )
        .get();
      if (hasColumn?.count === 0) {
        db.exec(
          `ALTER TABLE bank_transactions ADD COLUMN matched_receipt_id INTEGER REFERENCES receipts(id) ON DELETE SET NULL`,
        );
        db.exec(
          'CREATE INDEX IF NOT EXISTS idx_bank_transactions_matched_receipt_id ON bank_transactions(matched_receipt_id)',
        );
        logger.info('✓ Added matched_receipt_id to bank_transactions');
      }
    },
  },
  {
    name: '050_add_bank_cards_enabled_to_groups',
    up: (db) => {
      const check = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count FROM pragma_table_info('groups')
          WHERE name = 'bank_cards_enabled'
        `);
      if (check.get()?.count === 0) {
        db.exec(`ALTER TABLE groups ADD COLUMN bank_cards_enabled INTEGER NOT NULL DEFAULT 0`);
        logger.info('✓ Added bank_cards_enabled to groups');
      }
    },
  },
  {
    name: '051_scope_chat_history_by_topic',
    up: (db) => {
      const hasColumn = db
        .query<{ count: number }, []>(
          `SELECT COUNT(*) as count FROM pragma_table_info('chat_messages') WHERE name = 'message_thread_id'`,
        )
        .get();
      if (hasColumn?.count === 0) {
        db.exec(`ALTER TABLE chat_messages ADD COLUMN message_thread_id INTEGER`);
      }
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_chat_messages_group_thread_id
          ON chat_messages(group_id, message_thread_id, id)
        `);
      logger.info('✓ Scoped chat history by Telegram topic');
    },
  },
];
