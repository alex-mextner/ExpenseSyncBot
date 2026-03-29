// Tests for /disconnect — verifies cascading deletion of all group data

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { GroupRepository } from '../../database/repositories/group.repository';
import { GroupSpreadsheetRepository } from '../../database/repositories/group-spreadsheet.repository';
import { clearTestDb, createTestDb } from '../../test-utils/db';

let db: Database;
let groups: GroupRepository;
let spreadsheets: GroupSpreadsheetRepository;

beforeAll(() => {
  db = createTestDb();
  groups = new GroupRepository(db);
  spreadsheets = new GroupSpreadsheetRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
});

const ALLOWED_TABLES = ['expenses', 'budgets', 'chat_messages', 'categories'] as const;

/** Helper: count rows in a table filtered by group_id */
function countByGroup(table: (typeof ALLOWED_TABLES)[number], groupId: number): number {
  if (!ALLOWED_TABLES.includes(table)) throw new Error(`Table ${table} not in whitelist`);
  const result = db
    .query<{ count: number }, [number]>(`SELECT COUNT(*) as count FROM ${table} WHERE group_id = ?`)
    .get(groupId);
  return result?.count ?? 0;
}

describe('/disconnect — cascading group deletion', () => {
  test('deleting group_spreadsheets then group removes all related data', () => {
    const telegramGroupId = -1001234;
    const group = groups.create({ telegram_group_id: telegramGroupId });

    // Seed related data via raw SQL
    db.exec(`INSERT INTO users (telegram_id, group_id) VALUES (111, ${group.id})`);
    spreadsheets.setYear(group.id, 2026, 'sheet-abc');
    db.exec(`INSERT INTO categories (name, group_id) VALUES ('Food', ${group.id})`);
    db.exec(
      `INSERT INTO expenses (group_id, user_id, amount, currency, eur_amount, category, comment, date) VALUES (${group.id}, 1, 100, 'EUR', 100, 'Food', 'test', '2026-03-29')`,
    );
    db.exec(
      `INSERT INTO budgets (group_id, category, month, limit_amount, currency) VALUES (${group.id}, 'Food', '2026-03', 500, 'EUR')`,
    );
    db.exec(
      `INSERT INTO chat_messages (group_id, user_id, role, content) VALUES (${group.id}, 1, 'user', 'hello')`,
    );

    // Verify data exists
    expect(groups.findByTelegramGroupId(telegramGroupId)).not.toBeNull();
    expect(spreadsheets.listAll(group.id).length).toBe(1);
    expect(countByGroup('expenses', group.id)).toBe(1);
    expect(countByGroup('budgets', group.id)).toBe(1);
    expect(countByGroup('chat_messages', group.id)).toBe(1);

    // Perform disconnect: delete spreadsheets first (no CASCADE), then group
    db.exec('BEGIN');
    spreadsheets.deleteByGroupId(group.id);
    groups.delete(telegramGroupId);
    db.exec('COMMIT');

    // Verify everything is gone
    expect(groups.findByTelegramGroupId(telegramGroupId)).toBeNull();
    expect(spreadsheets.listAll(group.id).length).toBe(0);
    expect(countByGroup('expenses', group.id)).toBe(0);
    expect(countByGroup('budgets', group.id)).toBe(0);
    expect(countByGroup('chat_messages', group.id)).toBe(0);
  });

  test('deleting group without spreadsheets works fine', () => {
    const telegramGroupId = -1005678;
    groups.create({ telegram_group_id: telegramGroupId });

    db.exec('BEGIN');
    const group = groups.findByTelegramGroupId(telegramGroupId);
    if (!group) throw new Error('Group not found');
    spreadsheets.deleteByGroupId(group.id);
    groups.delete(telegramGroupId);
    db.exec('COMMIT');

    expect(groups.findByTelegramGroupId(telegramGroupId)).toBeNull();
  });

  test('deleting group fails without removing spreadsheets first', () => {
    const telegramGroupId = -1009999;
    const group = groups.create({ telegram_group_id: telegramGroupId });
    spreadsheets.setYear(group.id, 2026, 'sheet-xyz');

    // Direct delete should fail due to foreign key constraint
    expect(() => {
      groups.delete(telegramGroupId);
    }).toThrow();

    // Group should still exist
    expect(groups.findByTelegramGroupId(telegramGroupId)).not.toBeNull();
  });
});
