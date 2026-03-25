import { Database } from 'bun:sqlite';
import { env } from '../config/env';
import { encryptToken, isEncryptedToken } from '../services/google/token-encryption';
import { createLogger } from '../utils/logger.ts';

const logger = createLogger('schema');

/**
 * Initialize database connection
 */
export function initDatabase(): Database {
  const db = new Database(env.DATABASE_PATH, { create: true });

  // Enable WAL mode for better concurrency
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // Retry for up to 5 seconds instead of failing immediately on SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 5000;');

  return db;
}

/**
 * Run database migrations
 */
export function runMigrations(db: Database): void {
  // Create migrations table
  db.exec(`
    CREATE TABLE IF NOT EXISTS migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);

  const migrations = [
    {
      name: '001_create_users_table',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id INTEGER NOT NULL UNIQUE,
            google_refresh_token TEXT,
            spreadsheet_id TEXT,
            default_currency TEXT NOT NULL DEFAULT 'USD',
            enabled_currencies TEXT NOT NULL DEFAULT '["USD"]',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
          );
        `);
      },
    },
    {
      name: '002_create_categories_table',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS categories (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
            UNIQUE(user_id, name)
          );
        `);

        // Create index for faster lookups
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_categories_user_id
          ON categories(user_id);
        `);
      },
    },
    {
      name: '003_create_pending_expenses_table',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS pending_expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            message_id INTEGER NOT NULL,
            parsed_amount REAL NOT NULL,
            parsed_currency TEXT NOT NULL,
            detected_category TEXT,
            comment TEXT NOT NULL,
            status TEXT NOT NULL CHECK(status IN ('pending_category', 'confirmed')),
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_pending_expenses_user_id
          ON pending_expenses(user_id);
        `);

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_pending_expenses_message_id
          ON pending_expenses(message_id);
        `);
      },
    },
    {
      name: '004_create_expenses_table',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS expenses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            user_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            category TEXT NOT NULL,
            comment TEXT NOT NULL,
            amount REAL NOT NULL,
            currency TEXT NOT NULL,
            usd_amount REAL NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_expenses_user_id
          ON expenses(user_id);
        `);

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_expenses_date
          ON expenses(date);
        `);
      },
    },
    {
      name: '005_create_groups_and_refactor',
      up: () => {
        // Create groups table
        db.exec(`
          CREATE TABLE IF NOT EXISTS groups (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_group_id INTEGER NOT NULL UNIQUE,
            google_refresh_token TEXT,
            spreadsheet_id TEXT,
            default_currency TEXT NOT NULL DEFAULT 'USD',
            enabled_currencies TEXT NOT NULL DEFAULT '["USD"]',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
          );
        `);

        // Create new users table with group_id
        db.exec(`
          CREATE TABLE IF NOT EXISTS users_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            telegram_id INTEGER NOT NULL UNIQUE,
            group_id INTEGER,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE SET NULL
          );
        `);

        // Migrate existing users (drop google data, they need to reconnect)
        db.exec(`
          INSERT INTO users_new (id, telegram_id, created_at, updated_at)
          SELECT id, telegram_id, created_at, updated_at FROM users;
        `);

        // Drop old users table
        db.exec(`DROP TABLE IF EXISTS users;`);

        // Rename new table
        db.exec(`ALTER TABLE users_new RENAME TO users;`);

        // Update categories table to use group_id
        db.exec(`
          CREATE TABLE IF NOT EXISTS categories_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
            UNIQUE(group_id, name)
          );
        `);

        // Drop old categories (will be recreated by users)
        db.exec(`DROP TABLE IF EXISTS categories;`);
        db.exec(`ALTER TABLE categories_new RENAME TO categories;`);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_categories_group_id
          ON categories(group_id);
        `);

        // Update expenses table to include group_id
        db.exec(`
          CREATE TABLE IF NOT EXISTS expenses_new (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            date TEXT NOT NULL,
            category TEXT NOT NULL,
            comment TEXT NOT NULL,
            amount REAL NOT NULL,
            currency TEXT NOT NULL,
            usd_amount REAL NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

        // Drop old expenses (will be recreated)
        db.exec(`DROP TABLE IF EXISTS expenses;`);
        db.exec(`ALTER TABLE expenses_new RENAME TO expenses;`);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_expenses_group_id
          ON expenses(group_id);
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_expenses_user_id
          ON expenses(user_id);
        `);
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_expenses_date
          ON expenses(date);
        `);
      },
    },
    {
      name: '006_rename_usd_to_eur',
      up: () => {
        // Rename usd_amount to eur_amount in expenses table
        db.exec(`
          ALTER TABLE expenses RENAME COLUMN usd_amount TO eur_amount;
        `);
      },
    },
    {
      name: '007_create_budgets_table',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS budgets (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            category TEXT NOT NULL,
            month TEXT NOT NULL,
            limit_amount REAL NOT NULL,
            currency TEXT NOT NULL DEFAULT 'EUR',
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
            UNIQUE(group_id, category, month)
          );
        `);

        // Create indexes for faster lookups
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_budgets_group_id
          ON budgets(group_id);
        `);

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_budgets_month
          ON budgets(month);
        `);

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_budgets_group_month
          ON budgets(group_id, month);
        `);
      },
    },
    {
      name: '008_create_chat_messages_table',
      up: () => {
        db.exec(`
          CREATE TABLE IF NOT EXISTS chat_messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            group_id INTEGER NOT NULL,
            user_id INTEGER NOT NULL,
            role TEXT NOT NULL CHECK(role IN ('user', 'assistant')),
            content TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (group_id) REFERENCES groups(id) ON DELETE CASCADE,
            FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
          );
        `);

        // Create indexes for faster lookups
        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_chat_messages_group_id
          ON chat_messages(group_id);
        `);

        db.exec(`
          CREATE INDEX IF NOT EXISTS idx_chat_messages_created_at
          ON chat_messages(created_at);
        `);
      },
    },
    {
      name: '009_add_custom_prompt_to_groups',
      up: () => {
        // Add custom_prompt column to groups table
        db.exec(`
          ALTER TABLE groups ADD COLUMN custom_prompt TEXT;
        `);
      },
    },
    {
      name: '010_create_photo_processing_queue',
      up: () => {
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
      up: () => {
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
      up: () => {
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
      up: () => {
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
      up: () => {
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
      up: () => {
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
      up: () => {
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
      up: () => {
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
    {
      name: '018_add_analytics_indexes_and_advice_log',
      up: () => {
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
      up: () => {
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
      up: () => {
        db.exec(`ALTER TABLE dev_tasks ADD COLUMN failed_at_state TEXT`);
        logger.info('✓ Added failed_at_state column to dev_tasks');
      },
    },
    {
      name: '021_encrypt_existing_refresh_tokens',
      up: () => {
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
  ];

  // Check and run migrations
  const checkMigration = db.query<{ count: number }, [string]>(
    'SELECT COUNT(*) as count FROM migrations WHERE name = ?',
  );

  const recordMigration = db.query<void, [string]>('INSERT INTO migrations (name) VALUES (?)');

  for (const migration of migrations) {
    const result = checkMigration.get(migration.name);

    if (result && result.count === 0) {
      logger.info(`Running migration: ${migration.name}`);
      migration.up();
      recordMigration.run(migration.name);
      logger.info(`✓ Migration ${migration.name} completed`);
    }
  }

  logger.info('✓ All migrations completed');
}

/**
 * Initialize database with schema
 */
export function setupDatabase(): Database {
  const db = initDatabase();
  runMigrations(db);
  return db;
}
