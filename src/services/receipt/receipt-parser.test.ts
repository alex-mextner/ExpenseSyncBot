// Tests for receipt-parser.ts — unified parser with tool-calling sum verification.
// Mocks aiStreamRound from streaming module and simulates tool_calls flow.

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

import type { AIReceiptItem } from './ai-extractor';
import { repairTruncatedJson } from './ai-extractor';

// ── Mock aiStreamRound with a programmable tool-calling machine ────────────
//
// The parser runs in rounds. On each round we return:
//   - One or more tool_calls → executor runs, next round sees the results
//   - An emit_items call → parser records items and stops
//
// Tests push scenarios to `mockRounds` — an array where each entry is
// "what aiStreamRound should return on round N".

interface MockToolCall {
  id: string;
  name: string;
  arguments: string;
}

interface MockStreamResult {
  text: string;
  toolCalls: MockToolCall[];
  finishReason: string;
  assistantMessage: {
    role: 'assistant';
    content: string | null;
    tool_calls?: Array<{
      id: string;
      type: 'function';
      function: { name: string; arguments: string };
    }>;
  };
  providerUsed: string;
}

let mockRounds: MockStreamResult[] = [];
let roundIndex = 0;

function buildMockResult(toolCalls: MockToolCall[], text = ''): MockStreamResult {
  return {
    text,
    toolCalls,
    finishReason: 'tool_calls',
    assistantMessage: {
      role: 'assistant',
      content: text || null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function' as const,
        function: { name: tc.name, arguments: tc.arguments },
      })),
    },
    providerUsed: 'mock-smart',
  };
}

const mockAiStreamRound = mock((_opts?: unknown, _cbs?: unknown): Promise<MockStreamResult> => {
  const result = mockRounds[roundIndex] ?? {
    text: 'APPROVE',
    toolCalls: [],
    finishReason: 'stop',
    assistantMessage: { role: 'assistant' as const, content: 'APPROVE' },
    providerUsed: 'mock-smart',
  };
  roundIndex++;
  return Promise.resolve(result);
});

mock.module('../ai/streaming', () => ({
  aiStreamRound: mockAiStreamRound,
  stripThinkingTags: (t: string) => t.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(),
}));

import { parseReceipt } from './receipt-parser';

/** Long enough to pass the < 10 char early-return guard in parseReceipt */
const SAMPLE_RECEIPT = 'Sample receipt text with items and total';

function resetMocks(): void {
  mockAiStreamRound.mockClear();
  mockRounds = [];
  roundIndex = 0;
}

// ── Fixture builders ────────────────────────────────────────────────────────

function makeItem(overrides: Partial<AIReceiptItem> = {}): AIReceiptItem {
  return {
    name_ru: 'Молоко',
    name_original: 'Milk',
    quantity: 1,
    price: 100,
    total: 100,
    category: 'Еда',
    possible_categories: ['Разное'],
    ...overrides,
  };
}

function calcSumCall(id: string, numbers: number[]): MockToolCall {
  return {
    id,
    name: 'calculate_sum',
    arguments: JSON.stringify({ numbers, label: 'item totals' }),
  };
}

function emitItemsCall(
  id: string,
  items: AIReceiptItem[],
  extras: { currency?: string; claimed_total?: number; date?: string } = {},
): MockToolCall {
  return {
    id,
    name: 'emit_items',
    arguments: JSON.stringify({ items, ...extras }),
  };
}

// ── Tests: repairTruncatedJson (legacy helper still re-exported from ai-extractor) ──

describe('repairTruncatedJson', () => {
  it('extracts complete items from truncated JSON', () => {
    const truncated = `\`\`\`json
{
  "items": [
    {"name_ru": "Молоко", "quantity": 1, "price": 150, "total": 150, "category": "Еда", "possible_categories": ["Продукты"]},
    {"name_ru": "Хлеб", "quantity": 2, "price": 60, "total": 120, "category": "Еда", "possible_categories": ["Продукты"]},
    {"name_ru": "Обрезанный товар", "quantity": 1, "price": 200, "tot`;

    const result = repairTruncatedJson(truncated, 'length');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.name_ru).toBe('Молоко');
    expect(result.items[1]?.name_ru).toBe('Хлеб');
  });

  it('extracts currency from truncated response', () => {
    const truncated = `{"items": [{"name_ru": "Сок", "quantity": 1, "price": 100, "total": 100, "category": "Еда"}], "currency": "RSD", "extra_field": "trun`;

    const result = repairTruncatedJson(truncated, 'length');
    expect(result.items).toHaveLength(1);
    expect(result.currency).toBe('RSD');
  });

  it('throws when no items key found', () => {
    expect(() => repairTruncatedJson('some random text', 'length')).toThrow('No valid JSON found');
  });

  it('throws when no complete items found', () => {
    const truncated = `{"items": [{"name_ru": "Incomplete`;
    expect(() => repairTruncatedJson(truncated, 'length')).toThrow('No valid JSON found');
  });
});

// ── Tests: parseReceipt — happy path ────────────────────────────────────────

describe('parseReceipt — happy path', () => {
  beforeEach(resetMocks);

  it('verifies sum via calculate_sum then emits items', async () => {
    const items = [
      makeItem({ name_ru: 'Молоко', total: 100 }),
      makeItem({ name_ru: 'Хлеб', total: 50 }),
    ];
    mockRounds = [
      buildMockResult([calcSumCall('c1', [100, 50])]),
      buildMockResult([emitItemsCall('c2', items, { currency: 'RSD', claimed_total: 150 })]),
    ];

    const result = await parseReceipt('Молоко 100\nХлеб 50\nИтого: 150', []);

    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.name_ru).toBe('Молоко');
    expect(result.currency).toBe('RSD');
    expect(result.claimedTotal).toBe(150);
    expect(result.computedSum).toBe(150);
    expect(result.sumVerified).toBe(true);
    expect(result.calculateSumRounds).toBe(1);
  });

  it('extracts date in YYYY-MM-DD format', async () => {
    const items = [makeItem({ total: 100 })];
    mockRounds = [
      buildMockResult([calcSumCall('c1', [100])]),
      buildMockResult([
        emitItemsCall('c2', items, { currency: 'RSD', claimed_total: 100, date: '2025-11-24' }),
      ]),
    ];

    const result = await parseReceipt(SAMPLE_RECEIPT, []);
    expect(result.date).toBe('2025-11-24');
  });

  it('drops malformed date', async () => {
    const items = [makeItem({ total: 100 })];
    mockRounds = [
      buildMockResult([calcSumCall('c1', [100])]),
      buildMockResult([
        emitItemsCall('c2', items, { currency: 'RSD', claimed_total: 100, date: '24/11/2025' }),
      ]),
    ];

    const result = await parseReceipt(SAMPLE_RECEIPT, []);
    expect(result.date).toBeUndefined();
  });

  it('forwards onProgress callback as onTextDelta', async () => {
    mockAiStreamRound.mockImplementationOnce(
      (_opts: unknown, cbs?: unknown): Promise<MockStreamResult> => {
        const cb = cbs as { onTextDelta?: (t: string) => void } | undefined;
        cb?.onTextDelta?.('streaming token');
        return Promise.resolve(
          buildMockResult([
            emitItemsCall('c1', [makeItem({ total: 100 })], {
              currency: 'RSD',
              claimed_total: 100,
            }),
          ]),
        );
      },
    );

    const chunks: string[] = [];
    await parseReceipt(SAMPLE_RECEIPT, [], undefined, (delta) => chunks.push(delta));
    expect(chunks).toEqual(['streaming token']);
  });

  it('passes chain: smart to aiStreamRound', async () => {
    mockRounds = [
      buildMockResult([emitItemsCall('c1', [makeItem({ total: 100 })], { currency: 'RSD' })]),
    ];

    await parseReceipt(SAMPLE_RECEIPT, []);

    const opts = (mockAiStreamRound.mock.calls[0] as unknown as [{ chain: string }])[0];
    expect(opts.chain).toBe('smart');
  });

  it('tracks calculateSumRounds when model re-verifies', async () => {
    const items = [makeItem({ total: 100 }), makeItem({ name_ru: 'Хлеб', total: 50 })];
    mockRounds = [
      // First calc — wrong items (missed one)
      buildMockResult([calcSumCall('c1', [100])]),
      // Second calc — fixed
      buildMockResult([calcSumCall('c2', [100, 50])]),
      buildMockResult([emitItemsCall('c3', items, { currency: 'RSD', claimed_total: 150 })]),
    ];

    const result = await parseReceipt(SAMPLE_RECEIPT, []);
    expect(result.calculateSumRounds).toBe(2);
    expect(result.sumVerified).toBe(true);
  });
});

// ── Tests: parseReceipt — empty / no-text cases ─────────────────────────────

describe('parseReceipt — empty receipts', () => {
  beforeEach(resetMocks);

  it('returns empty items for NO_TEXT marker without calling AI', async () => {
    const result = await parseReceipt('NO_TEXT', []);
    expect(result.items).toHaveLength(0);
    expect(result.providerUsed).toBe('none');
    expect(mockAiStreamRound).toHaveBeenCalledTimes(0);
  });

  it('returns empty items for very short text without calling AI', async () => {
    const result = await parseReceipt('[QR]', []);
    expect(result.items).toHaveLength(0);
    expect(mockAiStreamRound).toHaveBeenCalledTimes(0);
  });

  it('does not mark empty receipts as sumVerified', async () => {
    mockRounds = [
      buildMockResult([calcSumCall('c1', [])]),
      buildMockResult([emitItemsCall('c2', [], { currency: 'RSD', claimed_total: 0 })]),
    ];

    const result = await parseReceipt(
      'Фискальный чек без позиций — длинный текст для прохождения length check',
      [],
    );
    expect(result.items).toHaveLength(0);
    expect(result.sumVerified).toBe(false);
    // Currency + claimedTotal should NOT leak into result for empty receipts
    expect(result.currency).toBeUndefined();
    expect(result.claimedTotal).toBeUndefined();
  });
});

// ── Tests: parseReceipt — category normalization ────────────────────────────

describe('parseReceipt — category validation', () => {
  beforeEach(resetMocks);

  it('keeps existing category when it matches', async () => {
    mockRounds = [
      buildMockResult([calcSumCall('c1', [100])]),
      buildMockResult([
        emitItemsCall('c2', [makeItem({ category: 'Еда', total: 100 })], {
          currency: 'RSD',
          claimed_total: 100,
        }),
      ]),
    ];

    const result = await parseReceipt(SAMPLE_RECEIPT, ['Еда', 'Разное']);
    expect(result.items[0]?.category).toBe('Еда');
  });

  it('fuzzy-matches case-mismatched category', async () => {
    mockRounds = [
      buildMockResult([calcSumCall('c1', [100])]),
      buildMockResult([
        emitItemsCall('c2', [makeItem({ category: 'еда', total: 100 })], {
          currency: 'RSD',
          claimed_total: 100,
        }),
      ]),
    ];

    const result = await parseReceipt(SAMPLE_RECEIPT, ['Еда', 'Разное']);
    expect(result.items[0]?.category).toBe('Еда');
  });

  it('falls back to "Разное" when no fuzzy match', async () => {
    mockRounds = [
      buildMockResult([calcSumCall('c1', [100])]),
      buildMockResult([
        emitItemsCall('c2', [makeItem({ category: 'ZZZ_NONEXISTENT', total: 100 })], {
          currency: 'RSD',
          claimed_total: 100,
        }),
      ]),
    ];

    const result = await parseReceipt(SAMPLE_RECEIPT, ['Продукты', 'Разное']);
    expect(result.items[0]?.category).toBe('Разное');
  });

  it('filters out non-existing possible_categories', async () => {
    mockRounds = [
      buildMockResult([calcSumCall('c1', [100])]),
      buildMockResult([
        emitItemsCall(
          'c2',
          [
            makeItem({
              category: 'Еда',
              total: 100,
              possible_categories: ['Еда', 'FakeCategory'],
            }),
          ],
          { currency: 'RSD', claimed_total: 100 },
        ),
      ]),
    ];

    const result = await parseReceipt(SAMPLE_RECEIPT, ['Еда', 'Разное']);
    const possibles = result.items[0]?.possible_categories ?? [];
    expect(possibles).toContain('Еда');
    expect(possibles).not.toContain('FakeCategory');
  });
});

// ── Tests: parseReceipt — prompt-leak defense ───────────────────────────────

describe('parseReceipt — prompt leak defense', () => {
  beforeEach(resetMocks);

  it('replaces leaked name_ru with name_original', async () => {
    mockRounds = [
      buildMockResult([calcSumCall('c1', [180])]),
      buildMockResult([
        emitItemsCall(
          'c2',
          [
            makeItem({
              name_ru: 'перевод на русский',
              name_original: 'Banana 1kg',
              total: 180,
              price: 180,
            }),
          ],
          { currency: 'RSD', claimed_total: 180 },
        ),
      ]),
    ];

    const result = await parseReceipt(SAMPLE_RECEIPT, []);
    expect(result.items[0]?.name_ru).toBe('Banana 1kg');
  });

  it('falls back to "Товар (total)" when name_original is also leaked', async () => {
    mockRounds = [
      buildMockResult([calcSumCall('c1', [200])]),
      buildMockResult([
        emitItemsCall(
          'c2',
          [
            makeItem({
              name_ru: 'название товара на русском',
              name_original: 'оригинальное название',
              total: 200,
              price: 200,
            }),
          ],
          { currency: 'RSD', claimed_total: 200 },
        ),
      ]),
    ];

    const result = await parseReceipt(SAMPLE_RECEIPT, []);
    expect(result.items[0]?.name_ru).toBe('Товар (200)');
  });
});

// ── Tests: parseReceipt — sumVerified semantics ─────────────────────────────

describe('parseReceipt — sum verification', () => {
  beforeEach(resetMocks);

  it('rejects when sum differs from claimed total beyond tolerance', async () => {
    mockRounds = [
      buildMockResult([calcSumCall('c1', [100])]),
      buildMockResult([
        emitItemsCall('c2', [makeItem({ total: 100 })], { currency: 'RSD', claimed_total: 200 }),
      ]),
    ];

    const result = await parseReceipt(SAMPLE_RECEIPT, []);
    expect(result.sumVerified).toBe(false);
  });

  it('approves when sum matches within 1% tolerance', async () => {
    mockRounds = [
      buildMockResult([calcSumCall('c1', [99.5])]),
      buildMockResult([
        emitItemsCall('c2', [makeItem({ total: 99.5 })], { currency: 'RSD', claimed_total: 100 }),
      ]),
    ];

    const result = await parseReceipt(SAMPLE_RECEIPT, []);
    expect(result.sumVerified).toBe(true);
  });

  it('marks sumVerified=false when calculate_sum was never called', async () => {
    mockRounds = [
      buildMockResult([
        emitItemsCall('c1', [makeItem({ total: 100 })], { currency: 'RSD', claimed_total: 100 }),
      ]),
    ];

    const result = await parseReceipt(SAMPLE_RECEIPT, []);
    expect(result.sumVerified).toBe(false);
    expect(result.calculateSumRounds).toBe(0);
  });
});
