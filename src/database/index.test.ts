// Tests for DatabaseService — transaction helper

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
