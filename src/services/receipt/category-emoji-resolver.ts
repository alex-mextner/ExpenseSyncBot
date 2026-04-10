/**
 * Async category emoji resolver with HF semantic-match fallback.
 * Used when a user-defined category name doesn't have an exact entry in
 * CATEGORY_EMOJIS — asks a multilingual sentence-similarity model to pick
 * the closest known category key. Results are cached in SQLite
 * (category_emoji_cache table) so HF is called at most once per unique
 * unknown category.
 */
import { InferenceClient } from '@huggingface/inference';
import {
  CATEGORY_EMOJIS,
  DEFAULT_CATEGORY_EMOJI,
  getCategoryEmoji,
} from '../../config/category-emojis';
import { env } from '../../config/env';
import { database } from '../../database';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('category-emoji-resolver');

const client = new InferenceClient(env.HF_TOKEN);

// Multilingual sentence embedding model — small, fast, hosted on HF serverless
const SIMILARITY_MODEL = 'sentence-transformers/paraphrase-multilingual-MiniLM-L12-v2';

// Cosine similarity score below which we don't trust the match and fall
// back to the default emoji. Tuned empirically for the MiniLM model.
const SIMILARITY_THRESHOLD = 0.5;

/**
 * Resolve emoji for a category name. Tries in order:
 * 1. Exact match in CATEGORY_EMOJIS (case-insensitive) — returned sync-ish.
 * 2. Cached HF match from category_emoji_cache table.
 * 3. Fresh HF sentence-similarity lookup (if HF_TOKEN is configured).
 * 4. Default emoji.
 *
 * Every path through 2-4 writes to the cache so subsequent lookups skip HF.
 */
export async function resolveCategoryEmoji(category: string): Promise<string> {
  const trimmed = category.trim();
  if (!trimmed) return DEFAULT_CATEGORY_EMOJI;

  // 1. Exact match — don't bother hitting the cache or HF
  const exact = CATEGORY_EMOJIS[trimmed];
  if (exact) return exact;
  const lower = trimmed.toLowerCase();
  for (const [key, emoji] of Object.entries(CATEGORY_EMOJIS)) {
    if (key.toLowerCase() === lower) return emoji;
  }

  // 2. Cache
  const cached = database.categoryEmojiCache.get(trimmed);
  if (cached) return cached;

  // 3. HF semantic match (if available)
  if (env.HF_TOKEN) {
    try {
      const match = await matchWithHF(trimmed);
      if (match) {
        database.categoryEmojiCache.set(trimmed, match.emoji, match.key);
        return match.emoji;
      }
    } catch (err) {
      logger.warn({ err, data: { category: trimmed } }, 'HF category matching failed');
    }
  }

  // 4. Default — cache it so we don't retry HF for the same unknown category
  database.categoryEmojiCache.set(trimmed, DEFAULT_CATEGORY_EMOJI, null);
  return DEFAULT_CATEGORY_EMOJI;
}

/**
 * Resolve emojis for many categories in one shot — useful when formatting
 * a receipt summary with multiple categories. Deduplicates before hitting
 * the cache/HF.
 */
export async function resolveCategoryEmojis(
  categories: readonly string[],
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const unique = Array.from(new Set(categories.map((c) => c.trim()).filter(Boolean)));
  for (const cat of unique) {
    result.set(cat, await resolveCategoryEmoji(cat));
  }
  return result;
}

/**
 * Ask HF which known category key is closest to the user's category by
 * sentence similarity. Returns null if the best score is below the threshold.
 */
async function matchWithHF(category: string): Promise<{ emoji: string; key: string } | null> {
  // Use deduped CATEGORY_EMOJIS keys — some entries are aliases (e.g. Food/Еда)
  // but they still show up as distinct keys, which is fine: whichever variant
  // scores highest gives the correct emoji.
  const keys = Object.keys(CATEGORY_EMOJIS);

  const scores = await client.sentenceSimilarity({
    model: SIMILARITY_MODEL,
    inputs: {
      source_sentence: category,
      sentences: keys,
    },
  });

  if (!Array.isArray(scores) || scores.length !== keys.length) {
    logger.warn(
      { data: { category, scoresLen: scores?.length, keysLen: keys.length } },
      'HF sentence-similarity returned unexpected shape',
    );
    return null;
  }

  let bestIdx = -1;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < scores.length; i++) {
    const score = scores[i];
    if (typeof score === 'number' && score > bestScore) {
      bestScore = score;
      bestIdx = i;
    }
  }

  if (bestIdx < 0 || bestScore < SIMILARITY_THRESHOLD) {
    logger.info(
      { data: { category, bestScore, threshold: SIMILARITY_THRESHOLD } },
      'HF match below threshold, using default emoji',
    );
    return null;
  }

  const key = keys[bestIdx];
  if (!key) return null;
  const emoji = CATEGORY_EMOJIS[key];
  if (!emoji) return null;

  logger.info(
    { data: { category, matchedKey: key, score: bestScore, emoji } },
    'HF category match',
  );
  return { emoji, key };
}

// Keep getCategoryEmoji re-exported for convenience so callers that need
// both sync and async access only import from this module.
export { getCategoryEmoji };
