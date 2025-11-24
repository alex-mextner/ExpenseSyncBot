import { Database } from 'bun:sqlite';
import { env } from '../config/env';

/**
 * Initialize database connection
 */
export function initDatabase(): Database {
  const db = new Database(env.DATABASE_PATH, { create: true });

  // Enable WAL mode for better concurrency
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

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
  ];

  // Check and run migrations
  const checkMigration = db.query<{ count: number }, [string]>(
    'SELECT COUNT(*) as count FROM migrations WHERE name = ?'
  );

  const recordMigration = db.query<void, [string]>(
    'INSERT INTO migrations (name) VALUES (?)'
  );

  for (const migration of migrations) {
    const result = checkMigration.get(migration.name);

    if (result && result.count === 0) {
      console.log(`Running migration: ${migration.name}`);
      migration.up();
      recordMigration.run(migration.name);
      console.log(`✓ Migration ${migration.name} completed`);
    }
  }

  console.log('✓ All migrations completed');
}

/**
 * Initialize database with schema
 */
export function setupDatabase(): Database {
  const db = initDatabase();
  runMigrations(db);
  return db;
}
