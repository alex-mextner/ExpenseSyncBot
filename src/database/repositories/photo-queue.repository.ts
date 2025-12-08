import type { Database } from 'bun:sqlite';
import type { PhotoQueueItem, CreatePhotoQueueData, UpdatePhotoQueueData } from '../types';

export class PhotoQueueRepository {
  constructor(private db: Database) {}

  /**
   * Find photo queue item by ID
   */
  findById(id: number): PhotoQueueItem | null {
    const query = this.db.query<PhotoQueueItem, [number]>(`
      SELECT * FROM photo_processing_queue WHERE id = ?
    `);

    return query.get(id) || null;
  }

  /**
   * Find all pending items (status = 'pending')
   */
  findPending(): PhotoQueueItem[] {
    const query = this.db.query<PhotoQueueItem, []>(`
      SELECT * FROM photo_processing_queue
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `);

    return query.all();
  }

  /**
   * Find by group and user
   */
  findByGroupAndUser(groupId: number, userId: number): PhotoQueueItem[] {
    const query = this.db.query<PhotoQueueItem, [number, number]>(`
      SELECT * FROM photo_processing_queue
      WHERE group_id = ? AND user_id = ?
      ORDER BY created_at DESC
    `);

    return query.all(groupId, userId);
  }

  /**
   * Create new photo queue item
   */
  create(data: CreatePhotoQueueData): PhotoQueueItem {
    const query = this.db.query<{ id: number }, [number, number, number, number | null, string, string]>(`
      INSERT INTO photo_processing_queue (
        group_id,
        user_id,
        message_id,
        message_thread_id,
        file_id,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    const result = query.get(
      data.group_id,
      data.user_id,
      data.message_id,
      data.message_thread_id ?? null,
      data.file_id,
      data.status
    );

    if (!result) {
      throw new Error('Failed to create photo queue item');
    }

    const item = this.findById(result.id);

    if (!item) {
      throw new Error('Failed to retrieve created photo queue item');
    }

    return item;
  }

  /**
   * Update photo queue item
   */
  update(id: number, data: UpdatePhotoQueueData): PhotoQueueItem {
    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.status !== undefined) {
      updates.push('status = ?');
      values.push(data.status);
    }

    if (data.error_message !== undefined) {
      updates.push('error_message = ?');
      values.push(data.error_message || '');
    }

    if (data.summary_mode !== undefined) {
      updates.push('summary_mode = ?');
      values.push(data.summary_mode);
    }

    if (data.ai_summary !== undefined) {
      updates.push('ai_summary = ?');
      values.push(data.ai_summary);
    }

    if (data.correction_history !== undefined) {
      updates.push('correction_history = ?');
      values.push(data.correction_history);
    }

    if (data.waiting_for_bulk_correction !== undefined) {
      updates.push('waiting_for_bulk_correction = ?');
      values.push(data.waiting_for_bulk_correction);
    }

    if (data.summary_message_id !== undefined) {
      updates.push('summary_message_id = ?');
      values.push(data.summary_message_id);
    }

    if (updates.length === 0) {
      throw new Error('No fields to update');
    }

    values.push(id);

    const query = this.db.query<void, (string | number | null)[]>(`
      UPDATE photo_processing_queue
      SET ${updates.join(', ')}
      WHERE id = ?
    `);

    query.run(...values);

    const item = this.findById(id);

    if (!item) {
      throw new Error('Failed to retrieve updated photo queue item');
    }

    return item;
  }

  /**
   * Find item waiting for bulk correction input in a group
   */
  findWaitingForBulkCorrection(groupId: number): PhotoQueueItem | null {
    const query = this.db.query<PhotoQueueItem, [number]>(`
      SELECT * FROM photo_processing_queue
      WHERE group_id = ? AND waiting_for_bulk_correction = 1
      ORDER BY created_at DESC
      LIMIT 1
    `);

    return query.get(groupId) || null;
  }

  /**
   * Delete photo queue item
   */
  delete(id: number): boolean {
    const query = this.db.query<void, [number]>(`
      DELETE FROM photo_processing_queue WHERE id = ?
    `);

    query.run(id);
    return true;
  }

  /**
   * Delete all done items older than specified days
   */
  deleteOldDoneItems(daysOld: number = 7): number {
    const query = this.db.query<{ count: number }, [string]>(`
      SELECT COUNT(*) as count
      FROM photo_processing_queue
      WHERE status = 'done' AND datetime(created_at) < datetime('now', ?)
    `);

    const result = query.get(`-${daysOld} days`);
    const count = result?.count || 0;

    const deleteQuery = this.db.query<void, [string]>(`
      DELETE FROM photo_processing_queue
      WHERE status = 'done' AND datetime(created_at) < datetime('now', ?)
    `);

    deleteQuery.run(`-${daysOld} days`);
    return count;
  }
}
