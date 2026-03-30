// Merchant normalization rules and rule-request queue.
import type { Database } from 'bun:sqlite';
import type {
  CreateMerchantRuleData,
  CreateMerchantRuleRequestData,
  MerchantRule,
  MerchantRuleRequest,
  UpdateMerchantRuleData,
} from '../types';

export class MerchantRulesRepository {
  constructor(private db: Database) {}

  insert(data: CreateMerchantRuleData): MerchantRule {
    const result = this.db
      .query<{ id: number }, [string, string, string, string | null, number, string]>(`
      INSERT INTO merchant_rules (pattern, flags, replacement, category, confidence, source)
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `)
      .get(
        data.pattern,
        data.flags ?? 'i',
        data.replacement,
        data.category ?? null,
        data.confidence ?? 1.0,
        data.source ?? 'ai',
      );

    if (!result) throw new Error('Failed to insert merchant rule');
    const rule = this.findById(result.id);
    if (!rule) throw new Error('Failed to retrieve merchant rule');
    return rule;
  }

  findById(id: number): MerchantRule | null {
    return (
      this.db.query<MerchantRule, [number]>('SELECT * FROM merchant_rules WHERE id = ?').get(id) ??
      null
    );
  }

  findApproved(): MerchantRule[] {
    return this.db
      .query<MerchantRule, []>("SELECT * FROM merchant_rules WHERE status = 'approved' ORDER BY id")
      .all();
  }

  findPendingReview(): MerchantRule[] {
    return this.db
      .query<MerchantRule, []>(
        "SELECT * FROM merchant_rules WHERE status = 'pending_review' ORDER BY created_at DESC",
      )
      .all();
  }

  updateStatus(id: number, status: MerchantRule['status']): void {
    this.db
      .query<void, [string, number]>(
        "UPDATE merchant_rules SET status = ?, updated_at = datetime('now') WHERE id = ?",
      )
      .run(status, id);
  }

  update(id: number, data: UpdateMerchantRuleData): void {
    const fields: string[] = ["updated_at = datetime('now')"];
    const values: (string | number | null)[] = [];

    if (data.pattern !== undefined) {
      fields.push('pattern = ?');
      values.push(data.pattern);
    }
    if (data.replacement !== undefined) {
      fields.push('replacement = ?');
      values.push(data.replacement);
    }
    if (data.category !== undefined) {
      fields.push('category = ?');
      values.push(data.category);
    }
    if (data.confidence !== undefined) {
      fields.push('confidence = ?');
      values.push(data.confidence);
    }
    if (data.status !== undefined) {
      fields.push('status = ?');
      values.push(data.status);
    }

    values.push(id);
    this.db.prepare(`UPDATE merchant_rules SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  insertRuleRequest(data: CreateMerchantRuleRequestData): void {
    this.db
      .query<void, [string, number | null, number | null, string | null, string | null]>(`
      INSERT OR IGNORE INTO merchant_rule_requests
        (merchant_raw, mcc, group_id, user_category, user_comment)
      VALUES (?, ?, ?, ?, ?)
    `)
      .run(
        data.merchant_raw,
        data.mcc ?? null,
        data.group_id ?? null,
        data.user_category ?? null,
        data.user_comment ?? null,
      );
  }

  findUnprocessedRequests(): MerchantRuleRequest[] {
    return this.db
      .query<MerchantRuleRequest, []>(
        'SELECT * FROM merchant_rule_requests WHERE processed = 0 ORDER BY created_at',
      )
      .all();
  }

  markRequestProcessed(id: number): void {
    this.db
      .query<void, [number]>('UPDATE merchant_rule_requests SET processed = 1 WHERE id = ?')
      .run(id);
  }

  pruneOldRequests(): void {
    this.db.exec(
      "DELETE FROM merchant_rule_requests WHERE processed = 1 AND created_at < datetime('now', '-7 days')",
    );
  }
}
