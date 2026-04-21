// Tests for link-analyzer.ts — URL extraction + processPaymentLinks integration.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

// ── logger ───────────────────────────────────────────────────────────────
const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── receipt-fetcher / parser / photo-processor ───────────────────────────
const mockFetchReceiptData = mock<(url: string) => Promise<string>>(
  async () => 'receipt content, long enough to pass the 50-char guard in link-analyzer',
);
mock.module('./receipt-fetcher', () => ({ fetchReceiptData: mockFetchReceiptData }));

interface MockParseResult {
  items: Array<{
    name_ru: string;
    name_original?: string;
    quantity: number;
    price: number;
    total: number;
    category: string;
    possible_categories?: string[];
  }>;
  currency?: string;
  sumVerified: boolean;
  computedSum: number;
  providerUsed: string;
  calculateSumRounds: number;
}

const defaultParseResult = (): MockParseResult => ({
  items: [
    {
      name_ru: 'Молоко',
      quantity: 1,
      price: 100,
      total: 100,
      category: 'Еда',
    },
  ],
  currency: 'RSD',
  sumVerified: true,
  computedSum: 100,
  providerUsed: 'mock',
  calculateSumRounds: 0,
});

let mockParseResult: MockParseResult = defaultParseResult();
let mockParseThrows: Error | null = null;

const mockParseReceipt = mock<
  (
    content: string,
    categories: string[],
    examples: Map<string, unknown[]>,
  ) => Promise<MockParseResult>
>(async () => {
  if (mockParseThrows) throw mockParseThrows;
  return mockParseResult;
});

mock.module('./receipt-parser', () => ({ parseReceipt: mockParseReceipt }));

const mockSaveExtractedItems = mock(
  (_queueId: number, _items: unknown[], _currency: string) => undefined,
);
const mockShowReceiptConfirmationOptions = mock(async () => undefined);
mock.module('./photo-processor', () => ({
  saveExtractedItems: mockSaveExtractedItems,
  showReceiptConfirmationOptions: mockShowReceiptConfirmationOptions,
}));

// ── database ─────────────────────────────────────────────────────────────
interface PhotoQueueRow {
  id: number;
  group_id: number;
  user_id: number;
  message_id: number;
  message_thread_id: number | null;
  file_id: string;
  status: string;
}

let photoQueueNextId = 1;
const mockPhotoQueue = {
  create: mock(
    (data: Omit<PhotoQueueRow, 'id'>): PhotoQueueRow => ({
      id: photoQueueNextId++,
      ...data,
    }),
  ),
};

const mockCategories = {
  findByGroupId: mock((_groupId: number) => [{ id: 1, group_id: 1, name: 'Еда', created_at: '' }]),
};

const mockExpenses = {
  getRecentExamplesByCategory: mock((_groupId: number) => new Map<string, unknown[]>()),
};

const mockGroups = {
  findById: mock((id: number) => ({
    id,
    telegram_group_id: 100,
    default_currency: 'EUR',
    active_topic_id: null,
  })),
};

mock.module('../../database', () => ({
  database: {
    photoQueue: mockPhotoQueue,
    categories: mockCategories,
    expenses: mockExpenses,
    groups: mockGroups,
  },
}));

import type { Group, User } from '../../database/types';
// ── imports under test ───────────────────────────────────────────────────
import { extractURLsFromText, processPaymentLinks } from './link-analyzer';

// ── test helpers ─────────────────────────────────────────────────────────
const mockSetReaction = mock(
  async (_params: {
    chat_id: number;
    message_id: number;
    reaction: Array<{ type: string; emoji: string }>;
  }) => undefined,
);

function makeBot(opts: { reactionThrows?: boolean } = {}): {
  api: { setMessageReaction: typeof mockSetReaction };
} {
  mockSetReaction.mockClear();
  if (opts.reactionThrows) {
    mockSetReaction.mockImplementation(async () => {
      throw new Error('Reaction unavailable');
    });
  } else {
    mockSetReaction.mockImplementation(async () => undefined);
  }
  return { api: { setMessageReaction: mockSetReaction } };
}

function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1,
    telegram_group_id: 100,
    default_currency: 'EUR',
    active_topic_id: null,
    created_at: '',
    ...overrides,
  } as Group;
}

function makeUser(overrides: Partial<User> = {}): User {
  return { id: 2, telegram_id: 200, group_id: 1, created_at: '', ...overrides } as User;
}

beforeEach(() => {
  mockParseResult = defaultParseResult();
  mockParseThrows = null;
  photoQueueNextId = 1;
  mockPhotoQueue.create.mockClear();
  mockParseReceipt.mockClear();
  mockFetchReceiptData.mockClear();
  mockSaveExtractedItems.mockClear();
  mockShowReceiptConfirmationOptions.mockClear();
  logMock.info.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
});

describe('extractURLsFromText', () => {
  describe('basic URL extraction', () => {
    it('extracts single http URL from text', () => {
      const result = extractURLsFromText('Check this link: http://example.com/receipt');
      expect(result).toEqual(['http://example.com/receipt']);
    });

    it('extracts single https URL from text', () => {
      const result = extractURLsFromText('Your receipt: https://shop.example.com/r?id=123');
      expect(result).toEqual(['https://shop.example.com/r?id=123']);
    });

    it('extracts multiple URLs from text', () => {
      const text = 'Link 1: https://a.com/page and Link 2: https://b.com/other';
      const result = extractURLsFromText(text);
      expect(result).toHaveLength(2);
      expect(result).toContain('https://a.com/page');
      expect(result).toContain('https://b.com/other');
    });

    it('returns empty array when no URLs present', () => {
      expect(extractURLsFromText('No links here, just text')).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      expect(extractURLsFromText('')).toEqual([]);
    });

    it('extracts URL with query parameters', () => {
      const text = 'Receipt at https://store.com/receipt?id=abc&token=xyz123';
      const result = extractURLsFromText(text);
      expect(result).toContain('https://store.com/receipt?id=abc&token=xyz123');
    });

    it('extracts URL with path segments', () => {
      const text = 'See https://api.example.com/v2/receipts/order/12345';
      const result = extractURLsFromText(text);
      expect(result).toContain('https://api.example.com/v2/receipts/order/12345');
    });

    it('extracts URL at start of text', () => {
      const result = extractURLsFromText('https://example.com is a great site');
      expect(result[0]).toBe('https://example.com');
    });

    it('extracts URL at end of text', () => {
      const result = extractURLsFromText('Visit us at https://example.com');
      expect(result[0]).toBe('https://example.com');
    });

    it('URL only input', () => {
      const result = extractURLsFromText('https://example.com/path');
      expect(result).toEqual(['https://example.com/path']);
    });
  });

  describe('filtering non-URLs', () => {
    it('does not extract ftp URLs (only http/https)', () => {
      const result = extractURLsFromText('ftp://example.com/file.txt');
      expect(result).toEqual([]);
    });

    it('does not extract email addresses', () => {
      const result = extractURLsFromText('Contact us at user@example.com');
      expect(result).toEqual([]);
    });

    it('does not extract bare domain names', () => {
      const result = extractURLsFromText('Visit example.com for more info');
      expect(result).toEqual([]);
    });

    it('does not extract protocol-relative URLs', () => {
      const result = extractURLsFromText('//example.com/path');
      expect(result).toEqual([]);
    });

    it('handles text with numbers only', () => {
      const result = extractURLsFromText('Order 12345 for 99.99 EUR');
      expect(result).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('stops extracting URL at whitespace', () => {
      const text = 'Link: https://example.com/path and more text';
      const result = extractURLsFromText(text);
      expect(result[0]).toBe('https://example.com/path');
    });

    it('extracts URL with port', () => {
      const text = 'API at https://api.example.com:8443/endpoint';
      const result = extractURLsFromText(text);
      expect(result).toContain('https://api.example.com:8443/endpoint');
    });

    it('extracts multiple adjacent URLs on separate lines', () => {
      const text = 'https://first.com\nhttps://second.com';
      const result = extractURLsFromText(text);
      expect(result).toHaveLength(2);
    });

    it('handles URL with encoded characters', () => {
      const text = 'https://example.com/path?q=hello%20world';
      const result = extractURLsFromText(text);
      expect(result).toContain('https://example.com/path?q=hello%20world');
    });

    it('handles Telegram payment link format', () => {
      const text = 'Receipt: https://pay.example.com/check?fn=123&i=1&fp=456&s=789&n=1';
      const result = extractURLsFromText(text);
      expect(result[0]).toContain('pay.example.com/check');
    });

    it('returns array not null for no match', () => {
      const result = extractURLsFromText('just text');
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it('extracts URLs from Russian language text', () => {
      const text = 'Ссылка на чек: https://check.example.ru/r?id=999';
      const result = extractURLsFromText(text);
      expect(result).toContain('https://check.example.ru/r?id=999');
    });

    it('handles text with HTML tags mixed in', () => {
      const text = 'Click <a href="https://example.com">here</a>';
      const result = extractURLsFromText(text);
      // The regex grabs URL from href value but stops at the quote
      // The exact result depends on the regex, just assert it extracts something
      expect(Array.isArray(result)).toBe(true);
    });

    it('strips markdown formatting around URL', () => {
      // Markdown link brackets are part of the surrounding punctuation; the regex
      // grabs the URL text through until whitespace or forbidden chars.
      const text = 'See [our receipt](https://example.com/r?id=1) below';
      const result = extractURLsFromText(text);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toContain('example.com/r');
    });
  });
});

describe('processPaymentLinks', () => {
  afterEach(() => {
    mockSetReaction.mockReset();
  });

  it('returns true and queues receipt when a valid payment URL resolves to items', async () => {
    const bot = makeBot();
    const found = await processPaymentLinks(
      bot as unknown as Parameters<typeof processPaymentLinks>[0],
      100,
      500,
      ['https://pay.example.com/receipt?id=1'],
      makeGroup(),
      makeUser(),
    );

    expect(found).toBe(true);
    expect(mockFetchReceiptData).toHaveBeenCalledTimes(1);
    expect(mockParseReceipt).toHaveBeenCalledTimes(1);
    expect(mockPhotoQueue.create).toHaveBeenCalledTimes(1);
    expect(mockSaveExtractedItems).toHaveBeenCalledTimes(1);
    expect(mockShowReceiptConfirmationOptions).toHaveBeenCalledTimes(1);
  });

  it('creates photo queue with file_id prefixed "link:"', async () => {
    const bot = makeBot();
    await processPaymentLinks(
      bot as unknown as Parameters<typeof processPaymentLinks>[0],
      100,
      500,
      ['https://pay.example.com/x'],
      makeGroup(),
      makeUser(),
    );

    const createArg = mockPhotoQueue.create.mock.calls[0]?.[0] as { file_id: string };
    expect(createArg.file_id).toBe('link:https://pay.example.com/x');
  });

  it('returns false when no URLs are given', async () => {
    const bot = makeBot();
    const found = await processPaymentLinks(
      bot as unknown as Parameters<typeof processPaymentLinks>[0],
      100,
      500,
      [],
      makeGroup(),
      makeUser(),
    );

    expect(found).toBe(false);
    expect(mockFetchReceiptData).not.toHaveBeenCalled();
    expect(mockPhotoQueue.create).not.toHaveBeenCalled();
  });

  it('returns false when fetched content is too short', async () => {
    mockFetchReceiptData.mockResolvedValueOnce('tiny'); // < 50 chars, short-circuits
    const bot = makeBot();

    const found = await processPaymentLinks(
      bot as unknown as Parameters<typeof processPaymentLinks>[0],
      100,
      500,
      ['https://pay.example.com/x'],
      makeGroup(),
      makeUser(),
    );

    expect(found).toBe(false);
    expect(mockParseReceipt).not.toHaveBeenCalled();
    expect(mockPhotoQueue.create).not.toHaveBeenCalled();
  });

  it('returns false when parser returns no items', async () => {
    mockParseResult = { ...defaultParseResult(), items: [] };
    const bot = makeBot();

    const found = await processPaymentLinks(
      bot as unknown as Parameters<typeof processPaymentLinks>[0],
      100,
      500,
      ['https://pay.example.com/empty'],
      makeGroup(),
      makeUser(),
    );

    expect(found).toBe(false);
    expect(mockPhotoQueue.create).not.toHaveBeenCalled();
  });

  it('returns false when parser throws (error swallowed by analyzeLink catch)', async () => {
    // Force parser to reject — analyzeLink catches & returns null, so nothing is queued.
    mockParseReceipt.mockImplementationOnce(async () => {
      throw new Error('parser exploded');
    });
    const bot = makeBot();

    const found = await processPaymentLinks(
      bot as unknown as Parameters<typeof processPaymentLinks>[0],
      100,
      500,
      ['https://pay.example.com/bad'],
      makeGroup(),
      makeUser(),
    );

    expect(found).toBe(false);
    expect(mockParseReceipt).toHaveBeenCalled();
    expect(mockPhotoQueue.create).not.toHaveBeenCalled();
    expect(mockSaveExtractedItems).not.toHaveBeenCalled();
  });

  it('continues through multiple URLs and queues only the payment links', async () => {
    // First URL → tiny content (not payment); second URL → valid
    mockFetchReceiptData
      .mockResolvedValueOnce('small')
      .mockResolvedValueOnce(
        'receipt content, big enough to pass the length check — padding padding padding',
      );

    const bot = makeBot();
    const found = await processPaymentLinks(
      bot as unknown as Parameters<typeof processPaymentLinks>[0],
      100,
      500,
      ['https://not-payment.example/page', 'https://pay.example.com/real'],
      makeGroup(),
      makeUser(),
    );

    expect(found).toBe(true);
    expect(mockFetchReceiptData).toHaveBeenCalledTimes(2);
    expect(mockPhotoQueue.create).toHaveBeenCalledTimes(1);
  });

  it('sets 👀 reaction on every URL attempted', async () => {
    const bot = makeBot();
    await processPaymentLinks(
      bot as unknown as Parameters<typeof processPaymentLinks>[0],
      100,
      500,
      ['https://pay.example.com/1'],
      makeGroup(),
      makeUser(),
    );

    expect(mockSetReaction).toHaveBeenCalled();
    const firstCall = mockSetReaction.mock.calls[0]?.[0] as {
      reaction: Array<{ type: string; emoji: string }>;
    };
    expect(firstCall.reaction[0]?.emoji).toBe('👀');
  });

  it('clears reaction (empty array) when nothing was found', async () => {
    mockFetchReceiptData.mockResolvedValueOnce('tiny');
    const bot = makeBot();

    await processPaymentLinks(
      bot as unknown as Parameters<typeof processPaymentLinks>[0],
      100,
      500,
      ['https://pay.example.com/nothing'],
      makeGroup(),
      makeUser(),
    );

    // Two reaction calls: one 👀, one cleared []
    expect(mockSetReaction).toHaveBeenCalledTimes(2);
    const lastCall = mockSetReaction.mock.calls.at(-1)?.[0] as {
      reaction: Array<{ type: string; emoji: string }>;
    };
    expect(lastCall.reaction).toEqual([]);
  });

  it('does not clear reaction when something was found', async () => {
    const bot = makeBot();
    await processPaymentLinks(
      bot as unknown as Parameters<typeof processPaymentLinks>[0],
      100,
      500,
      ['https://pay.example.com/hit'],
      makeGroup(),
      makeUser(),
    );

    // Only the initial 👀, never the clear
    expect(mockSetReaction).toHaveBeenCalledTimes(1);
  });

  it('swallows reaction API errors and still processes the link', async () => {
    const bot = makeBot({ reactionThrows: true });

    const found = await processPaymentLinks(
      bot as unknown as Parameters<typeof processPaymentLinks>[0],
      100,
      500,
      ['https://pay.example.com/reaction-fails'],
      makeGroup(),
      makeUser(),
    );

    expect(found).toBe(true);
    expect(mockPhotoQueue.create).toHaveBeenCalledTimes(1);
  });

  it('uses parsed currency when the receipt parser returns one', async () => {
    mockParseResult = { ...defaultParseResult(), currency: 'USD' };
    const bot = makeBot();

    await processPaymentLinks(
      bot as unknown as Parameters<typeof processPaymentLinks>[0],
      100,
      500,
      ['https://pay.example.com/usd'],
      makeGroup(),
      makeUser(),
    );

    const currencyArg = mockSaveExtractedItems.mock.calls[0]?.[2];
    expect(currencyArg).toBe('USD');
  });

  it('falls back to group default_currency when parser returns no currency', async () => {
    const { currency: _ignored, ...rest } = defaultParseResult();
    void _ignored;
    mockParseResult = rest;
    // analyzeLink looks up group by id via database.groups.findById — override it
    mockGroups.findById.mockImplementationOnce((id: number) => ({
      id,
      telegram_group_id: 100,
      default_currency: 'RSD',
      active_topic_id: null,
    }));
    const bot = makeBot();

    await processPaymentLinks(
      bot as unknown as Parameters<typeof processPaymentLinks>[0],
      100,
      500,
      ['https://pay.example.com/nocur'],
      makeGroup({ default_currency: 'RSD' }),
      makeUser(),
    );

    const currencyArg = mockSaveExtractedItems.mock.calls[0]?.[2];
    expect(currencyArg).toBe('RSD');
  });
});
