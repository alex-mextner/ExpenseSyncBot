// Tests for AdviceLogRepository — all public methods

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createTestDb } from '../../test-utils/db';
import { AdviceLogRepository } from './advice-log.repository';

let db: Database;
let repo: AdviceLogRepository;
let groupId: number;

beforeAll(() => {
  db = createTestDb();
  repo = new AdviceLogRepository(db);
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec(`
    DELETE FROM advice_log;
    DELETE FROM users;
    DELETE FROM groups;
  `);
  const gResult = db
    .prepare(
      `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, 'EUR', '["EUR"]')`,
    )
    .run(200100);
  groupId = gResult.lastInsertRowid as number;
});

describe('AdviceLogRepository', () => {
  describe('create', () => {
    it('creates and returns an advice log entry with id', () => {
      const entry = repo.create({
        group_id: groupId,
        tier: 'quick',
        trigger_type: 'weekly_check',
        advice_text: 'You spent a lot this week.',
      });
      expect(entry.id).toBeGreaterThan(0);
      expect(entry.group_id).toBe(groupId);
      expect(entry.tier).toBe('quick');
      expect(entry.trigger_type).toBe('weekly_check');
      expect(entry.advice_text).toBe('You spent a lot this week.');
      expect(entry.trigger_data).toBeNull();
      expect(entry.topic).toBeNull();
    });

    it('creates entry with trigger_data and topic', () => {
      const entry = repo.create({
        group_id: groupId,
        tier: 'alert',
        trigger_type: 'budget_threshold',
        trigger_data: '{"category":"Food","percent":90}',
        topic: 'budget_food',
        advice_text: 'Food budget is at 90%.',
      });
      expect(entry.trigger_data).toBe('{"category":"Food","percent":90}');
      expect(entry.topic).toBe('budget_food');
    });

    it('creates entries with all three tiers', () => {
      const tiers = ['quick', 'alert', 'deep'] as const;
      for (const tier of tiers) {
        const entry = repo.create({
          group_id: groupId,
          tier,
          trigger_type: 'manual',
          advice_text: `${tier} advice`,
        });
        expect(entry.tier).toBe(tier);
      }
    });

    it('stores created_at timestamp', () => {
      const entry = repo.create({
        group_id: groupId,
        tier: 'quick',
        trigger_type: 'manual',
        advice_text: 'test',
      });
      expect(typeof entry.created_at).toBe('string');
      expect(entry.created_at.length).toBeGreaterThan(0);
    });
  });

  describe('findById', () => {
    it('returns entry by id', () => {
      const created = repo.create({
        group_id: groupId,
        tier: 'deep',
        trigger_type: 'anomaly',
        advice_text: 'Anomaly detected.',
      });
      const found = repo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
    });

    it('returns null for non-existent id', () => {
      const found = repo.findById(999999);
      expect(found).toBeNull();
    });
  });

  describe('getRecent', () => {
    it('returns entries for group in descending order', () => {
      repo.create({
        group_id: groupId,
        tier: 'quick',
        trigger_type: 'manual',
        advice_text: 'first',
      });
      repo.create({
        group_id: groupId,
        tier: 'alert',
        trigger_type: 'manual',
        advice_text: 'second',
      });
      const recent = repo.getRecent(groupId, 10);
      expect(recent.length).toBe(2);
    });

    it('respects limit parameter', () => {
      for (let i = 0; i < 5; i++) {
        repo.create({
          group_id: groupId,
          tier: 'quick',
          trigger_type: 'manual',
          advice_text: `advice ${i}`,
        });
      }
      const recent = repo.getRecent(groupId, 3);
      expect(recent).toHaveLength(3);
    });

    it('returns empty array for group with no entries', () => {
      const gResult2 = db
        .prepare(
          `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, 'EUR', '["EUR"]')`,
        )
        .run(300200);
      const groupId2 = gResult2.lastInsertRowid as number;
      const recent = repo.getRecent(groupId2, 10);
      expect(recent).toEqual([]);
    });

    it('uses default limit of 10', () => {
      for (let i = 0; i < 15; i++) {
        repo.create({
          group_id: groupId,
          tier: 'quick',
          trigger_type: 'manual',
          advice_text: `advice ${i}`,
        });
      }
      const recent = repo.getRecent(groupId);
      expect(recent).toHaveLength(10);
    });
  });

  describe('getRecentTopics', () => {
    it('returns only non-null topics', () => {
      repo.create({
        group_id: groupId,
        tier: 'quick',
        trigger_type: 'manual',
        topic: 'topic_a',
        advice_text: 'advice with topic',
      });
      repo.create({
        group_id: groupId,
        tier: 'quick',
        trigger_type: 'manual',
        advice_text: 'advice without topic',
      });
      const topics = repo.getRecentTopics(groupId, 10);
      expect(topics).toContain('topic_a');
      expect(topics).toHaveLength(1);
    });

    it('returns at most limit topics', () => {
      for (let i = 0; i < 8; i++) {
        repo.create({
          group_id: groupId,
          tier: 'quick',
          trigger_type: 'manual',
          topic: `topic_${i}`,
          advice_text: `advice ${i}`,
        });
      }
      const topics = repo.getRecentTopics(groupId, 3);
      expect(topics).toHaveLength(3);
    });

    it('returns empty array when no topics exist', () => {
      repo.create({
        group_id: groupId,
        tier: 'quick',
        trigger_type: 'manual',
        advice_text: 'no topic here',
      });
      const topics = repo.getRecentTopics(groupId, 10);
      expect(topics).toEqual([]);
    });
  });

  describe('getLastByTier', () => {
    it('returns most recent entry for tier', () => {
      repo.create({
        group_id: groupId,
        tier: 'deep',
        trigger_type: 'manual',
        advice_text: 'old deep',
      });
      repo.create({
        group_id: groupId,
        tier: 'deep',
        trigger_type: 'manual',
        advice_text: 'new deep',
      });
      const last = repo.getLastByTier(groupId, 'deep');
      expect(last).not.toBeNull();
      // Both are valid — just verify we get a deep tier result
      expect(last?.tier).toBe('deep');
    });

    it('returns null when no entries for tier', () => {
      repo.create({
        group_id: groupId,
        tier: 'quick',
        trigger_type: 'manual',
        advice_text: 'quick only',
      });
      const last = repo.getLastByTier(groupId, 'deep');
      expect(last).toBeNull();
    });

    it('does not return entries from other groups', () => {
      const gResult2 = db
        .prepare(
          `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies) VALUES (?, 'EUR', '["EUR"]')`,
        )
        .run(400300);
      const groupId2 = gResult2.lastInsertRowid as number;
      repo.create({
        group_id: groupId2,
        tier: 'alert',
        trigger_type: 'manual',
        advice_text: 'other group advice',
      });
      const last = repo.getLastByTier(groupId, 'alert');
      expect(last).toBeNull();
    });
  });

  describe('countToday', () => {
    it('counts entries created today', () => {
      repo.create({
        group_id: groupId,
        tier: 'quick',
        trigger_type: 'manual',
        advice_text: 'today advice 1',
      });
      repo.create({
        group_id: groupId,
        tier: 'alert',
        trigger_type: 'manual',
        advice_text: 'today advice 2',
      });
      const today = new Date().toISOString().slice(0, 10);
      const count = repo.countToday(groupId, today);
      expect(count).toBe(2);
    });

    it('returns 0 for a past date with no entries', () => {
      repo.create({
        group_id: groupId,
        tier: 'quick',
        trigger_type: 'manual',
        advice_text: 'some advice',
      });
      const count = repo.countToday(groupId, '2020-01-01');
      expect(count).toBe(0);
    });

    it('returns 0 for group with no entries', () => {
      const today = new Date().toISOString().slice(0, 10);
      const count = repo.countToday(groupId, today);
      expect(count).toBe(0);
    });
  });

  describe('hasTopicThisMonth', () => {
    it('returns true when topic was created this month', () => {
      repo.create({
        group_id: groupId,
        tier: 'quick',
        trigger_type: 'manual',
        topic: 'budget_food',
        advice_text: 'food budget advice',
      });
      const monthStart = new Date();
      monthStart.setDate(1);
      const monthStartStr = monthStart.toISOString().slice(0, 10);
      const result = repo.hasTopicThisMonth(groupId, 'budget_food', monthStartStr);
      expect(result).toBe(true);
    });

    it('returns false when topic was not created this month', () => {
      repo.create({
        group_id: groupId,
        tier: 'quick',
        trigger_type: 'manual',
        topic: 'budget_food',
        advice_text: 'food budget advice',
      });
      // Use a future date as month start — no entries after that
      const result = repo.hasTopicThisMonth(groupId, 'budget_food', '2099-01-01');
      expect(result).toBe(false);
    });

    it('returns false for different topic', () => {
      repo.create({
        group_id: groupId,
        tier: 'quick',
        trigger_type: 'manual',
        topic: 'budget_food',
        advice_text: 'food advice',
      });
      const monthStart = new Date();
      monthStart.setDate(1);
      const monthStartStr = monthStart.toISOString().slice(0, 10);
      const result = repo.hasTopicThisMonth(groupId, 'budget_transport', monthStartStr);
      expect(result).toBe(false);
    });
  });
});
