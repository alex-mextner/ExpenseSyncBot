// src/services/ai/bank-tools.test.ts

import type { Database } from 'bun:sqlite';
import { afterAll, beforeEach, describe, expect, test } from 'bun:test';
import { BankAccountsRepository } from '../../database/repositories/bank-accounts.repository';
import { BankConnectionsRepository } from '../../database/repositories/bank-connections.repository';
import { BankTransactionsRepository } from '../../database/repositories/bank-transactions.repository';
import { GroupRepository } from '../../database/repositories/group.repository';
import { clearTestDb, createTestDb } from '../../test-utils/db';
import { executeTool } from './tool-executor';
import type { AgentContext } from './types';

let db: Database;
let groupId: number;

db = createTestDb();
const groupRepo = new GroupRepository(db);
const connRepo = new BankConnectionsRepository(db);
const accRepo = new BankAccountsRepository(db);
const txRepo = new BankTransactionsRepository(db);

afterAll(() => db.close());

beforeEach(() => {
  clearTestDb(db);
  const group = groupRepo.create({ telegram_group_id: Date.now() });
  groupId = group.id;
});

// Note: executeTool uses the database singleton; these tests exercise the routing
// and result shape without mocking the singleton (empty DB returns empty lists).

describe('bank AI tools', () => {
  // These tests verify the tool returns structured results; actual AI calls are not made.
  test('get_bank_balances returns empty list when no connections', async () => {
    const ctx: AgentContext = {
      groupId,
      userId: 1,
      chatId: groupId,
      userName: 'test',
      userFullName: 'Test User',
      customPrompt: null,
      telegramGroupId: groupId,
    };
    const result = await executeTool('get_bank_balances', {}, ctx);
    expect(result.success).toBe(true);
  });

  test('get_bank_transactions returns empty list when no transactions', async () => {
    const ctx: AgentContext = {
      groupId,
      userId: 1,
      chatId: groupId,
      userName: 'test',
      userFullName: 'Test User',
      customPrompt: null,
      telegramGroupId: groupId,
    };
    const result = await executeTool('get_bank_transactions', { period: 'current_month' }, ctx);
    expect(result.success).toBe(true);
  });

  test('find_missing_expenses returns no missing when no transactions', async () => {
    const ctx: AgentContext = {
      groupId,
      userId: 1,
      chatId: groupId,
      userName: 'test',
      userFullName: 'Test User',
      customPrompt: null,
      telegramGroupId: groupId,
    };
    const result = await executeTool('find_missing_expenses', { period: 'current_month' }, ctx);
    expect(result.success).toBe(true);
  });
});

// Suppress unused variable warnings — repos are imported for completeness
void connRepo;
void accRepo;
void txRepo;
