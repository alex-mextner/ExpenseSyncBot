// Shared harness for the spending-analytics test files: in-memory DB wiring, seeded fixture data
// and the Testable* subclass exposing protected compute* methods.
// Split out of spending-analytics.test.ts so each describe area lives in its own <=1200-line test file.
// Every test file calls installAnalyticsFixture() at load time (bun runs test files sequentially),
// which gives that file a fresh in-memory DB and points the mocked `database` singleton at it.

import type { Database } from 'bun:sqlite';
import { mock } from 'bun:test';
import { format, subDays, subMonths } from 'date-fns';
import { BudgetRepository } from '../../database/repositories/budget.repository';
import { ExpenseRepository } from '../../database/repositories/expense.repository';
import { createTestDb } from '../../test-utils/db';
import { seedGroupAndUser } from '../../test-utils/fixtures';

/** Stand-in for the `database` singleton; fields are re-pointed by installAnalyticsFixture(). */
const mockDatabase: {
  db?: Database;
  expenses?: ExpenseRepository;
  budgets?: BudgetRepository;
} = {};

// Mock the database module so SpendingAnalytics picks up our in-memory repos
mock.module('../../database', () => ({ database: mockDatabase }));

export interface AnalyticsFixture {
  db: Database;
  expenseRepo: ExpenseRepository;
  budgetRepo: BudgetRepository;
}

/** Create a fresh in-memory DB with real repositories and make the mocked singleton use it. */
export function installAnalyticsFixture(): AnalyticsFixture {
  const db = createTestDb();
  const expenseRepo = new ExpenseRepository(db);
  const budgetRepo = new BudgetRepository(db);
  mockDatabase.db = db;
  mockDatabase.expenses = expenseRepo;
  mockDatabase.budgets = budgetRepo;
  return { db, expenseRepo, budgetRepo };
}

// Import AFTER mock is set up
export const {
  SpendingAnalytics,
  buildCategoryProfiles,
  buildIntervalProfiles,
  passesActivityGate,
  projectCategory,
} = await import('./spending-analytics');

export class TestableSpendingAnalytics extends SpendingAnalytics {
  testComputeVelocity = (groupId: number, today: string) => this.computeVelocity(groupId, today);
  testComputeStreak = (groupId: number, today: string) => this.computeStreak(groupId, today);
  testComputeDayPatterns = (groupId: number, today: string) =>
    this.computeDayPatterns(groupId, today);
  testComputeWeekOverWeek = (groupId: number, today: string) =>
    this.computeWeekOverWeek(groupId, today);
  testComputeMonthOverMonth = (
    groupId: number,
    now: Date,
    currentMonthStart: string,
    today: string,
  ) => this.computeMonthOverMonth(groupId, now, currentMonthStart, today);
  testComputeProjection = (
    groupId: number,
    now: Date,
    currentMonth: string,
    monthStart: string,
    today: string,
  ) => this.computeProjection(groupId, now, currentMonth, monthStart, today);
  testComputeBurnRates = (
    groupId: number,
    now: Date,
    currentMonth: string,
    monthStart: string,
    today: string,
  ) => this.computeBurnRates(groupId, now, currentMonth, monthStart, today);
  testComputeAnomalies = (groupId: number, now: Date, currentMonthStart: string, today: string) =>
    this.computeAnomalies(groupId, now, currentMonthStart, today);
  testComputeBudgetUtilization = (
    groupId: number,
    currentMonth: string,
    monthStart: string,
    today: string,
  ) => this.computeBudgetUtilization(groupId, currentMonth, monthStart, today);
}

// --- Fixture data ---

export const GROUP_ID = 1;
export const USER_ID = 1;

export const now = new Date();
export const today = format(now, 'yyyy-MM-dd');
export const yesterday = format(subDays(now, 1), 'yyyy-MM-dd');
export const sevenDaysAgo = format(subDays(now, 7), 'yyyy-MM-dd');
export const fourteenDaysAgo = format(subDays(now, 14), 'yyyy-MM-dd');
export const lastMonth = subMonths(now, 1);
export const lastMonthDate = format(
  new Date(lastMonth.getFullYear(), lastMonth.getMonth(), 15),
  'yyyy-MM-dd',
);
export const twoMonthsAgoDate = format(
  new Date(subMonths(now, 2).getFullYear(), subMonths(now, 2).getMonth(), 15),
  'yyyy-MM-dd',
);
export const threeMonthsAgoDate = format(
  new Date(subMonths(now, 3).getFullYear(), subMonths(now, 3).getMonth(), 15),
  'yyyy-MM-dd',
);
export const currentMonth = format(now, 'yyyy-MM');

function insertExpense(db: Database, date: string, category: string, eurAmount: number) {
  db.run(
    `INSERT INTO expenses (group_id, user_id, date, category, comment, amount, currency, eur_amount)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [GROUP_ID, USER_ID, date, category, 'test', eurAmount, 'EUR', eurAmount],
  );
}

/** Seed the baseline group, user, expenses and current-month budgets shared by every test file. */
export function seedAnalyticsFixture(db: Database): void {
  seedGroupAndUser(db, { groupId: 12345, userId: 99999 });

  // -- Expenses --

  // Today
  insertExpense(db, today, 'Food', 50);
  insertExpense(db, today, 'Transport', 30);

  // Yesterday
  insertExpense(db, yesterday, 'Food', 25);
  insertExpense(db, yesterday, 'Entertainment', 15);

  // 7 days ago
  insertExpense(db, sevenDaysAgo, 'Food', 100);
  insertExpense(db, sevenDaysAgo, 'Transport', 40);

  // 14 days ago
  insertExpense(db, fourteenDaysAgo, 'Food', 80);

  // Last month (mid-month)
  insertExpense(db, lastMonthDate, 'Food', 200);
  insertExpense(db, lastMonthDate, 'Transport', 100);
  insertExpense(db, lastMonthDate, 'Entertainment', 50);

  // 2 months ago
  insertExpense(db, twoMonthsAgoDate, 'Food', 180);
  insertExpense(db, twoMonthsAgoDate, 'Transport', 90);

  // 3 months ago (for anomaly history)
  insertExpense(db, threeMonthsAgoDate, 'Food', 150);
  insertExpense(db, threeMonthsAgoDate, 'Transport', 70);

  // -- Budgets for current month --
  db.run(
    `INSERT INTO budgets (group_id, category, month, limit_amount, currency) VALUES (?, ?, ?, ?, ?)`,
    [GROUP_ID, 'Food', currentMonth, 300, 'EUR'],
  );
  db.run(
    `INSERT INTO budgets (group_id, category, month, limit_amount, currency) VALUES (?, ?, ?, ?, ?)`,
    [GROUP_ID, 'Transport', currentMonth, 150, 'EUR'],
  );
}
