// Tests for BankCredentialsRepository — encrypted credentials storage

import type { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { BankConnectionsRepository } from './bank-connections.repository';
import { BankCredentialsRepository } from './bank-credentials.repository';
import { GroupRepository } from './group.repository';

let db: Database;
let repo: BankCredentialsRepository;
let connRepo: BankConnectionsRepository;
let connectionId: number;

db = createTestDb();
repo = new BankCredentialsRepository(db);
connRepo = new BankConnectionsRepository(db);
const groupRepo = new GroupRepository(db);

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  const conn = connRepo.create({ group_id: group.id, bank_name: 'tbc', display_name: 'TBC Bank' });
  connectionId = conn.id;
});

describe('BankCredentialsRepository', () => {
  test('upsert and findByConnectionId', () => {
    repo.upsert(connectionId, 'encrypted-data-abc');
    const cred = repo.findByConnectionId(connectionId);
    expect(cred?.encrypted_data).toBe('encrypted-data-abc');
  });

  test('upsert updates existing row', () => {
    repo.upsert(connectionId, 'first');
    repo.upsert(connectionId, 'second');
    expect(repo.findByConnectionId(connectionId)?.encrypted_data).toBe('second');
  });

  test('findByConnectionId returns null when not found', () => {
    expect(repo.findByConnectionId(999)).toBeNull();
  });

  test('deleteByConnectionId removes row', () => {
    repo.upsert(connectionId, 'data');
    repo.deleteByConnectionId(connectionId);
    expect(repo.findByConnectionId(connectionId)).toBeNull();
  });
});
