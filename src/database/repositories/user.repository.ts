import type { Database } from 'bun:sqlite';
import type { User, CreateUserData, UpdateUserData } from '../types';

export class UserRepository {
  constructor(private db: Database) {}

  /**
   * Find user by Telegram ID
   */
  findByTelegramId(telegramId: number): User | null {
    const query = this.db.query<User, [number]>(`
      SELECT * FROM users WHERE telegram_id = ?
    `);

    return query.get(telegramId) || null;
  }

  /**
   * Find user by ID
   */
  findById(id: number): User | null {
    const query = this.db.query<User, [number]>(`
      SELECT * FROM users WHERE id = ?
    `);

    return query.get(id) || null;
  }

  /**
   * Create new user
   */
  create(data: CreateUserData): User {
    const query = this.db.query<{ id: number }, [number, number | null]>(`
      INSERT INTO users (telegram_id, group_id)
      VALUES (?, ?)
      RETURNING id
    `);

    const result = query.get(data.telegram_id, data.group_id || null);

    if (!result) {
      throw new Error('Failed to create user');
    }

    const user = this.findById(result.id);

    if (!user) {
      throw new Error('Failed to retrieve created user');
    }

    return user;
  }

  /**
   * Update user
   */
  update(telegramId: number, data: UpdateUserData): User | null {
    const user = this.findByTelegramId(telegramId);

    if (!user) return null;

    const updates: string[] = [];
    const values: (number | null)[] = [];

    if (data.group_id !== undefined) {
      updates.push('group_id = ?');
      values.push(data.group_id);
    }

    updates.push('updated_at = CURRENT_TIMESTAMP');

    values.push(telegramId);

    const query = this.db.query(`
      UPDATE users
      SET ${updates.join(', ')}
      WHERE telegram_id = ?
    `);

    query.run(...values);

    return this.findByTelegramId(telegramId);
  }

  /**
   * Delete user
   */
  delete(telegramId: number): boolean {
    const query = this.db.query<void, [number]>(`
      DELETE FROM users WHERE telegram_id = ?
    `);

    query.run(telegramId);
    return true;
  }

  /**
   * Find users by group ID
   */
  findByGroupId(groupId: number): User[] {
    const query = this.db.query<User, [number]>(`
      SELECT * FROM users WHERE group_id = ?
    `);

    return query.all(groupId);
  }
}
