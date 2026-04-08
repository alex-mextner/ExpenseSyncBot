// Tests for digit custom emoji loader and formatter

import { beforeEach, describe, expect, mock, test } from 'bun:test';

// NODE_ENV=test silences pino globally — no stdout pollution.
// Logger mock not needed here: we verify behavior via return values.

import { digitEmoji, hasDigitEmojis, loadDigitEmojis, resetDigitEmojis } from './digit-emoji';

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
    expect(digitEmoji(2)).toBe('<tg-emoji emoji-id="id_2">2</tg-emoji>');
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
      expect(digitEmoji(i)).toBe(`<tg-emoji emoji-id="id_${i}">${i}</tg-emoji>`);
    }
  });
});

describe('digitEmoji', () => {
  test('returns plain digit with period when emojis not loaded', () => {
    expect(digitEmoji(1)).toBe('1.');
    expect(digitEmoji(5)).toBe('5.');
    expect(digitEmoji(9)).toBe('9.');
  });

  test('returns tg-emoji HTML when emojis are loaded', async () => {
    const bot = createMockBot([
      { emoji: '1\uFE0F\u20E3', custom_emoji_id: 'emoji_one' },
      { emoji: '2\uFE0F\u20E3', custom_emoji_id: 'emoji_two' },
      { emoji: '3\uFE0F\u20E3', custom_emoji_id: 'emoji_three' },
    ]);

    await loadDigitEmojis(bot);

    expect(digitEmoji(1)).toBe('<tg-emoji emoji-id="emoji_one">1</tg-emoji>');
    expect(digitEmoji(2)).toBe('<tg-emoji emoji-id="emoji_two">2</tg-emoji>');
    expect(digitEmoji(3)).toBe('<tg-emoji emoji-id="emoji_three">3</tg-emoji>');
  });

  test('falls back for digits without emoji IDs', async () => {
    const bot = createMockBot([{ emoji: '1\uFE0F\u20E3', custom_emoji_id: 'emoji_one' }]);

    await loadDigitEmojis(bot);

    expect(digitEmoji(1)).toBe('<tg-emoji emoji-id="emoji_one">1</tg-emoji>');
    expect(digitEmoji(5)).toBe('5.');
  });
});

describe('resetDigitEmojis', () => {
  test('clears cached emojis', async () => {
    const bot = createMockBot([{ emoji: '1\uFE0F\u20E3', custom_emoji_id: 'id_1' }]);

    await loadDigitEmojis(bot);
    expect(hasDigitEmojis()).toBe(true);

    resetDigitEmojis();
    expect(hasDigitEmojis()).toBe(false);
    expect(digitEmoji(1)).toBe('1.');
  });
});
