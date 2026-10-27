// Migrations 010-017: photo processing queue, receipt items, expense items, their later column additions, active topic.
// Split out of schema.ts so no single file carries the whole migration history. List order and
// migration names are the contract with already-migrated databases and must not change.

import { migrationLogger as logger } from './migration-logger';
import type { Migration } from './types';

export const photoQueueAndReceiptItemMigrations: Migration[] = [
  {
    name: '010_create_photo_processing_queue',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS photo_processing_queue (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            message_id INTEGER NOT NULL,
            message_thread_id INTEGER,
            file_id TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'processing', 'done', 'error')),
            error_message TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_photo_queue_status
          ON photo_processing_queue(status);
        `);

      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_photo_queue_group_user
          ON photo_processing_queue(group_id, user_id);
        `);
    },
  },
  {
    name: '011_create_receipt_items',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS receipt_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            photo_queue_id INTEGER NOT NULL,
            name_ru TEXT NOT NULL,
            name_original TEXT,
            quantity REAL NOT NULL,
            price REAL NOT NULL,
            total REAL NOT NULL,
            currency TEXT NOT NULL,
            suggested_category TEXT NOT NULL,
            possible_categories TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed')),
            confirmed_category TEXT,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (photo_queue_id) REFERENCES photo_processing_queue(id) ON DELETE CASCADE
          );
        `);

      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_receipt_items_queue_id
          ON receipt_items(photo_queue_id);
        `);

      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_receipt_items_status
          ON receipt_items(status);
        `);
    },
  },
  {
    name: '012_create_expense_items',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS expense_items (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            expense_id INTEGER NOT NULL,
            name_ru TEXT NOT NULL,
            name_original TEXT,
            quantity REAL NOT NULL,
            price REAL NOT NULL,
            total REAL NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (expense_id) REFERENCES expenses(id) ON DELETE CASCADE
          );
        `);

      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_expense_items_expense_id
          ON expense_items(expense_id);
        `);
    },
  },
  {
    name: '013_add_message_thread_id_to_photo_queue',
    up: (db) => {
      // Check if column already exists (SQLite doesn't have IF NOT EXISTS for ALTER TABLE)
      const checkColumn = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count
          FROM pragma_table_info('photo_processing_queue')
          WHERE name = 'message_thread_id'
        `);
      const result = checkColumn.get();

      if (result && result.count === 0) {
        db.exec(`
            ALTER TABLE photo_processing_queue
            ADD COLUMN message_thread_id INTEGER;
          `);
        logger.info('✓ Added message_thread_id column to photo_processing_queue');
      }
    },
  },
  {
    name: '014_add_waiting_for_category_input',
    up: (db) => {
      // Check if column already exists
      const checkColumn = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count
          FROM pragma_table_info('receipt_items')
          WHERE name = 'waiting_for_category_input'
        `);
      const result = checkColumn.get();

      if (result && result.count === 0) {
        db.exec(`
            ALTER TABLE receipt_items
            ADD COLUMN waiting_for_category_input INTEGER DEFAULT 0;
          `);
        logger.info('✓ Added waiting_for_category_input column to receipt_items');
      }
    },
  },
  {
    name: '015_add_skipped_status_to_receipt_items',
    up: (db) => {
      // SQLite doesn't support ALTER TABLE ... MODIFY COLUMN
      // So we need to recreate the table with the new constraint

      // 1. Create new table with updated constraint
      db.exec(`
          CREATE TABLE receipt_items_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            photo_queue_id INTEGER NOT NULL,
            name_ru TEXT NOT NULL,
            name_original TEXT,
            quantity REAL NOT NULL,
            price REAL NOT NULL,
            total REAL NOT NULL,
            currency TEXT NOT NULL,
            suggested_category TEXT NOT NULL,
            possible_categories TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending', 'confirmed', 'skipped')),
            confirmed_category TEXT,
            waiting_for_category_input INTEGER DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (photo_queue_id) REFERENCES photo_processing_queue(id) ON DELETE CASCADE
          );
        `);

      // 2. Copy data from old table
      db.exec(`
          INSERT INTO receipt_items_new
          SELECT * FROM receipt_items;
        `);

      // 3. Drop old table
      db.exec(`DROP TABLE receipt_items;`);

      // 4. Rename new table
      db.exec(`ALTER TABLE receipt_items_new RENAME TO receipt_items;`);

      // 5. Recreate indexes
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_receipt_items_queue_id
          ON receipt_items(photo_queue_id);
        `);

      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_receipt_items_status
          ON receipt_items(status);
        `);

      logger.info('✓ Added "skipped" status to receipt_items');
    },
  },
  {
    name: '016_add_summary_mode_to_photo_queue',
    up: (db) => {
      // Add summary_mode column (0=item-by-item, 1=bulk summary mode)
      const checkSummaryMode = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count
          FROM pragma_table_info('photo_processing_queue')
          WHERE name = 'summary_mode'
        `);
      if (checkSummaryMode.get()?.count === 0) {
        db.exec(`
            ALTER TABLE photo_processing_queue
            ADD COLUMN summary_mode INTEGER DEFAULT 0;
          `);
      }

      // Add ai_summary column for storing current summary JSON
      const checkAiSummary = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count
          FROM pragma_table_info('photo_processing_queue')
          WHERE name = 'ai_summary'
        `);
      if (checkAiSummary.get()?.count === 0) {
        db.exec(`
            ALTER TABLE photo_processing_queue
            ADD COLUMN ai_summary TEXT;
          `);
      }

      // Add correction_history column for storing correction history JSON
      const checkCorrectionHistory = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count
          FROM pragma_table_info('photo_processing_queue')
          WHERE name = 'correction_history'
        `);
      if (checkCorrectionHistory.get()?.count === 0) {
        db.exec(`
            ALTER TABLE photo_processing_queue
            ADD COLUMN correction_history TEXT;
          `);
      }

      // Add waiting_for_bulk_correction flag
      const checkWaitingBulk = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count
          FROM pragma_table_info('photo_processing_queue')
          WHERE name = 'waiting_for_bulk_correction'
        `);
      if (checkWaitingBulk.get()?.count === 0) {
        db.exec(`
            ALTER TABLE photo_processing_queue
            ADD COLUMN waiting_for_bulk_correction INTEGER DEFAULT 0;
          `);
      }

      // Add summary_message_id to track which message to edit
      const checkSummaryMessageId = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count
          FROM pragma_table_info('photo_processing_queue')
          WHERE name = 'summary_message_id'
        `);
      if (checkSummaryMessageId.get()?.count === 0) {
        db.exec(`
            ALTER TABLE photo_processing_queue
            ADD COLUMN summary_message_id INTEGER;
          `);
      }

      logger.info('✓ Added summary mode columns to photo_processing_queue');
    },
  },
  {
    name: '017_add_active_topic_id_to_groups',
    up: (db) => {
      const checkColumn = db.query<{ count: number }, []>(`
          SELECT COUNT(*) as count
          FROM pragma_table_info('groups')
          WHERE name = 'active_topic_id'
        `);
      const result = checkColumn.get();

      if (result && result.count === 0) {
        db.exec(`
            ALTER TABLE groups
            ADD COLUMN active_topic_id INTEGER;
          `);
        logger.info('✓ Added active_topic_id column to groups');
      }
    },
  },
];
