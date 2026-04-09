# Streaming Receipt Scanner — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace synchronous receipt scan/OCR endpoints with async processing + SSE streaming, so the miniapp shows items progressively and survives phone sleep. Also fix font rendering and improve the confirm UI with category comboboxes.

**Architecture:** Server accepts scan request → returns scanId immediately (202) → processes in background → streams events (url, item, done, error) via SSE. Client opens EventSource, renders items as they arrive. Polling fallback on SSE failure. Session recovery via sessionStorage + scanId.

**Tech Stack:** Bun.serve (existing), `@huggingface/inference` chatCompletionStream, native EventSource (client), ReadableStream SSE (server), `crypto.randomUUID()` for IDs.

**Spec:** `docs/specs/2026-04-02-streaming-receipt-scanner.md`

---

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

## Task 6: Client API Functions

**Files:**
- Create: `miniapp/src/api/receipt-stream.ts`
- Modify: `miniapp/src/api/receipt.ts`

New API functions for streaming flow + category fetching.

- [ ] **Step 6.1: Create receipt-stream.ts**

```typescript
// miniapp/src/api/receipt-stream.ts

/** Streaming receipt scan API — starts async scans and subscribes to SSE events */
import { ApiError, apiRequest } from './client';
import type { ReceiptItem } from './receipt';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ScanPollResult {
  phase: string;
  url: string | null;
  items: ReceiptItem[];
  currency: string | null;
  fileId: string | null;
  error: string | null;
  errorCode: string | null;
}

export interface StreamCallbacks {
  onUrl?: (url: string, raw?: string) => void;
  onStatus?: (phase: string) => void;
  onItem?: (item: ReceiptItem) => void;
  onDone?: (result: { items: ReceiptItem[]; currency?: string; fileId?: string | null }) => void;
  onError?: (error: { message: string; code: string }) => void;
}

// ── API Functions ───────────────────────────────────────────────────────────

/** Start async QR scan — returns scanId immediately */
export async function startScan(groupId: number, qr: string): Promise<string> {
  const result = await apiRequest<{ scanId: string }>(`/api/receipt/scan?groupId=${groupId}`, {
    method: 'POST',
    body: JSON.stringify({ qr }),
  });
  return result.scanId;
}

/** Start async OCR scan — returns scanId immediately */
export async function startOcr(groupId: number, imageBlob: Blob): Promise<string> {
  const compressed = await compressImage(imageBlob);
  const formData = new FormData();
  formData.append('image', compressed, 'receipt.jpg');
  const result = await apiRequest<{ scanId: string }>(`/api/receipt/ocr?groupId=${groupId}`, {
    method: 'POST',
    body: formData,
  });
  return result.scanId;
}

/** Fetch group categories for combobox */
export async function fetchCategories(groupId: number): Promise<string[]> {
  const result = await apiRequest<{ categories: string[] }>(`/api/categories?groupId=${groupId}`);
  return result.categories;
}

/** Poll scan state (fallback when SSE fails) */
export async function pollScan(scanId: string): Promise<ScanPollResult> {
  const initData = window.Telegram?.WebApp?.initData ?? '';
  return apiRequest<ScanPollResult>(
    `/api/receipt/scan/${scanId}?initData=${encodeURIComponent(initData)}`,
  );
}

/**
 * Open SSE stream for scan results.
 * Returns cleanup function. Falls back to polling on SSE failure.
 */
export function streamScan(scanId: string, callbacks: StreamCallbacks): () => void {
  const initData = window.Telegram?.WebApp?.initData ?? '';
  const baseUrl = import.meta.env.VITE_API_URL ?? '';
  const url = `${baseUrl}/api/receipt/scan/${scanId}/stream?initData=${encodeURIComponent(initData)}`;

  let es: EventSource | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let pollBackoff = 3000;

  function startSSE() {
    es = new EventSource(url);

    es.addEventListener('url', (e: Event) => {
      if (closed) return;
      const me = e as MessageEvent;
      try {
        const data = JSON.parse(me.data);
        callbacks.onUrl?.(data.url, data.raw);
      } catch { /* ignore */ }
    });

    es.addEventListener('status', (e: Event) => {
      if (closed) return;
      const me = e as MessageEvent;
      try {
        const data = JSON.parse(me.data);
        callbacks.onStatus?.(data.phase);
      } catch { /* ignore */ }
    });

    es.addEventListener('item', (e: Event) => {
      if (closed) return;
      const me = e as MessageEvent;
      try {
        const item = JSON.parse(me.data) as ReceiptItem;
        callbacks.onItem?.(item);
      } catch { /* ignore */ }
    });

    es.addEventListener('done', (e: Event) => {
      if (closed) return;
      const me = e as MessageEvent;
      try {
        const data = JSON.parse(me.data);
        callbacks.onDone?.(data);
      } catch { /* ignore */ }
      cleanup();
    });

    // Named 'error' events from server come as MessageEvent with data.
    // Connection errors come as plain Event without data.
    es.addEventListener('error', (e: Event) => {
      if (closed) return;

      // Try server-sent error event first (MessageEvent with data)
      const me = e as MessageEvent;
      if (me.data) {
        try {
          const data = JSON.parse(me.data);
          if (data.message || data.code) {
            callbacks.onError?.(data);
            cleanup();
            return;
          }
        } catch { /* not a data event */ }
      }

      // Connection error — close SSE and fall back to polling
      es?.close();
      es = null;
      startPolling();
    });
  }

  function startPolling() {
    if (closed) return;

    async function poll() {
      if (closed) return;
      try {
        const state = await pollScan(scanId);

        if (state.url) callbacks.onUrl?.(state.url);

        if (state.phase === 'done') {
          callbacks.onDone?.({
            items: state.items,
            currency: state.currency ?? undefined,
            fileId: state.fileId,
          });
          cleanup();
          return;
        }
        if (state.phase === 'error') {
          callbacks.onError?.({
            message: state.error ?? 'Unknown error',
            code: state.errorCode ?? 'SCAN_FAILED',
          });
          cleanup();
          return;
        }

        pollBackoff = Math.min(pollBackoff * 1.5, 10_000);
        pollTimer = setTimeout(poll, pollBackoff);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'INIT_DATA_EXPIRED') {
          callbacks.onError?.({ message: 'Session expired', code: 'INIT_DATA_EXPIRED' });
          cleanup();
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          callbacks.onError?.({ message: 'Скан истёк, попробуй ещё раз', code: 'SCAN_EXPIRED' });
          cleanup();
          return;
        }
        pollTimer = setTimeout(poll, pollBackoff);
      }
    }

    poll();
  }

  function cleanup() {
    closed = true;
    es?.close();
    es = null;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  if (typeof EventSource !== 'undefined') {
    startSSE();
  } else {
    startPolling();
  }

  return cleanup;
}

// ── Image Compression ───────────────────────────────────────────────────────

async function compressImage(blob: Blob): Promise<Blob> {
  const MAX_SIDE = 1800;
  const QUALITY = 0.85;
  const MAX_SIZE = 2 * 1024 * 1024;

  const img = await createImageBitmap(blob);
  const { width, height } = img;
  let w = width;
  let h = height;

  if (w > MAX_SIDE || h > MAX_SIDE) {
    const ratio = Math.min(MAX_SIDE / w, MAX_SIDE / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    if (blob.size <= MAX_SIZE) return blob;
    throw new Error('Cannot compress image: OffscreenCanvas not supported');
  }

  ctx.drawImage(img, 0, 0, w, h);
  const compressed = await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });

  if (compressed.size > MAX_SIZE) {
    throw new Error('Image too large after compression');
  }

  return compressed;
}
```

- [ ] **Step 6.2: Update receipt.ts — remove scanQR and uploadOCR**

Remove `scanQR`, `uploadOCR`, and `compressImage` functions. Keep:
- `ReceiptItem`, `ScanResult`, `OcrResult`, `ConfirmExpense` types
- `confirmExpenses` function

- [ ] **Step 6.3: Commit**

```bash
git add miniapp/src/api/receipt-stream.ts miniapp/src/api/receipt.ts
git commit -m "feat(miniapp): add streaming scan API client with SSE + polling fallback"
```

---

## Task 7: Scanner.tsx — Streaming UI + Font Fix + Category Combobox

**Files:**
- Modify: `miniapp/src/tabs/Scanner.tsx`
- Modify: `miniapp/index.html`

Replace `loading` phase with `streaming`. Show progressive item rendering. Add scan line animation for OCR. Update session recovery with scanId dedup fix. Fix global font-family. Replace category text inputs with comboboxes.

- [ ] **Step 7.1: Fix global font-family in miniapp/index.html**

Telegram does NOT provide a `--tg-theme-font-family` CSS variable. Add system font stack to `<head>`:

```html
<style>
  * { box-sizing: border-box; }
  body, input, button, select, textarea {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  }
</style>
```

Add this before the `<script>` tag for `telegram-web-app.js`.

- [ ] **Step 7.2: Update types and imports in Scanner.tsx**

```typescript
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { confirmExpenses } from '../api/receipt';
import type { ReceiptItem } from '../api/receipt';
import { startScan, startOcr, streamScan, pollScan, fetchCategories } from '../api/receipt-stream';
```

Update Phase type:
```typescript
type Phase = 'idle' | 'url-input' | 'ocr-input' | 'streaming' | 'confirm' | 'done' | 'error';
```

Update SavedState:
```typescript
interface SavedState {
  phase: Phase;
  items: ReceiptItem[];
  fileId: string | null;
  currency: string;
  urlInput: string;
  scrollY: number;
  reloadAttempted: boolean;
  scanId?: string;
  groupId?: number;
  photoPreview?: string;
}
```

- [ ] **Step 7.3: Add new state variables**

```typescript
const [scanId, setScanId] = useState<string | null>(null);
const [streamUrl, setStreamUrl] = useState<string | null>(null);
const [photoPreview, setPhotoPreview] = useState<string | null>(null);
const [isOcrMode, setIsOcrMode] = useState(false);
const [categories, setCategories] = useState<string[]>([]);
const cleanupRef = useRef<(() => void) | null>(null);
```

- [ ] **Step 7.4: Add CSS keyframes injection + cleanup**

```typescript
useEffect(() => {
  const id = 'scanner-keyframes';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    @keyframes scanMove {
      0% { top: 5%; }
      100% { top: 95%; }
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
  return () => { document.getElementById(id)?.remove(); };
}, []);
```

- [ ] **Step 7.5: Fetch categories on mount**

```typescript
useEffect(() => {
  fetchCategories(groupId).then(setCategories).catch(() => {});
}, [groupId]);
```

- [ ] **Step 7.6: Cleanup SSE on unmount**

```typescript
useEffect(() => {
  return () => { cleanupRef.current?.(); };
}, []);
```

- [ ] **Step 7.7: Implement streaming scan flow**

Replace `handleQRDetected`:
```typescript
const handleQRDetected = useCallback(
  async (qrData: string) => {
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
    setPhase('streaming');
    setIsOcrMode(false);
    setItems([]);
    setStreamUrl(null);

    try {
      const id = await startScan(groupId, qrData);
      setScanId(id);
      sessionStorage.setItem('scanner_scanId', id);

      cleanupRef.current = streamScan(id, {
        onUrl: (url) => setStreamUrl(url),
        onItem: (item) => setItems((prev) => [...prev, item]),
        onDone: (result) => {
          setItems(result.items);
          setCurrency(result.currency ?? '');
          setFileId(result.fileId ?? null);
          setPhase('confirm');
          sessionStorage.removeItem('scanner_scanId');
        },
        onError: (error) => {
          if (error.code === 'INIT_DATA_EXPIRED') {
            handleExpiredSession('streaming');
            return;
          }
          setError(friendlyErrorMessage(new ApiError(0, error.message, error.code)));
          setPhase('error');
          sessionStorage.removeItem('scanner_scanId');
        },
      });
    } catch (e) {
      if (isExpiredSession(e)) {
        handleExpiredSession('idle');
        return;
      }
      setError(friendlyErrorMessage(e));
      setPhase('error');
    }
  },
  [groupId, handleExpiredSession],
);
```

Replace `handleFileUpload`:
```typescript
const handleFileUpload = useCallback(
  async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhase('streaming');
    setIsOcrMode(true);
    setItems([]);

    // Save photo preview as data URL for session recovery
    const reader = new FileReader();
    reader.onload = () => setPhotoPreview(reader.result as string);
    reader.readAsDataURL(file);

    try {
      const id = await startOcr(groupId, file);
      setScanId(id);
      sessionStorage.setItem('scanner_scanId', id);

      cleanupRef.current = streamScan(id, {
        onItem: (item) => setItems((prev) => [...prev, item]),
        onDone: (result) => {
          setItems(result.items);
          setCurrency(result.currency ?? '');
          setFileId(result.fileId ?? null);
          setPhase('confirm');
          setPhotoPreview(null);
          sessionStorage.removeItem('scanner_scanId');
        },
        onError: (error) => {
          if (error.code === 'INIT_DATA_EXPIRED') {
            handleExpiredSession('streaming');
            return;
          }
          setError(friendlyErrorMessage(new ApiError(0, error.message, error.code)));
          setPhase('error');
          sessionStorage.removeItem('scanner_scanId');
        },
      });
    } catch (uploadErr) {
      if (isExpiredSession(uploadErr)) {
        handleExpiredSession('ocr-input');
        return;
      }
      setError(friendlyErrorMessage(uploadErr));
      setPhase('error');
    }
  },
  [groupId, handleExpiredSession],
);
```

- [ ] **Step 7.8: Session recovery with dedup fix**

Key fix: when reconnecting from session recovery, do NOT append items from SSE if poll already returned them. Instead, poll first → if still processing, set items from poll, then open SSE with `onItem` that only appends items BEYOND the known count.

```typescript
async function reconnectToScan(id: string, photo?: string) {
  try {
    const state = await pollScan(id);
    setScanId(id);
    if (photo) setPhotoPreview(photo);

    if (state.phase === 'done') {
      setItems(state.items);
      setCurrency(state.currency ?? '');
      setFileId(state.fileId ?? null);
      setPhase('confirm');
      sessionStorage.removeItem('scanner_scanId');
      return;
    }

    if (state.phase === 'error') {
      setError(state.error ?? 'Ошибка сканирования');
      setPhase('error');
      sessionStorage.removeItem('scanner_scanId');
      return;
    }

    // Still processing — set known items, open SSE
    setPhase('streaming');
    setItems(state.items);
    if (state.url) setStreamUrl(state.url);
    setIsOcrMode(!!photo);

    // Track known item count to skip SSE replayed items
    const knownCount = state.items.length;
    let sseItemIndex = 0;

    cleanupRef.current = streamScan(id, {
      onUrl: (url) => setStreamUrl(url),
      onItem: (item) => {
        sseItemIndex++;
        // Skip replayed items that we already have from poll
        if (sseItemIndex <= knownCount) return;
        setItems((prev) => [...prev, item]);
      },
      onDone: (result) => {
        setItems(result.items); // Full replace on done
        setCurrency(result.currency ?? '');
        setFileId(result.fileId ?? null);
        setPhase('confirm');
        setPhotoPreview(null);
        sessionStorage.removeItem('scanner_scanId');
      },
      onError: (error) => {
        setError(error.message);
        setPhase('error');
        sessionStorage.removeItem('scanner_scanId');
      },
    });
  } catch {
    sessionStorage.removeItem('scanner_scanId');
    setPhase('idle');
  }
}
```

Update the mount useEffect:
```typescript
useEffect(() => {
  const saved = loadSavedState();
  if (!saved) {
    const orphanedScanId = sessionStorage.getItem('scanner_scanId');
    if (orphanedScanId) {
      reconnectToScan(orphanedScanId);
    }
    return;
  }

  setReloadAttempted(saved.reloadAttempted);
  setUrlInput(saved.urlInput);
  setCurrency(saved.currency);
  setFileId(saved.fileId);

  if (saved.scanId) {
    reconnectToScan(saved.scanId, saved.photoPreview);
  } else {
    setItems(saved.items);
    setPhase(saved.phase);
    requestAnimationFrame(() => window.scrollTo(0, saved.scrollY));
  }
}, []);
```

- [ ] **Step 7.9: Update handleExpiredSession to include scanId + photo**

```typescript
const handleExpiredSession = useCallback(
  (currentPhase: Phase) => {
    if (reloadAttempted) {
      setError('Сессия истекла. Закрой и открой Mini App заново.');
      setPhase('error');
      return;
    }
    cleanupRef.current?.();
    saveAndReload({
      phase: currentPhase,
      items,
      fileId,
      currency,
      urlInput,
      scanId: scanId ?? undefined,
      groupId,
      photoPreview: photoPreview ?? undefined,
    });
  },
  [reloadAttempted, items, fileId, currency, urlInput, scanId, photoPreview, groupId],
);
```

- [ ] **Step 7.10: Update resetToIdle**

```typescript
const resetToIdle = () => {
  cleanupRef.current?.();
  cleanupRef.current = null;
  setItems([]);
  setFileId(null);
  setCurrency('');
  setError('');
  setUrlInput('');
  setScanId(null);
  setStreamUrl(null);
  setPhotoPreview(null);
  setIsOcrMode(false);
  setPhase('idle');
  sessionStorage.removeItem('scanner_scanId');
};
```

- [ ] **Step 7.11: Implement streaming phase UI**

Replace the `loading` phase render:

```typescript
if (phase === 'streaming') {
  return (
    <div style={pageStyle}>
      {/* OCR: photo with scan line */}
      {isOcrMode && photoPreview && (
        <div style={scanOverlayStyle}>
          <img
            src={photoPreview}
            alt="Receipt"
            style={{
              width: '100%',
              borderRadius: 8,
              maxHeight: items.length > 0 ? 120 : 240,
              objectFit: 'cover',
              transition: 'max-height 0.3s ease',
            }}
          />
          {items.length === 0 && <div style={scanLineStyle} />}
        </div>
      )}

      {/* QR: shortened URL */}
      {!isOcrMode && streamUrl && (
        <div style={{
          fontSize: 13,
          color: 'var(--tg-theme-hint-color, #999)',
          marginBottom: 12,
          wordBreak: 'break-all',
        }}>
          🔗 {streamUrl}
        </div>
      )}

      {/* Status label with pulsing dot */}
      <div style={{ fontSize: 15, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={pulsingDotStyle} />
        {items.length === 0
          ? (isOcrMode ? 'Сканируем чек...' : 'Загружаем чек...')
          : 'Распознаём позиции...'}
      </div>

      {/* Items appearing one by one */}
      {items.map((item, i) => (
        <div key={i} style={{ ...streamingItemStyle, animation: 'slideIn 0.3s ease' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
            <span style={{ fontWeight: 600, whiteSpace: 'nowrap', marginLeft: 8 }}>
              {item.total.toLocaleString('ru-RU')}
            </span>
          </div>
          {item.qty > 1 && (
            <div style={{ fontSize: 13, color: 'var(--tg-theme-hint-color, #999)' }}>
              {item.qty} × {item.price.toLocaleString('ru-RU')}
            </div>
          )}
        </div>
      ))}

      {/* Skeleton placeholder */}
      <div style={skeletonStyle}>
        <div style={skeletonBarStyle} />
      </div>

      <button type="button" onClick={() => { cleanupRef.current?.(); resetToIdle(); }} style={{ ...secondaryBtnStyle, marginTop: 16 }}>
        Отмена
      </button>
    </div>
  );
}
```

- [ ] **Step 7.12: Redesign confirm phase with category combobox**

Replace the confirm phase render. Key changes:
- Category input → `<input>` with `<datalist>` (native combobox — works everywhere, no extra deps)
- Cleaner card layout with better visual hierarchy
- Total line at top

```typescript
if (phase === 'confirm') {
  const total = items.reduce((sum, it) => sum + it.total, 0);

  return (
    <div style={pageStyle}>
      <h3 style={{ margin: '0 0 4px' }}>Подтверди расходы</h3>
      <div style={{ fontSize: 14, color: 'var(--tg-theme-hint-color, #999)', marginBottom: 16 }}>
        {items.length} {pluralize(items.length, 'позиция', 'позиции', 'позиций')} · {total.toLocaleString('ru-RU')} {currency}
      </div>

      {/* Category datalist — shared by all items */}
      <datalist id="category-options">
        {categories.map((cat) => (
          <option key={cat} value={cat} />
        ))}
      </datalist>

      {items.map((item, i) => (
        <div
          key={i}
          style={{
            border: '1px solid var(--tg-theme-hint-color, rgba(128,128,128,0.2))',
            borderRadius: 10,
            padding: '10px 12px',
            marginBottom: 8,
          }}
        >
          {/* Row 1: name + total + delete */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              value={item.name}
              onChange={(e) => handleItemChange(i, 'name', e.target.value)}
              style={{ ...inputStyle, flex: 1, padding: '8px 10px', fontSize: 15 }}
            />
            <span style={{ fontWeight: 600, whiteSpace: 'nowrap', fontSize: 15 }}>
              {item.total.toLocaleString('ru-RU')}
            </span>
            <button
              type="button"
              onClick={() => handleRemoveItem(i)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--tg-theme-hint-color, #999)',
                fontSize: 20,
                cursor: 'pointer',
                padding: '0 4px',
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
          {/* Row 2: category combobox + qty info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <input
              list="category-options"
              value={item.category}
              onChange={(e) => handleItemChange(i, 'category', e.target.value)}
              placeholder="Категория"
              style={{
                ...inputStyle,
                flex: 1,
                padding: '6px 10px',
                fontSize: 14,
                color: 'var(--tg-theme-hint-color, #777)',
              }}
            />
            {item.qty > 1 && (
              <span style={{ fontSize: 13, color: 'var(--tg-theme-hint-color, #999)', whiteSpace: 'nowrap' }}>
                {item.qty} × {item.price.toLocaleString('ru-RU')}
              </span>
            )}
          </div>
        </div>
      ))}

      {items.length > 0 && (
        <button type="button" onClick={handleConfirm} style={{ ...btnStyle, marginTop: 8 }}>
          Записать {items.length} {pluralize(items.length, 'расход', 'расхода', 'расходов')}
        </button>
      )}
      <button type="button" onClick={resetToIdle} style={{ ...secondaryBtnStyle, marginTop: 8 }}>
        Отмена
      </button>
    </div>
  );
}
```

The native `<datalist>` provides:
- Dropdown with existing categories on tap/focus
- Filtering as user types
- Ability to enter new categories (not locked to list)
- Works in Telegram WebView (iOS Safari + Android Chrome)
- Zero dependencies

- [ ] **Step 7.13: Add new style constants**

Add alongside existing `pageStyle`, `btnStyle`, etc.:

```typescript
const scanOverlayStyle: React.CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  borderRadius: 8,
  marginBottom: 16,
};

const scanLineStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  height: 3,
  background: 'linear-gradient(to right, transparent 0%, #4CAF50 30%, #4CAF50 70%, transparent 100%)',
  boxShadow: '0 0 8px rgba(76, 175, 80, 0.6)',
  animation: 'scanMove 2.5s ease-in-out infinite alternate',
  top: '5%',
};

const pulsingDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: 'var(--tg-theme-button-color, #2196F3)',
  animation: 'pulse 1.5s ease-in-out infinite',
  flexShrink: 0,
};

const streamingItemStyle: React.CSSProperties = {
  border: '1px solid var(--tg-theme-hint-color, rgba(128,128,128,0.2))',
  borderRadius: 8,
  padding: 10,
  marginBottom: 6,
};

const skeletonStyle: React.CSSProperties = {
  border: '1px dashed var(--tg-theme-hint-color, rgba(128,128,128,0.2))',
  borderRadius: 8,
  padding: 14,
  marginBottom: 6,
};

const skeletonBarStyle: React.CSSProperties = {
  height: 14,
  borderRadius: 4,
  background: 'var(--tg-theme-hint-color, rgba(128,128,128,0.15))',
  animation: 'pulse 1.5s ease-in-out infinite',
  width: '60%',
};
```

- [ ] **Step 7.14: Build miniapp**

Run: `cd miniapp && npx vite build`
Expected: Build succeeds

- [ ] **Step 7.15: Typecheck**

Run: `bun run type-check`
Expected: No type errors

- [ ] **Step 7.16: Lint**

Run: `bun run lint`
Expected: No errors

- [ ] **Step 7.17: Commit**

```bash
git add miniapp/src/tabs/Scanner.tsx miniapp/src/api/receipt-stream.ts miniapp/src/api/receipt.ts miniapp/index.html
git commit -m "feat(miniapp): streaming scanner UI, font fix, category combobox"
```

---

## Task 8: Integration Verification

- [ ] **Step 8.1: Typecheck**

Run: `bun run type-check`

- [ ] **Step 8.2: Lint**

Run: `bun run lint:fix && bun run format`

- [ ] **Step 8.3: Full test suite**

Run: `bun run test`

- [ ] **Step 8.4: Knip**

Run: `bunx knip`

- [ ] **Step 8.5: Build miniapp**

Run: `cd miniapp && npx vite build`

- [ ] **Step 8.6: Final commit if needed**

```bash
git add -A && git commit -m "chore: lint and cleanup from streaming scanner implementation"
```

---

## Summary

| Task | Files | Key Changes |
|------|-------|-------------|
| 1. Stream JSON Parser | 2 new | Incremental item parser + `getCurrency()` |
| 2. URL Shortener | 2 new | Truncate URLs for display |
| 3. Scan Store | 2 new | State + SSE pub/sub + `telegramGroupId` in state |
| 4. Streaming AI Extractor | 1 modified, 1 new test | `streamExtractExpenses` + `Promise.race` timeout + extracted helpers |
| 5. Server API | 2 modified | Async 202 endpoints + SSE + poll + categories + distinct error codes |
| 6. Client API | 1 new, 1 modified | `startScan`, `streamScan`, `fetchCategories` |
| 7. Scanner.tsx + UI | 2 modified | Streaming UI, font fix, category `<datalist>` combobox, reconnect dedup |
| 8. Verification | 0 | Typecheck, lint, test, build |
