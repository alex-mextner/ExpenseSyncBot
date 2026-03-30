import type { Database } from 'bun:sqlite';
import type {
  CategoryTotal,
  DailyTotal,
  DayOfWeekStats,
  DayOfWeekTopCategory,
  MonthComparisonRow,
  MonthlyHistoryRow,
  VelocityRow,
  WeekPeriodRow,
} from '../../services/analytics/types';
import type { CreateExpenseData, Expense } from '../types';

export class ExpenseRepository {
  constructor(private db: Database) {}

  /**
   * Find expense by ID
   */
  findById(id: number): Expense | null {
    const query = this.db.query<Expense, [number]>(`
      SELECT * FROM expenses WHERE id = ?
    `);

    return query.get(id) || null;
  }

  /**
   * Find all expenses for a group
   */
  findByGroupId(groupId: number, limit?: number): Expense[] {
    const query = this.db.query<Expense, [number, number]>(`
      SELECT * FROM expenses
      WHERE group_id = ?
      ORDER BY date DESC, created_at DESC
      LIMIT ?
    `);

    return query.all(groupId, limit || 100);
  }

  /**
   * Find expenses by date range
   */
  findByDateRange(groupId: number, startDate: string, endDate: string): Expense[] {
    const query = this.db.query<Expense, [number, string, string]>(`
      SELECT * FROM expenses
      WHERE group_id = ? AND date >= ? AND date <= ?
      ORDER BY date DESC
    `);

    return query.all(groupId, startDate, endDate);
  }

  /**
   * Find expenses that may be duplicates of a bank transaction.
   * Returns exact matches (same date, ±1% amount, same currency) and fuzzy matches (±1 day).
   * Only considers expenses not already linked to a bank transaction.
   */
  findPotentialDuplicates(
    groupId: number,
    date: string,
    amount: number,
    currency: string,
  ): { exact: Expense[]; fuzzy: Expense[] } {
    const notLinked = `
      AND NOT EXISTS (
        SELECT 1 FROM bank_transactions bt WHERE bt.matched_expense_id = e.id
      )
    `;
    const amountTolerance = amount * 0.01;

    const exact = this.db
      .query<Expense, [number, string, string, number, number]>(`
        SELECT e.* FROM expenses e
        WHERE e.group_id = ?
          AND e.date = ?
          AND e.currency = ?
          AND ABS(e.amount - ?) <= ?
          ${notLinked}
        ORDER BY e.created_at DESC
        LIMIT 5
      `)
      .all(groupId, date, currency, amount, amountTolerance);

    const exactIds = new Set(exact.map((e) => e.id));

    const fuzzy = this.db
      .query<Expense, [number, string, string, string, string, number, number, string]>(`
        SELECT e.* FROM expenses e
        WHERE e.group_id = ?
          AND e.date >= date(?, '-1 day')
          AND e.date <= date(?, '+1 day')
          AND e.date != ?
          AND e.currency = ?
          AND ABS(e.amount - ?) <= ?
          ${notLinked}
        ORDER BY ABS(julianday(e.date) - julianday(?)) ASC, e.created_at DESC
        LIMIT 5
      `)
      .all(groupId, date, date, date, currency, amount, amountTolerance, date);

    return {
      exact,
      fuzzy: fuzzy.filter((e) => !exactIds.has(e.id)),
    };
  }

  /**
   * Create new expense
   */
  create(data: CreateExpenseData): Expense {
    const query = this.db.query<
      { id: number },
      [number, number, string, string, string, number, string, number]
    >(`
      INSERT INTO expenses (
        group_id,
        user_id,
        date,
        category,
        comment,
        amount,
        currency,
        eur_amount
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    const result = query.get(
      data.group_id,
      data.user_id,
      data.date,
      data.category,
      data.comment,
      data.amount,
      data.currency,
      data.eur_amount,
    );

    if (!result) {
      throw new Error('Failed to create expense');
    }

    const expense = this.findById(result.id);

    if (!expense) {
      throw new Error('Failed to retrieve created expense');
    }

    return expense;
  }

  /**
   * Delete expense
   */
  delete(id: number): boolean {
    const query = this.db.query<void, [number]>(`
      DELETE FROM expenses WHERE id = ?
    `);

    query.run(id);
    return true;
  }

  /**
   * Get total expenses by currency
   */
  getTotalsByCurrency(groupId: number): Record<string, number> {
    const query = this.db.query<{ currency: string; total: number }, [number]>(`
      SELECT currency, SUM(amount) as total
      FROM expenses
      WHERE group_id = ?
      GROUP BY currency
    `);

    const results = query.all(groupId);
    const totals: Record<string, number> = {};

    for (const result of results) {
      totals[result.currency] = result.total;
    }

    return totals;
  }

  /**
   * Get total expenses in EUR
   */
  getTotalInEUR(groupId: number): number {
    const query = this.db.query<{ total: number }, [number]>(`
      SELECT SUM(eur_amount) as total
      FROM expenses
      WHERE group_id = ?
    `);

    const result = query.get(groupId);
    return result?.total || 0;
  }

  /**
   * Get expenses by category
   */
  findByCategory(groupId: number, category: string): Expense[] {
    const query = this.db.query<Expense, [number, string]>(`
      SELECT * FROM expenses
      WHERE group_id = ? AND category = ?
      ORDER BY date DESC
    `);

    return query.all(groupId, category);
  }

  /**
   * Delete all expenses for a group (for sync)
   */
  deleteAllByGroupId(groupId: number): number {
    const countQuery = this.db.query<{ count: number }, [number]>(`
      SELECT COUNT(*) as count FROM expenses WHERE group_id = ?
    `);

    const result = countQuery.get(groupId);
    const count = result?.count || 0;

    const deleteQuery = this.db.query<void, [number]>(`
      DELETE FROM expenses WHERE group_id = ?
    `);

    deleteQuery.run(groupId);
    return count;
  }

  // === Analytics methods ===

  /**
   * Get category totals (EUR) for a date range
   * Uses composite index idx_expenses_group_date
   */
  getCategoryTotals(groupId: number, startDate: string, endDate: string): CategoryTotal[] {
    const query = this.db.query<CategoryTotal, [number, string, string]>(`
      SELECT category, SUM(eur_amount) as total, COUNT(*) as tx_count
      FROM expenses
      WHERE group_id = ? AND date >= ? AND date <= ?
      GROUP BY category
    `);

    return query.all(groupId, startDate, endDate);
  }

  /**
   * Get daily totals (EUR) for a date range
   */
  getDailyTotals(groupId: number, startDate: string, endDate: string): DailyTotal[] {
    const query = this.db.query<DailyTotal, [number, string, string]>(`
      SELECT date, SUM(eur_amount) as total, COUNT(*) as tx_count
      FROM expenses
      WHERE group_id = ? AND date >= ? AND date <= ?
      GROUP BY date
      ORDER BY date ASC
    `);

    return query.all(groupId, startDate, endDate);
  }

  /**
   * Get day-of-week aggregated stats (last N days)
   * strftime('%w') returns 0=Sunday, 6=Saturday
   */
  getDayOfWeekStats(groupId: number, startDate: string, endDate: string): DayOfWeekStats[] {
    const query = this.db.query<DayOfWeekStats, [number, string, string]>(`
      SELECT
        CAST(strftime('%w', date) AS INTEGER) as dow,
        COUNT(*) as tx_count,
        SUM(eur_amount) as total,
        COUNT(DISTINCT date) as unique_days
      FROM expenses
      WHERE group_id = ? AND date >= ? AND date <= ?
      GROUP BY dow
    `);

    return query.all(groupId, startDate, endDate);
  }

  /**
   * Get top category per day-of-week
   */
  getDayOfWeekTopCategories(
    groupId: number,
    startDate: string,
    endDate: string,
  ): DayOfWeekTopCategory[] {
    const query = this.db.query<DayOfWeekTopCategory, [number, string, string]>(`
      SELECT dow, category, cat_total FROM (
        SELECT
          CAST(strftime('%w', date) AS INTEGER) as dow,
          category,
          SUM(eur_amount) as cat_total,
          ROW_NUMBER() OVER (PARTITION BY CAST(strftime('%w', date) AS INTEGER) ORDER BY SUM(eur_amount) DESC) as rn
        FROM expenses
        WHERE group_id = ? AND date >= ? AND date <= ?
        GROUP BY dow, category
      ) WHERE rn = 1
    `);

    return query.all(groupId, startDate, endDate);
  }

  /**
   * Get week-over-week spending by category
   * current_week: last 7 days, previous_week: 7 days before that
   */
  getWeekOverWeekData(groupId: number, today: string): WeekPeriodRow[] {
    const query = this.db.query<WeekPeriodRow, [string, string, string, number, string]>(`
      SELECT
        CASE
          WHEN date >= date(?, '-6 days') THEN 'current_week'
          WHEN date >= date(?, '-13 days') AND date < date(?, '-6 days') THEN 'previous_week'
        END as period,
        category,
        SUM(eur_amount) as total
      FROM expenses
      WHERE group_id = ? AND date >= date(?, '-13 days')
      GROUP BY period, category
      HAVING period IS NOT NULL
    `);

    return query.all(today, today, today, groupId, today);
  }

  /**
   * Get month-over-month spending by category
   * Compares first N days of current month with first N days of previous month
   */
  getMonthOverMonthData(
    groupId: number,
    currentMonthStart: string,
    currentMonthEnd: string,
    prevMonthStart: string,
    prevMonthSameDay: string,
  ): MonthComparisonRow[] {
    const query = this.db.query<
      MonthComparisonRow,
      [string, string, string, string, number, string, string]
    >(`
      SELECT
        category,
        SUM(CASE WHEN date >= ? AND date <= ? THEN eur_amount ELSE 0 END) as current_month,
        SUM(CASE WHEN date >= ? AND date <= ? THEN eur_amount ELSE 0 END) as previous_month
      FROM expenses
      WHERE group_id = ? AND date >= ? AND date <= ?
      GROUP BY category
    `);

    return query.all(
      currentMonthStart,
      currentMonthEnd,
      prevMonthStart,
      prevMonthSameDay,
      groupId,
      prevMonthStart,
      currentMonthEnd,
    );
  }

  /**
   * Get velocity data: spending in two consecutive 7-day windows
   */
  getVelocityData(groupId: number, today: string): VelocityRow[] {
    const query = this.db.query<VelocityRow, [string, number, string, string]>(`
      SELECT
        CASE
          WHEN date >= date(?, '-6 days') THEN 'recent'
          ELSE 'earlier'
        END as period,
        SUM(eur_amount) as total,
        COUNT(*) as tx_count
      FROM expenses
      WHERE group_id = ? AND date >= date(?, '-13 days') AND date <= ?
      GROUP BY period
    `);

    return query.all(today, groupId, today, today);
  }

  /**
   * Get monthly category history for anomaly detection
   * Returns per-category per-month totals for the specified range
   */
  getMonthlyHistoryByCategory(
    groupId: number,
    startDate: string,
    endDate: string,
  ): MonthlyHistoryRow[] {
    const query = this.db.query<MonthlyHistoryRow, [number, string, string]>(`
      SELECT
        category,
        strftime('%Y-%m', date) as month,
        SUM(eur_amount) as monthly_total
      FROM expenses
      WHERE group_id = ? AND date >= ? AND date < ?
      GROUP BY category, month
    `);

    return query.all(groupId, startDate, endDate);
  }

  /**
   * Get total EUR spent in a date range (single number)
   */
  getTotalEurForRange(groupId: number, startDate: string, endDate: string): number {
    const query = this.db.query<{ total: number }, [number, string, string]>(`
      SELECT COALESCE(SUM(eur_amount), 0) as total
      FROM expenses
      WHERE group_id = ? AND date >= ? AND date <= ?
    `);

    const result = query.get(groupId, startDate, endDate);
    return result?.total || 0;
  }

  /**
   * Get recent expense examples grouped by category (for AI receipt categorization)
   */
  getRecentExamplesByCategory(
    groupId: number,
    limit: number = 5,
  ): Map<string, Array<{ comment: string; amount: number; currency: string }>> {
    const query = this.db.query<
      { category: string; comment: string; amount: number; currency: string },
      [number]
    >(`
      SELECT category, comment, amount, currency
      FROM expenses
      WHERE group_id = ? AND comment != ''
      ORDER BY date DESC, created_at DESC
      LIMIT 200
    `);

    const rows = query.all(groupId);
    const result = new Map<string, Array<{ comment: string; amount: number; currency: string }>>();

    for (const row of rows) {
      const existing = result.get(row.category);
      if (existing) {
        if (existing.length < limit) {
          existing.push({ comment: row.comment, amount: row.amount, currency: row.currency });
        }
      } else {
        result.set(row.category, [
          { comment: row.comment, amount: row.amount, currency: row.currency },
        ]);
      }
    }

    return result;
  }

  /**
   * Count expenses in a date range
   */
  getCountForRange(groupId: number, startDate: string, endDate: string): number {
    const query = this.db.query<{ count: number }, [number, string, string]>(`
      SELECT COUNT(*) as count
      FROM expenses
      WHERE group_id = ? AND date >= ? AND date <= ?
    `);

    const result = query.get(groupId, startDate, endDate);
    return result?.count || 0;
  }
}
