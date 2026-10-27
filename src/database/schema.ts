/** Database schema migrations — runs on startup, applies pending migrations to the SQLite database */
import { Database } from 'bun:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { env } from '../config/env';
import { createLogger } from '../utils/logger.ts';
import { migrations } from './migrations';

const logger = createLogger('schema');

/**
 * Initialize database connection
 */
export function initDatabase(): Database {
  // In tests, use in-memory DB to avoid file lock contention between parallel test processes
  const isTest = process.env.NODE_ENV === 'test';
  const dbPath = isTest ? ':memory:' : env.DATABASE_PATH;

  if (!isTest) {
    mkdirSync(dirname(env.DATABASE_PATH), { recursive: true });
  }
  const db = new Database(dbPath, { create: true });

  // Enable WAL mode for better concurrency
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  // Retry for up to 5 seconds instead of failing immediately on SQLITE_BUSY
  db.exec('PRAGMA busy_timeout = 5000;');
  // Performance PRAGMAs
  db.exec('PRAGMA synchronous = NORMAL;');
  db.exec('PRAGMA cache_size = -8000;'); // 8MB
  db.exec('PRAGMA temp_store = MEMORY;');

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

  // Check and run migrations
  const checkMigration = db.query<{ count: number }, [string]>(
    'SELECT COUNT(*) as count FROM migrations WHERE name = ?',
  );

  const recordMigration = db.query<void, [string]>('INSERT INTO migrations (name) VALUES (?)');

  let applied = 0;

  for (const migration of migrations) {
    const result = checkMigration.get(migration.name);
    if (result && result.count === 0) {
      logger.info(`Running migration: ${migration.name}`);
      migration.up(db);
      recordMigration.run(migration.name);
      applied++;
    }
  }

  if (applied > 0) {
    logger.info(`✓ ${applied} migration(s) applied`);
  } else {
    logger.debug('No pending migrations');
  }
}

/**
 * Initialize database with schema
 */
export function setupDatabase(): Database {
  const db = initDatabase();
  runMigrations(db);
  return db;
}
