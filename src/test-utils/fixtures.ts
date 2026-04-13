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

  db.run(`INSERT OR IGNORE INTO users (telegram_id, group_id) VALUES (?, ?)`, [
    telegramUserId,
    group.id,
  ]);
  const user = db
    .query<{ id: number }, [number]>('SELECT id FROM users WHERE telegram_id = ?')
    .get(telegramUserId);
  if (!user)
    throw new Error(`seedGroupAndUser: user insert failed for telegram_id=${telegramUserId}`);

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

/** Minimal valid FinancialSnapshot with neutral values. Override individual fields as needed. */
export function buildNeutralSnapshot(
  overrides: Partial<import('../services/analytics/types').FinancialSnapshot> = {},
): import('../services/analytics/types').FinancialSnapshot {
  return {
    burnRates: [],
    weekTrend: {
      period: 'week',
      current_total: 0,
      previous_total: 0,
      change_percent: 0,
      direction: 'stable',
      category_changes: [],
    },
    monthTrend: {
      period: 'month',
      current_total: 0,
      previous_total: 0,
      change_percent: 0,
      direction: 'stable',
      category_changes: [],
    },
    anomalies: [],
    dayOfWeekPatterns: [],
    velocity: {
      period_1_daily_avg: 0,
      period_2_daily_avg: 0,
      acceleration: 0,
      trend: 'stable',
    },
    budgetUtilization: null,
    streak: {
      current_streak_days: 0,
      streak_type: 'no_spending',
      avg_daily_during_streak: 0,
      overall_daily_average: 0,
    },
    projection: null,
    ...overrides,
  };
}
