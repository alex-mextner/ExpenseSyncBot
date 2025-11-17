import type { Database } from 'bun:sqlite';
import type { PendingExpense, CreatePendingExpenseData, UpdatePendingExpenseData } from '../types';

export class PendingExpenseRepository {
  constructor(private db: Database) {}

  /**
   * Find pending expense by message ID
   */
  findByMessageId(messageId: number): PendingExpense | null {
    const query = this.db.query<PendingExpense, [number]>(`
      SELECT * FROM pending_expenses WHERE message_id = ?
    `);

    return query.get(messageId) || null;
  }

  /**
   * Find pending expense by ID
   */
  findById(id: number): PendingExpense | null {
    const query = this.db.query<PendingExpense, [number]>(`
      SELECT * FROM pending_expenses WHERE id = ?
    `);

    return query.get(id) || null;
  }

  /**
   * Find all pending expenses for a user
   */
  findByUserId(userId: number): PendingExpense[] {
    const query = this.db.query<PendingExpense, [number]>(`
      SELECT * FROM pending_expenses
      WHERE user_id = ?
      ORDER BY created_at DESC
    `);

    return query.all(userId);
  }

  /**
   * Create new pending expense
   */
  create(data: CreatePendingExpenseData): PendingExpense {
    const query = this.db.query<{ id: number }, [number, number, number, string, string | null, string, string]>(`
      INSERT INTO pending_expenses (
        user_id,
        message_id,
        parsed_amount,
        parsed_currency,
        detected_category,
        comment,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    const result = query.get(
      data.user_id,
      data.message_id,
      data.parsed_amount,
      data.parsed_currency,
      data.detected_category,
      data.comment,
      data.status
    );

    if (!result) {
      throw new Error('Failed to create pending expense');
    }

    const pendingExpense = this.findById(result.id);

    if (!pendingExpense) {
      throw new Error('Failed to retrieve created pending expense');
    }

    return pendingExpense;
  }

  /**
   * Update pending expense
   */
  update(id: number, data: UpdatePendingExpenseData): PendingExpense | null {
    const expense = this.findById(id);

    if (!expense) return null;

    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.detected_category !== undefined) {
      updates.push('detected_category = ?');
      values.push(data.detected_category);
    }

    if (data.status !== undefined) {
      updates.push('status = ?');
      values.push(data.status);
    }

    if (updates.length === 0) {
      return expense;
    }

    values.push(id);

    const query = this.db.query(`
      UPDATE pending_expenses
      SET ${updates.join(', ')}
      WHERE id = ?
    `);

    query.run(...values);

    return this.findById(id);
  }

  /**
   * Delete pending expense
   */
  delete(id: number): boolean {
    const query = this.db.query<void, [number]>(`
      DELETE FROM pending_expenses WHERE id = ?
    `);

    query.run(id);
    return true;
  }

  /**
   * Delete pending expense by message ID
   */
  deleteByMessageId(messageId: number): boolean {
    const query = this.db.query<void, [number]>(`
      DELETE FROM pending_expenses WHERE message_id = ?
    `);

    query.run(messageId);
    return true;
  }

  /**
   * Get all confirmed but not synced expenses
   */
  findConfirmed(userId: number): PendingExpense[] {
    const query = this.db.query<PendingExpense, [number]>(`
      SELECT * FROM pending_expenses
      WHERE user_id = ? AND status = 'confirmed'
      ORDER BY created_at ASC
    `);

    return query.all(userId);
  }
}
