/** Budget repository — CRUD and progress tracking for per-category spending budgets */
import type { Database } from 'bun:sqlite';
import type { Budget, BudgetProgress, CreateBudgetData, UpdateBudgetData } from '../types';

export class BudgetRepository {
  constructor(private db: Database) {}

  /**
   * Set or update budget (UPSERT)
   */
  setBudget(data: CreateBudgetData): Budget {
    const currency = data.currency || 'EUR';

    // Atomic UPSERT — no TOCTOU race between check and insert/update
    const result = this.db
      .query<Budget, [number, string, string, number, string]>(
        `INSERT INTO budgets (group_id, category, month, limit_amount, currency)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (group_id, category, month) DO UPDATE SET
           limit_amount = excluded.limit_amount,
           currency = excluded.currency,
           updated_at = CURRENT_TIMESTAMP
         RETURNING *`,
      )
      .get(data.group_id, data.category, data.month, data.limit_amount, currency);

    if (!result) {
      throw new Error('Failed to upsert budget');
    }

    return result;
  }

  /**
   * Find budget by ID
   */
  findById(id: number): Budget | null {
    const query = this.db.query<Budget, [number]>(`
      SELECT * FROM budgets WHERE id = ?
    `);

    return query.get(id) || null;
  }

  /**
   * Find budget for specific group, category and month
   */
  findByGroupCategoryMonth(groupId: number, category: string, month: string): Budget | null {
    const query = this.db.query<Budget, [number, string, string]>(`
      SELECT * FROM budgets
      WHERE group_id = ? AND category = ? AND month = ?
    `);

    return query.get(groupId, category, month) || null;
  }

  /**
   * Get budget for exact month — no fallback
   */
  getBudgetForMonth(groupId: number, category: string, month: string): Budget | null {
    return this.findByGroupCategoryMonth(groupId, category, month);
  }

  /**
   * Get all budgets for exact month — no inheritance loop
   */
  getAllBudgetsForMonth(groupId: number, month: string): Budget[] {
    return this.db
      .query<Budget, [number, string]>(
        'SELECT * FROM budgets WHERE group_id = ? AND month = ? ORDER BY category ASC',
      )
      .all(groupId, month);
  }

  /**
   * Get all budgets for a group (all months, all categories)
   */
  findByGroupId(groupId: number): Budget[] {
    const query = this.db.query<Budget, [number]>(`
      SELECT * FROM budgets
      WHERE group_id = ?
      ORDER BY month DESC, category ASC
    `);

    return query.all(groupId);
  }

  /**
   * Delete budget
   */
  delete(id: number): boolean {
    const query = this.db.query<void, [number]>(`
      DELETE FROM budgets WHERE id = ?
    `);

    query.run(id);
    return true;
  }

  /**
   * Delete budget by group, category and month
   */
  deleteByGroupCategoryMonth(groupId: number, category: string, month: string): boolean {
    const query = this.db.query<void, [number, string, string]>(`
      DELETE FROM budgets
      WHERE group_id = ? AND category = ? AND month = ?
    `);

    query.run(groupId, category, month);
    return true;
  }

  /**
   * Update budget
   */
  update(id: number, data: UpdateBudgetData): Budget | null {
    const fields: string[] = [];
    const values: (number | string)[] = [];

    if (data.limit_amount !== undefined) {
      fields.push('limit_amount = ?');
      values.push(data.limit_amount);
    }

    if (data.currency !== undefined) {
      fields.push('currency = ?');
      values.push(data.currency);
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    fields.push('updated_at = CURRENT_TIMESTAMP');

    const query = this.db.query<void, (number | string)[]>(`
      UPDATE budgets
      SET ${fields.join(', ')}
      WHERE id = ?
    `);

    query.run(...values, id);

    return this.findById(id);
  }

  /**
   * Get budget progress with actual spending
   * Requires expenses data to calculate
   */
  getBudgetProgress(
    groupId: number,
    category: string,
    month: string,
    spentAmount: number,
  ): BudgetProgress | null {
    const budget = this.findByGroupCategoryMonth(groupId, category, month);
    if (!budget) return null;

    const percentage =
      budget.limit_amount > 0 ? Math.round((spentAmount / budget.limit_amount) * 100) : 0;

    return {
      category,
      limit_amount: budget.limit_amount,
      spent_amount: spentAmount,
      currency: budget.currency,
      percentage,
      is_exceeded: spentAmount > budget.limit_amount,
      is_warning: percentage >= 90,
    };
  }

  /**
   * Check if category exists in any budget for group
   */
  hasBudget(groupId: number, category: string): boolean {
    const query = this.db.query<{ count: number }, [number, string]>(`
      SELECT COUNT(*) as count FROM budgets
      WHERE group_id = ? AND category = ?
    `);

    const result = query.get(groupId, category);
    return result ? result.count > 0 : false;
  }
}
