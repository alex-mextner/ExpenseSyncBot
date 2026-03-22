import type { Database } from 'bun:sqlite';
import type { AdviceLog, CreateAdviceLogData } from '../../services/analytics/types';

export class AdviceLogRepository {
  constructor(private db: Database) {}

  /**
   * Record a generated advice entry
   */
  create(data: CreateAdviceLogData): AdviceLog {
    const query = this.db.query<
      { id: number },
      [number, string, string, string | null, string | null, string]
    >(`
      INSERT INTO advice_log (group_id, tier, trigger_type, trigger_data, topic, advice_text)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    const result = query.get(
      data.group_id,
      data.tier,
      data.trigger_type,
      data.trigger_data || null,
      data.topic || null,
      data.advice_text,
    );

    if (!result) {
      throw new Error('Failed to create advice log entry');
    }

    return this.findById(result.id)!;
  }

  /**
   * Find advice log by ID
   */
  findById(id: number): AdviceLog | null {
    const query = this.db.query<AdviceLog, [number]>(`
      SELECT * FROM advice_log WHERE id = ?
    `);

    return query.get(id) || null;
  }

  /**
   * Get recent advice for a group (for anti-repetition)
   */
  getRecentTopics(groupId: number, limit: number = 5): string[] {
    const query = this.db.query<{ topic: string }, [number, number]>(`
      SELECT topic FROM advice_log
      WHERE group_id = ? AND topic IS NOT NULL
      ORDER BY created_at DESC
      LIMIT ?
    `);

    return query.all(groupId, limit).map((r) => r.topic);
  }

  /**
   * Get recent advice entries for a group
   */
  getRecent(groupId: number, limit: number = 10): AdviceLog[] {
    const query = this.db.query<AdviceLog, [number, number]>(`
      SELECT * FROM advice_log
      WHERE group_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `);

    return query.all(groupId, limit);
  }

  /**
   * Get last advice of a specific tier for a group
   */
  getLastByTier(groupId: number, tier: string): AdviceLog | null {
    const query = this.db.query<AdviceLog, [number, string]>(`
      SELECT * FROM advice_log
      WHERE group_id = ? AND tier = ?
      ORDER BY created_at DESC
      LIMIT 1
    `);

    return query.get(groupId, tier) || null;
  }

  /**
   * Count advice entries for a group today
   */
  countToday(groupId: number, today: string): number {
    const query = this.db.query<{ count: number }, [number, string]>(`
      SELECT COUNT(*) as count FROM advice_log
      WHERE group_id = ? AND date(created_at) = ?
    `);

    const result = query.get(groupId, today);
    return result?.count || 0;
  }

  /**
   * Check if a specific trigger topic was already fired this month
   */
  hasTopicThisMonth(groupId: number, topic: string, monthStart: string): boolean {
    const query = this.db.query<{ count: number }, [number, string, string]>(`
      SELECT COUNT(*) as count FROM advice_log
      WHERE group_id = ? AND topic = ? AND created_at >= ?
    `);

    const result = query.get(groupId, topic, monthStart);
    return (result?.count || 0) > 0;
  }
}
