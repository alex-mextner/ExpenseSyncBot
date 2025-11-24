import type { Database } from 'bun:sqlite';
import type { Group, CreateGroupData, UpdateGroupData } from '../types';
import type { CurrencyCode } from '../../config/constants';

export class GroupRepository {
  constructor(private db: Database) {}

  /**
   * Find group by Telegram group ID
   */
  findByTelegramGroupId(telegramGroupId: number): Group | null {
    const query = this.db.query<Group, [number]>(`
      SELECT * FROM groups WHERE telegram_group_id = ?
    `);

    const result = query.get(telegramGroupId);

    if (!result) return null;

    // Parse JSON fields
    return {
      ...result,
      enabled_currencies: JSON.parse(result.enabled_currencies as unknown as string) as CurrencyCode[],
    };
  }

  /**
   * Find group by ID
   */
  findById(id: number): Group | null {
    const query = this.db.query<Group, [number]>(`
      SELECT * FROM groups WHERE id = ?
    `);

    const result = query.get(id);

    if (!result) return null;

    return {
      ...result,
      enabled_currencies: JSON.parse(result.enabled_currencies as unknown as string) as CurrencyCode[],
    };
  }

  /**
   * Create new group
   */
  create(data: CreateGroupData): Group {
    const query = this.db.query<{ id: number }, [number, string]>(`
      INSERT INTO groups (telegram_group_id, default_currency)
      VALUES (?, ?)
      RETURNING id
    `);

    const result = query.get(data.telegram_group_id, data.default_currency || 'USD');

    if (!result) {
      throw new Error('Failed to create group');
    }

    const group = this.findById(result.id);

    if (!group) {
      throw new Error('Failed to retrieve created group');
    }

    return group;
  }

  /**
   * Update group
   */
  update(telegramGroupId: number, data: UpdateGroupData): Group | null {
    const group = this.findByTelegramGroupId(telegramGroupId);

    if (!group) return null;

    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.google_refresh_token !== undefined) {
      updates.push('google_refresh_token = ?');
      values.push(data.google_refresh_token);
    }

    if (data.spreadsheet_id !== undefined) {
      updates.push('spreadsheet_id = ?');
      values.push(data.spreadsheet_id);
    }

    if (data.default_currency !== undefined) {
      updates.push('default_currency = ?');
      values.push(data.default_currency);
    }

    if (data.enabled_currencies !== undefined) {
      updates.push('enabled_currencies = ?');
      values.push(JSON.stringify(data.enabled_currencies));
    }

    if (data.custom_prompt !== undefined) {
      updates.push('custom_prompt = ?');
      values.push(data.custom_prompt);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');

    values.push(telegramGroupId);

    const query = this.db.query(`
      UPDATE groups
      SET ${updates.join(', ')}
      WHERE telegram_group_id = ?
    `);

    query.run(...values);

    return this.findByTelegramGroupId(telegramGroupId);
  }

  /**
   * Delete group
   */
  delete(telegramGroupId: number): boolean {
    const query = this.db.query<void, [number]>(`
      DELETE FROM groups WHERE telegram_group_id = ?
    `);

    query.run(telegramGroupId);
    return true;
  }

  /**
   * Check if group has completed setup
   */
  hasCompletedSetup(telegramGroupId: number): boolean {
    const group = this.findByTelegramGroupId(telegramGroupId);

    if (!group) return false;

    return !!(
      group.google_refresh_token &&
      group.spreadsheet_id &&
      group.enabled_currencies.length > 0
    );
  }
}
