// Tests for DatabaseService — transaction, queryAll, queryOne, exec, getDb

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../test-utils/db';
import { DatabaseService } from './index';

let db: Database;
let service: DatabaseService;
let groupId: number;
let userId: number;

beforeAll(() => {
  db = createTestDb();
  // Use the same in-memory db for all repos so we can verify isolation
  service = new DatabaseService(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
  const group = service.groups.create({ telegram_group_id: Date.now() });
  groupId = group.id;
  const user = service.users.create({ telegram_id: Date.now(), group_id: groupId });
  userId = user.id;
});

describe('DatabaseService.transaction', () => {
  test('rolls back on error — expense is NOT created when transaction throws', () => {
    const before = service.expenses.findByGroupId(groupId);
    expect(before).toHaveLength(0);

    expect(() => {
      service.transaction(() => {
        service.expenses.create({
          group_id: groupId,
          user_id: userId,
          date: '2024-01-15',
          category: 'Food',
          comment: 'rollback test',
          amount: 10,
          currency: 'EUR',
          eur_amount: 10,
        });
        throw new Error('intentional rollback');
      });
    }).toThrow('intentional rollback');

    const after = service.expenses.findByGroupId(groupId);
    expect(after).toHaveLength(0);
  });

  test('returns value from fn on success', () => {
    const result = service.transaction(() => {
      return 42;
    });
    expect(result).toBe(42);
  });

  test('commits on success — expense IS created when transaction succeeds', () => {
    service.transaction(() => {
      service.expenses.create({
        group_id: groupId,
        user_id: userId,
        date: '2024-01-15',
        category: 'Food',
        comment: 'commit test',
        amount: 20,
        currency: 'EUR',
        eur_amount: 20,
      });
    });

    const after = service.expenses.findByGroupId(groupId);
    expect(after).toHaveLength(1);
    expect(after[0]?.comment).toBe('commit test');
  });
});

describe('DatabaseService.queryAll', () => {
  test('returns all matching rows', () => {
    service.expenses.create({
      group_id: groupId,
      user_id: userId,
      date: '2024-01-15',
      category: 'Food',
      comment: 'first',
      amount: 10,
      currency: 'EUR',
      eur_amount: 10,
    });
    service.expenses.create({
      group_id: groupId,
      user_id: userId,
      date: '2024-01-16',
      category: 'Transport',
      comment: 'second',
      amount: 5,
      currency: 'EUR',
      eur_amount: 5,
    });

    const rows = service.queryAll<{ comment: string }>(
      'SELECT comment FROM expenses WHERE group_id = ?',
      groupId,
    );

    expect(rows).toHaveLength(2);
    const comments = rows.map((r) => r.comment).sort();
    expect(comments).toEqual(['first', 'second']);
  });

  test('returns empty array when no rows match', () => {
    const rows = service.queryAll<{ comment: string }>(
      'SELECT comment FROM expenses WHERE group_id = ?',
      groupId,
    );
    expect(rows).toEqual([]);
  });
});

describe('DatabaseService.queryOne', () => {
  test('returns first matching row', () => {
    service.expenses.create({
      group_id: groupId,
      user_id: userId,
      date: '2024-01-15',
      category: 'Food',
      comment: 'only one',
      amount: 10,
      currency: 'EUR',
      eur_amount: 10,
    });

    const row = service.queryOne<{ comment: string }>(
      'SELECT comment FROM expenses WHERE group_id = ?',
      groupId,
    );

    expect(row).not.toBeNull();
    expect(row?.comment).toBe('only one');
  });

  test('returns null when no rows match', () => {
    const row = service.queryOne<{ comment: string }>(
      'SELECT comment FROM expenses WHERE group_id = ?',
      groupId,
    );
    expect(row).toBeNull();
  });
});

describe('DatabaseService.exec', () => {
  test('executes INSERT without params', () => {
    service.exec(`INSERT INTO categories (group_id, name) VALUES (${groupId}, 'ExecTest')`);

    const row = service.queryOne<{ name: string }>(
      "SELECT name FROM categories WHERE group_id = ? AND name = 'ExecTest'",
      groupId,
    );
    expect(row?.name).toBe('ExecTest');
  });

  test('executes INSERT with bound params', () => {
    service.exec('INSERT INTO categories (group_id, name) VALUES (?, ?)', groupId, 'ParamTest');

    const row = service.queryOne<{ name: string }>(
      "SELECT name FROM categories WHERE group_id = ? AND name = 'ParamTest'",
      groupId,
    );
    expect(row?.name).toBe('ParamTest');
  });

  test('executes DELETE with bound params', () => {
    service.categories.create({ group_id: groupId, name: 'ToDelete' });

    service.exec("DELETE FROM categories WHERE group_id = ? AND name = 'ToDelete'", groupId);

    const row = service.queryOne<{ name: string }>(
      "SELECT name FROM categories WHERE group_id = ? AND name = 'ToDelete'",
      groupId,
    );
    expect(row).toBeNull();
  });
});

describe('DatabaseService.getDb', () => {
  test('returns the underlying Database instance', () => {
    const rawDb = service.getDb();
    expect(rawDb).toBeDefined();
    // Verify it is a functional Database by running a trivial query directly
    const result = rawDb.query<{ val: number }, []>('SELECT 1 AS val').get();
    expect(result?.val).toBe(1);
  });

  test('returned instance is the same one used by repositories', () => {
    const rawDb = service.getDb();
    // Insert via raw db, read via repository — same connection must be used
    rawDb.query('INSERT INTO categories (group_id, name) VALUES (?, ?)').run(groupId, 'RawInsert');

    const cat = service.queryOne<{ name: string }>(
      "SELECT name FROM categories WHERE group_id = ? AND name = 'RawInsert'",
      groupId,
    );
    expect(cat?.name).toBe('RawInsert');
  });
});
