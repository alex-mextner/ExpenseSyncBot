// Saves and restores point-in-time snapshots of expenses and budgets before sync operations

import type { Database } from 'bun:sqlite';
import { createLogger } from '../../utils/logger.ts';
import type { Budget, BudgetSnapshot, Expense, ExpenseSnapshot } from '../types';

const logger = createLogger('sync-snapshot');

export class SyncSnapshotRepository {
  constructor(private db: Database) {}

  /**
   * Save a snapshot of all expenses and budgets for a group.
   * Returns the snapshot_id (UUID) that can be used to restore later.
   */
  saveSnapshot(groupId: number, expenses: Expense[], budgets: Budget[]): string {
    const snapshotId = crypto.randomUUID();

    const insertExpense = this.db.prepare(`
      INSERT INTO expense_snapshots (snapshot_id, group_id, expense_id, user_id, date, category, comment, amount, currency, eur_amount)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    const insertBudget = this.db.prepare(`
      INSERT INTO budget_snapshots (snapshot_id, group_id, budget_id, category, month, limit_amount, currency)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const tx = this.db.transaction(() => {
      for (const e of expenses) {
        insertExpense.run(
          snapshotId,
          groupId,
          e.id,
          e.user_id,
          e.date,
          e.category,
          e.comment,
          e.amount,
          e.currency,
          e.eur_amount,
        );
      }
      for (const b of budgets) {
        insertBudget.run(
          snapshotId,
          groupId,
          b.id,
          b.category,
          b.month,
          b.limit_amount,
          b.currency,
        );
      }
    });
    tx();

    logger.info(
      `[SNAPSHOT] Saved snapshot ${snapshotId} for group ${groupId}: ${expenses.length} expenses, ${budgets.length} budgets`,
    );

    // Auto-cleanup old snapshots (keep 30 days)
    this.cleanOldSnapshots(30);

    return snapshotId;
  }

  /** Get all expense snapshots for a given snapshot_id */
  getExpenseSnapshots(snapshotId: string): ExpenseSnapshot[] {
    return this.db
      .query<ExpenseSnapshot, [string]>(
        'SELECT * FROM expense_snapshots WHERE snapshot_id = ? ORDER BY date',
      )
      .all(snapshotId);
  }

  /** Get all budget snapshots for a given snapshot_id */
  getBudgetSnapshots(snapshotId: string): BudgetSnapshot[] {
    return this.db
      .query<BudgetSnapshot, [string]>(
        'SELECT * FROM budget_snapshots WHERE snapshot_id = ? ORDER BY month, category',
      )
      .all(snapshotId);
  }

  /** List all snapshot IDs for a group, newest first */
  listSnapshots(
    groupId: number,
  ): Array<{ snapshotId: string; createdAt: string; expenseCount: number; budgetCount: number }> {
    return this.db
      .query<
        { snapshotId: string; createdAt: string; expenseCount: number; budgetCount: number },
        [number, number]
      >(
        `SELECT
          e.snapshot_id as snapshotId,
          e.created_at as createdAt,
          (SELECT COUNT(*) FROM expense_snapshots WHERE snapshot_id = e.snapshot_id) as expenseCount,
          (SELECT COUNT(*) FROM budget_snapshots WHERE snapshot_id = e.snapshot_id) as budgetCount
        FROM expense_snapshots e
        WHERE e.group_id = ?
        GROUP BY e.snapshot_id
        ORDER BY e.created_at DESC
        LIMIT ?`,
      )
      .all(groupId, 20);
  }

  /** Delete snapshots older than N days to prevent unbounded growth */
  cleanOldSnapshots(daysToKeep: number): number {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - daysToKeep);
    const cutoffStr = cutoff.toISOString();

    const countBefore =
      this.db
        .query<{ cnt: number }, []>(
          'SELECT (SELECT COUNT(*) FROM expense_snapshots) + (SELECT COUNT(*) FROM budget_snapshots) as cnt',
        )
        .get()?.cnt ?? 0;

    const deleteExpenses = this.db.prepare('DELETE FROM expense_snapshots WHERE created_at < ?');
    const deleteBudgets = this.db.prepare('DELETE FROM budget_snapshots WHERE created_at < ?');

    const tx = this.db.transaction(() => {
      deleteExpenses.run(cutoffStr);
      deleteBudgets.run(cutoffStr);
    });
    tx();

    const countAfter =
      this.db
        .query<{ cnt: number }, []>(
          'SELECT (SELECT COUNT(*) FROM expense_snapshots) + (SELECT COUNT(*) FROM budget_snapshots) as cnt',
        )
        .get()?.cnt ?? 0;

    const deleted = countBefore - countAfter;
    if (deleted > 0) {
      logger.info(`[SNAPSHOT] Cleaned ${deleted} snapshot rows older than ${daysToKeep} days`);
    }
    return deleted;
  }
}
