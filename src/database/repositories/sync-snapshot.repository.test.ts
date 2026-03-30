// Tests for SyncSnapshotRepository — snapshot create, retrieve, pruning

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { GroupRepository } from './group.repository';
import { SyncSnapshotRepository } from './sync-snapshot.repository';

let db: Database;
let snapshots: SyncSnapshotRepository;
let groups: GroupRepository;
let groupId: number;

beforeAll(() => {
  db = createTestDb();
  snapshots = new SyncSnapshotRepository(db);
  groups = new GroupRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
  const group = groups.create({ telegram_group_id: Date.now() });
  groupId = group.id;
});

describe('SyncSnapshotRepository', () => {
  test('create and retrieve latest snapshot', () => {
    const expenses = [
      { id: 1, category: 'Food', amount: 10, currency: 'EUR' },
      { id: 2, category: 'Transport', amount: 5, currency: 'EUR' },
    ];

    const created = snapshots.create(groupId, expenses, expenses.length);
    expect(created.group_id).toBe(groupId);
    expect(created.expense_count).toBe(2);

    const latest = snapshots.getLatest(groupId);
    expect(latest).not.toBeNull();
    expect(latest?.id).toBe(created.id);

    // biome-ignore lint/style/noNonNullAssertion: test asserts not null above
    const parsed = JSON.parse(latest!.snapshot_data);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].category).toBe('Food');
  });

  test('getLatest returns null for group without snapshots', () => {
    expect(snapshots.getLatest(groupId)).toBeNull();
  });

  test('keeps max 3 snapshots, prunes older ones', () => {
    snapshots.create(groupId, [{ n: 1 }], 1);
    snapshots.create(groupId, [{ n: 2 }], 1);
    snapshots.create(groupId, [{ n: 3 }], 1);
    snapshots.create(groupId, [{ n: 4 }], 1);

    const count = db
      .query<{ count: number }, [number]>(
        'SELECT COUNT(*) as count FROM sync_snapshots WHERE group_id = ?',
      )
      .get(groupId);

    expect(count?.count).toBe(3);

    // Latest should be snapshot 4
    const latest = snapshots.getLatest(groupId);
    // biome-ignore lint/style/noNonNullAssertion: test asserts not null via create
    const parsed = JSON.parse(latest!.snapshot_data);
    expect(parsed[0].n).toBe(4);
  });

  test('snapshots are isolated by group_id', () => {
    const group2 = groups.create({ telegram_group_id: Date.now() + 999_999 });

    snapshots.create(groupId, [{ g: 1 }], 1);
    snapshots.create(group2.id, [{ g: 2 }], 1);

    const latest1 = snapshots.getLatest(groupId);
    const latest2 = snapshots.getLatest(group2.id);

    // biome-ignore lint/style/noNonNullAssertion: test asserts not null via create
    expect(JSON.parse(latest1!.snapshot_data)[0].g).toBe(1);
    // biome-ignore lint/style/noNonNullAssertion: test asserts not null via create
    expect(JSON.parse(latest2!.snapshot_data)[0].g).toBe(2);
  });
});
