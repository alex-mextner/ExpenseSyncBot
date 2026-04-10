/** Category emoji cache repository — stores semantic-match results for user-defined category names */
import type { Database } from 'bun:sqlite';

interface CategoryEmojiCacheRow {
  category: string;
  emoji: string;
  matched_key: string | null;
  created_at: string;
}

export class CategoryEmojiCacheRepository {
  constructor(private db: Database) {}

  /**
   * Look up a cached emoji for a category name. Key is case-insensitive.
   */
  get(category: string): string | null {
    const key = category.trim().toLowerCase();
    if (!key) return null;

    const query = this.db.query<CategoryEmojiCacheRow, [string]>(
      'SELECT * FROM category_emoji_cache WHERE category = ?',
    );
    const row = query.get(key);
    return row?.emoji ?? null;
  }

  /**
   * Store a resolved emoji for a category name. Upserts on conflict.
   * matchedKey records which CATEGORY_EMOJIS entry was chosen (for debugging);
   * pass null when the resolver fell back to the default emoji.
   */
  set(category: string, emoji: string, matchedKey: string | null): void {
    const key = category.trim().toLowerCase();
    if (!key) return;

    const query = this.db.query<void, [string, string, string | null]>(`
      INSERT INTO category_emoji_cache (category, emoji, matched_key)
      VALUES (?, ?, ?)
      ON CONFLICT(category) DO UPDATE SET
        emoji = excluded.emoji,
        matched_key = excluded.matched_key
    `);
    query.run(key, emoji, matchedKey);
  }
}
