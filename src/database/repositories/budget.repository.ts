/** Budget repository — CRUD and progress tracking for per-category spending budgets */
import type { Database } from 'bun:sqlite';
import type { Budget, BudgetProgress, CreateBudgetData } from '../types';

/**
 * Read-only budget operations.
 * This is the public interface exposed via database.budgets.
 * Write operations are internal — use BudgetManager instead.
 */
export interface BudgetReadRepository {
  findById(id: number): Budget | null;
  findByGroupCategoryMonth(groupId: number, category: string, month: string): Budget | null;
  getBudgetForMonth(groupId: number, category: string, month: string): Budget | null;
  getAllBudgetsForMonth(groupId: number, month: string): Budget[];
  findByGroupId(groupId: number): Budget[];
  getBudgetProgress(
    groupId: number,
    category: string,
    month: string,
    spentAmount: number,
  ): BudgetProgress | null;
  hasBudget(groupId: number, category: string): boolean;
}

/**
 * Full budget repository including write operations.
 * Write methods are only for BudgetManager — never use directly in feature code.
 */
export class BudgetRepository implements BudgetReadRepository {
  constructor(private db: Database) {}

  /**
   * Set or update budget (UPSERT).
   * INTERNAL — use BudgetManager.set() or BudgetManager.importFromSheet() instead.
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

  /** Find budget by ID */
  findById(id: number): Budget | null {
    const query = this.db.query<Budget, [number]>(`
      SELECT * FROM budgets WHERE id = ?
    `);

    return query.get(id) || null;
  }

  /** Find budget for specific group, category and month (case-insensitive category) */
  findByGroupCategoryMonth(groupId: number, category: string, month: string): Budget | null {
    const lowerCategory = category.toLowerCase();
    const rows = this.db
      .query<Budget, [number, string]>('SELECT * FROM budgets WHERE group_id = ? AND month = ?')
      .all(groupId, month);

    return rows.find((r) => r.category.toLowerCase() === lowerCategory) ?? null;
  }

  /** Get budget for exact month — no fallback */
  getBudgetForMonth(groupId: number, category: string, month: string): Budget | null {
    return this.findByGroupCategoryMonth(groupId, category, month);
  }

  /** Get all budgets for exact month — no inheritance loop */
  getAllBudgetsForMonth(groupId: number, month: string): Budget[] {
    return this.db
      .query<Budget, [number, string]>(
        'SELECT * FROM budgets WHERE group_id = ? AND month = ? ORDER BY category ASC',
      )
      .all(groupId, month);
  }

  /** Get all budgets for a group (all months, all categories) */
  findByGroupId(groupId: number): Budget[] {
    const query = this.db.query<Budget, [number]>(`
      SELECT * FROM budgets
      WHERE group_id = ?
      ORDER BY month DESC, category ASC
    `);

    return query.all(groupId);
  }

  /**
   * Delete budget by id.
   * INTERNAL — use BudgetManager.deleteLocal() instead.
   */
  delete(id: number): boolean {
    const query = this.db.query<void, [number]>(`
      DELETE FROM budgets WHERE id = ?
    `);

    query.run(id);
    return true;
  }

  /**
   * Delete budget by group, category and month.
   * INTERNAL — use BudgetManager.delete() instead.
   */
  deleteByGroupCategoryMonth(groupId: number, category: string, month: string): boolean {
    const budget = this.findByGroupCategoryMonth(groupId, category, month);
    if (budget) {
      this.db.query<void, [number]>('DELETE FROM budgets WHERE id = ?').run(budget.id);
    }
    return true;
  }

  /** Get budget progress with actual spending */
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

  /** Check if category exists in any budget for group (case-insensitive) */
  hasBudget(groupId: number, category: string): boolean {
    const lowerCategory = category.toLowerCase();
    const rows = this.db
      .query<Budget, [number]>('SELECT category FROM budgets WHERE group_id = ?')
      .all(groupId);

    return rows.some((r) => r.category.toLowerCase() === lowerCategory);
  }
}
