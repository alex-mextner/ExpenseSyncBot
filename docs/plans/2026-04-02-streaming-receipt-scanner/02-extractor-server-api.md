# Streaming Receipt Scanner — Implementation Plan — Part 2/4: Tasks 4-5: streaming AI extractor, server endpoints

[← Back to index](../2026-04-02-streaming-receipt-scanner.md)

## Task 4: Streaming AI Extractor

**Files:**
- Modify: `src/services/receipt/ai-extractor.ts`
- Create: `src/services/receipt/ai-extractor-streaming.test.ts`

Add `streamExtractExpenses()` that uses `chatCompletionStream()` and emits items via `onItem` callback as they're parsed from the stream. Add `AbortSignal.timeout(30_000)` to both streaming and existing non-streaming function. Extract shared category validation into reusable helpers.

- [ ] **Step 4.1: Write failing tests for streamExtractExpenses**

Separate file to avoid `mock.module` conflicts with existing ai-extractor.test.ts:

```typescript
// src/services/receipt/ai-extractor-streaming.test.ts

/** Tests for streamExtractExpenses — streaming AI extraction with incremental item emission */
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { ScanReceiptItem } from '../../web/scan-store';

// Mock logger to prevent noise
const logMock = { info: mock(() => {}), warn: mock(() => {}), error: mock(() => {}), debug: mock(() => {}) };
mock.module('../../utils/logger', () => ({
  createLogger: () => logMock,
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
      return { choices: [{ message: { content: '{"items":[],"currency":"RSD"}' }, finish_reason: 'stop' }] };
    }
  },
}));

// Import AFTER mocks are set up
const { streamExtractExpenses } = await import('./ai-extractor');

beforeEach(() => {
  streamCalls = [];
});

describe('streamExtractExpenses', () => {
  it('calls onItem for each extracted item as they stream in', async () => {
    streamFactory = () =>
      makeStream([
        { choices: [{ delta: { content: '{"items": [{"name_ru": "Молоко", "quantity": 1, "price": 89.99, "total": 89.99, "category": "Еда", "possible_categories": ["Разное"]}' } }] },
        { choices: [{ delta: { content: ', {"name_ru": "Хлеб", "quantity": 2, "price": 45, "total": 90, "category": "Еда", "possible_categories": []}' } }] },
        { choices: [{ delta: { content: '], "currency": "RSD"}' } }] },
      ]);

    const receivedItems: ScanReceiptItem[] = [];
    const result = await streamExtractExpenses(
      'receipt text here',
      ['Еда', 'Разное'],
      (item) => receivedItems.push(item),
    );

    expect(receivedItems).toHaveLength(2);
    expect(receivedItems[0].name).toBe('Молоко');
    expect(receivedItems[0].qty).toBe(1);
    expect(receivedItems[1].name).toBe('Хлеб');

    expect(result.items).toHaveLength(2);
    expect(result.currency).toBe('RSD');
  });

  it('maps AIReceiptItem fields to ScanReceiptItem (name_ru→name, quantity→qty)', async () => {
    streamFactory = () =>
      makeStream([
        { choices: [{ delta: { content: '{"items": [{"name_ru": "Масло", "name_original": "Butter", "quantity": 3, "price": 100, "total": 300, "category": "Еда", "possible_categories": ["Разное"]}], "currency": "EUR"}' } }] },
      ]);

    let received: ScanReceiptItem | null = null;
    await streamExtractExpenses('text', ['Еда', 'Разное'], (item) => { received = item; });

    expect(received).not.toBeNull();
    expect(received!.name).toBe('Масло');
    expect(received!.qty).toBe(3);
    expect(received!).not.toHaveProperty('name_ru');
    expect(received!).not.toHaveProperty('quantity');
  });

  it('strips <think> blocks from streamed content', async () => {
    streamFactory = () =>
      makeStream([
        { choices: [{ delta: { content: '<think>Analyzing receipt...</think>' } }] },
        { choices: [{ delta: { content: '{"items": [{"name_ru": "Сок", "quantity": 1, "price": 150, "total": 150, "category": "Еда", "possible_categories": []}], "currency": "RSD"}' } }] },
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
        { choices: [{ delta: { content: '{"items": [{"name_ru": "Вода", "quantity": 1, "price": 50, "total": 50, "category": "Еда", "possible_categories": []}], "currency": "RSD"}' } }] },
      ]);
    };

    const result = await streamExtractExpenses('text', ['Еда'], () => {});
    expect(result.items).toHaveLength(1);
    expect(attemptCount).toBe(2);
  });

  it('validates categories against existing list', async () => {
    streamFactory = () =>
      makeStream([
        { choices: [{ delta: { content: '{"items": [{"name_ru": "Шуруп", "quantity": 1, "price": 30, "total": 30, "category": "Инструменты", "possible_categories": []}], "currency": "RSD"}' } }] },
      ]);

    let receivedCategory = '';
    await streamExtractExpenses('text', ['Еда', 'Разное'], (item) => { receivedCategory = item.category; });
    // "Инструменты" not in list → falls back to "Разное"
    expect(receivedCategory).toBe('Разное');
  });
});
```

- [ ] **Step 4.2: Run tests to verify they fail**

Run: `bun test src/services/receipt/ai-extractor-streaming.test.ts`
Expected: FAIL — `streamExtractExpenses` not exported

- [ ] **Step 4.3: Extract shared category validation helpers**

Refactor `src/services/receipt/ai-extractor.ts` — extract category validation from `extractExpensesFromReceipt` into reusable top-level functions:

```typescript
import { findBestCategoryMatch } from '../../utils/fuzzy-search';
```

Remove the dynamic `await import('../../utils/fuzzy-search')` from inside the loop. Add these helpers:

```typescript
/** Map AIReceiptItem → ScanReceiptItem (client-facing field names) */
export function mapAiToScanItem(aiItem: AIReceiptItem): ScanReceiptItem {
  return {
    name: aiItem.name_ru,
    qty: aiItem.quantity,
    price: aiItem.price,
    total: aiItem.total,
    category: aiItem.category,
  };
}

/** Validate and fix a single item's category against existing categories. Mutates aiItem.category. */
function validateItemCategory(aiItem: AIReceiptItem, existingCategories: string[]): void {
  if (existingCategories.length === 0) return;

  if (!existingCategories.includes(aiItem.category)) {
    const match = findBestCategoryMatch(aiItem.category, existingCategories);
    aiItem.category = match || existingCategories.find((c) => c === 'Разное') || existingCategories[0] || 'Разное';
  }

  if (aiItem.possible_categories?.length) {
    aiItem.possible_categories = aiItem.possible_categories.filter((cat) => existingCategories.includes(cat));
  }
}
```

Update existing `extractExpensesFromReceipt` to use `validateItemCategory` instead of inline logic (lines 291-333). Keep the `possible_categories` initialization check (lines 283-289) in the loop.

- [ ] **Step 4.4: Implement streamExtractExpenses**

Add to `src/services/receipt/ai-extractor.ts` after the existing function:

```typescript
import { StreamJsonParser } from './stream-json-parser';
import type { ScanReceiptItem } from '../../web/scan-store';

/**
 * Streaming AI extraction — emits items via onItem as they parse from the stream.
 * onItem receives client-facing ScanReceiptItem (name, qty — not name_ru, quantity).
 * Returns full AIExtractionResult when done.
 */
export async function streamExtractExpenses(
  receiptData: string,
  existingCategories: string[],
  onItem: (item: ScanReceiptItem) => void,
  options?: { maxRetries?: number; categoryExamples?: Map<string, CategoryExample[]> },
): Promise<AIExtractionResult> {
  const maxRetries = options?.maxRetries ?? 3;
  let lastError: Error | null = null;

  const isHTML = receiptData.includes('<html') || receiptData.includes('<!DOCTYPE');
  const text = isHTML ? extractTextFromHTML(receiptData) : receiptData;

  if (isHTML) {
    logger.info(`[AI_STREAM] Extracted text from HTML: ${receiptData.length} -> ${text.length} chars`);
  }

  const prompt = buildExtractionPrompt(text, existingCategories, options?.categoryExamples);

  for (const modelConfig of MODELS) {
    logger.info(`[AI_STREAM] Trying model: ${modelConfig.name}`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(
          `[AI_STREAM] Sending ${text.length} chars to ${modelConfig.name} (attempt ${attempt}/${maxRetries})`,
        );

        const parser = new StreamJsonParser();

        // AbortSignal with Promise.race fallback
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 30_000);

        try {
          const stream = client.chatCompletionStream({
            provider: modelConfig.provider,
            model: modelConfig.model,
            messages: [
              { role: 'system', content: 'You are a receipt parser. Extract items from receipts and return valid JSON only.' },
              { role: 'user', content: prompt },
            ],
            max_tokens: 8192,
            temperature: 0.3,
          });

          // Wrap in Promise.race for abort — HF client may not respect signal directly
          const iterateStream = async () => {
            for await (const chunk of stream) {
              if (controller.signal.aborted) throw new Error('Timeout: 30s exceeded');
              const content = chunk.choices?.[0]?.delta?.content;
              if (!content) continue;

              const newItems = parser.push(content);
              for (const aiItem of newItems) {
                validateItemCategory(aiItem, existingCategories);
                onItem(mapAiToScanItem(aiItem));
              }
            }
          };

          const abortPromise = new Promise<never>((_, reject) => {
            controller.signal.addEventListener('abort', () => reject(new Error('Timeout: 30s exceeded')));
          });

          await Promise.race([iterateStream(), abortPromise]);
        } finally {
          clearTimeout(timeout);
        }

        // Get final result
        const allAiItems = parser.getAllItems();
        if (allAiItems.length === 0) {
          throw new Error('Empty result: no items extracted from stream');
        }

        const currency = parser.getCurrency() as CurrencyCode | undefined;

        logger.info(
          `[AI_STREAM] Successfully extracted ${allAiItems.length} items using ${modelConfig.name}`,
        );

        const result: AIExtractionResult = { items: allAiItems };
        if (currency) result.currency = currency;
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown streaming error');
        logger.error(
          `[AI_STREAM] Stream failed on attempt ${attempt}/${maxRetries} (${modelConfig.name}): ${lastError.message}`,
        );

        if (attempt < maxRetries) {
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    logger.info(`[AI_STREAM] ${modelConfig.name} failed after ${maxRetries} attempts, trying next model...`);
  }

  throw new Error(`Failed to stream extract receipt data after trying all models: ${lastError?.message}`);
}
```

- [ ] **Step 4.5: Add AbortSignal timeout to existing extractExpensesFromReceipt**

In the existing function, wrap the `client.chatCompletion()` call (around line 185):

```typescript
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);
try {
  const response = await Promise.race([
    client.chatCompletion({
      provider: modelConfig.provider,
      model: modelConfig.model,
      messages: [
        { role: 'system', content: 'You are a receipt parser. Extract items from receipts and return valid JSON only.' },
        { role: 'user', content: prompt },
      ],
      max_tokens: 8192,
      temperature: 0.3,
    }),
    new Promise<never>((_, reject) => {
      controller.signal.addEventListener('abort', () => reject(new Error('Timeout: 30s exceeded')));
    }),
  ]);
  // ... rest of existing processing unchanged ...
} finally {
  clearTimeout(timeout);
}
```

- [ ] **Step 4.6: Run tests to verify they pass**

Run: `bun test src/services/receipt/ai-extractor-streaming.test.ts`
Expected: All 5 streaming tests PASS

Run: `bun test src/services/receipt/ai-extractor.test.ts`
Expected: Existing tests still PASS

- [ ] **Step 4.7: Run full test suite**

Run: `bun run test`
Expected: All tests PASS

- [ ] **Step 4.8: Commit**

```bash
git add src/services/receipt/ai-extractor.ts src/services/receipt/ai-extractor-streaming.test.ts
git commit -m "feat(receipt): add streaming AI extractor with 30s timeout"
```

---

## Task 5: Server API Endpoints

**Files:**
- Modify: `src/web/miniapp-api.ts`
- Modify or create: `src/web/miniapp-api.test.ts`

Replace sync `POST /api/receipt/scan` and `POST /api/receipt/ocr` with async 202 + background processing. Add SSE stream, poll, and categories endpoints. Implement distinct error codes from spec: `SCAN_FAILED`, `FETCH_FAILED`, `CREDITS_EXHAUSTED`.

- [ ] **Step 5.1: Write tests for new endpoints**

Add to existing `src/web/miniapp-api.test.ts`. Read the existing test setup first to match mock patterns.

Tests to cover:
- `POST /api/receipt/scan` returns 202 with scanId
- `POST /api/receipt/ocr` returns 202 with scanId
- `GET /api/receipt/scan/:scanId` returns current state
- `GET /api/receipt/scan/:scanId` returns 404 for unknown ID
- `GET /api/receipt/scan/:scanId` returns 403 for wrong group
- `GET /api/receipt/scan/:scanId/stream` returns SSE with correct headers
- `GET /api/receipt/scan/:scanId/stream` replays existing items
- `GET /api/categories?groupId=X` returns category names array

- [ ] **Step 5.2: Run tests to verify they fail**

Run: `bun test src/web/miniapp-api.test.ts`
Expected: New tests FAIL

- [ ] **Step 5.3: Add imports to miniapp-api.ts**

```typescript
import { createScan, getScan, updateScan, emitEvent, subscribe } from './scan-store';
import { streamExtractExpenses } from '../services/receipt/ai-extractor';
import { shortenReceiptUrl } from '../services/receipt/url-shortener';
```

- [ ] **Step 5.4: Replace POST /api/receipt/scan**

Replace lines 226-293 (the sync scan endpoint). Keep validation logic, change response to 202 + scanId:

```typescript
if (url.pathname === '/api/receipt/scan' && req.method === 'POST') {
  // ... existing groupId and body and qr validation unchanged ...

  const ctx = await validateAndResolveContext(req, corsOrigin, telegramGroupId);
  if (!ctx.ok) return ctx.response;

  const scanId = createScan(ctx.internalGroupId, telegramGroupId);
  const categoryNames = database.categories
    .findByGroupId(ctx.internalGroupId)
    .map((c) => c.name);

  logger.info({ userId: ctx.userId, groupId: telegramGroupId, scanId }, 'Async receipt scan started');

  processScanInBackground(scanId, qr as string, categoryNames).catch((e) =>
    logger.error({ err: e, scanId }, 'Background scan processing crashed'),
  );

  return new Response(JSON.stringify({ scanId }), {
    status: 202,
    headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders },
  });
}
```

- [ ] **Step 5.5: Implement processScanInBackground**

```typescript
/** Detect error code from error type */
function classifyScanError(err: unknown, source: 'fetch' | 'extract'): string {
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  if (source === 'fetch') return 'FETCH_FAILED';
  if (msg.includes('402') || msg.includes('credit') || msg.includes('billing') || msg.includes('payment')) {
    return 'CREDITS_EXHAUSTED';
  }
  return 'SCAN_FAILED';
}

async function processScanInBackground(
  scanId: string,
  qr: string,
  categoryNames: string[],
): Promise<void> {
  try {
    updateScan(scanId, { phase: 'fetching' });

    let html: string;
    try {
      html = await fetchReceiptData(qr);
    } catch (fetchErr) {
      const message = fetchErr instanceof Error ? fetchErr.message : 'Failed to fetch receipt';
      updateScan(scanId, { phase: 'error', error: message, errorCode: 'FETCH_FAILED' });
      emitEvent(scanId, 'error', { message, code: 'FETCH_FAILED' });
      notifyScanFailure('QR scan (fetch)', qr, fetchErr).catch((e) =>
        logger.warn({ err: e }, 'notifyScanFailure failed'),
      );
      return;
    }

    const shortUrl = shortenReceiptUrl(qr);
    updateScan(scanId, { phase: 'extracting', url: shortUrl, rawUrl: qr });
    emitEvent(scanId, 'url', { url: shortUrl, raw: qr });

    const result = await streamExtractExpenses(
      html,
      categoryNames,
      (item) => {
        const state = getScan(scanId);
        if (state) state.items.push(item);
        emitEvent(scanId, 'item', item);
      },
    );

    const state = getScan(scanId);
    const allItems = state?.items ?? [];
    updateScan(scanId, { phase: 'done', items: allItems, currency: result.currency });
    emitEvent(scanId, 'done', { items: allItems, currency: result.currency });

    logger.info({ scanId, itemCount: allItems.length }, 'Scan completed');
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const errorCode = classifyScanError(err, 'extract');
    updateScan(scanId, { phase: 'error', error: message, errorCode });
    emitEvent(scanId, 'error', { message, code: errorCode });

    notifyScanFailure('QR scan (streaming)', qr, err).catch((e) =>
      logger.warn({ err: e }, 'notifyScanFailure failed'),
    );
  }
}
```

- [ ] **Step 5.6: Replace POST /api/receipt/ocr similarly**

Return 202 + scanId. Background:

```typescript
async function processOcrInBackground(
  scanId: string,
  imageBuffer: Buffer,
  categoryNames: string[],
  bot: unknown,
  groupTelegramId: number,
): Promise<void> {
  try {
    updateScan(scanId, { phase: 'processing' });

    const compressed = await sharp(imageBuffer)
      .resize(1800, 1800, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 85 })
      .toBuffer();

    const text = await extractTextFromImageBuffer(compressed);

    let telegramFileId: string | null = null;
    try {
      // ... existing Telegram upload logic from current OCR endpoint ...
    } catch (uploadErr) {
      logger.warn({ err: uploadErr, scanId }, 'Failed to upload receipt to Telegram');
    }

    updateScan(scanId, { phase: 'extracting', fileId: telegramFileId });

    const result = await streamExtractExpenses(
      text,
      categoryNames,
      (item) => {
        const state = getScan(scanId);
        if (state) state.items.push(item);
        emitEvent(scanId, 'item', item);
      },
    );

    const state = getScan(scanId);
    const allItems = state?.items ?? [];
    updateScan(scanId, {
      phase: 'done',
      items: allItems,
      currency: result.currency,
      fileId: telegramFileId,
    });
    emitEvent(scanId, 'done', { items: allItems, currency: result.currency, fileId: telegramFileId });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    const errorCode = classifyScanError(err, 'extract');
    updateScan(scanId, { phase: 'error', error: message, errorCode });
    emitEvent(scanId, 'error', { message, code: errorCode });

    notifyScanFailure('OCR (streaming)', '[image]', err).catch((e) =>
      logger.warn({ err: e }, 'notifyScanFailure failed'),
    );
  }
}
```

- [ ] **Step 5.7: Add GET /api/receipt/scan/:scanId/stream (SSE endpoint)**

Place before the 404 fallback. Uses `scanState.telegramGroupId` for auth — no DB lookup needed:

```typescript
const streamMatch = url.pathname.match(/^\/api\/receipt\/scan\/([^/]+)\/stream$/);
if (streamMatch && req.method === 'GET') {
  const scanId = streamMatch[1];
  const state = getScan(scanId);
  if (!state) return errorResponse(404, 'Scan not found', 'NOT_FOUND', corsHeaders);

  // Auth via initData query param (same pattern as dashboard SSE)
  const initData = url.searchParams.get('initData') ?? '';
  const syntheticReq = new Request(req.url, {
    headers: { ...Object.fromEntries(req.headers), 'X-Telegram-Init-Data': initData },
  });

  const ctx = await validateAndResolveContext(syntheticReq, corsOrigin, state.telegramGroupId);
  if (!ctx.ok) return ctx.response;
  if (ctx.internalGroupId !== state.groupId) {
    return errorResponse(403, 'Forbidden', 'FORBIDDEN_GROUP', corsHeaders);
  }

  const sseHeaders = {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    ...ctx.corsHeaders,
  };

  let unsub: (() => void) | null = null;
  let pingInterval: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const encoder = new TextEncoder();
      const send = (msg: string) => {
        try { controller.enqueue(encoder.encode(msg)); } catch { /* closed */ }
      };

      unsub = subscribe(scanId, send);
      if (!unsub) {
        send('event: error\ndata: {"message":"Too many connections","code":"TOO_MANY_SUBSCRIBERS"}\n\n');
        controller.close();
        return;
      }

      // Replay current state
      if (state.url) {
        send(`event: url\ndata: ${JSON.stringify({ url: state.url, raw: state.rawUrl })}\n\n`);
      }
      for (const item of state.items) {
        send(`event: item\ndata: ${JSON.stringify(item)}\n\n`);
      }
      if (state.phase === 'done') {
        send(`event: done\ndata: ${JSON.stringify({ items: state.items, currency: state.currency, fileId: state.fileId })}\n\n`);
      }
      if (state.phase === 'error') {
        send(`event: error\ndata: ${JSON.stringify({ message: state.error, code: state.errorCode })}\n\n`);
      }

      pingInterval = setInterval(() => send('event: ping\ndata: {}\n\n'), 15_000);
    },
    cancel() {
      if (unsub) unsub();
      if (pingInterval) clearInterval(pingInterval);
    },
  });

  return new Response(stream, { status: 200, headers: sseHeaders });
}
```

- [ ] **Step 5.8: Add GET /api/receipt/scan/:scanId (poll endpoint)**

```typescript
const pollMatch = url.pathname.match(/^\/api\/receipt\/scan\/([^/]+)$/);
if (pollMatch && req.method === 'GET') {
  const scanId = pollMatch[1];
  const state = getScan(scanId);
  if (!state) return errorResponse(404, 'Scan not found or expired', 'NOT_FOUND', corsHeaders);

  const initData = url.searchParams.get('initData') ?? '';
  const syntheticReq = new Request(req.url, {
    headers: { ...Object.fromEntries(req.headers), 'X-Telegram-Init-Data': initData },
  });

  const ctx = await validateAndResolveContext(syntheticReq, corsOrigin, state.telegramGroupId);
  if (!ctx.ok) return ctx.response;
  if (ctx.internalGroupId !== state.groupId) {
    return errorResponse(403, 'Forbidden', 'FORBIDDEN_GROUP', corsHeaders);
  }

  return new Response(
    JSON.stringify({
      phase: state.phase,
      url: state.url ?? null,
      items: state.items,
      currency: state.currency ?? null,
      fileId: state.fileId ?? null,
      error: state.error ?? null,
      errorCode: state.errorCode ?? null,
    }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders } },
  );
}
```

- [ ] **Step 5.9: Add GET /api/categories endpoint**

```typescript
if (url.pathname === '/api/categories' && req.method === 'GET') {
  const groupIdParam = url.searchParams.get('groupId');
  const telegramGroupId = groupIdParam ? parseInt(groupIdParam, 10) : Number.NaN;
  if (Number.isNaN(telegramGroupId)) {
    return errorResponse(400, 'Missing or invalid groupId', 'BAD_REQUEST', corsHeaders);
  }

  const ctx = await validateAndResolveContext(req, corsOrigin, telegramGroupId);
  if (!ctx.ok) return ctx.response;

  const categories = database.categories
    .findByGroupId(ctx.internalGroupId)
    .map((c) => c.name);

  return new Response(
    JSON.stringify({ categories }),
    { status: 200, headers: { 'Content-Type': 'application/json', ...ctx.corsHeaders } },
  );
}
```

- [ ] **Step 5.10: Run tests**

Run: `bun run test`
Expected: All tests PASS

- [ ] **Step 5.11: Commit**

```bash
git add src/web/miniapp-api.ts src/web/miniapp-api.test.ts
git commit -m "feat(web): async scan/ocr endpoints with SSE streaming + categories API"
```

---

