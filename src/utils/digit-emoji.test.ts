// Tests for digit custom emoji loader and formatter

import { beforeEach, describe, expect, mock, test } from 'bun:test';

// NODE_ENV=test silences pino globally — no stdout pollution.
// Logger mock not needed here: we verify behavior via return values.

import { TelegramError } from 'gramio';
import {
  buildExpenseReaction,
  digitEmoji,
  getCheckEmojiId,
  getDigitEmojiId,
  hasDigitEmojis,
  loadDigitEmojis,
  loadReactionEmojis,
  resetDigitEmojis,
  setExpenseReaction,
} from './digit-emoji';

beforeEach(() => {
  resetDigitEmojis();
});

function createMockBot(stickers: Array<{ emoji?: string; custom_emoji_id?: string }>) {
  return {
    api: {
      getStickerSet: mock().mockResolvedValue({
        name: 'CyrillicFont',
        stickers,
      }),
    },
  } as unknown as Parameters<typeof loadDigitEmojis>[0];
}

describe('loadDigitEmojis', () => {
  test('loads digit emojis from sticker set with keycap emojis', async () => {
    const bot = createMockBot([
      { emoji: '1\uFE0F\u20E3', custom_emoji_id: 'id_1' },
      { emoji: '2\uFE0F\u20E3', custom_emoji_id: 'id_2' },
      { emoji: '3\uFE0F\u20E3', custom_emoji_id: 'id_3' },
      { emoji: '\u2764', custom_emoji_id: 'id_heart' },
    ]);

    await loadDigitEmojis(bot);

    expect(hasDigitEmojis()).toBe(true);
    expect(digitEmoji(1)).toContain('id_1');
    expect(digitEmoji(2)).toContain('id_2');
    expect(digitEmoji(3)).toContain('id_3');
  });

  test('skips stickers without custom_emoji_id', async () => {
    const bot = createMockBot([
      { emoji: '1\uFE0F\u20E3' },
      { emoji: '2\uFE0F\u20E3', custom_emoji_id: 'id_2' },
    ]);

    await loadDigitEmojis(bot);

    expect(hasDigitEmojis()).toBe(true);
    expect(digitEmoji(1)).toBe('1.');
    expect(digitEmoji(2)).toBe('<tg-emoji emoji-id="id_2">2\uFE0F\u20E3</tg-emoji>');
  });

  test('hasDigitEmojis returns false when no digit emojis found', async () => {
    const bot = createMockBot([{ emoji: '\u2764', custom_emoji_id: 'id_heart' }]);

    await loadDigitEmojis(bot);

    expect(hasDigitEmojis()).toBe(false);
  });

  test('handles API error gracefully without throwing', async () => {
    const bot = {
      api: {
        getStickerSet: mock().mockRejectedValue(new Error('Network error')),
      },
    } as unknown as Parameters<typeof loadDigitEmojis>[0];

    await loadDigitEmojis(bot);

    expect(hasDigitEmojis()).toBe(false);
    expect(digitEmoji(1)).toBe('1.');
  });

  test('does not refetch if already loaded', async () => {
    const getStickerSet = mock().mockResolvedValue({
      name: 'CyrillicFont',
      stickers: [{ emoji: '1\uFE0F\u20E3', custom_emoji_id: 'id_1' }],
    });
    const bot = { api: { getStickerSet } } as unknown as Parameters<typeof loadDigitEmojis>[0];

    await loadDigitEmojis(bot);
    await loadDigitEmojis(bot);

    expect(getStickerSet).toHaveBeenCalledTimes(1);
  });

  test('loads all digits 0-9', async () => {
    const keycapDigits = Array.from({ length: 10 }, (_, i) => ({
      emoji: `${i}\uFE0F\u20E3`,
      custom_emoji_id: `id_${i}`,
    }));
    const bot = createMockBot(keycapDigits);

    await loadDigitEmojis(bot);

    expect(hasDigitEmojis()).toBe(true);
    for (let i = 0; i <= 9; i++) {
      const keycap = `${i}\uFE0F\u20E3`;
      expect(digitEmoji(i)).toBe(`<tg-emoji emoji-id="id_${i}">${keycap}</tg-emoji>`);
    }
  });
});

describe('digitEmoji', () => {
  test('returns plain digit with period when emojis not loaded', () => {
    expect(digitEmoji(1)).toBe('1.');
    expect(digitEmoji(5)).toBe('5.');
    expect(digitEmoji(9)).toBe('9.');
    expect(digitEmoji(12)).toBe('12.');
  });

  test('returns tg-emoji HTML for single digits', async () => {
    const bot = createMockBot([
      { emoji: '1\uFE0F\u20E3', custom_emoji_id: 'emoji_one' },
      { emoji: '2\uFE0F\u20E3', custom_emoji_id: 'emoji_two' },
      { emoji: '3\uFE0F\u20E3', custom_emoji_id: 'emoji_three' },
    ]);

    await loadDigitEmojis(bot);

    expect(digitEmoji(1)).toBe('<tg-emoji emoji-id="emoji_one">1\uFE0F\u20E3</tg-emoji>');
    expect(digitEmoji(2)).toBe('<tg-emoji emoji-id="emoji_two">2\uFE0F\u20E3</tg-emoji>');
    expect(digitEmoji(3)).toBe('<tg-emoji emoji-id="emoji_three">3\uFE0F\u20E3</tg-emoji>');
  });

  test('composes multi-digit numbers from individual emoji', async () => {
    const allDigits = Array.from({ length: 10 }, (_, i) => ({
      emoji: `${i}\uFE0F\u20E3`,
      custom_emoji_id: `id_${i}`,
    }));
    const bot = createMockBot(allDigits);

    await loadDigitEmojis(bot);

    expect(digitEmoji(10)).toBe(
      '<tg-emoji emoji-id="id_1">1\uFE0F\u20E3</tg-emoji><tg-emoji emoji-id="id_0">0\uFE0F\u20E3</tg-emoji>',
    );
    expect(digitEmoji(12)).toBe(
      '<tg-emoji emoji-id="id_1">1\uFE0F\u20E3</tg-emoji><tg-emoji emoji-id="id_2">2\uFE0F\u20E3</tg-emoji>',
    );
    expect(digitEmoji(25)).toBe(
      '<tg-emoji emoji-id="id_2">2\uFE0F\u20E3</tg-emoji><tg-emoji emoji-id="id_5">5\uFE0F\u20E3</tg-emoji>',
    );
  });

  test('falls back to plain text if any digit in multi-digit number is missing', async () => {
    // Only has digit 1, missing digit 0
    const bot = createMockBot([{ emoji: '1\uFE0F\u20E3', custom_emoji_id: 'emoji_one' }]);

    await loadDigitEmojis(bot);

    expect(digitEmoji(1)).toBe('<tg-emoji emoji-id="emoji_one">1\uFE0F\u20E3</tg-emoji>');
    expect(digitEmoji(10)).toBe('10.');
    expect(digitEmoji(5)).toBe('5.');
  });
});

describe('resetDigitEmojis', () => {
  test('clears cached emojis including check emoji', async () => {
    const bot = createMockBot([{ emoji: '1\uFE0F\u20E3', custom_emoji_id: 'id_1' }]);

    await loadDigitEmojis(bot);
    expect(hasDigitEmojis()).toBe(true);

    resetDigitEmojis();
    expect(hasDigitEmojis()).toBe(false);
    expect(getCheckEmojiId()).toBeNull();
    expect(digitEmoji(1)).toBe('1.');
  });
});

describe('loadReactionEmojis', () => {
  function createReactionBot(stickers: Array<{ emoji?: string; custom_emoji_id?: string }>) {
    return {
      api: {
        getStickerSet: mock().mockResolvedValue({ name: 'RestrictedEmoji', stickers }),
      },
    } as unknown as Parameters<typeof loadReactionEmojis>[0];
  }

  test('loads ✅ and 💯 from sticker set', async () => {
    const bot = createReactionBot([
      { emoji: '✅', custom_emoji_id: 'id_check' },
      { emoji: '💯', custom_emoji_id: 'id_hundred' },
      { emoji: '❌', custom_emoji_id: 'id_cross' },
    ]);

    await loadReactionEmojis(bot);

    expect(getCheckEmojiId()).toBe('id_check');
  });

  test('handles missing ✅ gracefully', async () => {
    const bot = createReactionBot([
      { emoji: '❌', custom_emoji_id: 'id_cross' },
      { emoji: '💯', custom_emoji_id: 'id_hundred' },
    ]);

    await loadReactionEmojis(bot);

    expect(getCheckEmojiId()).toBeNull();
  });

  test('handles API error gracefully', async () => {
    const bot = {
      api: { getStickerSet: mock().mockRejectedValue(new Error('Not found')) },
    } as unknown as Parameters<typeof loadReactionEmojis>[0];

    await loadReactionEmojis(bot);

    expect(getCheckEmojiId()).toBeNull();
  });

  test('does not refetch if already loaded', async () => {
    const getStickerSet = mock().mockResolvedValue({
      name: 'RestrictedEmoji',
      stickers: [{ emoji: '✅', custom_emoji_id: 'id_check' }],
    });
    const bot = { api: { getStickerSet } } as unknown as Parameters<typeof loadReactionEmojis>[0];

    await loadReactionEmojis(bot);
    await loadReactionEmojis(bot);

    expect(getStickerSet).toHaveBeenCalledTimes(1);
  });
});

describe('getDigitEmojiId', () => {
  test('returns null when not loaded', () => {
    expect(getDigitEmojiId(1)).toBeNull();
  });

  test('returns custom emoji ID for loaded digit', async () => {
    const bot = createMockBot([
      { emoji: '2\uFE0F\u20E3', custom_emoji_id: 'id_2' },
      { emoji: '5\uFE0F\u20E3', custom_emoji_id: 'id_5' },
    ]);

    await loadDigitEmojis(bot);

    expect(getDigitEmojiId(2)).toBe('id_2');
    expect(getDigitEmojiId(5)).toBe('id_5');
    expect(getDigitEmojiId(7)).toBeNull();
  });
});

describe('buildExpenseReaction', () => {
  function loadReaction(stickers: Array<{ emoji?: string; custom_emoji_id?: string }>) {
    return {
      api: {
        getStickerSet: mock().mockResolvedValue({ name: 'RestrictedEmoji', stickers }),
      },
    } as unknown as Parameters<typeof loadReactionEmojis>[0];
  }

  test('returns 👍 fallback when no custom emojis loaded', () => {
    expect(buildExpenseReaction(1)).toEqual({ type: 'emoji', emoji: '👍' });
  });

  test('returns ✅ for single expense', async () => {
    await loadReactionEmojis(loadReaction([{ emoji: '✅', custom_emoji_id: 'check_id' }]));

    expect(buildExpenseReaction(1)).toEqual({
      type: 'custom_emoji',
      custom_emoji_id: 'check_id',
    });
  });

  test('returns digit for 2-9 expenses', async () => {
    await loadReactionEmojis(
      loadReaction([
        { emoji: '✅', custom_emoji_id: 'check_id' },
        { emoji: '💯', custom_emoji_id: 'hundred_id' },
      ]),
    );
    const digitBot = createMockBot([
      { emoji: '2\uFE0F\u20E3', custom_emoji_id: 'digit_2' },
      { emoji: '5\uFE0F\u20E3', custom_emoji_id: 'digit_5' },
    ]);
    await loadDigitEmojis(digitBot);

    expect(buildExpenseReaction(2)).toEqual({ type: 'custom_emoji', custom_emoji_id: 'digit_2' });
    expect(buildExpenseReaction(5)).toEqual({ type: 'custom_emoji', custom_emoji_id: 'digit_5' });
  });

  test('returns 💯 for 10+ expenses', async () => {
    await loadReactionEmojis(
      loadReaction([
        { emoji: '✅', custom_emoji_id: 'check_id' },
        { emoji: '💯', custom_emoji_id: 'hundred_id' },
      ]),
    );

    expect(buildExpenseReaction(10)).toEqual({
      type: 'custom_emoji',
      custom_emoji_id: 'hundred_id',
    });
    expect(buildExpenseReaction(25)).toEqual({
      type: 'custom_emoji',
      custom_emoji_id: 'hundred_id',
    });
  });

  test('falls back to ✅ for 2-9 when digit emojis not loaded', async () => {
    await loadReactionEmojis(loadReaction([{ emoji: '✅', custom_emoji_id: 'check_id' }]));

    expect(buildExpenseReaction(3)).toEqual({
      type: 'custom_emoji',
      custom_emoji_id: 'check_id',
    });
  });

  test('falls back to ✅ for 10+ when 💯 not loaded', async () => {
    await loadReactionEmojis(loadReaction([{ emoji: '✅', custom_emoji_id: 'check_id' }]));

    expect(buildExpenseReaction(10)).toEqual({
      type: 'custom_emoji',
      custom_emoji_id: 'check_id',
    });
  });
});

describe('setExpenseReaction', () => {
  function createFullBot(opts: { reactionFails?: boolean } = {}) {
    const setMessageReaction = opts.reactionFails
      ? mock()
          .mockRejectedValueOnce(
            new TelegramError(
              {
                ok: false,
                error_code: 400,
                description: 'Bad Request: REACTION_INVALID',
                parameters: {},
              } as never,
              'setMessageReaction',
              {} as never,
            ),
          )
          .mockResolvedValueOnce(true)
      : mock().mockResolvedValue(true);

    return {
      bot: {
        api: {
          getStickerSet: mock().mockResolvedValue({
            name: 'RestrictedEmoji',
            stickers: [
              { emoji: '✅', custom_emoji_id: 'check_id' },
              { emoji: '💯', custom_emoji_id: 'hundred_id' },
            ],
          }),
          setMessageReaction,
        },
      } as unknown as Parameters<typeof setExpenseReaction>[0],
      setMessageReaction,
    };
  }

  test('uses custom emoji when supported', async () => {
    const { bot, setMessageReaction } = createFullBot();
    await loadReactionEmojis(bot as unknown as Parameters<typeof loadReactionEmojis>[0]);

    await setExpenseReaction(bot, -123, 456, 1);

    expect(setMessageReaction).toHaveBeenCalledTimes(1);
    expect(setMessageReaction).toHaveBeenCalledWith({
      chat_id: -123,
      message_id: 456,
      reaction: [{ type: 'custom_emoji', custom_emoji_id: 'check_id' }],
    });
  });

  test('falls back to standard emoji on REACTION_INVALID', async () => {
    const { bot, setMessageReaction } = createFullBot({ reactionFails: true });
    await loadReactionEmojis(bot as unknown as Parameters<typeof loadReactionEmojis>[0]);

    await setExpenseReaction(bot, -123, 456, 1);

    expect(setMessageReaction).toHaveBeenCalledTimes(2);
    // Second call should be standard emoji
    expect(setMessageReaction.mock.calls[1]?.[0]).toEqual({
      chat_id: -123,
      message_id: 456,
      reaction: [{ type: 'emoji', emoji: '👍' }],
    });
  });

  test('falls back to 💯 standard for 10+ expenses on REACTION_INVALID', async () => {
    const { bot, setMessageReaction } = createFullBot({ reactionFails: true });
    await loadReactionEmojis(bot as unknown as Parameters<typeof loadReactionEmojis>[0]);

    await setExpenseReaction(bot, -123, 456, 15);

    expect(setMessageReaction).toHaveBeenCalledTimes(2);
    expect(setMessageReaction.mock.calls[1]?.[0]).toEqual({
      chat_id: -123,
      message_id: 456,
      reaction: [{ type: 'emoji', emoji: '💯' }],
    });
  });

  test('uses standard emoji directly when no custom loaded', async () => {
    const { bot, setMessageReaction } = createFullBot();
    // Don't load reaction emojis — buildExpenseReaction returns standard 👍

    await setExpenseReaction(bot, -123, 456, 1);

    expect(setMessageReaction).toHaveBeenCalledTimes(1);
    expect(setMessageReaction).toHaveBeenCalledWith({
      chat_id: -123,
      message_id: 456,
      reaction: [{ type: 'emoji', emoji: '👍' }],
    });
  });

  test('rethrows non-REACTION_INVALID errors', async () => {
    const setMessageReaction = mock().mockRejectedValue(
      new TelegramError(
        {
          ok: false,
          error_code: 403,
          description: 'Forbidden: bot was blocked by the user',
          parameters: {},
        } as never,
        'setMessageReaction',
        {} as never,
      ),
    );
    const bot = {
      api: {
        getStickerSet: mock().mockResolvedValue({
          name: 'RestrictedEmoji',
          stickers: [{ emoji: '✅', custom_emoji_id: 'check_id' }],
        }),
        setMessageReaction,
      },
    } as unknown as Parameters<typeof setExpenseReaction>[0];
    await loadReactionEmojis(bot as unknown as Parameters<typeof loadReactionEmojis>[0]);

    await expect(setExpenseReaction(bot, -123, 456, 1)).rejects.toThrow('Forbidden');
  });
});
