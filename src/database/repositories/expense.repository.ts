import type { Database } from 'bun:sqlite';
import type { Expense, CreateExpenseData } from '../types';

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
   * Find all expenses for a user
   */
  findByUserId(userId: number, limit?: number): Expense[] {
    const query = this.db.query<Expense, [number, number]>(`
      SELECT * FROM expenses
      WHERE user_id = ?
      ORDER BY date DESC, created_at DESC
      LIMIT ?
    `);

    return query.all(userId, limit || 100);
  }

  /**
   * Find expenses by date range
   */
  findByDateRange(userId: number, startDate: string, endDate: string): Expense[] {
    const query = this.db.query<Expense, [number, string, string]>(`
      SELECT * FROM expenses
      WHERE user_id = ? AND date >= ? AND date <= ?
      ORDER BY date DESC
    `);

    return query.all(userId, startDate, endDate);
  }

  /**
   * Create new expense
   */
  create(data: CreateExpenseData): Expense {
    const query = this.db.query<{ id: number }, [number, string, string, string, number, string, number]>(`
      INSERT INTO expenses (
        user_id,
        date,
        category,
        comment,
        amount,
        currency,
        usd_amount
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    const result = query.get(
      data.user_id,
      data.date,
      data.category,
      data.comment,
      data.amount,
      data.currency,
      data.usd_amount
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
  getTotalsByCurrency(userId: number): Record<string, number> {
    const query = this.db.query<{ currency: string; total: number }, [number]>(`
      SELECT currency, SUM(amount) as total
      FROM expenses
      WHERE user_id = ?
      GROUP BY currency
    `);

    const results = query.all(userId);
    const totals: Record<string, number> = {};

    for (const result of results) {
      totals[result.currency] = result.total;
    }

    return totals;
  }

  /**
   * Get total expenses in USD
   */
  getTotalInUSD(userId: number): number {
    const query = this.db.query<{ total: number }, [number]>(`
      SELECT SUM(usd_amount) as total
      FROM expenses
      WHERE user_id = ?
    `);

    const result = query.get(userId);
    return result?.total || 0;
  }

  /**
   * Get expenses by category
   */
  findByCategory(userId: number, category: string): Expense[] {
    const query = this.db.query<Expense, [number, string]>(`
      SELECT * FROM expenses
      WHERE user_id = ? AND category = ?
      ORDER BY date DESC
    `);

    return query.all(userId, category);
  }
}
