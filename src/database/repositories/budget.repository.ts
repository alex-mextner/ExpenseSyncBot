import type { Database } from 'bun:sqlite';
import type { Budget, CreateBudgetData, UpdateBudgetData, BudgetProgress } from '../types';
import type { CurrencyCode } from '../../config/constants';

export class BudgetRepository {
  constructor(private db: Database) {}

  /**
   * Set or update budget (UPSERT)
   */
  setBudget(data: CreateBudgetData): Budget {
    const currency = data.currency || 'EUR';

    // Check if budget already exists
    const existing = this.findByGroupCategoryMonth(
      data.group_id,
      data.category,
      data.month
    );

    if (existing) {
      // Update existing budget
      const query = this.db.query<void, [number, string, number, string]>(`
        UPDATE budgets
        SET limit_amount = ?, updated_at = CURRENT_TIMESTAMP
        WHERE group_id = ? AND category = ? AND month = ?
      `);

      query.run(data.limit_amount, data.group_id, data.category, data.month);

      const updated = this.findById(existing.id);
      if (!updated) {
        throw new Error('Failed to retrieve updated budget');
      }
      return updated;
    }

    // Insert new budget
    const query = this.db.query<{ id: number }, [number, string, string, number, string]>(`
      INSERT INTO budgets (group_id, category, month, limit_amount, currency)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id
    `);

    const result = query.get(data.group_id, data.category, data.month, data.limit_amount, currency);

    if (!result) {
      throw new Error('Failed to create budget');
    }

    const budget = this.findById(result.id);

    if (!budget) {
      throw new Error('Failed to retrieve created budget');
    }

    return budget;
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
   * Get budget for month with fallback to latest available
   */
  getBudgetForMonth(groupId: number, category: string, month: string): Budget | null {
    // Try to get budget for specific month
    const monthBudget = this.findByGroupCategoryMonth(groupId, category, month);

    if (monthBudget) {
      return monthBudget;
    }

    // Fallback to latest available budget for this category
    return this.getLatestBudget(groupId, category);
  }

  /**
   * Get latest budget for category (fallback when month-specific doesn't exist)
   */
  getLatestBudget(groupId: number, category: string): Budget | null {
    const query = this.db.query<Budget, [number, string]>(`
      SELECT * FROM budgets
      WHERE group_id = ? AND category = ?
      ORDER BY month DESC
      LIMIT 1
    `);

    return query.get(groupId, category) || null;
  }

  /**
   * Get all budgets for specific month (with fallback to latest)
   */
  getAllBudgetsForMonth(groupId: number, month: string): Budget[] {
    // Get all categories that have budgets
    const categoriesQuery = this.db.query<{ category: string }, [number]>(`
      SELECT DISTINCT category FROM budgets
      WHERE group_id = ?
    `);

    const categories = categoriesQuery.all(groupId);

    // For each category, get budget for month (with fallback)
    const budgets: Budget[] = [];

    for (const { category } of categories) {
      const budget = this.getBudgetForMonth(groupId, category, month);
      if (budget) {
        budgets.push(budget);
      }
    }

    return budgets;
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
    spentAmount: number
  ): BudgetProgress | null {
    const budget = this.getBudgetForMonth(groupId, category, month);

    if (!budget) {
      return null;
    }

    const percentage = budget.limit_amount > 0
      ? Math.round((spentAmount / budget.limit_amount) * 100)
      : 0;

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
