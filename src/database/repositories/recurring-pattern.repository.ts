/** Repository for recurring expense pattern detection and tracking */
import type { Database } from 'bun:sqlite';
import type {
  CreateRecurringPatternData,
  RecurringPattern,
  RecurringPatternStatus,
} from '../types';

export class RecurringPatternRepository {
  constructor(private db: Database) {}

  /**
   * Find all active recurring patterns for a group
   */
  findByGroupId(groupId: number): RecurringPattern[] {
    return this.db
      .query<RecurringPattern, [number]>(
        `SELECT * FROM recurring_patterns
         WHERE group_id = ? AND status = 'active'
         ORDER BY category ASC`,
      )
      .all(groupId);
  }

  /**
   * Find all recurring patterns for a group (including paused and dismissed)
   */
  findAllByGroupId(groupId: number): RecurringPattern[] {
    return this.db
      .query<RecurringPattern, [number]>(
        `SELECT * FROM recurring_patterns
         WHERE group_id = ?
         ORDER BY status ASC, category ASC`,
      )
      .all(groupId);
  }

  /**
   * Find a recurring pattern by ID
   */
  findById(id: number): RecurringPattern | null {
    return (
      this.db
        .query<RecurringPattern, [number]>('SELECT * FROM recurring_patterns WHERE id = ?')
        .get(id) || null
    );
  }

  /**
   * Create a new recurring pattern
   */
  create(data: CreateRecurringPatternData): RecurringPattern {
    const intervalDays = data.interval_days ?? 30;
    const toleranceDays = data.tolerance_days ?? 5;

    const result = this.db
      .query<
        { id: number },
        [
          number,
          string,
          number,
          string,
          number,
          number | null,
          number,
          string | null,
          string | null,
        ]
      >(
        `INSERT INTO recurring_patterns
           (group_id, category, expected_amount, currency, interval_days, expected_day, tolerance_days, last_seen_date, next_expected_date)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        data.group_id,
        data.category,
        data.expected_amount,
        data.currency,
        intervalDays,
        data.expected_day ?? null,
        toleranceDays,
        data.last_seen_date ?? null,
        data.next_expected_date ?? null,
      );

    if (!result) {
      throw new Error('Failed to create recurring pattern');
    }

    const pattern = this.findById(result.id);
    if (!pattern) {
      throw new Error('Failed to retrieve created recurring pattern');
    }

    return pattern;
  }

  /**
   * Update last_seen_date and next_expected_date after a matching expense is recorded
   */
  updateLastSeen(id: number, date: string, nextExpectedDate: string): void {
    this.db
      .query<void, [string, string, number]>(
        `UPDATE recurring_patterns
         SET last_seen_date = ?, next_expected_date = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(date, nextExpectedDate, id);
  }

  /**
   * Change pattern status (active / paused / dismissed)
   */
  updateStatus(id: number, status: RecurringPatternStatus): void {
    this.db
      .query<void, [string, number]>(
        `UPDATE recurring_patterns
         SET status = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .run(status, id);
  }

  /**
   * Find overdue patterns: next_expected_date + tolerance_days < today
   */
  findOverdue(groupId: number, today: string): RecurringPattern[] {
    return this.db
      .query<RecurringPattern, [number, string]>(
        `SELECT * FROM recurring_patterns
         WHERE group_id = ? AND status = 'active'
           AND next_expected_date IS NOT NULL
           AND date(next_expected_date, '+' || tolerance_days || ' days') < date(?)
         ORDER BY next_expected_date ASC`,
      )
      .all(groupId, today);
  }

  /**
   * Delete a recurring pattern
   */
  delete(id: number): void {
    this.db.query<void, [number]>('DELETE FROM recurring_patterns WHERE id = ?').run(id);
  }

  /**
   * Find existing pattern by group, category and currency (to avoid duplicates)
   */
  findByGroupCategoryCurrency(
    groupId: number,
    category: string,
    currency: string,
  ): RecurringPattern | null {
    return (
      this.db
        .query<RecurringPattern, [number, string, string]>(
          `SELECT * FROM recurring_patterns
           WHERE group_id = ? AND category = ? AND currency = ? AND status != 'dismissed'`,
        )
        .get(groupId, category, currency) || null
    );
  }
}
