# Streaming Receipt Scanner — Implementation Plan — Part 1/4: File structure, Tasks 1-3: stream parser, URL shortener, scan store

[← Back to index](../2026-04-02-streaming-receipt-scanner.md)

## File Structure

### New files (server)
| File | Responsibility |
|------|---------------|
| `src/web/scan-store.ts` | In-memory `Map<scanId, ScanState>`, SSE pub/sub, TTL cleanup |
| `src/web/scan-store.test.ts` | Tests for scan store |
| `src/services/receipt/stream-json-parser.ts` | Extracts complete `AIReceiptItem` objects from growing JSON buffer |
| `src/services/receipt/stream-json-parser.test.ts` | Tests for parser edge cases |
| `src/services/receipt/url-shortener.ts` | `shortenReceiptUrl(url)` — truncate receipt URLs for display |
| `src/services/receipt/url-shortener.test.ts` | Tests for URL shortener |
| `src/services/receipt/ai-extractor-streaming.test.ts` | Tests for `streamExtractExpenses` (separate file to isolate `mock.module`) |

### Modified files (server)
| File | Changes |
|------|---------|
| `src/services/receipt/ai-extractor.ts` | Add `streamExtractExpenses()`, add AbortSignal timeout to existing `extractExpensesFromReceipt()`, extract shared helpers |
| `src/web/miniapp-api.ts` | Replace sync scan/ocr endpoints → async 202 + background processing; add SSE stream endpoint; add poll endpoint; add `GET /api/categories` |

### New files (client)
| File | Responsibility |
|------|---------------|
| `miniapp/src/api/receipt-stream.ts` | `startScan`, `startOcr`, `streamScan`, `pollScan`, `fetchCategories` functions |

### Modified files (client)
| File | Changes |
|------|---------|
| `miniapp/src/tabs/Scanner.tsx` | Replace `loading` phase with `streaming`; progressive item rendering; scan line animation for OCR; session recovery with scanId; global font-family fix; category combobox in confirm phase |
| `miniapp/src/api/receipt.ts` | Keep `confirmExpenses` and types; remove `scanQR` and `uploadOCR` (moved to receipt-stream.ts) |
| `miniapp/index.html` | Add global font-family style |

---

## Task 1: Stream JSON Parser

**Files:**
- Create: `src/services/receipt/stream-json-parser.ts`
- Create: `src/services/receipt/stream-json-parser.test.ts`

The parser extracts complete `AIReceiptItem` objects from a growing JSON string buffer as tokens arrive from the AI streaming response. It handles `<think>` blocks, markdown fences, string escapes, and decimal comma→dot normalization.

- [ ] **Step 1.1: Write failing tests for StreamJsonParser**

```typescript
// src/services/receipt/stream-json-parser.test.ts

/** Tests for StreamJsonParser — incremental JSON item extraction from AI streaming responses */
import { describe, expect, it } from 'bun:test';
import { StreamJsonParser } from './stream-json-parser';

describe('StreamJsonParser', () => {
  it('extracts complete items from a full JSON response', () => {
    const parser = new StreamJsonParser();
    const items = parser.push(`{"items": [
      {"name_ru": "Молоко", "quantity": 1, "price": 89.99, "total": 89.99, "category": "Еда"},
      {"name_ru": "Хлеб", "quantity": 2, "price": 45, "total": 90, "category": "Еда"}
    ], "currency": "RSD"}`);
    expect(items).toHaveLength(2);
    expect(items[0].name_ru).toBe('Молоко');
    expect(items[1].name_ru).toBe('Хлеб');
  });

  it('emits items incrementally as they complete', () => {
    const parser = new StreamJsonParser();
    const batch1 = parser.push('{"items": [{"name_ru": "Молоко", "quantity": 1, "price": 89.99, "total": 89.99, "category": "Еда"}');
    expect(batch1).toHaveLength(1);
    expect(batch1[0].name_ru).toBe('Молоко');

    const batch2 = parser.push(', {"name_ru": "Хлеб", "quantity": 2, "price": 45, "total": 90, "category": "Еда"}');
    expect(batch2).toHaveLength(1);
    expect(batch2[0].name_ru).toBe('Хлеб');

    expect(parser.getAllItems()).toHaveLength(2);
  });

  it('handles <think> blocks by stripping them', () => {
    const parser = new StreamJsonParser();
    const items = parser.push('<think>Let me analyze this receipt...</think>{"items": [{"name_ru": "Сок", "quantity": 1, "price": 150, "total": 150, "category": "Еда"}]}');
    expect(items).toHaveLength(1);
    expect(items[0].name_ru).toBe('Сок');
  });

  it('handles partial <think> block across chunks', () => {
    const parser = new StreamJsonParser();
    const batch1 = parser.push('<think>Analyzing the receipt');
    expect(batch1).toHaveLength(0);

    const batch2 = parser.push('</think>{"items": [{"name_ru": "Вода", "quantity": 1, "price": 50, "total": 50, "category": "Еда"}]}');
    expect(batch2).toHaveLength(1);
    expect(batch2[0].name_ru).toBe('Вода');
  });

  it('strips markdown code fences', () => {
    const parser = new StreamJsonParser();
    const items = parser.push('```json\n{"items": [{"name_ru": "Масло", "quantity": 1, "price": 200, "total": 200, "category": "Еда"}]}\n```');
    expect(items).toHaveLength(1);
    expect(items[0].name_ru).toBe('Масло');
  });

  it('fixes decimal comma separators (399,99 → 399.99)', () => {
    const parser = new StreamJsonParser();
    const items = parser.push('{"items": [{"name_ru": "Сыр", "quantity": 1, "price": 399,99, "total": 399,99, "category": "Еда"}]}');
    expect(items).toHaveLength(1);
    expect(items[0].price).toBe(399.99);
    expect(items[0].total).toBe(399.99);
  });

  it('handles escaped quotes inside strings', () => {
    const parser = new StreamJsonParser();
    const items = parser.push('{"items": [{"name_ru": "Торт \\"Наполеон\\"", "quantity": 1, "price": 500, "total": 500, "category": "Еда"}]}');
    expect(items).toHaveLength(1);
    expect(items[0].name_ru).toBe('Торт "Наполеон"');
  });

  it('handles braces inside string values', () => {
    const parser = new StreamJsonParser();
    const items = parser.push('{"items": [{"name_ru": "Набор {маленький}", "quantity": 1, "price": 100, "total": 100, "category": "Разное"}]}');
    expect(items).toHaveLength(1);
    expect(items[0].name_ru).toBe('Набор {маленький}');
  });

  it('skips items missing required fields (name_ru, total)', () => {
    const parser = new StreamJsonParser();
    const items = parser.push('{"items": [{"quantity": 1, "price": 100}, {"name_ru": "Хлеб", "quantity": 1, "price": 45, "total": 45, "category": "Еда"}]}');
    expect(items).toHaveLength(1);
    expect(items[0].name_ru).toBe('Хлеб');
  });

  it('handles truncated response (no closing bracket)', () => {
    const parser = new StreamJsonParser();
    const batch1 = parser.push('{"items": [{"name_ru": "Яблоко", "quantity": 1, "price": 60, "total": 60, "category": "Еда"}, {"name_ru": "Груша');
    expect(batch1).toHaveLength(1);
    expect(batch1[0].name_ru).toBe('Яблоко');
    expect(parser.getAllItems()).toHaveLength(1);
  });

  it('returns empty array when no items found', () => {
    const parser = new StreamJsonParser();
    const items = parser.push('Some random text without JSON');
    expect(items).toHaveLength(0);
  });

  it('handles multiple <think> blocks', () => {
    const parser = new StreamJsonParser();
    const items = parser.push('<think>First thought</think><think>Second thought</think>{"items": [{"name_ru": "Чай", "quantity": 1, "price": 80, "total": 80, "category": "Еда"}]}');
    expect(items).toHaveLength(1);
  });

  it('extracts currency from response', () => {
    const parser = new StreamJsonParser();
    parser.push('{"items": [{"name_ru": "Вода", "quantity": 1, "price": 50, "total": 50, "category": "Еда"}], "currency": "RSD"}');
    expect(parser.getCurrency()).toBe('RSD');
  });

  it('returns undefined currency when not present', () => {
    const parser = new StreamJsonParser();
    parser.push('{"items": [{"name_ru": "Вода", "quantity": 1, "price": 50, "total": 50, "category": "Еда"}]}');
    expect(parser.getCurrency()).toBeUndefined();
  });

  it('extracts currency that appears in later chunk', () => {
    const parser = new StreamJsonParser();
    parser.push('{"items": [{"name_ru": "Вода", "quantity": 1, "price": 50, "total": 50, "category": "Еда"}]');
    expect(parser.getCurrency()).toBeUndefined();
    parser.push(', "currency": "EUR"}');
    expect(parser.getCurrency()).toBe('EUR');
  });
});
```

- [ ] **Step 1.2: Run tests to verify they fail**

Run: `bun test src/services/receipt/stream-json-parser.test.ts`
Expected: FAIL — module `./stream-json-parser` not found

- [ ] **Step 1.3: Implement StreamJsonParser**

```typescript
// src/services/receipt/stream-json-parser.ts

/** Incremental JSON parser that extracts complete AIReceiptItem objects from a growing AI response buffer */

import type { AIReceiptItem } from './ai-extractor';

export class StreamJsonParser {
  private buffer = '';
  private emittedCount = 0;

  /** Append new tokens from the AI stream, returns any newly completed items */
  push(chunk: string): AIReceiptItem[] {
    this.buffer += chunk;

    // Strip completed <think>...</think> blocks
    this.buffer = this.buffer.replace(/<think>[\s\S]*?<\/think>/gi, '');

    // Check for unclosed <think> block — remove partial content from parse area
    const openThink = this.buffer.lastIndexOf('<think>');
    if (openThink >= 0) {
      const closeThink = this.buffer.indexOf('</think>', openThink);
      if (closeThink < 0) {
        // Partial think block — only parse content before <think>
        const cleanPart = this.buffer.substring(0, openThink);
        const allItems = this.extractItems(cleanPart);
        const newItems = allItems.slice(this.emittedCount);
        this.emittedCount = allItems.length;
        return newItems;
      }
    }

    // Strip markdown code fences
    this.buffer = this.buffer.replace(/```(?:json)?\s*/g, '').replace(/\s*```/g, '');

    // Fix decimal comma separators: 399,99 → 399.99
    this.buffer = this.buffer.replace(/(\d),(\d)/g, '$1.$2');

    const allItems = this.extractItems(this.buffer);
    const newItems = allItems.slice(this.emittedCount);
    this.emittedCount = allItems.length;
    return newItems;
  }

  /** Get all items extracted so far */
  getAllItems(): AIReceiptItem[] {
    return this.extractItems(this.buffer);
  }

  /** Extract currency code from the buffer (appears after items array) */
  getCurrency(): string | undefined {
    const match = this.buffer.match(/"currency"\s*:\s*"([A-Z]{3})"/);
    return match?.[1];
  }

  /** Extract all complete item objects from the given text */
  private extractItems(text: string): AIReceiptItem[] {
    const itemsKeyPos = text.indexOf('"items"');
    if (itemsKeyPos < 0) return [];

    const bracketStart = text.indexOf('[', itemsKeyPos);
    if (bracketStart < 0) return [];

    const items: AIReceiptItem[] = [];
    let i = bracketStart + 1;

    while (i < text.length) {
      const objStart = this.findNextObjectStart(text, i);
      if (objStart < 0) break;

      const objEnd = this.findMatchingBrace(text, objStart);
      if (objEnd < 0) break;

      const objStr = text.substring(objStart, objEnd + 1);
      try {
        const item = JSON.parse(objStr) as AIReceiptItem;
        if (item.name_ru && typeof item.total === 'number') {
          items.push(item);
        }
      } catch {
        // Malformed object, skip
      }

      i = objEnd + 1;
    }

    return items;
  }

  /** Find the next '{' that starts an object (skip whitespace and commas) */
  private findNextObjectStart(text: string, from: number): number {
    for (let i = from; i < text.length; i++) {
      const ch = text[i];
      if (ch === '{') return i;
      if (ch === ']') return -1;
      if (ch === ' ' || ch === '\n' || ch === '\r' || ch === '\t' || ch === ',') continue;
    }
    return -1;
  }

  /** Find matching '}' for '{' at pos, respecting string literals and nesting */
  private findMatchingBrace(text: string, pos: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;

    for (let i = pos; i < text.length; i++) {
      const ch = text[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (ch === '\\' && inString) {
        escaped = true;
        continue;
      }

      if (ch === '"') {
        inString = !inString;
        continue;
      }

      if (inString) continue;

      if (ch === '{') depth++;
      if (ch === '}') {
        depth--;
        if (depth === 0) return i;
      }
    }

    return -1;
  }
}
```

- [ ] **Step 1.4: Run tests to verify they pass**

Run: `bun test src/services/receipt/stream-json-parser.test.ts`
Expected: All 15 tests PASS

- [ ] **Step 1.5: Commit**

```bash
git add src/services/receipt/stream-json-parser.ts src/services/receipt/stream-json-parser.test.ts
git commit -m "feat(receipt): add StreamJsonParser for incremental AI response parsing"
```

---

## Task 2: URL Shortener

**Files:**
- Create: `src/services/receipt/url-shortener.ts`
- Create: `src/services/receipt/url-shortener.test.ts`

Simple utility to truncate receipt URLs for display in the streaming UI.

- [ ] **Step 2.1: Write failing tests for shortenReceiptUrl**

```typescript
// src/services/receipt/url-shortener.test.ts

/** Tests for shortenReceiptUrl — truncates receipt URLs for display */
import { describe, expect, it } from 'bun:test';
import { shortenReceiptUrl } from './url-shortener';

describe('shortenReceiptUrl', () => {
  it('shortens a typical Serbian fiscal receipt URL', () => {
    const url = 'https://suf.rs/v/vl?pib=100049340&dp=02.04.2025&boi=AAABBB123456';
    const result = shortenReceiptUrl(url);
    expect(result).toBe('suf.rs/v/vl?...');
  });

  it('keeps short URLs with query intact', () => {
    const url = 'https://example.com/r?id=123';
    const result = shortenReceiptUrl(url);
    expect(result).toBe('example.com/r?...');
  });

  it('returns hostname + pathname for URLs without query string', () => {
    const url = 'https://receipt.example.com/view/abc';
    const result = shortenReceiptUrl(url);
    expect(result).toBe('receipt.example.com/view/abc');
  });

  it('truncates long pathnames to ~30 chars', () => {
    const url = 'https://example.com/very/long/path/that/exceeds/thirty/characters/here';
    const result = shortenReceiptUrl(url);
    expect(result.length).toBeLessThanOrEqual(65);
    expect(result).toContain('...');
  });

  it('returns first 80 chars + ... for non-URL input', () => {
    const qrData = 'A'.repeat(100);
    const result = shortenReceiptUrl(qrData);
    expect(result).toBe('A'.repeat(80) + '...');
  });

  it('returns short non-URL input as-is', () => {
    const qrData = 'some-short-data';
    const result = shortenReceiptUrl(qrData);
    expect(result).toBe('some-short-data');
  });

  it('handles URL with no pathname', () => {
    const url = 'https://example.com?key=value';
    const result = shortenReceiptUrl(url);
    expect(result).toBe('example.com?...');
  });
});
```

- [ ] **Step 2.2: Run tests to verify they fail**

Run: `bun test src/services/receipt/url-shortener.test.ts`
Expected: FAIL — module `./url-shortener` not found

- [ ] **Step 2.3: Implement shortenReceiptUrl**

```typescript
// src/services/receipt/url-shortener.ts

/** Truncate receipt URLs for display in the streaming scanner UI */

const MAX_PATH_LENGTH = 30;
const MAX_NON_URL_LENGTH = 80;

/**
 * Shorten a receipt URL (or QR data) for display.
 * URLs: hostname + truncated pathname + "?..." if query present.
 * Non-URLs: first 80 chars + "..."
 */
export function shortenReceiptUrl(urlOrQr: string): string {
  let parsed: URL;
  try {
    parsed = new URL(urlOrQr);
  } catch {
    if (urlOrQr.length <= MAX_NON_URL_LENGTH) return urlOrQr;
    return `${urlOrQr.substring(0, MAX_NON_URL_LENGTH)}...`;
  }

  let pathname = parsed.pathname;
  if (pathname === '/') pathname = '';

  if (pathname.length > MAX_PATH_LENGTH) {
    const start = pathname.substring(0, 15);
    const end = pathname.substring(pathname.length - 12);
    pathname = `${start}...${end}`;
  }

  const base = `${parsed.hostname}${pathname}`;
  const hasQuery = parsed.search.length > 1;

  return hasQuery ? `${base}?...` : base;
}
```

- [ ] **Step 2.4: Run tests to verify they pass**

Run: `bun test src/services/receipt/url-shortener.test.ts`
Expected: All 7 tests PASS

- [ ] **Step 2.5: Commit**

```bash
git add src/services/receipt/url-shortener.ts src/services/receipt/url-shortener.test.ts
git commit -m "feat(receipt): add shortenReceiptUrl utility"
```

---

## Task 3: Scan Store

**Files:**
- Create: `src/web/scan-store.ts`
- Create: `src/web/scan-store.test.ts`

In-memory scan state store with SSE pub/sub, 30-minute TTL cleanup, max 5 subscribers per scan. Stores both `groupId` (internal DB ID) and `telegramGroupId` (for auth on SSE/poll endpoints without extra DB lookup).

- [ ] **Step 3.1: Write failing tests for scan store**

```typescript
// src/web/scan-store.test.ts

/** Tests for scan store — in-memory scan state with SSE pub/sub and TTL cleanup */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import {
  createScan,
  emitEvent,
  getScan,
  subscribe,
  updateScan,
  _cleanupExpired,
  _resetForTests,
} from './scan-store';

beforeEach(() => {
  _resetForTests();
});

describe('createScan', () => {
  it('creates a scan with pending phase and returns scanId', () => {
    const scanId = createScan(42, 12345);
    expect(typeof scanId).toBe('string');
    expect(scanId.length).toBeGreaterThan(0);

    const state = getScan(scanId);
    expect(state).toBeDefined();
    expect(state!.phase).toBe('pending');
    expect(state!.groupId).toBe(42);
    expect(state!.telegramGroupId).toBe(12345);
    expect(state!.items).toEqual([]);
  });

  it('creates unique IDs', () => {
    const id1 = createScan(1, 100);
    const id2 = createScan(1, 100);
    expect(id1).not.toBe(id2);
  });
});

describe('updateScan', () => {
  it('merges patch into existing state', () => {
    const scanId = createScan(1, 100);
    updateScan(scanId, { phase: 'fetching', url: 'test.com' });
    const state = getScan(scanId);
    expect(state!.phase).toBe('fetching');
    expect(state!.url).toBe('test.com');
    expect(state!.groupId).toBe(1);
  });

  it('is a no-op for unknown scanId', () => {
    updateScan('nonexistent', { phase: 'done' });
  });

  it('notifies SSE subscribers on phase update', () => {
    const scanId = createScan(1, 100);
    const received: string[] = [];
    subscribe(scanId, (event) => received.push(event));

    updateScan(scanId, { phase: 'extracting' });
    expect(received).toHaveLength(1);
    expect(received[0]).toContain('event: status');
    expect(received[0]).toContain('"phase":"extracting"');
  });
});

describe('emitEvent', () => {
  it('sends SSE-formatted event to all subscribers', () => {
    const scanId = createScan(1, 100);
    const received1: string[] = [];
    const received2: string[] = [];
    subscribe(scanId, (e) => received1.push(e));
    subscribe(scanId, (e) => received2.push(e));

    emitEvent(scanId, 'item', { name: 'Молоко', total: 89.99 });

    expect(received1).toHaveLength(1);
    expect(received2).toHaveLength(1);
    expect(received1[0]).toBe('event: item\ndata: {"name":"Молоко","total":89.99}\n\n');
  });

  it('is a no-op for unknown scanId', () => {
    emitEvent('nonexistent', 'item', {});
  });
});

describe('subscribe', () => {
  it('returns unsubscribe function', () => {
    const scanId = createScan(1, 100);
    const received: string[] = [];
    const unsub = subscribe(scanId, (e) => received.push(e));

    emitEvent(scanId, 'ping', {});
    expect(received).toHaveLength(1);

    unsub!();
    emitEvent(scanId, 'ping', {});
    expect(received).toHaveLength(1);
  });

  it('rejects with null when exceeding 5 subscribers', () => {
    const scanId = createScan(1, 100);
    for (let i = 0; i < 5; i++) {
      expect(subscribe(scanId, () => {})).not.toBeNull();
    }
    expect(subscribe(scanId, () => {})).toBeNull();
  });

  it('allows new subscriber after one unsubscribes', () => {
    const scanId = createScan(1, 100);
    const unsubs: Array<(() => void) | null> = [];
    for (let i = 0; i < 5; i++) {
      unsubs.push(subscribe(scanId, () => {}));
    }
    expect(subscribe(scanId, () => {})).toBeNull();

    unsubs[0]!();
    expect(subscribe(scanId, () => {})).not.toBeNull();
  });
});

describe('TTL cleanup', () => {
  it('removes scans older than TTL', () => {
    const scanId = createScan(1, 100);
    expect(getScan(scanId)).toBeDefined();

    const state = getScan(scanId)!;
    state.createdAt = Date.now() - 31 * 60 * 1000;

    _cleanupExpired();

    expect(getScan(scanId)).toBeUndefined();
  });
});
```

- [ ] **Step 3.2: Run tests to verify they fail**

Run: `bun test src/web/scan-store.test.ts`
Expected: FAIL — module `./scan-store` not found

- [ ] **Step 3.3: Implement scan store**

```typescript
// src/web/scan-store.ts

/** In-memory scan state store with SSE pub/sub and 30-minute TTL cleanup */

import type { CurrencyCode } from '../config/constants';
import { createLogger } from '../utils/logger';

const logger = createLogger('scan-store');

// ── Types ───────────────────────────────────────────────────────────────────

export type ScanPhase = 'pending' | 'fetching' | 'processing' | 'extracting' | 'done' | 'error';

/** Client-facing receipt item (mapped from AIReceiptItem) */
export interface ScanReceiptItem {
  name: string;
  qty: number;
  price: number;
  total: number;
  category: string;
}

export interface ScanState {
  phase: ScanPhase;
  groupId: number;
  telegramGroupId: number;
  url?: string;
  rawUrl?: string;
  items: ScanReceiptItem[];
  currency?: CurrencyCode;
  fileId?: string | null;
  error?: string;
  errorCode?: string;
  createdAt: number;
}

// ── State ───────────────────────────────────────────────────────────────────

const scans = new Map<string, ScanState>();
const subscribers = new Map<string, Set<(event: string) => void>>();

const TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_SUBSCRIBERS = 5;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

// ── Public API ──────────────────────────────────────────────────────────────

/** Create a new scan entry, returns scanId */
export function createScan(groupId: number, telegramGroupId: number): string {
  const scanId = crypto.randomUUID();
  scans.set(scanId, {
    phase: 'pending',
    groupId,
    telegramGroupId,
    items: [],
    createdAt: Date.now(),
  });
  startCleanupIfNeeded();
  return scanId;
}

/** Get current scan state */
export function getScan(id: string): ScanState | undefined {
  return scans.get(id);
}

/** Merge patch into scan state and notify subscribers with a status event */
export function updateScan(id: string, patch: Partial<ScanState>): void {
  const state = scans.get(id);
  if (!state) return;
  Object.assign(state, patch);

  if (patch.phase) {
    emitEvent(id, 'status', { phase: patch.phase });
  }
}

/** Send SSE-formatted event to all subscribers of a scan */
export function emitEvent(id: string, event: string, data: unknown): void {
  const subs = subscribers.get(id);
  if (!subs || subs.size === 0) return;

  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const send of subs) {
    try {
      send(message);
    } catch {
      // Subscriber may have disconnected
    }
  }
}

/** Subscribe to SSE events for a scan. Returns unsubscribe fn, or null if max reached. */
export function subscribe(id: string, send: (event: string) => void): (() => void) | null {
  let subs = subscribers.get(id);
  if (!subs) {
    subs = new Set();
    subscribers.set(id, subs);
  }

  if (subs.size >= MAX_SUBSCRIBERS) return null;

  subs.add(send);

  return () => {
    const s = subscribers.get(id);
    if (s) {
      s.delete(send);
      if (s.size === 0) subscribers.delete(id);
    }
  };
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

/** Remove scans older than TTL */
export function _cleanupExpired(): void {
  const now = Date.now();
  for (const [id, state] of scans) {
    if (now - state.createdAt > TTL_MS) {
      scans.delete(id);
      subscribers.delete(id);
      logger.info({ scanId: id }, 'Cleaned up expired scan');
    }
  }

  if (scans.size === 0 && cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

function startCleanupIfNeeded(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(_cleanupExpired, CLEANUP_INTERVAL_MS);
}

/** Reset all state — for tests only */
export function _resetForTests(): void {
  scans.clear();
  subscribers.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
```

- [ ] **Step 3.4: Run tests to verify they pass**

Run: `bun test src/web/scan-store.test.ts`
Expected: All tests PASS

- [ ] **Step 3.5: Commit**

```bash
git add src/web/scan-store.ts src/web/scan-store.test.ts
git commit -m "feat(web): add in-memory scan store with SSE pub/sub"
```

---

