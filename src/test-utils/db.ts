// Shared in-memory SQLite helpers for repository tests

import { Database } from 'bun:sqlite';
import { runMigrations } from '../database/schema';

/**
 * Create an in-memory SQLite database with all migrations applied.
 */
export function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}

/**
 * Clear all user-data tables between tests.
 * Order respects foreign key constraints (children first).
 */
export function clearTestDb(db: Database): void {
  db.exec(`
    DELETE FROM expense_snapshots;
    DELETE FROM budget_snapshots;
    DELETE FROM merchant_rule_requests;
    DELETE FROM merchant_rules;
    DELETE FROM bank_transactions;
    DELETE FROM bank_accounts;
    DELETE FROM bank_plugin_state;
    DELETE FROM bank_credentials;
    DELETE FROM bank_connections;
    DELETE FROM advice_log;
    DELETE FROM expense_items;
    DELETE FROM chat_messages;
    DELETE FROM dev_tasks;
    DELETE FROM expenses;
    DELETE FROM budgets;
    DELETE FROM categories;
    DELETE FROM pending_expenses;
    DELETE FROM photo_processing_queue;
    DELETE FROM users;
    DELETE FROM group_members;
    DELETE FROM group_spreadsheets;
    DELETE FROM groups;
  `);
}
