# GLM-OCR KIE Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace expensive Qwen2.5-VL-72B raw-text OCR with GLM-OCR (0.9B) structured KIE extraction, and add a lightweight enrichment step for category assignment — cutting HF credits ~80x while improving accuracy.

**Architecture:** Vision model (GLM-OCR primary, Qwen fallback) extracts structured receipt items directly from image via KIE prompt. A separate DeepSeek call enriches items with Russian translations and categories. If enrichment fails, raw OCR items with default category are used — the user always sees something.

**Tech Stack:** `@huggingface/inference` (InferenceClient), `zai-org/GLM-OCR` (provider: `zai-org`), `Qwen/Qwen2.5-VL-72B-Instruct` (fallback), existing DeepSeek models for enrichment.

**Spec:** `docs/specs/2026-04-03-glm-ocr-kie-integration.md`

---

## File Structure

### Modified files
| File | Changes |
|------|---------|
| `src/services/receipt/ocr-extractor.ts` | Rewrite: new types, KIE extraction via `extractFromImage()`, remove URL-based approach |
| `src/services/receipt/ocr-extractor.test.ts` | Rewrite: tests for `extractFromImage()` with fallback chain |
| `src/services/receipt/ai-extractor.ts` | Add `enrichExtractedItems()` + `buildEnrichmentPrompt()` |
| `src/services/receipt/photo-processor.ts` | Update OCR calls: `extractFromImage` → `enrichExtractedItems` |
| `src/web/miniapp-api.ts` | Update `processOcrInBackground`: structured OCR + enrichment |

### New files
| File | Responsibility |
|------|---------------|
| `src/services/receipt/ai-extractor-enrichment.test.ts` | Tests for `enrichExtractedItems` (separate file for `mock.module` isolation) |

---

## Task 1: OCR Extractor Rewrite

**Files:**
- Rewrite: `src/services/receipt/ocr-extractor.ts`
- Rewrite: `src/services/receipt/ocr-extractor.test.ts`

The OCR extractor gets new types (`OcrReceiptItem`, `OcrExtractionResult`), a model fallback chain (`GLM-OCR` → `Qwen2.5-VL-72B`), and returns structured JSON items instead of raw text. Both old functions (`extractTextFromImageBuffer`, `extractTextFromImage`) are replaced by `extractFromImage()`.

- [ ] **Step 1.1: Write failing tests for extractFromImage**

```typescript
// src/services/receipt/ocr-extractor.test.ts

/** Tests for extractFromImage — structured KIE extraction with model fallback chain */
import { beforeEach, describe, expect, it, mock } from 'bun:test';

const logMock = {
  info: mock(() => {}),
  warn: mock(() => {}),
  error: mock(() => {}),
  debug: mock(() => {}),
};
mock.module('../../utils/logger', () => ({
  createLogger: () => logMock,
}));

let chatCompletionMock: ReturnType<typeof mock>;

mock.module('@huggingface/inference', () => ({
  InferenceClient: class {
    chatCompletion(...args: unknown[]) {
      return chatCompletionMock(...args);
    }
  },
}));

const { extractFromImage } = await import('./ocr-extractor');

describe('extractFromImage', () => {
  beforeEach(() => {
    logMock.info.mockClear();
    logMock.warn.mockClear();
    logMock.error.mockClear();
  });

  it('extracts structured items via GLM-OCR (primary model)', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ name: 'Молоко', quantity: 1, price: 89.99, total: 89.99 }],
                currency: 'RSD',
                store: 'Maxi',
              }),
            },
          },
        ],
      }),
    );

    const result = await extractFromImage(Buffer.from('fake-image'));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe('Молоко');
    expect(result.items[0]?.total).toBe(89.99);
    expect(result.currency).toBe('RSD');
    expect(result.store).toBe('Maxi');

    expect(chatCompletionMock).toHaveBeenCalledTimes(1);
    const callArgs = chatCompletionMock.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(callArgs.model).toBe('zai-org/GLM-OCR');
    expect(callArgs.provider).toBe('zai-org');
  });

  it('falls back to Qwen when GLM-OCR fails', async () => {
    let callCount = 0;
    chatCompletionMock = mock(() => {
      callCount++;
      if (callCount === 1) throw new Error('GLM-OCR unavailable');
      return Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ name: 'Хлеб', quantity: 2, price: 45, total: 90 }],
                currency: 'RSD',
              }),
            },
          },
        ],
      });
    });

    const result = await extractFromImage(Buffer.from('fake-image'));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe('Хлеб');
    expect(chatCompletionMock).toHaveBeenCalledTimes(2);
  });

  it('throws when all models fail', async () => {
    chatCompletionMock = mock(() => {
      throw new Error('Model failed');
    });
    await expect(extractFromImage(Buffer.from('fake-image'))).rejects.toThrow('All OCR models failed');
  });

  it('strips <think> blocks and code fences from response', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content:
                '<think>analyzing...</think>```json\n{"items": [{"name": "Сок", "quantity": 1, "price": 150, "total": 150}], "currency": "EUR"}\n```',
            },
          },
        ],
      }),
    );

    const result = await extractFromImage(Buffer.from('fake-image'));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe('Сок');
    expect(result.currency).toBe('EUR');
  });

  it('normalizes decimal commas (399,99 → 399.99)', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content:
                '{"items": [{"name": "Сыр", "quantity": 1, "price": 399,99, "total": 399,99}], "currency": "RSD"}',
            },
          },
        ],
      }),
    );

    const result = await extractFromImage(Buffer.from('fake-image'));
    expect(result.items[0]?.price).toBe(399.99);
    expect(result.items[0]?.total).toBe(399.99);
  });

  it('skips items missing required fields (name, total)', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [
                  { quantity: 1, price: 100 },
                  { name: 'Хлеб', quantity: 1, price: 45, total: 45 },
                ],
                currency: 'RSD',
              }),
            },
          },
        ],
      }),
    );

    const result = await extractFromImage(Buffer.from('fake-image'));
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.name).toBe('Хлеб');
  });

  it('defaults quantity to 1 when missing', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ name: 'Вода', price: 50, total: 50 }],
              }),
            },
          },
        ],
      }),
    );

    const result = await extractFromImage(Buffer.from('fake-image'));
    expect(result.items[0]?.quantity).toBe(1);
  });

  it('extracts optional fields (store, date, total)', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ name: 'Молоко', quantity: 1, price: 89.99, total: 89.99 }],
                store: 'Maxi',
                date: '03.04.2026',
                currency: 'RSD',
                total: 89.99,
              }),
            },
          },
        ],
      }),
    );

    const result = await extractFromImage(Buffer.from('fake-image'));
    expect(result.store).toBe('Maxi');
    expect(result.date).toBe('03.04.2026');
    expect(result.total).toBe(89.99);
  });

  it('throws when no items extracted (empty array)', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [{ message: { content: '{"items": []}' } }],
      }),
    );

    await expect(extractFromImage(Buffer.from('fake-image'))).rejects.toThrow('No items extracted');
  });

  it('throws when response is empty', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [{ message: { content: '' } }],
      }),
    );

    await expect(extractFromImage(Buffer.from('fake-image'))).rejects.toThrow();
  });

  it('does not log errors on success path', async () => {
    chatCompletionMock = mock(() =>
      Promise.resolve({
        choices: [
          {
            message: {
              content: JSON.stringify({
                items: [{ name: 'Вода', quantity: 1, price: 50, total: 50 }],
              }),
            },
          },
        ],
      }),
    );

    await extractFromImage(Buffer.from('fake-image'));
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `bun test src/services/receipt/ocr-extractor.test.ts`
Expected: FAIL — `extractFromImage` not exported

- [ ] **Step 1.3: Implement OCR extractor rewrite**

```typescript
// src/services/receipt/ocr-extractor.ts

/** OCR extractor — structured KIE extraction from receipt images via vision models */
import { mkdir, readdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { InferenceClient } from '@huggingface/inference';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('ocr-extractor');

const client = new InferenceClient(env.HF_TOKEN);

// ── Types ───────────────────────────────────────────────────────────────────

export interface OcrReceiptItem {
  name: string;
  quantity: number;
  price: number;
  total: number;
}

export interface OcrExtractionResult {
  items: OcrReceiptItem[];
  store?: string;
  date?: string;
  currency?: string;
  total?: number;
}

// ── Model Fallback Chain ────────────────────────────────────────────────────

const KIE_JSON_SCHEMA = `{"items": [{"name": "item name", "quantity": 1, "price": 100.00, "total": 100.00}], "store": "store name", "date": "DD.MM.YYYY", "currency": "RSD", "total": 1234.56}`;

const OCR_MODELS = [
  {
    model: 'zai-org/GLM-OCR',
    provider: 'zai-org' as string | undefined,
    name: 'GLM-OCR',
    systemPrompt: `Extract receipt items as JSON. Return ONLY valid JSON matching this schema:\n${KIE_JSON_SCHEMA}`,
    userPrompt: 'Extract all items from this receipt image.',
  },
  {
    model: 'Qwen/Qwen2.5-VL-72B-Instruct',
    provider: undefined as string | undefined,
    name: 'Qwen2.5-VL-72B',
    systemPrompt: undefined as string | undefined,
    userPrompt: `You are a receipt scanner. Look at this receipt image and extract all line items.\nReturn ONLY a valid JSON object with this exact structure:\n${KIE_JSON_SCHEMA}\nDo not include any text outside the JSON object. Do not wrap in markdown code fences.`,
  },
];

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Extract structured receipt items from image using vision models.
 * Tries GLM-OCR (0.9B KIE) first, falls back to Qwen2.5-VL-72B.
 */
export async function extractFromImage(imageBuffer: Buffer): Promise<OcrExtractionResult> {
  const dataUrl = `data:image/jpeg;base64,${imageBuffer.toString('base64')}`;
  let lastError: Error | null = null;

  for (const model of OCR_MODELS) {
    try {
      logger.info(`[OCR] Trying ${model.name} for structured extraction`);

      const messages: Array<{ role: string; content: unknown }> = [];

      if (model.systemPrompt) {
        messages.push({ role: 'system', content: model.systemPrompt });
      }

      messages.push({
        role: 'user',
        content: [
          { type: 'image_url', image_url: { url: dataUrl } },
          { type: 'text', text: model.userPrompt },
        ],
      });

      const response = await client.chatCompletion({
        provider: model.provider,
        model: model.model,
        messages,
        max_tokens: 4096,
        temperature: 0.1,
      });

      const content = response.choices[0]?.message?.content?.trim();
      if (!content) throw new Error(`Empty response from ${model.name}`);

      const result = parseOcrResponse(content);
      logger.info({ model: model.name, itemCount: result.items.length }, '[OCR] Structured extraction successful');
      return result;
    } catch (error) {
      lastError = error instanceof Error ? error : new Error(String(error));
      logger.warn({ err: lastError, model: model.name }, '[OCR] Model failed, trying next');
    }
  }

  throw new Error(`All OCR models failed: ${lastError?.message}`);
}

// ── Response Parser ─────────────────────────────────────────────────────────

/** Parse vision model response into structured OcrExtractionResult */
function parseOcrResponse(content: string): OcrExtractionResult {
  let cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/```(?:json)?\s*/g, '').replace(/\s*```/g, '');
  cleaned = cleaned.replace(/(\d),(\d)/g, '$1.$2');

  const parsed = JSON.parse(cleaned);

  const items: OcrReceiptItem[] = (parsed.items || [])
    .filter((item: Record<string, unknown>) => item.name && typeof item.total === 'number')
    .map((item: Record<string, unknown>) => ({
      name: String(item.name),
      quantity: Number(item.quantity) || 1,
      price: Number(item.price) || Number(item.total),
      total: Number(item.total),
    }));

  if (items.length === 0) throw new Error('No items extracted from receipt');

  return {
    items,
    store: typeof parsed.store === 'string' && parsed.store ? parsed.store : undefined,
    date: typeof parsed.date === 'string' && parsed.date ? parsed.date : undefined,
    currency: typeof parsed.currency === 'string' && parsed.currency ? parsed.currency : undefined,
    total: typeof parsed.total === 'number' ? parsed.total : undefined,
  };
}

// ── Legacy Cleanup ──────────────────────────────────────────────────────────

/**
 * Start periodic cleanup of old temp images.
 * Runs every 5 minutes and deletes files older than 5 minutes.
 */
export function startTempImageCleanup(): void {
  const CLEANUP_INTERVAL = 5 * 60 * 1000;
  const MAX_AGE = 5 * 60 * 1000;

  setInterval(async () => {
    try {
      const tempDir = path.join(process.cwd(), 'temp-images');

      let files: string[];
      try {
        files = await readdir(tempDir);
      } catch {
        return;
      }
      const now = Date.now();
      let deletedCount = 0;

      for (const file of files) {
        const filepath = path.join(tempDir, file);
        const stats = await stat(filepath);
        const age = now - stats.mtimeMs;

        if (age > MAX_AGE) {
          try {
            await unlink(filepath);
            deletedCount++;
          } catch (error) {
            logger.error({ err: error }, `[OCR_CLEANUP] Failed to delete old file ${file}`);
          }
        }
      }

      if (deletedCount > 0) {
        logger.info(`[OCR_CLEANUP] Deleted ${deletedCount} old temp image(s)`);
      }
    } catch (error) {
      logger.error({ err: error }, '[OCR_CLEANUP] Error during cleanup');
    }
  }, CLEANUP_INTERVAL);

  logger.info('[OCR_CLEANUP] Started periodic temp image cleanup (every 5 minutes)');
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `bun test src/services/receipt/ocr-extractor.test.ts`
Expected: All 11 tests PASS

- [ ] **Step 1.5: Commit**

```bash
git add src/services/receipt/ocr-extractor.ts src/services/receipt/ocr-extractor.test.ts
git commit -m "feat(receipt): rewrite OCR extractor with GLM-OCR KIE + Qwen fallback"
```

---

## Task 2: AI Enrichment Function

**Files:**
- Modify: `src/services/receipt/ai-extractor.ts`
- Create: `src/services/receipt/ai-extractor-enrichment.test.ts`

Add `enrichExtractedItems()` — takes structured OCR items, sends them to DeepSeek for Russian translation and category assignment. Much cheaper than full extraction (items already parsed). Graceful fallback: if DeepSeek fails, returns OCR items with `category: "Разное"`.

- [ ] **Step 2.1: Write failing tests for enrichExtractedItems**

```typescript
// src/services/receipt/ai-extractor-enrichment.test.ts

/** Tests for enrichExtractedItems — lightweight categorization of pre-extracted OCR items */
import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { OcrExtractionResult } from './ocr-extractor';

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
                  { name_ru: 'Молоко', name_original: 'Mleko', category: 'Еда', possible_categories: ['Напитки'] },
                  { name_ru: 'Белый хлеб', name_original: 'Hleb beli', category: 'Еда', possible_categories: [] },
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
  });

  it('falls back to first category when "Разное" not in list', async () => {
    chatCompletionMock = () => {
      throw new Error('fail');
    };

    const result = await enrichExtractedItems(sampleOcr, ['Еда', 'Транспорт']);
    expect(result.items[0]?.category).toBe('Еда');
  });

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
    expect(['Еда', 'Разное']).toContain(result.items[0]?.category);
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
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `bun test src/services/receipt/ai-extractor-enrichment.test.ts`
Expected: FAIL — `enrichExtractedItems` not exported

- [ ] **Step 2.3: Implement enrichExtractedItems**

Add these to `src/services/receipt/ai-extractor.ts`:

1. Add import at the top:
```typescript
import type { OcrExtractionResult } from './ocr-extractor';
```

2. Add `buildEnrichmentPrompt` function (before `enrichExtractedItems`):

```typescript
/** Build a lightweight prompt for categorizing pre-extracted OCR items */
function buildEnrichmentPrompt(
  ocrResult: OcrExtractionResult,
  existingCategories: string[],
  categoryExamples?: Map<string, CategoryExample[]>,
): string {
  const itemsList = ocrResult.items
    .map((item, i) => `${i + 1}. "${item.name}" — qty: ${item.quantity}, price: ${item.price}, total: ${item.total}`)
    .join('\n');

  let categorySection = `Available categories: ${existingCategories.join(', ')}`;
  if (categoryExamples && categoryExamples.size > 0) {
    const examples: string[] = [];
    for (const [cat, items] of categoryExamples) {
      const exList = items.slice(0, 3).map((e) => e.comment).join(', ');
      examples.push(`  ${cat}: ${exList}`);
    }
    categorySection += `\n\nCategory examples:\n${examples.join('\n')}`;
  }

  return `You have pre-extracted receipt items. Your tasks:
1. Translate each item name to Russian (name_ru)
2. Keep the original name (name_original)
3. Assign a category from the list below
4. Suggest 1-3 alternative categories (possible_categories)

${categorySection}

Receipt items:
${itemsList}
${ocrResult.store ? `\nStore: ${ocrResult.store}` : ''}${ocrResult.currency ? `\nCurrency: ${ocrResult.currency}` : ''}

Return ONLY valid JSON:
{"items": [{"name_ru": "Russian name", "name_original": "original", "category": "Category", "possible_categories": ["Alt1"]}]}

Rules:
- name_ru: Russian translation of the item name
- name_original: exact original name from receipt
- category: MUST be from the available categories list
- possible_categories: other fitting categories from the list (max 3, empty array if none)
- Return exactly ${ocrResult.items.length} items in the same order as input`;
}
```

3. Add `parseEnrichmentResponse` function:

```typescript
/** Parse DeepSeek enrichment response and merge with OCR data */
function parseEnrichmentResponse(
  content: string,
  ocrResult: OcrExtractionResult,
  existingCategories: string[],
): AIExtractionResult {
  let cleaned = content.replace(/<think>[\s\S]*?<\/think>/gi, '');
  cleaned = cleaned.replace(/```(?:json)?\s*/g, '').replace(/\s*```/g, '');

  const parsed = JSON.parse(cleaned);
  const enrichedItems: Array<Record<string, unknown>> = parsed.items || [];

  const items: AIReceiptItem[] = ocrResult.items.map((ocrItem, i) => {
    const enriched = enrichedItems[i] || {};
    const item: AIReceiptItem = {
      name_ru: typeof enriched.name_ru === 'string' ? enriched.name_ru : ocrItem.name,
      name_original: typeof enriched.name_original === 'string' ? enriched.name_original : ocrItem.name,
      quantity: ocrItem.quantity,
      price: ocrItem.price,
      total: ocrItem.total,
      category: typeof enriched.category === 'string' ? enriched.category : 'Разное',
      possible_categories: Array.isArray(enriched.possible_categories)
        ? enriched.possible_categories.filter((c): c is string => typeof c === 'string')
        : [],
    };

    validateItemCategory(item, existingCategories);
    return item;
  });

  return {
    items,
    currency: ocrResult.currency as CurrencyCode | undefined,
  };
}
```

4. Add `enrichExtractedItems` exported function:

```typescript
/**
 * Enrich pre-extracted OCR items with Russian translations and categories.
 * Uses DeepSeek models. If all fail, returns OCR items with default category "Разное".
 */
export async function enrichExtractedItems(
  ocrResult: OcrExtractionResult,
  existingCategories: string[],
  categoryExamples?: Map<string, CategoryExample[]>,
): Promise<AIExtractionResult> {
  const maxRetries = 3;
  const prompt = buildEnrichmentPrompt(ocrResult, existingCategories, categoryExamples);

  for (const modelConfig of MODELS) {
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(`[AI_ENRICH] Trying ${modelConfig.name} (attempt ${attempt}/${maxRetries})`);

        const response = await client.chatCompletion({
          provider: modelConfig.provider,
          model: modelConfig.model,
          messages: [
            { role: 'system', content: 'You categorize and translate receipt items. Return valid JSON only.' },
            { role: 'user', content: prompt },
          ],
          max_tokens: 4096,
          temperature: 0.3,
        });

        const content = response.choices[0]?.message?.content?.trim();
        if (!content) throw new Error('Empty enrichment response');

        const result = parseEnrichmentResponse(content, ocrResult, existingCategories);
        logger.info(`[AI_ENRICH] Successfully enriched ${result.items.length} items using ${modelConfig.name}`);
        return result;
      } catch (error) {
        logger.error(
          `[AI_ENRICH] Attempt ${attempt}/${maxRetries} failed (${modelConfig.name}): ${error instanceof Error ? error.message : error}`,
        );
        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }
  }

  // Graceful fallback: OCR items with default category
  logger.warn('[AI_ENRICH] All models failed, using raw OCR items with default category');
  const fallbackCategory =
    existingCategories.find((c) => c === 'Разное') || existingCategories[0] || 'Разное';
  return {
    items: ocrResult.items.map((item) => ({
      name_ru: item.name,
      name_original: item.name,
      quantity: item.quantity,
      price: item.price,
      total: item.total,
      category: fallbackCategory,
      possible_categories: [],
    })),
    currency: ocrResult.currency as CurrencyCode | undefined,
  };
}
```

- [ ] **Step 2.4: Run enrichment tests**

Run: `bun test src/services/receipt/ai-extractor-enrichment.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 2.5: Run existing AI extractor tests**

Run: `bun test src/services/receipt/ai-extractor.test.ts`
Expected: Existing tests still PASS

- [ ] **Step 2.6: Run streaming tests**

Run: `bun test src/services/receipt/ai-extractor-streaming.test.ts`
Expected: Existing tests still PASS

- [ ] **Step 2.7: Commit**

```bash
git add src/services/receipt/ai-extractor.ts src/services/receipt/ai-extractor-enrichment.test.ts
git commit -m "feat(receipt): add enrichExtractedItems for lightweight OCR item categorization"
```

---

## Task 3: Update Callers (photo-processor + miniapp-api)

**Files:**
- Modify: `src/services/receipt/photo-processor.ts`
- Modify: `src/web/miniapp-api.ts`

Update both OCR pipelines to use `extractFromImage` → `enrichExtractedItems` instead of raw text OCR → full AI extraction.

### photo-processor.ts changes

- [ ] **Step 3.1: Update photo-processor OCR calls**

In `src/services/receipt/photo-processor.ts`, find and replace all `extractTextFromImage` calls.

There are two places where OCR is called (both dynamic imports):
1. ~Line 170: OCR fallback when no QR found
2. ~Line 211: OCR fallback when QR fetch fails

Replace the import and call pattern. Change:
```typescript
const { extractTextFromImage } = await import('./ocr-extractor');
receiptData = await extractTextFromImage(photoBuffer);
```
To:
```typescript
const { extractFromImage } = await import('./ocr-extractor');
ocrResult = await extractFromImage(photoBuffer);
```

This requires refactoring the variable flow. Currently `receiptData: string` is used in both QR and OCR paths, then passed to `extractExpensesFromReceipt`. After the change:
- QR path: still uses `receiptData: string` → `extractExpensesFromReceipt(receiptData, ...)`
- OCR path: uses `ocrResult: OcrExtractionResult` → `enrichExtractedItems(ocrResult, ...)`

Read the full function to understand the control flow, then:

1. Add `OcrExtractionResult` type import
2. Add `enrichExtractedItems` import
3. Declare `let ocrResult: OcrExtractionResult | null = null` alongside existing `let receiptData: string`
4. In OCR branches, set `ocrResult` instead of `receiptData`
5. Before AI extraction (~line 240), add a branch:

```typescript
let extractionResult: AIExtractionResult;
try {
  if (ocrResult) {
    // OCR path: items already structured, just enrich with categories
    extractionResult = await enrichExtractedItems(ocrResult, categoryNames, categoryExamples);
  } else {
    // QR/HTML path: full text extraction needed
    extractionResult = await extractExpensesFromReceipt(receiptData, categoryNames, categoryExamples);
  }
} catch (error) {
  // ... existing error handling unchanged ...
}
```

### miniapp-api.ts changes

- [ ] **Step 3.2: Update miniapp-api imports**

In `src/web/miniapp-api.ts`, replace the import:
```typescript
// Old:
import { extractTextFromImageBuffer } from '../services/receipt/ocr-extractor';
// New:
import { extractFromImage } from '../services/receipt/ocr-extractor';
```

Add import:
```typescript
import { enrichExtractedItems, mapAiToScanItem } from '../services/receipt/ai-extractor';
```

Note: `mapAiToScanItem` should already be imported from the streaming scanner work. Verify and add if missing.

- [ ] **Step 3.3: Rewrite processOcrInBackground**

Replace the body of `processOcrInBackground` (~lines 978-1048). The new flow:

1. Compress image (unchanged)
2. `extractFromImage(compressedBuffer)` → structured items
3. Emit OCR items immediately as `item` events (with temporary category)
4. Upload to Telegram (unchanged)
5. `enrichExtractedItems(ocrResult, categoryNames)` → categorized items
6. Emit `done` with final enriched items

```typescript
async function processOcrInBackground(
  scanId: string,
  imageBuffer: Buffer,
  categoryNames: string[],
  telegramGroupId: number,
): Promise<void> {
  try {
    updateScan(scanId, { phase: 'processing' });

    // Compress image before OCR
    const compressedBuffer = await sharp(imageBuffer)
      .resize(1800, 1800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    // Structured OCR extraction
    const ocrResult = await extractFromImage(compressedBuffer);

    // Emit OCR items immediately (with temporary categories)
    const fallbackCategory = categoryNames.find((c) => c === 'Разное') || categoryNames[0] || 'Разное';
    for (const ocrItem of ocrResult.items) {
      const scanItem: import('./scan-store').ScanReceiptItem = {
        name: ocrItem.name,
        qty: ocrItem.quantity,
        price: ocrItem.price,
        total: ocrItem.total,
        category: fallbackCategory,
      };
      const state = getScan(scanId);
      if (state) state.items.push(scanItem);
      emitEvent(scanId, 'item', scanItem);
    }

    // Upload image to Telegram to get file_id
    let telegramFileId: string | null = null;
    try {
      const tgFormData = new FormData();
      tgFormData.append(
        'document',
        new File([compressedBuffer], 'receipt.jpg', { type: 'image/jpeg' }),
      );
      tgFormData.append('chat_id', String(telegramGroupId));

      const telegramResp = await fetch(
        `https://api.telegram.org/bot${env.BOT_TOKEN}/sendDocument`,
        { method: 'POST', body: tgFormData },
      );
      const tgResult = (await telegramResp.json()) as {
        ok: boolean;
        result?: { document?: { file_id: string } };
      };
      telegramFileId = tgResult.result?.document?.file_id ?? null;
    } catch (tgError) {
      logger.warn({ err: tgError }, '[OCR] Failed to upload receipt to Telegram, continuing without file_id');
    }

    // Enrich with categories via DeepSeek
    updateScan(scanId, { phase: 'extracting', fileId: telegramFileId });

    const enrichedResult = await enrichExtractedItems(ocrResult, categoryNames);
    const enrichedItems = enrichedResult.items.map(mapAiToScanItem);

    // Replace OCR items with enriched versions
    const state = getScan(scanId);
    if (state) state.items = enrichedItems;

    const ocrDonePatch: Partial<import('./scan-store').ScanState> = {
      phase: 'done',
      items: enrichedItems,
      fileId: telegramFileId,
    };
    if (enrichedResult.currency) ocrDonePatch.currency = enrichedResult.currency;
    updateScan(scanId, ocrDonePatch);
    emitEvent(scanId, 'done', {
      items: enrichedItems,
      currency: enrichedResult.currency,
      fileId: telegramFileId,
    });

    logger.info({ scanId, itemCount: enrichedItems.length }, 'OCR scan completed');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const errorCode = classifyScanError(err, 'extract');
    updateScan(scanId, { phase: 'error', error: message, errorCode });
    emitEvent(scanId, 'error', { message, code: errorCode });

    notifyScanFailure('OCR (KIE)', '[image]', err).catch((e) =>
      logger.warn({ err: e }, 'notifyScanFailure failed'),
    );
  }
}
```

- [ ] **Step 3.4: Remove unused import of streamExtractExpenses from miniapp-api (if only used in OCR path)**

Check if `streamExtractExpenses` is still used elsewhere in miniapp-api.ts (it is — in `processScanInBackground` for QR scans). If still used, keep the import. Only remove `extractTextFromImageBuffer` import.

- [ ] **Step 3.5: Run typecheck**

Run: `bun run type-check`
Expected: No type errors

- [ ] **Step 3.6: Run full test suite**

Run: `bun run test`
Expected: All tests PASS

- [ ] **Step 3.7: Commit**

```bash
git add src/services/receipt/photo-processor.ts src/web/miniapp-api.ts
git commit -m "feat(receipt): wire up GLM-OCR KIE extraction in photo-processor and miniapp"
```

---

## Task 4: Integration Verification

- [ ] **Step 4.1: Typecheck**

Run: `bun run type-check`

- [ ] **Step 4.2: Lint**

Run: `bun run lint:fix && bun run format`

- [ ] **Step 4.3: Full test suite**

Run: `bun run test`

- [ ] **Step 4.4: Knip**

Run: `bunx knip`
Check that old `extractTextFromImageBuffer` and `extractTextFromImage` don't show as used anywhere (they should be gone or unused).

- [ ] **Step 4.5: Build miniapp**

Run: `cd miniapp && node_modules/.bin/vite build`

- [ ] **Step 4.6: Final commit if needed**

```bash
git add -A && git commit -m "chore: lint and cleanup from GLM-OCR KIE integration"
```

---

## Summary

| Task | Files | Key Changes |
|------|-------|-------------|
| 1. OCR Extractor Rewrite | 2 rewritten | `extractFromImage()` with GLM-OCR → Qwen fallback, KIE JSON schema |
| 2. AI Enrichment | 1 modified, 1 new test | `enrichExtractedItems()` — translate + categorize, graceful fallback |
| 3. Update Callers | 2 modified | photo-processor + miniapp-api use new pipeline |
| 4. Verification | 0 | Typecheck, lint, test, knip, build |
