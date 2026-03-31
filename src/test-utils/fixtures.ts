// Shared test fixture factories

import type { Database } from 'bun:sqlite';

let nextId = 100_000;

/**
 * Insert a group + user combo and return their IDs.
 * Most tests need this boilerplate — extract it once.
 */
export function seedGroupAndUser(
  db: Database,
  overrides: { groupId?: number; userId?: number } = {},
): { groupId: number; userId: number } {
  const seq = ++nextId;
  const telegramGroupId = overrides.groupId ?? -seq;
  const telegramUserId = overrides.userId ?? seq;

  db.run(`INSERT OR IGNORE INTO groups (telegram_group_id, default_currency) VALUES (?, 'EUR')`, [
    telegramGroupId,
  ]);
  const group = db
    .query<{ id: number }, [number]>('SELECT id FROM groups WHERE telegram_group_id = ?')
    .get(telegramGroupId);
  if (!group)
    throw new Error(
      `seedGroupAndUser: group insert failed for telegram_group_id=${telegramGroupId}`,
    );

  db.run(
    `INSERT OR IGNORE INTO users (telegram_user_id, group_id, display_name) VALUES (?, ?, 'Test User')`,
    [telegramUserId, group.id],
  );
  const user = db
    .query<{ id: number }, [number]>('SELECT id FROM users WHERE telegram_user_id = ?')
    .get(telegramUserId);
  if (!user)
    throw new Error(`seedGroupAndUser: user insert failed for telegram_user_id=${telegramUserId}`);

  return { groupId: group.id, userId: user.id };
}

/** Standard expense fields with sensible defaults */
export interface ExpenseFixture {
  group_id: number;
  user_id: number;
  date: string;
  category: string;
  comment: string;
  amount: number;
  currency: string;
  eur_amount: number;
}

export function makeExpense(
  groupId: number,
  userId: number,
  overrides: Partial<ExpenseFixture> = {},
): ExpenseFixture {
  return {
    group_id: groupId,
    user_id: userId,
    date: '2024-01-15',
    category: 'Food',
    comment: 'Lunch',
    amount: 25.0,
    currency: 'EUR',
    eur_amount: 25.0,
    ...overrides,
  };
}
