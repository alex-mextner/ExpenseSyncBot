/** Tests for enrichExtractedItems — lightweight categorization of pre-extracted OCR items */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

// OcrExtractionResult may not exist yet (Task 1 in parallel) — define locally
interface OcrReceiptItem {
  name: string;
  quantity: number;
  price: number;
  total: number;
}

interface OcrExtractionResult {
  items: OcrReceiptItem[];
  store?: string;
  date?: string;
  currency?: string;
  total?: number;
}

const logMock = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
};
mock.module('../../utils/logger', () => ({
  createLogger: () => logMock,
}));

mock.module('../../utils/fuzzy-search', () => ({
  findBestCategoryMatch: (cat: string, existing: string[]) => {
    const lower = cat.toLowerCase();
    return existing.find((c) => c.toLowerCase().includes(lower)) ?? null;
  },
}));

let chatCompletionCalls: unknown[] = [];
let chatCompletionMock: (...args: unknown[]) => unknown;

mock.module('@huggingface/inference', () => ({
  InferenceClient: class {
    chatCompletion(...args: unknown[]) {
      chatCompletionCalls.push(args);
      return chatCompletionMock(...args);
    }
    chatCompletionStream() {
      throw new Error('Should not be called');
    }
  },
}));

const { enrichExtractedItems } = await import('./ai-extractor');

const sampleOcr: OcrExtractionResult = {
  items: [
    { name: 'Mleko', quantity: 1, price: 89.99, total: 89.99 },
    { name: 'Hleb beli', quantity: 2, price: 45, total: 90 },
  ],
  currency: 'RSD',
  store: 'Maxi',
};

beforeEach(() => {
  chatCompletionCalls = [];
  logMock.info.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
});

describe('enrichExtractedItems', () => {
  it('translates names and assigns categories from DeepSeek response', async () => {
    chatCompletionMock = () =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  {
                    name_ru: 'Молоко',
                    name_original: 'Mleko',
                    category: 'Еда',
                    possible_categories: ['Напитки'],
                  },
                  {
                    name_ru: 'Белый хлеб',
                    name_original: 'Hleb beli',
                    category: 'Еда',
                    possible_categories: [],
                  },
                ],
              }),
            },
          },
        ],
      });

    const result = await enrichExtractedItems(sampleOcr, ['Еда', 'Напитки', 'Разное']);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.name_ru).toBe('Молоко');
    expect(result.items[0]?.name_original).toBe('Mleko');
    expect(result.items[0]?.category).toBe('Еда');
    expect(result.items[0]?.quantity).toBe(1);
    expect(result.items[0]?.total).toBe(89.99);
    expect(result.items[1]?.name_ru).toBe('Белый хлеб');
    expect(result.currency).toBe('RSD');
  });

  it('preserves OCR prices/quantities even if DeepSeek omits them', async () => {
    chatCompletionMock = () =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  { name_ru: 'Молоко', category: 'Еда' },
                  { name_ru: 'Хлеб', category: 'Еда' },
                ],
              }),
            },
          },
        ],
      });

    const result = await enrichExtractedItems(sampleOcr, ['Еда', 'Разное']);
    expect(result.items[0]?.price).toBe(89.99);
    expect(result.items[0]?.quantity).toBe(1);
    expect(result.items[1]?.price).toBe(45);
    expect(result.items[1]?.quantity).toBe(2);
  });

  // Full failure path: 2 models × 3 retries with backoff = ~6s total delay
  it('falls back to raw OCR items with "Разное" when all DeepSeek models fail', async () => {
    chatCompletionMock = () => {
      throw new Error('DeepSeek down');
    };

    const result = await enrichExtractedItems(sampleOcr, ['Еда', 'Разное']);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]?.name_ru).toBe('Mleko');
    expect(result.items[0]?.category).toBe('Разное');
    expect(result.items[0]?.total).toBe(89.99);
    expect(result.items[1]?.name_ru).toBe('Hleb beli');
    expect(result.currency).toBe('RSD');
    expect(logMock.warn).toHaveBeenCalled();
  }, 15_000);

  it('falls back to first category when "Разное" not in list', async () => {
    chatCompletionMock = () => {
      throw new Error('fail');
    };

    const result = await enrichExtractedItems(sampleOcr, ['Еда', 'Транспорт']);
    expect(result.items[0]?.category).toBe('Еда');
  }, 15_000);

  it('validates categories against existing list', async () => {
    chatCompletionMock = () =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  { name_ru: 'Молоко', category: 'Молочные продукты', possible_categories: [] },
                  { name_ru: 'Хлеб', category: 'Еда', possible_categories: [] },
                ],
              }),
            },
          },
        ],
      });

    const result = await enrichExtractedItems(sampleOcr, ['Еда', 'Разное']);
    // "Молочные продукты" not in list → validateItemCategory should fix it
    const firstItem = result.items[0];
    expect(firstItem).toBeDefined();
    expect(firstItem?.category === 'Еда' || firstItem?.category === 'Разное').toBe(true);
    expect(result.items[1]?.category).toBe('Еда');
  });

  it('retries on failure before giving up', async () => {
    let attempt = 0;
    chatCompletionMock = () => {
      attempt++;
      if (attempt <= 2) throw new Error('temporary failure');
      return Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  { name_ru: 'Молоко', category: 'Еда' },
                  { name_ru: 'Хлеб', category: 'Еда' },
                ],
              }),
            },
          },
        ],
      });
    };

    const result = await enrichExtractedItems(sampleOcr, ['Еда', 'Разное']);
    expect(result.items[0]?.name_ru).toBe('Молоко');
    expect(attempt).toBeGreaterThanOrEqual(3);
  });

  it('strips <think> blocks from enrichment response', async () => {
    chatCompletionMock = () =>
      Promise.resolve({
        choices: [
          {
            message: {
              content:
                '<think>Let me categorize these items</think>{"items": [{"name_ru": "Молоко", "category": "Еда"}, {"name_ru": "Хлеб", "category": "Еда"}]}',
            },
          },
        ],
      });

    const result = await enrichExtractedItems(sampleOcr, ['Еда', 'Разное']);
    expect(result.items[0]?.name_ru).toBe('Молоко');
  });
});
