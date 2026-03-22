import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { DevTaskState } from '../../services/dev-pipeline/types';
import { DevTaskRepository } from './dev-task.repository';

let db: Database;
let repo: DevTaskRepository;

beforeAll(() => {
  db = new Database(':memory:');
  db.exec(`
    CREATE TABLE dev_tasks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      group_id INTEGER NOT NULL,
      user_id INTEGER NOT NULL,
      state TEXT NOT NULL DEFAULT 'pending',
      title TEXT,
      description TEXT NOT NULL,
      branch_name TEXT,
      worktree_path TEXT,
      pr_number INTEGER,
      pr_url TEXT,
      design TEXT,
      plan TEXT,
      code_review TEXT,
      error_log TEXT,
      retry_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    );
  `);
  repo = new DevTaskRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  db.exec('DELETE FROM dev_tasks');
});

describe('DevTaskRepository', () => {
  describe('create', () => {
    test('creates task and returns it with id', () => {
      const task = repo.create({
        group_id: 1,
        user_id: 10,
        description: 'Add dark mode support',
      });

      expect(task.id).toBeGreaterThan(0);
      expect(typeof task.id).toBe('number');
    });

    test('all fields populated correctly', () => {
      const task = repo.create({
        group_id: 42,
        user_id: 7,
        description: 'Refactor currency parser',
        title: 'Currency parser v2',
      });

      expect(task.group_id).toBe(42);
      expect(task.user_id).toBe(7);
      expect(task.state).toBe(DevTaskState.PENDING);
      expect(task.title).toBe('Currency parser v2');
      expect(task.description).toBe('Refactor currency parser');
      expect(task.branch_name).toBeNull();
      expect(task.worktree_path).toBeNull();
      expect(task.pr_number).toBeNull();
      expect(task.pr_url).toBeNull();
      expect(task.design).toBeNull();
      expect(task.plan).toBeNull();
      expect(task.code_review).toBeNull();
      expect(task.error_log).toBeNull();
      expect(task.retry_count).toBe(0);
      expect(task.created_at).toBeTruthy();
      expect(task.updated_at).toBeTruthy();
    });
  });

  describe('findById', () => {
    test('returns task by id', () => {
      const created = repo.create({
        group_id: 1,
        user_id: 1,
        description: 'Some task',
        title: 'Test title',
      });

      const found = repo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.description).toBe('Some task');
      expect(found?.title).toBe('Test title');
    });

    test('returns null for non-existent id', () => {
      const found = repo.findById(999999);
      expect(found).toBeNull();
    });
  });

  describe('findByGroupId', () => {
    test('returns tasks filtered by group_id', () => {
      repo.create({ group_id: 100, user_id: 1, description: 'Task A' });
      repo.create({ group_id: 100, user_id: 2, description: 'Task B' });
      repo.create({ group_id: 200, user_id: 3, description: 'Task C' });

      const group100Tasks = repo.findByGroupId(100);
      expect(group100Tasks).toHaveLength(2);
      expect(group100Tasks.every((t) => t.group_id === 100)).toBe(true);

      const group200Tasks = repo.findByGroupId(200);
      expect(group200Tasks).toHaveLength(1);
      expect(group200Tasks[0]?.description).toBe('Task C');
    });

    test('returns empty array for group with no tasks', () => {
      const tasks = repo.findByGroupId(777);
      expect(tasks).toEqual([]);
    });
  });

  describe('findActive', () => {
    test('returns only non-terminal tasks', () => {
      const pending = repo.create({ group_id: 1, user_id: 1, description: 'pending task' });
      const implementing = repo.create({
        group_id: 1,
        user_id: 1,
        description: 'implementing task',
      });
      const completed = repo.create({ group_id: 1, user_id: 1, description: 'completed task' });
      const rejected = repo.create({ group_id: 1, user_id: 1, description: 'rejected task' });
      const failed = repo.create({ group_id: 1, user_id: 1, description: 'failed task' });

      repo.update(implementing.id, { state: DevTaskState.IMPLEMENTING });
      repo.update(completed.id, { state: DevTaskState.COMPLETED });
      repo.update(rejected.id, { state: DevTaskState.REJECTED });
      repo.update(failed.id, { state: DevTaskState.FAILED });

      const active = repo.findActive();
      const activeIds = active.map((t) => t.id);

      expect(activeIds).toContain(pending.id);
      expect(activeIds).toContain(implementing.id);
      expect(activeIds).not.toContain(completed.id);
      expect(activeIds).not.toContain(rejected.id);
      expect(activeIds).not.toContain(failed.id);
    });
  });

  describe('findActiveByGroupId', () => {
    test('returns only non-terminal tasks for specific group', () => {
      const task1 = repo.create({ group_id: 50, user_id: 1, description: 'active in 50' });
      const task2 = repo.create({ group_id: 50, user_id: 1, description: 'done in 50' });
      repo.create({ group_id: 60, user_id: 1, description: 'active in 60' });

      repo.update(task2.id, { state: DevTaskState.COMPLETED });

      const active = repo.findActiveByGroupId(50);
      expect(active).toHaveLength(1);
      expect(active[0]?.id).toBe(task1.id);
    });

    test('excludes completed, rejected, and failed tasks', () => {
      const t1 = repo.create({ group_id: 5, user_id: 1, description: 't1' });
      const t2 = repo.create({ group_id: 5, user_id: 1, description: 't2' });
      const t3 = repo.create({ group_id: 5, user_id: 1, description: 't3' });

      repo.update(t1.id, { state: DevTaskState.COMPLETED });
      repo.update(t2.id, { state: DevTaskState.REJECTED });
      repo.update(t3.id, { state: DevTaskState.FAILED });

      const active = repo.findActiveByGroupId(5);
      expect(active).toHaveLength(0);
    });
  });

  describe('countActive', () => {
    test('returns correct count of active tasks', () => {
      repo.create({ group_id: 30, user_id: 1, description: 'a' });
      repo.create({ group_id: 30, user_id: 1, description: 'b' });
      const done = repo.create({ group_id: 30, user_id: 1, description: 'c' });
      repo.create({ group_id: 31, user_id: 1, description: 'd' });

      repo.update(done.id, { state: DevTaskState.COMPLETED });

      expect(repo.countActive(30)).toBe(2);
      expect(repo.countActive(31)).toBe(1);
      expect(repo.countActive(999)).toBe(0);
    });
  });

  describe('update', () => {
    test('updates specific fields', () => {
      const task = repo.create({ group_id: 1, user_id: 1, description: 'update me' });

      const updated = repo.update(task.id, {
        state: DevTaskState.IMPLEMENTING,
        branch_name: 'feat/dark-mode',
        worktree_path: '/tmp/worktree-123',
      });

      expect(updated).not.toBeNull();
      expect(updated?.state).toBe(DevTaskState.IMPLEMENTING);
      expect(updated?.branch_name).toBe('feat/dark-mode');
      expect(updated?.worktree_path).toBe('/tmp/worktree-123');
      // unchanged fields stay the same
      expect(updated?.description).toBe('update me');
    });

    test('returns updated task with new values', () => {
      const task = repo.create({ group_id: 1, user_id: 1, description: 'pr task' });

      const updated = repo.update(task.id, {
        pr_number: 42,
        pr_url: 'https://github.com/repo/pull/42',
        design: 'Design doc here',
        plan: 'Step 1, Step 2',
        code_review: 'LGTM',
        error_log: undefined,
        retry_count: 2,
        title: 'Updated title',
      });

      expect(updated?.pr_number).toBe(42);
      expect(updated?.pr_url).toBe('https://github.com/repo/pull/42');
      expect(updated?.design).toBe('Design doc here');
      expect(updated?.plan).toBe('Step 1, Step 2');
      expect(updated?.code_review).toBe('LGTM');
      expect(updated?.error_log).toBeNull();
      expect(updated?.retry_count).toBe(2);
      expect(updated?.title).toBe('Updated title');
    });

    test('updated_at changes after update', async () => {
      const task = repo.create({ group_id: 1, user_id: 1, description: 'timestamp test' });
      const originalUpdatedAt = task.updated_at;

      // SQLite CURRENT_TIMESTAMP has second precision, so we need a small delay
      await new Promise((resolve) => setTimeout(resolve, 1100));

      const updated = repo.update(task.id, { state: DevTaskState.DESIGNING });
      expect(updated?.updated_at).not.toBe(originalUpdatedAt);
    });

    test('returns unchanged task when no fields provided', () => {
      const task = repo.create({ group_id: 1, user_id: 1, description: 'noop update' });

      const result = repo.update(task.id, {});
      expect(result).not.toBeNull();
      expect(result?.id).toBe(task.id);
      expect(result?.description).toBe('noop update');
    });
  });

  describe('delete', () => {
    test('removes task from database', () => {
      const task = repo.create({ group_id: 1, user_id: 1, description: 'delete me' });
      expect(repo.findById(task.id)).not.toBeNull();

      const result = repo.delete(task.id);
      expect(result).toBe(true);
    });

    test('findById returns null after delete', () => {
      const task = repo.create({ group_id: 1, user_id: 1, description: 'gone soon' });
      repo.delete(task.id);

      expect(repo.findById(task.id)).toBeNull();
    });
  });
});
