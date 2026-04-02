// Tests for ai-extractor.ts — mocks global fetch (HuggingFace SDK uses fetch internally)
// Tests observable behavior: JSON parsing, think-tag stripping, markdown blocks,
// decimal separator normalization, category validation, fallback behavior, and error paths.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

import { extractExpensesFromReceipt, repairTruncatedJson } from './ai-extractor';

// The HuggingFace SDK makes two separate fetch calls for each chat completion:
// 1. GET /api/models/<model>?expand[]=inferenceProviderMapping — fetches provider metadata
// 2. POST <provider-api-url> — the actual chat completion request
//
// We must return appropriate responses for each URL to avoid "Body already used" errors.

// Fake provider mapping that satisfies the SDK's validation
function makeProviderMappingResponse(provider: string, modelId: string): Response {
  return new Response(
    JSON.stringify({
      inferenceProviderMapping: {
        [provider]: {
          providerId: modelId,
          status: 'live',
          task: 'conversational',
        },
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

// Return the correct provider for a given model — must match MODELS in ai-extractor.ts
function providerForModel(modelId: string): string {
  if (modelId.includes('DeepSeek-R1')) return 'novita';
  return 'fireworks-ai';
}

// Build a fake chat completion API response that passes SDK validation.
// The BaseConversationalTask.getResponse() requires: choices (array), created (number),
// id (string), model (string), usage (object).
function makeChatResponse(content: string | null, finishReason = 'stop'): Response {
  return new Response(
    JSON.stringify({
      id: 'test-id-123',
      object: 'chat.completion',
      created: 1700000000,
      model: 'deepseek-ai/DeepSeek-R1-0528',
      choices: [{ index: 0, message: { content, role: 'assistant' }, finish_reason: finishReason }],
      usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

// Install a URL-aware fetch mock.
// Calls to HF Hub (/api/models/) get provider metadata.
// All other calls get the chat completion content.
function mockFetchWithContent(chatContent: string | null): void {
  globalThis.fetch = mock(async (url: string | URL): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);
    if (urlStr.includes('/api/models/')) {
      const match = urlStr.match(/\/api\/models\/([^?]+)/);
      const modelId = match?.[1] ?? 'unknown/model';
      return makeProviderMappingResponse(providerForModel(modelId), modelId);
    }
    return makeChatResponse(chatContent);
  }) as unknown as typeof globalThis.fetch;
}

// Install a URL-aware fetch mock that throws on chat API calls
function mockFetchWithError(error: Error): void {
  globalThis.fetch = mock(async (url: string | URL): Promise<Response> => {
    const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);
    if (urlStr.includes('/api/models/')) {
      const match = urlStr.match(/\/api\/models\/([^?]+)/);
      const modelId = match?.[1] ?? 'unknown/model';
      return makeProviderMappingResponse(providerForModel(modelId), modelId);
    }
    throw error;
  }) as unknown as typeof globalThis.fetch;
}

// Valid minimal extraction result JSON
const VALID_ITEMS_JSON = JSON.stringify({
  items: [
    {
      name_ru: 'Молоко',
      name_original: 'Milk',
      quantity: 1,
      price: 100,
      total: 100,
      category: 'Еда',
      possible_categories: ['Напитки'],
    },
  ],
  currency: 'RSD',
});

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

  it('skips malformed item objects but keeps valid ones', () => {
    const mixed = `{"items": [
      {"name_ru": "Хороший", "quantity": 1, "price": 50, "total": 50, "category": "Еда"},
      {"broken": true},
      {"name_ru": "Тоже хороший", "quantity": 2, "price": 30, "total": 60, "category": "Еда"}
    ]}`;

    const result = repairTruncatedJson(mixed, 'stop');
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.name_ru).toBe('Хороший');
    expect(result.items[1]?.name_ru).toBe('Тоже хороший');
  });
});

describe('extractExpensesFromReceipt', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('success — basic parsing', () => {
    it('returns items array from valid JSON response', async () => {
      mockFetchWithContent(VALID_ITEMS_JSON);

      const result = await extractExpensesFromReceipt('Receipt text', [], undefined, 1);
      expect(Array.isArray(result.items)).toBe(true);
      expect(result.items.length).toBe(1);
    });

    it('returns correct item fields', async () => {
      mockFetchWithContent(VALID_ITEMS_JSON);

      const result = await extractExpensesFromReceipt('Receipt text', [], undefined, 1);
      const item = result.items[0];
      expect(item?.name_ru).toBe('Молоко');
      expect(item?.quantity).toBe(1);
      expect(item?.price).toBe(100);
      expect(item?.total).toBe(100);
      expect(item?.category).toBe('Еда');
    });

    it('salvages complete items from truncated AI response', async () => {
      const truncatedJson = `\`\`\`json
{
  "items": [
    {"name_ru": "Молоко", "quantity": 1, "price": 100, "total": 100, "category": "Еда", "possible_categories": ["Продукты"]},
    {"name_ru": "Хлеб", "quantity": 2, "price": 50, "total": 100, "category": "Еда", "possible_categories": ["Продукты"]},
    {"name_ru": "Обрезанный", "quantity": 1, "price": 200, "tot`;

      // Mock returns truncated response with finish_reason=length
      globalThis.fetch = mock(async (url: string | URL): Promise<Response> => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);
        if (urlStr.includes('/api/models/')) {
          const match = urlStr.match(/\/api\/models\/([^?]+)/);
          const modelId = match?.[1] ?? 'unknown/model';
          return makeProviderMappingResponse(providerForModel(modelId), modelId);
        }
        return makeChatResponse(truncatedJson, 'length');
      }) as unknown as typeof globalThis.fetch;

      const result = await extractExpensesFromReceipt('Receipt text', [], undefined, 1);
      expect(result.items).toHaveLength(2);
      expect(result.items[0]?.name_ru).toBe('Молоко');
      expect(result.items[1]?.name_ru).toBe('Хлеб');
    });

    it('returns currency from response', async () => {
      mockFetchWithContent(VALID_ITEMS_JSON);

      const result = await extractExpensesFromReceipt('Receipt', [], undefined, 1);
      expect(result.currency).toBe('RSD');
    });

    it('accepts plain text receipt data', async () => {
      mockFetchWithContent(VALID_ITEMS_JSON);

      const result = await extractExpensesFromReceipt(
        'Store: Mega Mart\nMilk 1L - 100 RSD',
        [],
        undefined,
        1,
      );
      expect(result.items.length).toBeGreaterThan(0);
    });

    it('detects HTML and strips tags before sending', async () => {
      mockFetchWithContent(VALID_ITEMS_JSON);

      const html = '<!DOCTYPE html><html><body><p>Milk 100 RSD</p></body></html>';
      const result = await extractExpensesFromReceipt(html, [], undefined, 1);
      expect(result.items.length).toBeGreaterThan(0);
    });
  });

  describe('response parsing edge cases', () => {
    it('strips <think> tags from reasoning model response', async () => {
      const withThink = `<think>Let me analyze this receipt carefully...</think>\n${VALID_ITEMS_JSON}`;
      mockFetchWithContent(withThink);

      const result = await extractExpensesFromReceipt('Receipt', [], undefined, 1);
      expect(result.items.length).toBe(1);
      expect(result.items[0]?.name_ru).toBe('Молоко');
    });

    it('strips multiple <think> blocks (greedy match)', async () => {
      const withMultipleThink = `<think>First thought</think><think>Second thought</think>${VALID_ITEMS_JSON}`;
      mockFetchWithContent(withMultipleThink);

      const result = await extractExpensesFromReceipt('Receipt', [], undefined, 1);
      expect(result.items.length).toBe(1);
    });

    it('unwraps JSON from markdown code block with json hint', async () => {
      const withCodeBlock = `\`\`\`json\n${VALID_ITEMS_JSON}\n\`\`\``;
      mockFetchWithContent(withCodeBlock);

      const result = await extractExpensesFromReceipt('Receipt', [], undefined, 1);
      expect(result.items.length).toBe(1);
    });

    it('unwraps JSON from plain code block (no language hint)', async () => {
      const withCodeBlock = `\`\`\`\n${VALID_ITEMS_JSON}\n\`\`\``;
      mockFetchWithContent(withCodeBlock);

      const result = await extractExpensesFromReceipt('Receipt', [], undefined, 1);
      expect(result.items.length).toBe(1);
    });

    it('fixes European decimal comma (399,99 → 399.99)', async () => {
      // Craft JSON that uses comma as decimal separator (invalid JSON, but the extractor fixes it)
      const rawJson =
        '{"items":[{"name_ru":"Хлеб","quantity":1,"price":399,99,"total":399,99,"category":"Еда","possible_categories":[]}],"currency":"RSD"}';
      mockFetchWithContent(rawJson);

      const result = await extractExpensesFromReceipt('Receipt', [], undefined, 1);
      expect(result.items[0]?.price).toBe(399.99);
    });

    it('falls back to {"items"...} extraction when JSON has extra text prefix', async () => {
      const withPrefix = `Here is the parsed receipt:\n\n${VALID_ITEMS_JSON}`;
      mockFetchWithContent(withPrefix);

      const result = await extractExpensesFromReceipt('Receipt', [], undefined, 1);
      expect(result.items.length).toBe(1);
    });
  });

  describe('category validation', () => {
    it('keeps AI category when it matches existing categories', async () => {
      const json = JSON.stringify({
        items: [
          {
            name_ru: 'Молоко',
            quantity: 1,
            price: 100,
            total: 100,
            category: 'Еда',
            possible_categories: [],
          },
        ],
        currency: 'EUR',
      });
      mockFetchWithContent(json);

      const result = await extractExpensesFromReceipt('Receipt', ['Еда', 'Разное'], undefined, 1);
      expect(result.items[0]?.category).toBe('Еда');
    });

    it('replaces unknown AI category with fuzzy match', async () => {
      const json = JSON.stringify({
        items: [
          {
            name_ru: 'Молоко',
            quantity: 1,
            price: 100,
            total: 100,
            category: 'еда', // lowercase — not in existingCategories but fuzzy-matches 'Еда'
            possible_categories: [],
          },
        ],
        currency: 'EUR',
      });
      mockFetchWithContent(json);

      const result = await extractExpensesFromReceipt('Receipt', ['Еда', 'Разное'], undefined, 1);
      expect(result.items[0]?.category).toBe('Еда');
    });

    it('falls back to first category when no fuzzy match found', async () => {
      const json = JSON.stringify({
        items: [
          {
            name_ru: 'Неизвестный товар',
            quantity: 1,
            price: 50,
            total: 50,
            category: 'XYZ_NONEXISTENT_CATEGORY',
            possible_categories: [],
          },
        ],
        currency: 'EUR',
      });
      mockFetchWithContent(json);

      const result = await extractExpensesFromReceipt(
        'Receipt',
        ['Продукты', 'Хозтовары'],
        undefined,
        1,
      );
      const validFallbacks = ['Продукты', 'Хозтовары', 'Разное'];
      const firstCategory = result.items[0]?.category;
      expect(typeof firstCategory === 'string' && validFallbacks.includes(firstCategory)).toBe(
        true,
      );
    });

    it('prefers "Разное" as fallback when it exists in categories', async () => {
      const json = JSON.stringify({
        items: [
          {
            name_ru: 'Неизвестный товар',
            quantity: 1,
            price: 50,
            total: 50,
            category: 'ZZZ_NONEXISTENT',
            possible_categories: [],
          },
        ],
        currency: 'EUR',
      });
      mockFetchWithContent(json);

      const result = await extractExpensesFromReceipt(
        'Receipt',
        ['Продукты', 'Разное'],
        undefined,
        1,
      );
      expect(result.items[0]?.category).toBe('Разное');
    });

    it('filters out non-existing possible_categories', async () => {
      const json = JSON.stringify({
        items: [
          {
            name_ru: 'Хлеб',
            quantity: 1,
            price: 50,
            total: 50,
            category: 'Еда',
            possible_categories: ['Еда', 'NonExistentCat', 'AnotherFake'],
          },
        ],
        currency: 'EUR',
      });
      mockFetchWithContent(json);

      const result = await extractExpensesFromReceipt('Receipt', ['Еда', 'Разное'], undefined, 1);
      const possibleCats = result.items[0]?.possible_categories ?? [];
      for (const cat of possibleCats) {
        expect(['Еда', 'Разное']).toContain(cat);
      }
    });

    it('initializes missing possible_categories to empty array', async () => {
      const json = JSON.stringify({
        items: [
          {
            name_ru: 'Хлеб',
            quantity: 1,
            price: 50,
            total: 50,
            category: 'Еда',
            // possible_categories intentionally omitted
          },
        ],
        currency: 'EUR',
      });
      mockFetchWithContent(json);

      const result = await extractExpensesFromReceipt('Receipt', [], undefined, 1);
      expect(Array.isArray(result.items[0]?.possible_categories)).toBe(true);
    });
  });

  describe('error paths', () => {
    it('throws when AI returns null content', async () => {
      mockFetchWithContent(null);

      await expect(extractExpensesFromReceipt('Receipt', [], undefined, 1)).rejects.toThrow();
    });

    it('throws when AI returns invalid JSON', async () => {
      mockFetchWithContent('this is not json at all');

      await expect(extractExpensesFromReceipt('Receipt', [], undefined, 1)).rejects.toThrow();
    });

    it('throws when items array is empty', async () => {
      mockFetchWithContent(JSON.stringify({ items: [], currency: 'EUR' }));

      await expect(extractExpensesFromReceipt('Receipt', [], undefined, 1)).rejects.toThrow();
    });

    it('throws when item is missing required fields', async () => {
      const badItem = JSON.stringify({
        items: [{ name_ru: 'Молоко' }], // missing quantity, price, total, category
        currency: 'EUR',
      });
      mockFetchWithContent(badItem);

      await expect(extractExpensesFromReceipt('Receipt', [], undefined, 1)).rejects.toThrow();
    });

    it('throws when network request fails', async () => {
      mockFetchWithError(new Error('network failure'));

      await expect(extractExpensesFromReceipt('Receipt', [], undefined, 1)).rejects.toThrow();
    });

    it('throws after all retries and models exhausted', async () => {
      mockFetchWithError(new Error('persistent failure'));

      try {
        await extractExpensesFromReceipt('Receipt', [], undefined, 1);
        throw new Error('should have thrown');
      } catch (err) {
        expect(err instanceof Error).toBe(true);
        if (err instanceof Error) {
          expect(err.message.length).toBeGreaterThan(0);
        }
      }
    });

    it('respects maxRetries — each model is tried the given number of times', async () => {
      let apiCallCount = 0;
      globalThis.fetch = mock(async (url: string | URL): Promise<Response> => {
        const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.href : String(url);
        if (urlStr.includes('/api/models/')) {
          const match = urlStr.match(/\/api\/models\/([^?]+)/);
          const modelId = match?.[1] ?? 'unknown/model';
          return makeProviderMappingResponse(providerForModel(modelId), modelId);
        }
        apiCallCount++;
        throw new Error('always fails');
      }) as unknown as typeof globalThis.fetch;

      await expect(extractExpensesFromReceipt('Receipt', [], undefined, 1)).rejects.toThrow();
      // 2 models × 1 retry each = 2 API calls
      expect(apiCallCount).toBe(2);
    });
  });
});
