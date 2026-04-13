// Shared test fixture factories

import type { Database } from 'bun:sqlite';
import type { BankTransaction, Expense } from '../database/types';

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

/** Build a full Expense object with sensible defaults. Override only what each test cares about. */
export function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 1,
    group_id: 1,
    user_id: 1,
    date: '2024-01-15',
    category: 'Food',
    comment: 'Lunch',
    amount: 25.0,
    currency: 'EUR',
    eur_amount: 25.0,
    receipt_id: null,
    receipt_file_id: null,
    created_at: '',
    ...overrides,
  };
}

/** Build a full BankTransaction object with sensible defaults. */
export function makeBankTransaction(overrides: Partial<BankTransaction> = {}): BankTransaction {
  return {
    id: 1,
    connection_id: 1,
    external_id: 'tx1',
    account_id: 'acc1',
    date: '2024-01-15',
    time: '12:00',
    amount: -50,
    sign_type: 'debit',
    currency: 'EUR',
    merchant: 'Store',
    merchant_normalized: null,
    mcc: null,
    raw_data: '{}',
    invoice_amount: null,
    invoice_currency: null,
    matched_expense_id: null,
    matched_receipt_id: null,
    telegram_message_id: null,
    edit_in_progress: 0,
    awaiting_comment: 0,
    prefill_category: null,
    prefill_comment: null,
    status: 'pending',
    created_at: '',
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
    technicalAnalysis: null,
    ...overrides,
  };
}
