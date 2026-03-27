import type { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { GroupRepository } from './group.repository';
import { MerchantRulesRepository } from './merchant-rules.repository';

let db: Database;
let repo: MerchantRulesRepository;
let groupId: number;

db = createTestDb();
repo = new MerchantRulesRepository(db);
const groupRepo = new GroupRepository(db);

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  groupId = groupRepo.create({ telegram_group_id: Date.now() }).id;
});

describe('MerchantRulesRepository', () => {
  test('insert creates rule with defaults', () => {
    const rule = repo.insert({ pattern: 'GLOVO.*', replacement: 'Glovo', category: 'food' });
    expect(rule.id).toBeGreaterThan(0);
    expect(rule.status).toBe('pending_review');
    expect(rule.source).toBe('ai');
    expect(rule.flags).toBe('i');
  });

  test('findApproved returns only approved rules', () => {
    repo.insert({ pattern: 'A', replacement: 'a' });
    const r2 = repo.insert({ pattern: 'B', replacement: 'b' });
    repo.updateStatus(r2.id, 'approved');
    const approved = repo.findApproved();
    expect(approved).toHaveLength(1);
    expect(approved.at(0)?.pattern).toBe('B');
  });

  test('findPendingReview returns pending_review rules', () => {
    repo.insert({ pattern: 'A', replacement: 'a' });
    expect(repo.findPendingReview()).toHaveLength(1);
  });

  test('update changes pattern and replacement', () => {
    const rule = repo.insert({ pattern: 'OLD.*', replacement: 'Old' });
    repo.update(rule.id, { pattern: 'NEW.*', replacement: 'New', category: 'test' });
    const updated = repo.findById(rule.id);
    expect(updated?.pattern).toBe('NEW.*');
    expect(updated?.category).toBe('test');
  });

  test('insertRuleRequest uses INSERT OR IGNORE (no duplicate)', () => {
    repo.insertRuleRequest({ merchant_raw: 'GLOVO*1234', group_id: groupId });
    repo.insertRuleRequest({ merchant_raw: 'GLOVO*1234', group_id: groupId });
    const requests = repo.findUnprocessedRequests();
    expect(requests).toHaveLength(1);
  });

  test('markRequestProcessed sets processed=1', () => {
    repo.insertRuleRequest({ merchant_raw: 'SHOP ABC', group_id: groupId });
    const req = repo.findUnprocessedRequests().at(0);
    if (!req) return;
    repo.markRequestProcessed(req.id);
    expect(repo.findUnprocessedRequests()).toHaveLength(0);
  });

  test('pruneOldRequests removes processed rows older than 7 days', () => {
    db.exec(`
      INSERT INTO merchant_rule_requests (merchant_raw, processed, created_at)
      VALUES ('OLD', 1, datetime('now', '-8 days'))
    `);
    repo.pruneOldRequests();
    expect(repo.findUnprocessedRequests()).toHaveLength(0);
    // verify the old processed row is gone
    const count = db
      .query<{ count: number }, []>(
        "SELECT COUNT(*) as count FROM merchant_rule_requests WHERE merchant_raw = 'OLD'",
      )
      .get();
    expect(count?.count).toBe(0);
  });
});
