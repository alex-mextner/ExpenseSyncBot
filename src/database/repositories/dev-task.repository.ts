/**
 * Dev task repository — data access for the dev_tasks table.
 */

import type { Database } from 'bun:sqlite';
import type {
  DevTask,
  CreateDevTaskData,
  UpdateDevTaskData,
  DevTaskState,
} from '../../services/dev-pipeline/types';

export class DevTaskRepository {
  constructor(private db: Database) {}

  /**
   * Create a new dev task
   */
  create(data: CreateDevTaskData): DevTask {
    const query = this.db.query<{ id: number }, [number, number, string, string | null]>(`
      INSERT INTO dev_tasks (group_id, user_id, description, title)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `);

    const result = query.get(
      data.group_id,
      data.user_id,
      data.description,
      data.title || null
    );

    if (!result) {
      throw new Error('Failed to create dev task');
    }

    const task = this.findById(result.id);
    if (!task) {
      throw new Error('Failed to retrieve created dev task');
    }

    return task;
  }

  /**
   * Find a task by ID
   */
  findById(id: number): DevTask | null {
    const query = this.db.query<DevTask, [number]>(`
      SELECT * FROM dev_tasks WHERE id = ?
    `);

    return query.get(id) || null;
  }

  /**
   * Find all active (non-terminal) tasks
   */
  findActive(): DevTask[] {
    const query = this.db.query<DevTask, []>(`
      SELECT * FROM dev_tasks
      WHERE state NOT IN ('completed', 'rejected', 'failed')
      ORDER BY created_at DESC
    `);

    return query.all();
  }

  /**
   * Find tasks by group ID
   */
  findByGroupId(groupId: number, limit: number = 10): DevTask[] {
    const query = this.db.query<DevTask, [number, number]>(`
      SELECT * FROM dev_tasks
      WHERE group_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    return query.all(groupId, limit);
  }

  /**
   * Find active tasks by group ID
   */
  findActiveByGroupId(groupId: number): DevTask[] {
    const query = this.db.query<DevTask, [number]>(`
      SELECT * FROM dev_tasks
      WHERE group_id = ?
        AND state NOT IN ('completed', 'rejected', 'failed')
      ORDER BY created_at DESC
    `);

    return query.all(groupId);
  }

  /**
   * Update a task
   */
  update(id: number, data: UpdateDevTaskData): DevTask | null {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.state !== undefined) {
      fields.push('state = ?');
      values.push(data.state);
    }

    if (data.title !== undefined) {
      fields.push('title = ?');
      values.push(data.title);
    }

    if (data.branch_name !== undefined) {
      fields.push('branch_name = ?');
      values.push(data.branch_name);
    }

    if (data.worktree_path !== undefined) {
      fields.push('worktree_path = ?');
      values.push(data.worktree_path);
    }

    if (data.pr_number !== undefined) {
      fields.push('pr_number = ?');
      values.push(data.pr_number);
    }

    if (data.pr_url !== undefined) {
      fields.push('pr_url = ?');
      values.push(data.pr_url);
    }

    if (data.design !== undefined) {
      fields.push('design = ?');
      values.push(data.design);
    }

    if (data.plan !== undefined) {
      fields.push('plan = ?');
      values.push(data.plan);
    }

    if (data.code_review !== undefined) {
      fields.push('code_review = ?');
      values.push(data.code_review);
    }

    if (data.error_log !== undefined) {
      fields.push('error_log = ?');
      values.push(data.error_log);
    }

    if (data.retry_count !== undefined) {
      fields.push('retry_count = ?');
      values.push(data.retry_count);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    const query = this.db.query<void, (string | number | null)[]>(`
      UPDATE dev_tasks
      SET ${fields.join(', ')}
      WHERE id = ?
    `);

    query.run(...values, id);

    return this.findById(id);
  }

  /**
   * Delete a task
   */
  delete(id: number): boolean {
    const query = this.db.query<void, [number]>(`
      DELETE FROM dev_tasks WHERE id = ?
    `);

    query.run(id);
    return true;
  }

  /**
   * Count active tasks for a group
   */
  countActive(groupId: number): number {
    const query = this.db.query<{ count: number }, [number]>(`
      SELECT COUNT(*) as count FROM dev_tasks
      WHERE group_id = ?
        AND state NOT IN ('completed', 'rejected', 'failed')
    `);

    const result = query.get(groupId);
    return result ? result.count : 0;
  }
}
