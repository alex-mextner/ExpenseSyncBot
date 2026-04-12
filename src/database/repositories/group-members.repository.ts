/** Group members repository — tracks which users belong to which groups (many-to-many) */
import type { Database } from 'bun:sqlite';

/** Group info for display in private chat buttons */
export interface GroupForButton {
  groupId: number;
  telegramGroupId: number;
  title: string | null;
  inviteLink: string | null;
}

export class GroupMembersRepository {
  constructor(private db: Database) {}

  /** Add or update user membership in a group */
  upsert(telegramId: number, groupId: number): void {
    this.db
      .query<void, [number, number]>(
        `INSERT INTO group_members (telegram_id, group_id)
         VALUES (?, ?)
         ON CONFLICT(telegram_id, group_id) DO NOTHING`,
      )
      .run(telegramId, groupId);
  }

  /** Find all groups a user belongs to, ordered by most recently joined */
  findGroupsByTelegramId(telegramId: number): GroupForButton[] {
    return this.db
      .query<GroupForButton, [number]>(
        `SELECT g.id AS groupId, g.telegram_group_id AS telegramGroupId,
                g.title, g.invite_link AS inviteLink
         FROM group_members gm
         JOIN groups g ON g.id = gm.group_id
         WHERE gm.telegram_id = ?
         ORDER BY gm.joined_at DESC`,
      )
      .all(telegramId);
  }

  /** Check if a user is a member of a specific group */
  isMember(telegramId: number, groupId: number): boolean {
    const row = this.db
      .query<{ c: number }, [number, number]>(
        `SELECT 1 AS c FROM group_members WHERE telegram_id = ? AND group_id = ? LIMIT 1`,
      )
      .get(telegramId, groupId);
    return row !== null;
  }

  /** Remove a user from a group */
  remove(telegramId: number, groupId: number): void {
    this.db
      .query<void, [number, number]>(
        `DELETE FROM group_members WHERE telegram_id = ? AND group_id = ?`,
      )
      .run(telegramId, groupId);
  }
}
