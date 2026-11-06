// Persistent budget-setup prompts (group/user/topic scoped) for the button and text/reply flows
import type { Database } from 'bun:sqlite';
import type { BudgetPrompt, BudgetPromptStatus, CreateBudgetPromptData } from '../types';

export class BudgetPromptRepository {
  constructor(private db: Database) {}

  create(data: CreateBudgetPromptData): BudgetPrompt {
    const result = this.db
      .query<{ id: number }, [number, number, string, string, number | null, string]>(`
        INSERT INTO budget_prompts (
          group_id,
          user_id,
          category,
          currency,
          message_thread_id,
          target_month
        )
        VALUES (?, ?, ?, ?, ?, ?)
        RETURNING id
      `)
      .get(
        data.group_id,
        data.user_id,
        data.category,
        data.currency,
        data.message_thread_id ?? null,
        data.target_month,
      );

    if (!result) throw new Error('Failed to create budget prompt');
    const prompt = this.findById(result.id);
    if (!prompt) throw new Error('Failed to read created budget prompt');
    return prompt;
  }

  findById(id: number): BudgetPrompt | null {
    return (
      this.db.query<BudgetPrompt, [number]>('SELECT * FROM budget_prompts WHERE id = ?').get(id) ??
      null
    );
  }

  bindMessage(id: number, telegramMessageId: number): void {
    this.db
      .query(
        `UPDATE budget_prompts
         SET telegram_message_id = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(telegramMessageId, id);
  }

  findActiveForUser(
    groupId: number,
    userId: number,
    messageThreadId: number | null,
  ): BudgetPrompt[] {
    if (messageThreadId === null) {
      return this.db
        .query<BudgetPrompt, [number, number]>(`
          SELECT * FROM budget_prompts
          WHERE group_id = ? AND user_id = ?
            AND status = 'active'
            AND message_thread_id IS NULL
            AND created_at >= datetime('now', '-7 days')
          ORDER BY id ASC
        `)
        .all(groupId, userId);
    }
    return this.db
      .query<BudgetPrompt, [number, number, number]>(`
        SELECT * FROM budget_prompts
        WHERE group_id = ? AND user_id = ?
          AND status = 'active'
          AND message_thread_id = ?
          AND created_at >= datetime('now', '-7 days')
        ORDER BY id ASC
      `)
      .all(groupId, userId, messageThreadId);
  }

  findActiveByMessage(
    groupId: number,
    userId: number,
    telegramMessageId: number,
    messageThreadId: number | null,
  ): BudgetPrompt | null {
    const threadClause =
      messageThreadId === null ? 'message_thread_id IS NULL' : 'message_thread_id = ?';
    const sql = `
      SELECT * FROM budget_prompts
      WHERE group_id = ? AND user_id = ?
        AND telegram_message_id = ?
        AND status = 'active'
        AND ${threadClause}
        AND created_at >= datetime('now', '-7 days')
      ORDER BY id DESC
      LIMIT 1
    `;
    if (messageThreadId === null) {
      return (
        this.db
          .query<BudgetPrompt, [number, number, number]>(sql)
          .get(groupId, userId, telegramMessageId) ?? null
      );
    }
    return (
      this.db
        .query<BudgetPrompt, [number, number, number, number]>(sql)
        .get(groupId, userId, telegramMessageId, messageThreadId) ?? null
    );
  }

  /** Active, non-expired prompt by id — used by button callbacks. */
  findActiveById(id: number): BudgetPrompt | null {
    return (
      this.db
        .query<BudgetPrompt, [number]>(`
          SELECT * FROM budget_prompts
          WHERE id = ? AND status = 'active'
            AND created_at >= datetime('now', '-7 days')
        `)
        .get(id) ?? null
    );
  }

  /**
   * Atomically leave the active state. Returns false when the prompt was already
   * finished, so concurrent button presses cannot both apply it.
   */
  finish(id: number, status: Exclude<BudgetPromptStatus, 'active'>): boolean {
    const result = this.db
      .query(
        `UPDATE budget_prompts
         SET status = ?, updated_at = CURRENT_TIMESTAMP
         WHERE id = ? AND status = 'active'`,
      )
      .run(status, id);
    return result.changes > 0;
  }

  /** Put a claimed prompt back (the budget write that followed the claim failed). */
  reopen(id: number): void {
    this.db
      .query(
        `UPDATE budget_prompts
         SET status = 'active', updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
      )
      .run(id);
  }

  /** Retire older active prompts for the same category in the same group/user/topic scope. */
  supersedeActive(
    groupId: number,
    userId: number,
    category: string,
    messageThreadId: number | null,
  ): void {
    this.db
      .query(
        `UPDATE budget_prompts
         SET status = 'skipped', updated_at = CURRENT_TIMESTAMP
         WHERE group_id = ? AND user_id = ? AND category = ?
           AND status = 'active'
           AND message_thread_id IS ?`,
      )
      .run(groupId, userId, category, messageThreadId);
  }
}
