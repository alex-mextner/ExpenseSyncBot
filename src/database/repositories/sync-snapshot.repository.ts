// Repository for pre-sync expense snapshots — enables /sync rollback
import type { Database } from 'bun:sqlite';

interface SyncSnapshot {
  id: number;
  group_id: number;
  snapshot_data: string;
  expense_count: number;
  created_at: string;
}

export class SyncSnapshotRepository {
  constructor(private db: Database) {}

  /**
   * Save a snapshot of current expenses for a group (JSON blob).
   * Automatically prunes old snapshots keeping only the latest 3.
   */
  create(groupId: number, expenses: unknown[], expenseCount: number): SyncSnapshot {
    const result = this.db
      .query<SyncSnapshot, [number, string, number]>(
        `INSERT INTO sync_snapshots (group_id, snapshot_data, expense_count)
         VALUES (?, ?, ?)
         RETURNING *`,
      )
      .get(groupId, JSON.stringify(expenses), expenseCount);

    if (!result) {
      throw new Error('Failed to create sync snapshot');
    }

    this.pruneOld(groupId, 3);
    return result;
  }

  /**
   * Get the most recent snapshot for a group.
   */
  getLatest(groupId: number): SyncSnapshot | null {
    return this.db
      .query<SyncSnapshot, [number]>(
        'SELECT * FROM sync_snapshots WHERE group_id = ? ORDER BY id DESC LIMIT 1',
      )
      .get(groupId);
  }

  /**
   * Delete old snapshots, keeping only the latest `keepCount`.
   */
  pruneOld(groupId: number, keepCount: number): void {
    this.db
      .query(
        `DELETE FROM sync_snapshots
         WHERE group_id = ? AND id NOT IN (
           SELECT id FROM sync_snapshots WHERE group_id = ? ORDER BY id DESC LIMIT ?
         )`,
      )
      .run(groupId, groupId, keepCount);
  }
}
