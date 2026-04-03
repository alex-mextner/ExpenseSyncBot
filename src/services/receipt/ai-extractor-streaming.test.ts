/** Tests for streamExtractExpenses — streaming AI extraction with incremental item emission */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { ScanReceiptItem } from '../../web/scan-store';

// Mock logger to prevent noise
const logMock = createMockLogger();
mock.module('../../utils/logger', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// Mock fuzzy-search (sync import)
mock.module('../../utils/fuzzy-search', () => ({
  findBestCategoryMatch: (cat: string, existing: string[]) => {
    const lower = cat.toLowerCase();
    return existing.find((c) => c.toLowerCase().includes(lower)) ?? null;
  },
}));

/** Helper: create an async iterable that yields chunks for chatCompletionStream */
async function* makeStream(chunks: Array<{ choices: Array<{ delta: { content: string } }> }>) {
  for (const chunk of chunks) yield chunk;
}

// Track chatCompletionStream calls for assertions
let streamCalls: unknown[] = [];
let streamFactory: () => AsyncGenerator<unknown>;

mock.module('@huggingface/inference', () => ({
  InferenceClient: class {
    chatCompletionStream(args: unknown) {
      streamCalls.push(args);
      return streamFactory();
    }
    async chatCompletion() {
      return {
        choices: [{ message: { content: '{"items":[],"currency":"RSD"}' }, finish_reason: 'stop' }],
      };
    }
  },
}));

// Import AFTER mocks are set up
const { streamExtractExpenses } = await import('./ai-extractor');

const originalSetTimeout = globalThis.setTimeout;

beforeEach(() => {
  // Make retry backoff instant but preserve large timeouts (e.g. 30s abort controller)
  globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) => {
    if (ms !== undefined && ms < 10_000) {
      fn();
      return 0;
    }
    return originalSetTimeout(fn as Parameters<typeof originalSetTimeout>[0], ms, ...args);
  }) as unknown as typeof setTimeout;
  streamCalls = [];
});

afterEach(() => {
  globalThis.setTimeout = originalSetTimeout;
});

describe('streamExtractExpenses', () => {
  it('calls onItem for each extracted item as they stream in', async () => {
    streamFactory = () =>
      makeStream([
        {
          choices: [
            {
              delta: {
                content:
                  '{"items": [{"name_ru": "Молоко", "quantity": 1, "price": 89.99, "total": 89.99, "category": "Еда", "possible_categories": ["Разное"]}',
              },
            },
          ],
        },
        {
          choices: [
            {
              delta: {
                content:
                  ', {"name_ru": "Хлеб", "quantity": 2, "price": 45, "total": 90, "category": "Еда", "possible_categories": []}',
              },
            },
          ],
        },
        { choices: [{ delta: { content: '], "currency": "RSD"}' } }] },
      ]);

    const receivedItems: ScanReceiptItem[] = [];
    const result = await streamExtractExpenses('receipt text here', ['Еда', 'Разное'], (item) =>
      receivedItems.push(item),
    );

    expect(receivedItems).toHaveLength(2);
    expect(receivedItems[0]?.name).toBe('Молоко');
    expect(receivedItems[0]?.qty).toBe(1);
    expect(receivedItems[1]?.name).toBe('Хлеб');

    expect(result.items).toHaveLength(2);
    expect(result.currency).toBe('RSD');
  });

  it('maps AIReceiptItem fields to ScanReceiptItem (name_ru->name, quantity->qty)', async () => {
    streamFactory = () =>
      makeStream([
        {
          choices: [
            {
              delta: {
                content:
                  '{"items": [{"name_ru": "Масло", "name_original": "Butter", "quantity": 3, "price": 100, "total": 300, "category": "Еда", "possible_categories": ["Разное"]}], "currency": "EUR"}',
              },
            },
          ],
        },
      ]);

    const received: ScanReceiptItem[] = [];
    await streamExtractExpenses('text', ['Еда', 'Разное'], (item) => {
      received.push(item);
    });

    expect(received).toHaveLength(1);
    expect(received[0]?.name).toBe('Масло');
    expect(received[0]?.qty).toBe(3);
    expect(received[0]).not.toHaveProperty('name_ru');
    expect(received[0]).not.toHaveProperty('quantity');
  });

  it('strips <think> blocks from streamed content', async () => {
    streamFactory = () =>
      makeStream([
        { choices: [{ delta: { content: '<think>Analyzing receipt...</think>' } }] },
        {
          choices: [
            {
              delta: {
                content:
                  '{"items": [{"name_ru": "Сок", "quantity": 1, "price": 150, "total": 150, "category": "Еда", "possible_categories": []}], "currency": "RSD"}',
              },
            },
          ],
        },
      ]);

    const names: string[] = [];
    await streamExtractExpenses('text', ['Еда'], (item) => names.push(item.name));
    expect(names).toEqual(['Сок']);
  });

  it('retries on error with exponential backoff', async () => {
    let attemptCount = 0;
    streamFactory = () => {
      attemptCount++;
      if (attemptCount === 1) throw new Error('Provider timeout');
      return makeStream([
        {
          choices: [
            {
              delta: {
                content:
                  '{"items": [{"name_ru": "Вода", "quantity": 1, "price": 50, "total": 50, "category": "Еда", "possible_categories": []}], "currency": "RSD"}',
              },
            },
          ],
        },
      ]);
    };

    const result = await streamExtractExpenses('text', ['Еда'], () => {});
    expect(result.items).toHaveLength(1);
    expect(attemptCount).toBe(2);
  });

  it('validates categories against existing list', async () => {
    streamFactory = () =>
      makeStream([
        {
          choices: [
            {
              delta: {
                content:
                  '{"items": [{"name_ru": "Шуруп", "quantity": 1, "price": 30, "total": 30, "category": "Инструменты", "possible_categories": []}], "currency": "RSD"}',
              },
            },
          ],
        },
      ]);

    let receivedCategory = '';
    await streamExtractExpenses('text', ['Еда', 'Разное'], (item) => {
      receivedCategory = item.category;
    });
    // "Инструменты" not in list -> falls back to "Разное"
    expect(receivedCategory).toBe('Разное');
  });
});
