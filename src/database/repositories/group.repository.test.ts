// Tests for GroupRepository — CRUD, JSON fields, update, cascade

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { GroupRepository } from './group.repository';

let db: Database;
let repo: GroupRepository;

beforeAll(() => {
  db = createTestDb();
  repo = new GroupRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
});

describe('GroupRepository', () => {
  describe('create', () => {
    test('creates group and returns it with id', () => {
      const group = repo.create({ telegram_group_id: 100 });
      expect(group.id).toBeGreaterThan(0);
      expect(typeof group.id).toBe('number');
    });

    test('defaults: default_currency USD, enabled_currencies []', () => {
      const group = repo.create({ telegram_group_id: 101 });
      expect(group.default_currency).toBe('USD');
      expect(group.enabled_currencies).toEqual([]);
    });

    test('custom default_currency is stored', () => {
      const group = repo.create({ telegram_group_id: 102, default_currency: 'EUR' });
      expect(group.default_currency).toBe('EUR');
    });

    test('new group has null google_refresh_token', () => {
      const group = repo.create({ telegram_group_id: 103 });
      expect(group.google_refresh_token).toBeNull();
    });

    test('new group has null spreadsheet_id', () => {
      const group = repo.create({ telegram_group_id: 104 });
      expect(group.spreadsheet_id).toBeNull();
    });

    test('new group has null custom_prompt', () => {
      const group = repo.create({ telegram_group_id: 105 });
      expect(group.custom_prompt).toBeNull();
    });

    test('new group has null active_topic_id', () => {
      const group = repo.create({ telegram_group_id: 106 });
      expect(group.active_topic_id).toBeNull();
    });

    test('created_at and updated_at are populated', () => {
      const group = repo.create({ telegram_group_id: 107 });
      expect(group.created_at).toBeTruthy();
      expect(group.updated_at).toBeTruthy();
    });

    test('telegram_group_id uniqueness enforced', () => {
      repo.create({ telegram_group_id: 108 });
      expect(() => repo.create({ telegram_group_id: 108 })).toThrow();
    });
  });

  describe('findByTelegramGroupId', () => {
    test('returns group for existing telegram_group_id', () => {
      const created = repo.create({ telegram_group_id: 200 });
      const found = repo.findByTelegramGroupId(200);
      expect(found).not.toBeNull();
      expect(found?.id).toBe(created.id);
      expect(found?.telegram_group_id).toBe(200);
    });

    test('returns null for non-existent telegram_group_id', () => {
      expect(repo.findByTelegramGroupId(99999)).toBeNull();
    });

    test('enabled_currencies is parsed as array', () => {
      repo.create({ telegram_group_id: 201 });
      const found = repo.findByTelegramGroupId(201);
      expect(Array.isArray(found?.enabled_currencies)).toBe(true);
    });
  });

  describe('findById', () => {
    test('returns group for existing id', () => {
      const created = repo.create({ telegram_group_id: 300 });
      const found = repo.findById(created.id);
      expect(found).not.toBeNull();
      expect(found?.telegram_group_id).toBe(300);
    });

    test('returns null for non-existent id', () => {
      expect(repo.findById(999999)).toBeNull();
    });

    test('enabled_currencies is parsed as array from JSON', () => {
      const created = repo.create({ telegram_group_id: 301 });
      const found = repo.findById(created.id);
      expect(Array.isArray(found?.enabled_currencies)).toBe(true);
    });
  });

  describe('update', () => {
    test('updates google_refresh_token', () => {
      repo.create({ telegram_group_id: 400 });
      const updated = repo.update(400, { google_refresh_token: 'token123' });
      expect(updated?.google_refresh_token).toBe('token123');
    });

    test('updates spreadsheet_id', () => {
      repo.create({ telegram_group_id: 401 });
      const updated = repo.update(401, { spreadsheet_id: 'sheet-abc' });
      expect(updated?.spreadsheet_id).toBe('sheet-abc');
    });

    test('updates default_currency', () => {
      repo.create({ telegram_group_id: 402 });
      const updated = repo.update(402, { default_currency: 'EUR' });
      expect(updated?.default_currency).toBe('EUR');
    });

    test('updates enabled_currencies (array stored as JSON)', () => {
      repo.create({ telegram_group_id: 403 });
      const updated = repo.update(403, { enabled_currencies: ['EUR', 'USD', 'RSD'] });
      expect(updated?.enabled_currencies).toEqual(['EUR', 'USD', 'RSD']);
    });

    test('updates custom_prompt', () => {
      repo.create({ telegram_group_id: 404 });
      const updated = repo.update(404, { custom_prompt: 'You are a helpful bot.' });
      expect(updated?.custom_prompt).toBe('You are a helpful bot.');
    });

    test('sets custom_prompt to null', () => {
      repo.create({ telegram_group_id: 405 });
      repo.update(405, { custom_prompt: 'some prompt' });
      const updated = repo.update(405, { custom_prompt: null });
      expect(updated?.custom_prompt).toBeNull();
    });

    test('updates active_topic_id', () => {
      repo.create({ telegram_group_id: 406 });
      const updated = repo.update(406, { active_topic_id: 42 });
      expect(updated?.active_topic_id).toBe(42);
    });

    test('sets active_topic_id to null', () => {
      repo.create({ telegram_group_id: 407 });
      repo.update(407, { active_topic_id: 10 });
      const updated = repo.update(407, { active_topic_id: null });
      expect(updated?.active_topic_id).toBeNull();
    });

    test('returns null for non-existent telegram_group_id', () => {
      const result = repo.update(999999, { spreadsheet_id: 'x' });
      expect(result).toBeNull();
    });

    test('multiple fields updated at once', () => {
      repo.create({ telegram_group_id: 408 });
      const updated = repo.update(408, {
        google_refresh_token: 'rt',
        spreadsheet_id: 'ss',
        default_currency: 'RSD',
      });
      expect(updated?.google_refresh_token).toBe('rt');
      expect(updated?.spreadsheet_id).toBe('ss');
      expect(updated?.default_currency).toBe('RSD');
    });
  });

  describe('getAll', () => {
    test('returns all groups', () => {
      repo.create({ telegram_group_id: 500 });
      repo.create({ telegram_group_id: 501 });
      repo.create({ telegram_group_id: 502 });
      const all = repo.getAll();
      expect(all.length).toBe(3);
    });

    test('returns empty array when no groups', () => {
      expect(repo.getAll()).toEqual([]);
    });

    test('all returned groups have parsed enabled_currencies', () => {
      repo.create({ telegram_group_id: 503 });
      repo.create({ telegram_group_id: 504 });
      const all = repo.getAll();
      for (const g of all) {
        expect(Array.isArray(g.enabled_currencies)).toBe(true);
      }
    });
  });

  describe('delete', () => {
    test('removes group from database', () => {
      repo.create({ telegram_group_id: 600 });
      repo.delete(600);
      expect(repo.findByTelegramGroupId(600)).toBeNull();
    });

    test('returns true', () => {
      repo.create({ telegram_group_id: 601 });
      expect(repo.delete(601)).toBe(true);
    });

    test('deleting non-existent group returns true (no error)', () => {
      expect(repo.delete(999999)).toBe(true);
    });
  });

  describe('spreadsheet_id via group_spreadsheets JOIN', () => {
    test('new group has null spreadsheet_id (no group_spreadsheets entry)', () => {
      const group = repo.create({ telegram_group_id: 800 });
      expect(group.spreadsheet_id).toBeNull();
    });

    test('findById returns spreadsheet_id from group_spreadsheets for current year', () => {
      const group = repo.create({ telegram_group_id: 801 });
      const year = new Date().getFullYear();
      db.exec(
        `INSERT INTO group_spreadsheets (group_id, year, spreadsheet_id) VALUES (${group.id}, ${year}, 'test-sheet-id')`,
      );
      const found = repo.findById(group.id);
      expect(found?.spreadsheet_id).toBe('test-sheet-id');
    });

    test('findById returns null spreadsheet_id when entry is for different year', () => {
      const group = repo.create({ telegram_group_id: 802 });
      db.exec(
        `INSERT INTO group_spreadsheets (group_id, year, spreadsheet_id) VALUES (${group.id}, 2020, 'old-sheet')`,
      );
      const found = repo.findById(group.id);
      expect(found?.spreadsheet_id).toBeNull();
    });

    test('update with spreadsheet_id writes to group_spreadsheets', () => {
      const group = repo.create({ telegram_group_id: 803 });
      repo.update(803, { spreadsheet_id: 'new-sheet' });
      const year = new Date().getFullYear();
      const row = db
        .query<{ spreadsheet_id: string }, [number, number]>(
          'SELECT spreadsheet_id FROM group_spreadsheets WHERE group_id = ? AND year = ?',
        )
        .get(group.id, year);
      expect(row?.spreadsheet_id).toBe('new-sheet');
    });
  });

  describe('hasCompletedSetup', () => {
    // hasCompletedSetup checks default_currency + enabled_currencies (not OAuth)
    test('returns false for new group with empty enabled_currencies', () => {
      repo.create({ telegram_group_id: 700 });
      expect(repo.hasCompletedSetup(700)).toBe(false);
    });

    test('returns false when enabled_currencies is empty', () => {
      repo.create({ telegram_group_id: 702 });
      repo.update(702, { enabled_currencies: [] });
      expect(repo.hasCompletedSetup(702)).toBe(false);
    });

    test('returns true when default_currency and enabled_currencies are set', () => {
      repo.create({ telegram_group_id: 703 });
      repo.update(703, { default_currency: 'EUR', enabled_currencies: ['EUR'] });
      expect(repo.hasCompletedSetup(703)).toBe(true);
    });

    test('returns false for non-existent group', () => {
      expect(repo.hasCompletedSetup(999999)).toBe(false);
    });
  });
});
