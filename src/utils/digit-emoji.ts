/** Fetches and caches digit custom emoji IDs from a Telegram sticker set for numbered lists */
import type { BotInstance } from '../bot/types';
import { createLogger } from './logger.ts';

const logger = createLogger('digit-emoji');

const STICKER_SET_NAME = 'CyrillicFont';

/** Keycap digit emojis → digit index mapping */
const KEYCAP_TO_DIGIT: Record<string, number> = {
  '0\uFE0F\u20E3': 0,
  '1\uFE0F\u20E3': 1,
  '2\uFE0F\u20E3': 2,
  '3\uFE0F\u20E3': 3,
  '4\uFE0F\u20E3': 4,
  '5\uFE0F\u20E3': 5,
  '6\uFE0F\u20E3': 6,
  '7\uFE0F\u20E3': 7,
  '8\uFE0F\u20E3': 8,
  '9\uFE0F\u20E3': 9,
};

/** Cached digit (1-9) → custom_emoji_id mapping */
let digitEmojiIds: Map<number, string> | null = null;

/**
 * Fetch CyrillicFont sticker set and cache digit emoji IDs.
 * Safe to call multiple times — fetches only once.
 */
export async function loadDigitEmojis(bot: BotInstance): Promise<void> {
  if (digitEmojiIds) return;

  try {
    const stickerSet = await bot.api.getStickerSet({ name: STICKER_SET_NAME });
    const map = new Map<number, string>();

    for (const sticker of stickerSet.stickers) {
      if (!sticker.custom_emoji_id || !sticker.emoji) continue;
      const digit = KEYCAP_TO_DIGIT[sticker.emoji];
      if (digit !== undefined) {
        map.set(digit, sticker.custom_emoji_id);
      }
    }

    if (map.size > 0) {
      digitEmojiIds = map;
      logger.info(`Loaded ${map.size} digit emojis from ${STICKER_SET_NAME}`);
    } else {
      logger.warn(`No digit emojis found in ${STICKER_SET_NAME} sticker set`);
    }
  } catch (err) {
    logger.error({ err }, `Failed to load ${STICKER_SET_NAME} sticker set`);
  }
}

/**
 * Get HTML for a digit custom emoji (1-9).
 * Returns `<tg-emoji emoji-id="...">N</tg-emoji>` if loaded, plain digit otherwise.
 */
export function digitEmoji(n: number): string {
  const id = digitEmojiIds?.get(n);
  if (id) {
    return `<tg-emoji emoji-id="${id}">${n}</tg-emoji>`;
  }
  return `${n}.`;
}

/** Check if digit emojis are loaded (for testing) */
export function hasDigitEmojis(): boolean {
  return digitEmojiIds !== null && digitEmojiIds.size > 0;
}

/** Reset cached emojis (for testing) */
export function resetDigitEmojis(): void {
  digitEmojiIds = null;
}
