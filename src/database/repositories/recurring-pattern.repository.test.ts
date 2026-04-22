// Tests for RecurringPatternRepository — CRUD, status transitions, overdue filter, cascade

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import type { CreateRecurringPatternData } from '../types';
import { GroupRepository } from './group.repository';
import { RecurringPatternRepository } from './recurring-pattern.repository';

let db: Database;
let patternRepo: RecurringPatternRepository;
let groupRepo: GroupRepository;
let groupId: number;

beforeAll(() => {
  db = createTestDb();
  patternRepo = new RecurringPatternRepository(db);
  groupRepo = new GroupRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  groupId = group.id;
});

function makePattern(
  overrides: Partial<CreateRecurringPatternData> = {},
): CreateRecurringPatternData {
  return {
    group_id: groupId,
    category: 'Rent',
    expected_amount: 500,
    currency: 'EUR',
    ...overrides,
  };
}

describe('RecurringPatternRepository', () => {
  describe('create', () => {
    test('persists row with all required columns', () => {
      const pattern = patternRepo.create(
        makePattern({
          category: 'Subscription',
          expected_amount: 9.99,
          currency: 'USD',
          interval_days: 30,
          expected_day: 15,
          tolerance_days: 3,
          last_seen_date: '2024-01-15',
          next_expected_date: '2024-02-15',
        }),
      );

      expect(pattern.id).toBeGreaterThan(0);
      expect(pattern.group_id).toBe(groupId);
      expect(pattern.category).toBe('Subscription');
      expect(pattern.expected_amount).toBe(9.99);
      expect(pattern.currency).toBe('USD');
      expect(pattern.interval_days).toBe(30);
      expect(pattern.expected_day).toBe(15);
      expect(pattern.tolerance_days).toBe(3);
      expect(pattern.last_seen_date).toBe('2024-01-15');
      expect(pattern.next_expected_date).toBe('2024-02-15');
    });

    test('defaults interval_days to 30 and tolerance_days to 5', () => {
      const pattern = patternRepo.create(makePattern());
      expect(pattern.interval_days).toBe(30);
      expect(pattern.tolerance_days).toBe(5);
    });

    test('defaults expected_day / last_seen / next_expected to null', () => {
      const pattern = patternRepo.create(makePattern());
      expect(pattern.expected_day).toBeNull();
      expect(pattern.last_seen_date).toBeNull();
      expect(pattern.next_expected_date).toBeNull();
    });

    test('defaults status to active', () => {
      const pattern = patternRepo.create(makePattern());
      expect(pattern.status).toBe('active');
    });

    test('populates created_at and updated_at', () => {
      const pattern = patternRepo.create(makePattern());
      expect(pattern.created_at).toBeTruthy();
      expect(pattern.updated_at).toBeTruthy();
    });
  });

  describe('findById', () => {
    test('returns pattern for existing id', () => {
      const created = patternRepo.create(makePattern());
      const found = patternRepo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    test('returns null for non-existent id', () => {
      expect(patternRepo.findById(999999)).toBeNull();
    });
  });

  describe('findByGroupId', () => {
    test('returns only active patterns sorted by category asc', () => {
      patternRepo.create(makePattern({ category: 'Rent' }));
      patternRepo.create(makePattern({ category: 'Apple' }));
      patternRepo.create(makePattern({ category: 'Netflix' }));

      const patterns = patternRepo.findByGroupId(groupId);
      expect(patterns).toHaveLength(3);
      expect(patterns[0]?.category).toBe('Apple');
      expect(patterns[1]?.category).toBe('Netflix');
      expect(patterns[2]?.category).toBe('Rent');
    });

    test('excludes paused and dismissed patterns', () => {
      const active = patternRepo.create(makePattern({ category: 'Rent' }));
      const paused = patternRepo.create(makePattern({ category: 'Gym' }));
      const dismissed = patternRepo.create(makePattern({ category: 'Spotify' }));
      patternRepo.updateStatus(paused.id, 'paused');
      patternRepo.updateStatus(dismissed.id, 'dismissed');

      const patterns = patternRepo.findByGroupId(groupId);
      expect(patterns).toHaveLength(1);
      expect(patterns[0]?.id).toBe(active.id);
    });

    test('returns empty array for group with no patterns', () => {
      expect(patternRepo.findByGroupId(groupId)).toEqual([]);
    });

    test('scoped to group', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 1 });
      patternRepo.create(makePattern({ group_id: group2.id }));

      expect(patternRepo.findByGroupId(groupId)).toEqual([]);
    });
  });

  describe('findAllByGroupId', () => {
    test('returns patterns of all statuses', () => {
      const a = patternRepo.create(makePattern({ category: 'A' }));
      const b = patternRepo.create(makePattern({ category: 'B' }));
      const c = patternRepo.create(makePattern({ category: 'C' }));
      patternRepo.updateStatus(b.id, 'paused');
      patternRepo.updateStatus(c.id, 'dismissed');

      const patterns = patternRepo.findAllByGroupId(groupId);
      expect(patterns).toHaveLength(3);
      const ids = patterns.map((p) => p.id);
      expect(ids).toContain(a.id);
      expect(ids).toContain(b.id);
      expect(ids).toContain(c.id);
    });

    test('orders by status asc then category asc', () => {
      // status sort: active < dismissed < paused (alphabetical)
      const rentActive = patternRepo.create(makePattern({ category: 'Rent' }));
      const appleActive = patternRepo.create(makePattern({ category: 'Apple' }));
      const gymPaused = patternRepo.create(makePattern({ category: 'Gym' }));
      patternRepo.updateStatus(gymPaused.id, 'paused');

      const patterns = patternRepo.findAllByGroupId(groupId);
      expect(patterns).toHaveLength(3);
      // Active group first (sorted by category), paused last
      expect(patterns[0]?.id).toBe(appleActive.id);
      expect(patterns[1]?.id).toBe(rentActive.id);
      expect(patterns[2]?.id).toBe(gymPaused.id);
    });

    test('returns empty array for group with no patterns', () => {
      expect(patternRepo.findAllByGroupId(groupId)).toEqual([]);
    });
  });

  describe('findByGroupCategoryCurrency', () => {
    test('returns matching active pattern', () => {
      const created = patternRepo.create(makePattern({ category: 'Netflix', currency: 'USD' }));

      const found = patternRepo.findByGroupCategoryCurrency(groupId, 'Netflix', 'USD');
      expect(found?.id).toBe(created.id);
    });

    test('returns paused pattern (non-dismissed still matches)', () => {
      const created = patternRepo.create(makePattern({ category: 'Rent' }));
      patternRepo.updateStatus(created.id, 'paused');

      const found = patternRepo.findByGroupCategoryCurrency(groupId, 'Rent', 'EUR');
      expect(found?.id).toBe(created.id);
    });

    test('excludes dismissed pattern', () => {
      const created = patternRepo.create(makePattern({ category: 'Rent' }));
      patternRepo.updateStatus(created.id, 'dismissed');

      const found = patternRepo.findByGroupCategoryCurrency(groupId, 'Rent', 'EUR');
      expect(found).toBeNull();
    });

    test('returns null when currency mismatches', () => {
      patternRepo.create(makePattern({ category: 'Netflix', currency: 'USD' }));

      expect(patternRepo.findByGroupCategoryCurrency(groupId, 'Netflix', 'EUR')).toBeNull();
    });

    test('returns null when category mismatches', () => {
      patternRepo.create(makePattern({ category: 'Netflix' }));

      expect(patternRepo.findByGroupCategoryCurrency(groupId, 'Spotify', 'EUR')).toBeNull();
    });

    test('scoped to group', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 5 });
      patternRepo.create(makePattern({ group_id: group2.id, category: 'Rent' }));

      expect(patternRepo.findByGroupCategoryCurrency(groupId, 'Rent', 'EUR')).toBeNull();
    });
  });

  describe('updateLastSeen', () => {
    test('updates last_seen_date and next_expected_date', () => {
      const pattern = patternRepo.create(makePattern());
      patternRepo.updateLastSeen(pattern.id, '2024-03-15', '2024-04-14');

      const updated = patternRepo.findById(pattern.id);
      expect(updated?.last_seen_date).toBe('2024-03-15');
      expect(updated?.next_expected_date).toBe('2024-04-14');
    });

    test('preserves other fields', () => {
      const pattern = patternRepo.create(
        makePattern({
          category: 'Rent',
          expected_amount: 500,
          currency: 'EUR',
          interval_days: 30,
          expected_day: 1,
          tolerance_days: 5,
        }),
      );
      patternRepo.updateLastSeen(pattern.id, '2024-03-01', '2024-03-31');

      const updated = patternRepo.findById(pattern.id);
      expect(updated?.category).toBe('Rent');
      expect(updated?.expected_amount).toBe(500);
      expect(updated?.currency).toBe('EUR');
      expect(updated?.interval_days).toBe(30);
      expect(updated?.expected_day).toBe(1);
      expect(updated?.tolerance_days).toBe(5);
      expect(updated?.status).toBe('active');
    });
  });

  describe('updateStatus', () => {
    test('changes status from active to paused', () => {
      const pattern = patternRepo.create(makePattern());
      patternRepo.updateStatus(pattern.id, 'paused');

      expect(patternRepo.findById(pattern.id)?.status).toBe('paused');
    });

    test('changes status to dismissed', () => {
      const pattern = patternRepo.create(makePattern());
      patternRepo.updateStatus(pattern.id, 'dismissed');

      expect(patternRepo.findById(pattern.id)?.status).toBe('dismissed');
    });

    test('can transition back to active', () => {
      const pattern = patternRepo.create(makePattern());
      patternRepo.updateStatus(pattern.id, 'paused');
      patternRepo.updateStatus(pattern.id, 'active');

      expect(patternRepo.findById(pattern.id)?.status).toBe('active');
    });

    test('preserves other fields', () => {
      const pattern = patternRepo.create(makePattern({ category: 'Rent', expected_amount: 500 }));
      patternRepo.updateStatus(pattern.id, 'paused');

      const updated = patternRepo.findById(pattern.id);
      expect(updated?.category).toBe('Rent');
      expect(updated?.expected_amount).toBe(500);
    });
  });

  describe('findOverdue', () => {
    test('returns active patterns whose next_expected + tolerance is past today', () => {
      // next_expected 2024-01-10, tolerance 5 → overdue after 2024-01-15
      patternRepo.create(
        makePattern({
          category: 'Rent',
          next_expected_date: '2024-01-10',
          tolerance_days: 5,
        }),
      );
      // next_expected 2024-01-10, tolerance 20 → not overdue by 2024-01-20
      patternRepo.create(
        makePattern({
          category: 'Gym',
          next_expected_date: '2024-01-10',
          tolerance_days: 20,
        }),
      );

      const overdue = patternRepo.findOverdue(groupId, '2024-01-20');
      expect(overdue).toHaveLength(1);
      expect(overdue[0]?.category).toBe('Rent');
    });

    test('excludes patterns with null next_expected_date', () => {
      patternRepo.create(makePattern({ category: 'Rent' }));

      expect(patternRepo.findOverdue(groupId, '2024-12-31')).toEqual([]);
    });

    test('excludes paused and dismissed patterns even if overdue', () => {
      const paused = patternRepo.create(
        makePattern({
          category: 'Gym',
          next_expected_date: '2024-01-01',
          tolerance_days: 1,
        }),
      );
      const dismissed = patternRepo.create(
        makePattern({
          category: 'Spotify',
          next_expected_date: '2024-01-01',
          tolerance_days: 1,
        }),
      );
      patternRepo.updateStatus(paused.id, 'paused');
      patternRepo.updateStatus(dismissed.id, 'dismissed');

      expect(patternRepo.findOverdue(groupId, '2024-02-01')).toEqual([]);
    });

    test('orders by next_expected_date asc', () => {
      patternRepo.create(
        makePattern({
          category: 'B',
          next_expected_date: '2024-01-10',
          tolerance_days: 1,
        }),
      );
      patternRepo.create(
        makePattern({
          category: 'A',
          next_expected_date: '2024-01-05',
          tolerance_days: 1,
        }),
      );

      const overdue = patternRepo.findOverdue(groupId, '2024-02-01');
      expect(overdue).toHaveLength(2);
      expect(overdue[0]?.next_expected_date).toBe('2024-01-05');
      expect(overdue[1]?.next_expected_date).toBe('2024-01-10');
    });

    test('scoped to group', () => {
      const group2 = groupRepo.create({ telegram_group_id: Date.now() + 7 });
      patternRepo.create(
        makePattern({
          group_id: group2.id,
          next_expected_date: '2024-01-01',
          tolerance_days: 1,
        }),
      );

      expect(patternRepo.findOverdue(groupId, '2024-02-01')).toEqual([]);
    });

    test('returns empty array when no patterns overdue', () => {
      patternRepo.create(
        makePattern({
          next_expected_date: '2024-12-31',
          tolerance_days: 5,
        }),
      );

      expect(patternRepo.findOverdue(groupId, '2024-01-01')).toEqual([]);
    });
  });

  describe('delete', () => {
    test('removes pattern from database', () => {
      const pattern = patternRepo.create(makePattern());
      patternRepo.delete(pattern.id);

      expect(patternRepo.findById(pattern.id)).toBeNull();
    });

    test('does not affect other patterns', () => {
      const a = patternRepo.create(makePattern({ category: 'A' }));
      const b = patternRepo.create(makePattern({ category: 'B' }));
      patternRepo.delete(a.id);

      expect(patternRepo.findById(a.id)).toBeNull();
      expect(patternRepo.findById(b.id)).not.toBeNull();
    });

    test('deleting non-existent id is a no-op', () => {
      expect(() => patternRepo.delete(999999)).not.toThrow();
    });
  });

  describe('FK cascade on group deletion', () => {
    test('deleting a group removes its recurring patterns', () => {
      const pattern = patternRepo.create(makePattern());
      expect(patternRepo.findById(pattern.id)).not.toBeNull();

      db.query<void, [number]>('DELETE FROM groups WHERE id = ?').run(groupId);

      expect(patternRepo.findById(pattern.id)).toBeNull();
    });
  });
});
