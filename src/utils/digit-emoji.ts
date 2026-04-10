/** Fetches and caches custom emoji IDs for numbered lists and message reactions */
import type { TelegramReactionType } from '@gramio/types';
import { TelegramError } from 'gramio';
import type { BotInstance } from '../bot/types';
import { createLogger } from './logger.ts';

const logger = createLogger('digit-emoji');

const STICKER_SET_NAME = 'CyrillicFont';
const RESTRICTED_EMOJI_SET = 'RestrictedEmoji';

/** Keycap digit emojis (used as sticker alt text in CyrillicFont) */
const KEYCAP_EMOJIS = [
  '0\uFE0F\u20E3',
  '1\uFE0F\u20E3',
  '2\uFE0F\u20E3',
  '3\uFE0F\u20E3',
  '4\uFE0F\u20E3',
  '5\uFE0F\u20E3',
  '6\uFE0F\u20E3',
  '7\uFE0F\u20E3',
  '8\uFE0F\u20E3',
  '9\uFE0F\u20E3',
] as const;

/** Keycap emoji string → digit index mapping */
const KEYCAP_TO_DIGIT: Record<string, number> = Object.fromEntries(
  KEYCAP_EMOJIS.map((emoji, i) => [emoji, i]),
);

/** Cached digit (0-9) → custom_emoji_id mapping */
let digitEmojiIds: Map<number, string> | null = null;

/** Cached ✅ custom emoji ID from RestrictedEmoji set */
let checkEmojiId: string | null = null;

/** Cached 💯 custom emoji ID from RestrictedEmoji set */
let hundredEmojiId: string | null = null;

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
 * The alt text inside <tg-emoji> must be the original keycap emoji (e.g. 1️⃣),
 * not just the digit — otherwise Telegram rejects with ENTITY_TEXT_INVALID.
 */
function singleDigitEmoji(d: number): string {
  const id = digitEmojiIds?.get(d);
  if (id) {
    return `<tg-emoji emoji-id="${id}">${KEYCAP_EMOJIS[d]}</tg-emoji>`;
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

/**
 * Load ✅ and 💯 custom emoji from RestrictedEmoji sticker set.
 * Safe to call multiple times — fetches only once.
 */
export async function loadReactionEmojis(bot: BotInstance): Promise<void> {
  if (checkEmojiId) return;

  try {
    const stickerSet = await bot.api.getStickerSet({ name: RESTRICTED_EMOJI_SET });
    for (const sticker of stickerSet.stickers) {
      if (!sticker.custom_emoji_id) continue;
      if (sticker.emoji === '✅' && !checkEmojiId) {
        checkEmojiId = sticker.custom_emoji_id;
      }
      if (sticker.emoji === '💯' && !hundredEmojiId) {
        hundredEmojiId = sticker.custom_emoji_id;
      }
    }
    if (checkEmojiId) {
      logger.info(`Loaded ✅ emoji from ${RESTRICTED_EMOJI_SET}: ${checkEmojiId}`);
    }
    if (hundredEmojiId) {
      logger.info(`Loaded 💯 emoji from ${RESTRICTED_EMOJI_SET}: ${hundredEmojiId}`);
    }
    if (!checkEmojiId && !hundredEmojiId) {
      logger.warn(`No reaction emojis found in ${RESTRICTED_EMOJI_SET}`);
    }
  } catch (err) {
    logger.error({ err }, `Failed to load ${RESTRICTED_EMOJI_SET} sticker set`);
  }
}

/** Get single digit (0-9) custom emoji ID for reactions */
export function getDigitEmojiId(digit: number): string | null {
  return digitEmojiIds?.get(digit) ?? null;
}

/** Get ✅ custom emoji ID */
export function getCheckEmojiId(): string | null {
  return checkEmojiId;
}

/**
 * Build single reaction for expense messages.
 * 1 expense → ✅, 2-9 → digit, 10+ → 💯. Fallback → 👍.
 */
export function buildExpenseReaction(expenseCount: number): TelegramReactionType {
  if (expenseCount >= 10 && hundredEmojiId) {
    return { type: 'custom_emoji', custom_emoji_id: hundredEmojiId };
  }

  if (expenseCount >= 2 && expenseCount <= 9) {
    const digitId = digitEmojiIds?.get(expenseCount);
    if (digitId) {
      return { type: 'custom_emoji', custom_emoji_id: digitId };
    }
  }

  if (checkEmojiId) {
    return { type: 'custom_emoji', custom_emoji_id: checkEmojiId };
  }

  return { type: 'emoji', emoji: '👍' };
}

/**
 * Standard emoji fallback for reactions (no Premium required).
 * 10+ → 💯, otherwise → 👍.
 */
function buildStandardReaction(expenseCount: number): TelegramReactionType {
  if (expenseCount >= 10) {
    return { type: 'emoji', emoji: '💯' };
  }
  return { type: 'emoji', emoji: '👍' };
}

/**
 * Set expense reaction on a message with automatic fallback.
 * Tries custom emoji first (✅, digits, 💯); on REACTION_INVALID falls back to standard emoji.
 */
export async function setExpenseReaction(
  bot: BotInstance,
  chatId: number | string,
  messageId: number,
  expenseCount: number,
): Promise<void> {
  const customReaction = buildExpenseReaction(expenseCount);

  // If buildExpenseReaction already returned a standard emoji, just use it
  if (customReaction.type === 'emoji') {
    await bot.api.setMessageReaction({
      chat_id: chatId,
      message_id: messageId,
      reaction: [customReaction],
    });
    return;
  }

  // Try custom emoji, fall back to standard on REACTION_INVALID
  try {
    await bot.api.setMessageReaction({
      chat_id: chatId,
      message_id: messageId,
      reaction: [customReaction],
    });
  } catch (err) {
    if (err instanceof TelegramError && err.message.includes('REACTION_INVALID')) {
      logger.debug('Custom emoji reaction not supported, falling back to standard');
      await bot.api.setMessageReaction({
        chat_id: chatId,
        message_id: messageId,
        reaction: [buildStandardReaction(expenseCount)],
      });
    } else {
      throw err;
    }
  }
}

/** Check if digit emojis are loaded (for testing) */
export function hasDigitEmojis(): boolean {
  return digitEmojiIds !== null && digitEmojiIds.size > 0;
}

/** Reset cached emojis (for testing) */
export function resetDigitEmojis(): void {
  digitEmojiIds = null;
  checkEmojiId = null;
  hundredEmojiId = null;
}
