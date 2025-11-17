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
