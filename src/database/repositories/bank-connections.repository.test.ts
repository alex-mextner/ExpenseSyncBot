// Tests for BankConnectionsRepository — CRUD, wizard lifecycle, sync queries

import type { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { BankConnectionsRepository } from './bank-connections.repository';
import { GroupRepository } from './group.repository';

let db: Database;
let repo: BankConnectionsRepository;
let groupRepo: GroupRepository;
let groupId: number;

db = createTestDb();
repo = new BankConnectionsRepository(db);
groupRepo = new GroupRepository(db);

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  groupId = groupRepo.create({ telegram_group_id: Date.now() }).id;
});

describe('BankConnectionsRepository', () => {
  test('create and findById', () => {
    const conn = repo.create({ group_id: groupId, bank_name: 'tbc', display_name: 'TBC Bank' });
    expect(conn.id).toBeGreaterThan(0);
    expect(conn.status).toBe('setup');
    expect(conn.consecutive_failures).toBe(0);
    expect(repo.findById(conn.id)).toEqual(conn);
  });

  test('findByGroupAndBank returns null when not found', () => {
    expect(repo.findByGroupAndBank(groupId, 'tbc')).toBeNull();
  });

  test('findByGroupAndBank returns connection after create', () => {
    repo.create({ group_id: groupId, bank_name: 'tbc', display_name: 'TBC Bank' });
    const found = repo.findByGroupAndBank(groupId, 'tbc');
    expect(found?.bank_name).toBe('tbc');
  });

  test('findActiveByGroupId returns only active', () => {
    repo.create({
      group_id: groupId,
      bank_name: 'tbc',
      display_name: 'TBC Bank',
      status: 'active',
    });
    repo.create({ group_id: groupId, bank_name: 'kaspi', display_name: 'Kaspi', status: 'setup' });
    const active = repo.findActiveByGroupId(groupId);
    expect(active).toHaveLength(1);
    expect(active[0]?.bank_name).toBe('tbc');
  });

  test('findAllActive returns connections from all groups', () => {
    const g2 = groupRepo.create({ telegram_group_id: Date.now() + 1 }).id;
    repo.create({
      group_id: groupId,
      bank_name: 'tbc',
      display_name: 'TBC Bank',
      status: 'active',
    });
    repo.create({ group_id: g2, bank_name: 'kaspi', display_name: 'Kaspi', status: 'active' });
    expect(repo.findAllActive()).toHaveLength(2);
  });

  test('update changes fields', () => {
    const conn = repo.create({ group_id: groupId, bank_name: 'tbc', display_name: 'TBC Bank' });
    repo.update(conn.id, { status: 'active', consecutive_failures: 2 });
    const updated = repo.findById(conn.id);
    expect(updated?.status).toBe('active');
    expect(updated?.consecutive_failures).toBe(2);
  });

  test('deleteById removes the row', () => {
    const conn = repo.create({ group_id: groupId, bank_name: 'tbc', display_name: 'TBC Bank' });
    repo.deleteById(conn.id);
    expect(repo.findById(conn.id)).toBeNull();
  });

  test('deleteStaleSetup removes setup rows older than 10 min', () => {
    // Insert a stale setup row by manipulating created_at
    db.exec(`
      INSERT INTO bank_connections (group_id, bank_name, display_name, status, created_at)
      VALUES (${groupId}, 'stale', 'Stale Bank', 'setup', datetime('now', '-11 minutes'))
    `);
    repo.deleteStaleSetup(groupId);
    expect(repo.findByGroupAndBank(groupId, 'stale')).toBeNull();
  });

  test('deleteStaleSetup does not remove active connections', () => {
    const conn = repo.create({
      group_id: groupId,
      bank_name: 'tbc',
      display_name: 'TBC Bank',
      status: 'active',
    });
    repo.deleteStaleSetup(groupId);
    expect(repo.findById(conn.id)).not.toBeNull();
  });
});
