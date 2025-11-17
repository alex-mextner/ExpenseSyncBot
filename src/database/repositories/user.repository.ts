import type { Database } from 'bun:sqlite';
import type { User, CreateUserData, UpdateUserData } from '../types';
import type { CurrencyCode } from '../../config/constants';

export class UserRepository {
  constructor(private db: Database) {}

  /**
   * Find user by Telegram ID
   */
  findByTelegramId(telegramId: number): User | null {
    const query = this.db.query<User, [number]>(`
      SELECT * FROM users WHERE telegram_id = ?
    `);

    const result = query.get(telegramId);

    if (!result) return null;

    // Parse JSON fields
    return {
      ...result,
      enabled_currencies: JSON.parse(result.enabled_currencies as unknown as string) as CurrencyCode[],
    };
  }

  /**
   * Find user by ID
   */
  findById(id: number): User | null {
    const query = this.db.query<User, [number]>(`
      SELECT * FROM users WHERE id = ?
    `);

    const result = query.get(id);

    if (!result) return null;

    return {
      ...result,
      enabled_currencies: JSON.parse(result.enabled_currencies as unknown as string) as CurrencyCode[],
    };
  }

  /**
   * Create new user
   */
  create(data: CreateUserData): User {
    const query = this.db.query<{ id: number }, [number, string]>(`
      INSERT INTO users (telegram_id, default_currency)
      VALUES (?, ?)
      RETURNING id
    `);

    const result = query.get(data.telegram_id, data.default_currency || 'USD');

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
   * Check if user has completed setup
   */
  hasCompletedSetup(telegramId: number): boolean {
    const user = this.findByTelegramId(telegramId);

    if (!user) return false;

    return !!(
      user.google_refresh_token &&
      user.spreadsheet_id &&
      user.enabled_currencies.length > 0
    );
  }
}
