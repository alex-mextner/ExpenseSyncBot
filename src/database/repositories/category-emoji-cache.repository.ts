/** Category emoji cache repository — stores LLM-resolved emoji per group × category */
import type { Database } from 'bun:sqlite';

interface CategoryEmojiCacheRow {
  group_id: number;
  category: string;
  emoji: string;
  matched_key: string | null;
  created_at: string;
}

export class CategoryEmojiCacheRepository {
  constructor(private db: Database) {}

  /**
   * Look up a cached emoji for (group, category). Category is case-insensitive.
   * Returns null when nothing cached yet — caller decides whether to call the LLM.
   */
  get(groupId: number, category: string): string | null {
    const key = category.trim().toLowerCase();
    if (!key) return null;

    const query = this.db.query<CategoryEmojiCacheRow, [number, string]>(
      'SELECT * FROM category_emoji_cache WHERE group_id = ? AND category = ?',
    );
    const row = query.get(groupId, key);
    return row?.emoji ?? null;
  }

  /**
   * Store a resolved emoji for (group, category). Upserts on conflict.
   * matchedKey records which CATEGORY_EMOJIS entry (or virtual key) was chosen
   * for debugging; pass null when the resolver fell back to the default emoji.
   */
  set(groupId: number, category: string, emoji: string, matchedKey: string | null): void {
    const key = category.trim().toLowerCase();
    if (!key) return;

    const query = this.db.query<void, [number, string, string, string | null]>(`
      INSERT INTO category_emoji_cache (group_id, category, emoji, matched_key)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(group_id, category) DO UPDATE SET
        emoji = excluded.emoji,
        matched_key = excluded.matched_key
    `);
    query.run(groupId, key, emoji, matchedKey);
  }
}
