// Migrations 056-057: persistent budget setup prompts (#123). Renumbered from the abandoned
// feat/budget-setup-ux-123 branch (052/053 there) because main already shipped its own 052-055.
// Migration names are the contract with already-migrated databases; these never shipped.

import { migrationLogger as logger } from './migration-logger';
import type { Migration } from './types';

export const budgetPromptMigrations: Migration[] = [
  {
    name: '056_create_budget_prompts',
    up: (db) => {
      db.exec(`
          CREATE TABLE IF NOT EXISTS budget_prompts (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            category TEXT NOT NULL,
            currency TEXT NOT NULL,
            telegram_message_id INTEGER,
            message_thread_id INTEGER,
            status TEXT NOT NULL DEFAULT 'active'
              CHECK(status IN ('active', 'used', 'skipped')),
            created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_budget_prompts_active_user
          ON budget_prompts(group_id, user_id, status, created_at)
        `);
      db.exec(`
          CREATE INDEX IF NOT EXISTS idx_budget_prompts_message
          ON budget_prompts(telegram_message_id)
        `);
      logger.info('✓ Added persistent budget setup prompts');
    },
  },
  {
    name: '057_budget_prompt_target_month',
    up: (db) => {
      db.exec('ALTER TABLE budget_prompts ADD COLUMN target_month TEXT');
    },
  },
];
