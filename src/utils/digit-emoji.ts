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

/** Cached digit (0-9) → custom_emoji_id mapping */
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
 * Format a single digit (0-9) as a custom emoji tag.
 * Returns plain digit if emoji ID is not available.
 */
function singleDigitEmoji(d: number): string {
  const id = digitEmojiIds?.get(d);
  if (id) {
    return `<tg-emoji emoji-id="${id}">${d}</tg-emoji>`;
  }
  return '';
}

/**
 * Get HTML for a numbered custom emoji.
 * For 1-9: single emoji. For 10+: composed from individual digit emojis.
 * Falls back to plain "N." when emojis are not loaded.
 */
export function digitEmoji(n: number): string {
  if (!digitEmojiIds || digitEmojiIds.size === 0) {
    return `${n}.`;
  }

  const digits = String(n).split('').map(Number);
  const parts = digits.map(singleDigitEmoji);

  // If any digit lacks an emoji ID, fall back to plain text
  if (parts.some((p) => p === '')) {
    return `${n}.`;
  }

  return parts.join('');
}

/** Check if digit emojis are loaded (for testing) */
export function hasDigitEmojis(): boolean {
  return digitEmojiIds !== null && digitEmojiIds.size > 0;
}

/** Reset cached emojis (for testing) */
export function resetDigitEmojis(): void {
  digitEmojiIds = null;
}
