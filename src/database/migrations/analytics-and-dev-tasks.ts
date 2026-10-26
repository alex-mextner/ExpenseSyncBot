// Migrations 018-020: analytics indexes, advice log, dev tasks.
// Split out of schema.ts so no single file carries the whole migration history. List order and
// migration names are the contract with already-migrated databases and must not change.

import { migrationLogger as logger } from './migration-logger';
import type { Migration } from './types';

export const analyticsAndDevTaskMigrations: Migration[] = [
  {
    name: '018_add_analytics_indexes_and_advice_log',
    up: (db) => {
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_expenses_group_date
          ON expenses(group_id, date);
        `);

      db.exec(`
          CREATE TABLE IF NOT EXISTS advice_log (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            tier TEXT NOT NULL CHECK(tier IN ('quick', 'alert', 'deep')),
            trigger_type TEXT NOT NULL,
            trigger_data TEXT,
            topic TEXT,
            advice_text TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE
          );
        `);

      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_advice_log_group_created
          ON advice_log(group_id, created_at);
        `);

      logger.info('✓ Added composite index on expenses(group_id, date) and advice_log table');
    },
  },
  {
    name: '019_create_dev_tasks_table',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS dev_tasks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            state TEXT NOT NULL DEFAULT 'pending',
            title TEXT,
            description TEXT NOT NULL,
            branch_name TEXT,
            worktree_path TEXT,
            pr_number INTEGER,
            pr_url TEXT,
            design TEXT,
            plan TEXT,
            code_review TEXT,
            error_log TEXT,
            retry_count INTEGER NOT NULL DEFAULT 0,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_dev_tasks_group_id
          ON dev_tasks(group_id);
        `);

      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_dev_tasks_state
          ON dev_tasks(state);
        `);

      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_dev_tasks_user_id
          ON dev_tasks(user_id);
        `);

      logger.info('✓ Created dev_tasks table');
    },
  },
  {
    name: '020_add_failed_at_state_to_dev_tasks',
    up: (db) => {
      db.exec(`ALTER TABLE dev_tasks ADD COLUMN failed_at_state TEXT`);
      logger.info('✓ Added failed_at_state column to dev_tasks');
    },
  },
];
