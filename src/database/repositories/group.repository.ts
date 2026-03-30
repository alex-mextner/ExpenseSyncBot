/** Group repository — manages Telegram group records, OAuth tokens, and spreadsheet settings */
import type { Database } from 'bun:sqlite';
import type { CurrencyCode } from '../../config/constants';
import type { CreateGroupData, Group, UpdateGroupData } from '../types';

/** Raw row from the LEFT JOIN query */
interface GroupRow extends Omit<Group, 'enabled_currencies'> {
  enabled_currencies: string;
}

/** SELECT clause that includes spreadsheet_id via LEFT JOIN on current year */
const GROUP_JOIN_SELECT = `
  SELECT
    g.id, g.telegram_group_id, g.google_refresh_token,
    g.default_currency, g.enabled_currencies, g.custom_prompt,
    g.active_topic_id, g.created_at, g.updated_at,
    gs.spreadsheet_id
  FROM groups g
  LEFT JOIN group_spreadsheets gs
    ON gs.group_id = g.id AND gs.year = CAST(strftime('%Y', 'now') AS INTEGER)
`;

function parseRow(row: GroupRow): Group {
  return {
    ...row,
    spreadsheet_id: row.spreadsheet_id ?? null,
    enabled_currencies: JSON.parse(row.enabled_currencies) as CurrencyCode[],
  };
}

export class GroupRepository {
  constructor(private db: Database) {}

  findByTelegramGroupId(telegramGroupId: number): Group | null {
    const result = this.db
      .query<GroupRow, [number]>(`${GROUP_JOIN_SELECT} WHERE g.telegram_group_id = ?`)
      .get(telegramGroupId);
    return result ? parseRow(result) : null;
  }

  findById(id: number): Group | null {
    const result = this.db.query<GroupRow, [number]>(`${GROUP_JOIN_SELECT} WHERE g.id = ?`).get(id);
    return result ? parseRow(result) : null;
  }

  findAll(): Group[] {
    return this.db.query<GroupRow, []>(GROUP_JOIN_SELECT).all().map(parseRow);
  }

  create(data: CreateGroupData): Group {
    const result = this.db
      .query<{ id: number }, [number, string]>(
        'INSERT INTO groups (telegram_group_id, default_currency) VALUES (?, ?) RETURNING id',
      )
      .get(data.telegram_group_id, data.default_currency || 'USD');

    if (!result) throw new Error('Failed to create group');

    const group = this.findById(result.id);
    if (!group) throw new Error('Failed to retrieve created group');
    return group;
  }

  update(telegramGroupId: number, data: UpdateGroupData): Group | null {
    const group = this.findByTelegramGroupId(telegramGroupId);
    if (!group) return null;

    // spreadsheet_id lives in group_spreadsheets, not groups
    if (data.spreadsheet_id !== undefined) {
      const currentYear = new Date().getFullYear();
      this.db
        .query<void, [number, number, string]>(
          'INSERT OR REPLACE INTO group_spreadsheets (group_id, year, spreadsheet_id) VALUES (?, ?, ?)',
        )
        .run(group.id, currentYear, data.spreadsheet_id);
    }

    const updates: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.google_refresh_token !== undefined) {
      updates.push('google_refresh_token = ?');
      values.push(data.google_refresh_token);
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
    if (data.active_topic_id !== undefined) {
      updates.push('active_topic_id = ?');
      values.push(data.active_topic_id);
    }

    if (data.bank_panel_summary_message_id !== undefined) {
      updates.push('bank_panel_summary_message_id = ?');
      values.push(data.bank_panel_summary_message_id);
    }

    if (updates.length > 0) {
      updates.push('updated_at = CURRENT_TIMESTAMP');
      values.push(telegramGroupId);
      this.db
        .query(`UPDATE groups SET ${updates.join(', ')} WHERE telegram_group_id = ?`)
        .run(...values);
    }

    return this.findByTelegramGroupId(telegramGroupId);
  }

  /** @deprecated Use findAll() */
  getAll(): Group[] {
    return this.findAll();
  }

  delete(telegramGroupId: number): boolean {
    this.db
      .query<void, [number]>('DELETE FROM groups WHERE telegram_group_id = ?')
      .run(telegramGroupId);
    return true;
  }

  hasCompletedSetup(telegramGroupId: number): boolean {
    const group = this.findByTelegramGroupId(telegramGroupId);
    if (!group) return false;
    return !!(group.default_currency && group.enabled_currencies.length > 0);
  }

  hasGoogleConnection(telegramGroupId: number): boolean {
    const group = this.findByTelegramGroupId(telegramGroupId);
    if (!group) return false;
    return !!(group.google_refresh_token && group.spreadsheet_id);
  }
}
