// Tests for GroupSpreadsheetRepository — getByYear, setYear, getCurrentYear, listAll

import type { Database } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { GroupSpreadsheetRepository } from './group-spreadsheet.repository';
import { GroupRepository } from './group.repository';

let db: Database;
let repo: GroupSpreadsheetRepository;
let groupRepo: GroupRepository;
let groupId: number;

beforeAll(() => {
  db = createTestDb();
  repo = new GroupSpreadsheetRepository(db);
  groupRepo = new GroupRepository(db);
});

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  groupId = group.id;
});

describe('GroupSpreadsheetRepository', () => {
  test('getByYear returns null when no entry', () => {
    expect(repo.getByYear(groupId, 2026)).toBeNull();
  });

  test('setYear creates entry, getByYear returns it', () => {
    repo.setYear(groupId, 2026, 'spreadsheet-123');
    expect(repo.getByYear(groupId, 2026)).toBe('spreadsheet-123');
  });

  test('setYear replaces existing entry (INSERT OR REPLACE)', () => {
    repo.setYear(groupId, 2026, 'old-id');
    repo.setYear(groupId, 2026, 'new-id');
    expect(repo.getByYear(groupId, 2026)).toBe('new-id');
  });

  test('getCurrentYear returns null when no entry for current year', () => {
    repo.setYear(groupId, 2020, 'old-spreadsheet');
    expect(repo.getCurrentYear(groupId)).toBeNull();
  });

  test('getCurrentYear returns spreadsheet for current year', () => {
    const year = new Date().getFullYear();
    repo.setYear(groupId, year, 'current-spreadsheet');
    expect(repo.getCurrentYear(groupId)).toBe('current-spreadsheet');
  });

  test('listAll returns entries sorted by year desc', () => {
    repo.setYear(groupId, 2024, 'id-2024');
    repo.setYear(groupId, 2026, 'id-2026');
    repo.setYear(groupId, 2025, 'id-2025');
    const all = repo.listAll(groupId);
    expect(all).toHaveLength(3);
    expect(all[0]).toEqual({ year: 2026, spreadsheetId: 'id-2026' });
    expect(all[2]).toEqual({ year: 2024, spreadsheetId: 'id-2024' });
  });

  test('listAll returns empty array when no entries', () => {
    expect(repo.listAll(groupId)).toEqual([]);
  });

  test('getByYear is isolated per group', () => {
    const g2 = groupRepo.create({ telegram_group_id: Date.now() + 1 });
    repo.setYear(groupId, 2026, 'id-g1');
    repo.setYear(g2.id, 2026, 'id-g2');
    expect(repo.getByYear(groupId, 2026)).toBe('id-g1');
    expect(repo.getByYear(g2.id, 2026)).toBe('id-g2');
  });
});
