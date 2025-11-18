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
   * Create new expense
   */
  create(data: CreateExpenseData): Expense {
    const query = this.db.query<{ id: number }, [number, number, string, string, string, number, string, number]>(`
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
      data.eur_amount
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
}
