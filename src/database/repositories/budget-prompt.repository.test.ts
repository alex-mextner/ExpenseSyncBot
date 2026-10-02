// Tests for BudgetPromptRepository — persistence, group/user/topic scoping, status transitions

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { BudgetPromptRepository } from './budget-prompt.repository';
import { GroupRepository } from './group.repository';
import { UserRepository } from './user.repository';

let db: Database;
let repo: BudgetPromptRepository;
let groupId: number;
let otherGroupId: number;
let userId: number;
let otherUserId: number;

beforeAll(() => {
  db = createTestDb();
  repo = new BudgetPromptRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
  const groups = new GroupRepository(db);
  const users = new UserRepository(db);
  groupId = groups.create({ telegram_group_id: -1001 }).id;
  otherGroupId = groups.create({ telegram_group_id: -1002 }).id;
  userId = users.create({ telegram_id: 1, group_id: groupId }).id;
  otherUserId = users.create({ telegram_id: 2, group_id: groupId }).id;
});

function createPrompt(overrides: { category?: string; thread?: number | null } = {}) {
  return repo.create({
    group_id: groupId,
    user_id: userId,
    category: overrides.category ?? 'Food',
    target_month: '2026-10',
    currency: 'EUR',
    message_thread_id: overrides.thread ?? null,
  });
}

describe('BudgetPromptRepository', () => {
  test('create persists an active prompt without a message id', () => {
    const prompt = createPrompt();
    expect(prompt.id).toBeGreaterThan(0);
    expect(prompt.status).toBe('active');
    expect(prompt.telegram_message_id).toBeNull();
    expect(prompt.category).toBe('Food');
  });

  test('bindMessage stores the Telegram message id', () => {
    const prompt = createPrompt();
    repo.bindMessage(prompt.id, 555);
    expect(repo.findById(prompt.id)?.telegram_message_id).toBe(555);
  });

  test('findActiveForUser is scoped by group, user and topic', () => {
    const general = createPrompt({ category: 'A' });
    const topic = createPrompt({ category: 'B', thread: 7 });
    repo.create({
      group_id: otherGroupId,
      user_id: userId,
      category: 'C',
      target_month: '2026-10',
      currency: 'EUR',
    });
    repo.create({
      group_id: groupId,
      user_id: otherUserId,
      category: 'D',
      target_month: '2026-10',
      currency: 'EUR',
    });

    expect(repo.findActiveForUser(groupId, userId, null).map((p) => p.id)).toEqual([general.id]);
    expect(repo.findActiveForUser(groupId, userId, 7).map((p) => p.id)).toEqual([topic.id]);
    expect(repo.findActiveForUser(groupId, userId, 8)).toEqual([]);
  });

  test('findActiveByMessage matches only the bound message', () => {
    const first = createPrompt({ category: 'A' });
    const second = createPrompt({ category: 'B' });
    repo.bindMessage(first.id, 10);
    repo.bindMessage(second.id, 11);

    expect(repo.findActiveByMessage(groupId, userId, 11, null)?.id).toBe(second.id);
    expect(repo.findActiveByMessage(groupId, userId, 99, null)).toBeNull();
    expect(repo.findActiveByMessage(groupId, otherUserId, 11, null)).toBeNull();
    expect(repo.findActiveByMessage(groupId, userId, 11, 7)).toBeNull();
  });

  test('finish moves the prompt out of the active set exactly once', () => {
    const prompt = createPrompt();
    expect(repo.finish(prompt.id, 'used')).toBe(true);
    expect(repo.finish(prompt.id, 'skipped')).toBe(false);
    expect(repo.findById(prompt.id)?.status).toBe('used');
    expect(repo.findActiveForUser(groupId, userId, null)).toEqual([]);
  });

  test('findActiveById ignores finished prompts', () => {
    const prompt = createPrompt();
    expect(repo.findActiveById(prompt.id)?.id).toBe(prompt.id);
    repo.finish(prompt.id, 'skipped');
    expect(repo.findActiveById(prompt.id)).toBeNull();
  });

  test('expired prompts are not active', () => {
    const prompt = createPrompt();
    db.query("UPDATE budget_prompts SET created_at = datetime('now', '-8 days') WHERE id = ?").run(
      prompt.id,
    );
    expect(repo.findActiveForUser(groupId, userId, null)).toEqual([]);
    expect(repo.findActiveById(prompt.id)).toBeNull();
  });

  test('reopen restores a finished prompt', () => {
    const prompt = createPrompt();
    repo.finish(prompt.id, 'used');
    repo.reopen(prompt.id);
    expect(repo.findById(prompt.id)?.status).toBe('active');
  });

  test('supersedeActive skips older active prompts for the same category and scope', () => {
    const old = createPrompt({ category: 'Food' });
    const otherCategory = createPrompt({ category: 'Rent' });
    const otherTopic = createPrompt({ category: 'Food', thread: 3 });

    repo.supersedeActive(groupId, userId, 'Food', null);

    expect(repo.findById(old.id)?.status).toBe('skipped');
    expect(repo.findById(otherCategory.id)?.status).toBe('active');
    expect(repo.findById(otherTopic.id)?.status).toBe('active');
  });

  test('prompts are removed with their group', () => {
    createPrompt();
    db.query('DELETE FROM groups WHERE id = ?').run(groupId);
    expect(db.query('SELECT COUNT(*) as c FROM budget_prompts').get()).toEqual({ c: 0 });
  });
});
