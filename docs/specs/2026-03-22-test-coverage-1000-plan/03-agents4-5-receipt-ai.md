# Test Coverage 1000 / TDD Error Handling — Implementation Plan — Part 3/4: Agents 4-5: receipt pipeline, AI layer + bot error formatter

[← Back to index](../2026-03-22-test-coverage-1000-plan.md)

## AGENT 4 — Receipt Pipeline (~110 tests)

**Files owned:** six receipt service test files.

**Depends on:** `src/errors/` (created by Agent 1). If not yet committed, define local stubs:
```typescript
class NetworkError extends Error { constructor(msg: string, public code = 'NETWORK_ERROR') { super(msg); } }
```
Replace with real import once Agent 1 commits.

**Mock strategy:** Use dependency injection (DI) for receipt-fetcher (see A4-3 — no `mock.module()`). Mock `fetch` globally via `global.fetch = mock(...)` for HTTP calls in other services.

**Run tests with:** `bun test src/services/receipt/`

---

### Task A4-1: QR scanner tests (~15 tests)

Read `src/services/receipt/qr-scanner.ts` first.

Focus on `isURL` and any parsing/extraction functions — pure logic, no mocks needed.

```typescript
// src/services/receipt/qr-scanner.test.ts
import { describe, it, expect } from 'bun:test';
import { isURL } from './qr-scanner';

describe('isURL', () => {
  it('returns true for http URL', () => expect(isURL('http://example.com')).toBe(true));
  it('returns true for https URL', () => expect(isURL('https://example.com/receipt?id=123')).toBe(true));
  it('returns false for plain text', () => expect(isURL('just text')).toBe(false));
  it('returns false for JSON string', () => expect(isURL('{"amount":100}')).toBe(false));
  it('returns false for empty string', () => expect(isURL('')).toBe(false));
  it('returns false for ftp URL (not supported)', () => expect(isURL('ftp://example.com')).toBe(false));
  it('handles URL with path and query', () => expect(isURL('https://api.store.com/r?t=abc&id=123')).toBe(true));
  // Add more based on what you find in qr-scanner.ts
});
```

```bash
bun test src/services/receipt/qr-scanner.test.ts
git commit -m "test(receipt): add qr-scanner tests"
```

---

### Task A4-2: Link analyzer tests (~20 tests)

Read `src/services/receipt/link-analyzer.ts` first.

This likely has URL classification/detection logic. Test each classification function.

```bash
bun test src/services/receipt/link-analyzer.test.ts
git commit -m "test(receipt): add link-analyzer tests"
```

---

### Task A4-3: Receipt fetcher tests with DI (~20 tests)

Read `src/services/receipt/receipt-fetcher.ts` first.

**`mock.module()` is banned in this project** (pipeline.ts:148). Use **dependency injection** instead.

- [ ] **Step 1: Add optional `getBrowserFn` parameter to `fetchReceiptData` in receipt-fetcher.ts**

This is a backward-compatible change — existing callers pass no second arg and get real Playwright.

```typescript
// In receipt-fetcher.ts — add optional second parameter:
export async function fetchReceiptData(
  qrData: string,
  getBrowserFn: () => Promise<{ newContext: Function }> = getBrowser,
): Promise<string>
// Pass getBrowserFn instead of calling getBrowser() directly inside the function body.
```

- [ ] **Step 2: Write TDD tests (write the NetworkError tests FIRST, they will fail)**

```typescript
// src/services/receipt/receipt-fetcher.test.ts
import { describe, it, expect, mock } from 'bun:test';
import { fetchReceiptData } from './receipt-fetcher';
import { NetworkError } from '../../errors';

// Fake browser factory — dependency-injected, no mock.module needed
function makeFakeBrowser(opts: { content?: string; gotoError?: Error } = {}) {
  return async () => ({
    newContext: async () => ({
      newPage: async () => ({
        goto: opts.gotoError
          ? mock(() => Promise.reject(opts.gotoError))
          : mock(() => Promise.resolve()),
        waitForTimeout: mock(() => Promise.resolve()),
        content: mock(() => Promise.resolve(
          opts.content ?? '<html><body>Receipt content with enough data to pass length check</body></html>'
        )),
        close: mock(() => Promise.resolve()),
      }),
      close: mock(() => Promise.resolve()),
    }),
  });
}

describe('fetchReceiptData', () => {
  it('returns page content for valid URL', async () => {
    const result = await fetchReceiptData('https://example.com/receipt', makeFakeBrowser());
    expect(typeof result).toBe('string');
    expect(result).toContain('Receipt content');
  });

  it('returns plain QR data as-is when not a URL', async () => {
    const json = '{"amount":1500,"store":"Supermarket"}';
    const result = await fetchReceiptData(json, makeFakeBrowser());
    expect(result).toBe(json);
  });

  it('does not call browser for non-URL QR data', async () => {
    let browserCalled = false;
    const trackingBrowser = async () => { browserCalled = true; return makeFakeBrowser()(); };
    await fetchReceiptData('plain text', trackingBrowser as Parameters<typeof fetchReceiptData>[1]);
    expect(browserCalled).toBe(false);
  });

  // TDD: write FIRST → test FAILS → fix receipt-fetcher.ts to throw NetworkError → test PASSES

  it('[TDD] throws NetworkError when page content is too short', async () => {
    await expect(
      fetchReceiptData('https://example.com/empty', makeFakeBrowser({ content: '<html></html>' }))
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('[TDD] throws NetworkError when browser navigation fails', async () => {
    await expect(
      fetchReceiptData(
        'https://unreachable.example.com',
        makeFakeBrowser({ gotoError: new Error('net::ERR_CONNECTION_REFUSED') })
      )
    ).rejects.toBeInstanceOf(NetworkError);
  });
});
```

- [ ] **Step 3: Run — NetworkError tests FAIL (receipt-fetcher throws plain Error)**

```bash
bun test src/services/receipt/receipt-fetcher.test.ts
```
Expected: 3 pass, 2 fail (`NetworkError` not thrown yet).

- [ ] **Step 4: Fix receipt-fetcher.ts to throw NetworkError**

```typescript
// In receipt-fetcher.ts:
import { NetworkError } from '../../errors';
// Replace: throw new Error('Page content too short...')
// With:    throw new NetworkError('Page content too short', 'EMPTY_CONTENT')
// Replace: catch (error) { throw error; }
// With:    catch (error) { throw new NetworkError('Browser navigation failed', 'NAVIGATION_FAILED', error); }
```

- [ ] **Step 5: Run — all tests PASS**

```bash
bun test src/services/receipt/receipt-fetcher.test.ts
git commit -m "feat(receipt): throw NetworkError on fetch failures (TDD) + tests"
```

---

### Task A4-4: OCR extractor tests (~20 tests)

Read `src/services/receipt/ocr-extractor.ts` first.

Mock any external APIs (HuggingFace inference, etc.).

TDD error cases:
- API returns 429 → should propagate as `HuggingFaceError`
- API returns malformed JSON → handle gracefully, return null

```bash
bun test src/services/receipt/ocr-extractor.test.ts
git commit -m "feat(receipt): throw typed errors from ocr-extractor (TDD) + tests"
```

---

### Task A4-5: Receipt summarizer + AI extractor tests (~20 + 15 tests)

Read both files first. Mock external dependencies.

```bash
bun test src/services/receipt/receipt-summarizer.test.ts src/services/receipt/ai-extractor.test.ts
git commit -m "test(receipt): add summarizer and ai-extractor tests"
```

---

### Task A4-6: Final run — all Agent 4 tests

```bash
bun test src/services/receipt/
```
Expected: ~110 tests, all green.

---

## AGENT 5 — AI Layer + Bot Error Formatter (~130 tests)

**Files owned:** `ai/agent.test.ts`, expand `telegram-stream.test.ts`, `bot-error-formatter.ts` (production + test).

**Run tests with:** `bun test src/services/ai/agent.test.ts src/services/ai/telegram-stream.test.ts src/bot/bot-error-formatter.test.ts`

---

### Task A5-1: Bot error formatter via TDD (~30 tests)

This is pure TDD: write tests FIRST, then implement `bot-error-formatter.ts`.

- [ ] **Step 1: Write failing tests first**

```typescript
// src/bot/bot-error-formatter.test.ts
// TDD: write before implementing bot-error-formatter.ts

import { describe, it, expect } from 'bun:test';
import { formatErrorForUser } from './bot-error-formatter';
import { GoogleSheetsError, HuggingFaceError, AnthropicError, NetworkError, OAuthError, AppError } from '../errors';

describe('formatErrorForUser', () => {
  describe('GoogleSheetsError', () => {
    it('returns spreadsheet-related message', () => {
      const err = new GoogleSheetsError('API error', 'SHEETS_API_ERROR');
      const msg = formatErrorForUser(err);
      expect(msg.toLowerCase()).toMatch(/таблиц|sheets|google/);
    });

    it('includes suggestion to retry', () => {
      const err = new GoogleSheetsError('quota exceeded', 'QUOTA_EXCEEDED');
      const msg = formatErrorForUser(err);
      expect(msg.length).toBeGreaterThan(10);
    });
  });

  describe('OAuthError', () => {
    it('returns reconnect suggestion', () => {
      const err = new OAuthError('token expired', 'TOKEN_EXPIRED');
      const msg = formatErrorForUser(err);
      expect(msg).toContain('/reconnect');
    });
  });

  describe('NetworkError', () => {
    it('returns network problem message', () => {
      const err = new NetworkError('connection refused', 'CONNECTION_REFUSED');
      const msg = formatErrorForUser(err);
      expect(msg.toLowerCase()).toMatch(/сеть|соединени|интернет|недоступ/);
    });
  });

  describe('HuggingFaceError', () => {
    it('returns AI service message', () => {
      const err = new HuggingFaceError('rate limit', 'RATE_LIMIT');
      const msg = formatErrorForUser(err);
      expect(msg.toLowerCase()).toMatch(/ai|ии|сервис|попробуй/);
    });
  });

  describe('AnthropicError', () => {
    it('returns AI service unavailable message', () => {
      const err = new AnthropicError('rate limit', 'RATE_LIMIT_429');
      const msg = formatErrorForUser(err);
      expect(msg.toLowerCase()).toMatch(/ai|ии|сервис|попробуй/);
    });
  });

  describe('generic AppError', () => {
    it('returns generic error message', () => {
      const err = new AppError('something', 'UNKNOWN');
      const msg = formatErrorForUser(err);
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(5);
    });
  });

  describe('unknown error', () => {
    it('handles plain Error', () => {
      const msg = formatErrorForUser(new Error('oops'));
      expect(typeof msg).toBe('string');
    });

    it('handles non-Error value', () => {
      const msg = formatErrorForUser('string error' as unknown as Error);
      expect(typeof msg).toBe('string');
    });
  });

  it('never returns empty string', () => {
    const errors = [
      new GoogleSheetsError('x', 'y'),
      new OAuthError('x', 'y'),
      new NetworkError('x', 'y'),
      new HuggingFaceError('x', 'y'),
      new Error('x'),
    ];
    for (const err of errors) {
      expect(formatErrorForUser(err).length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run — expect ALL FAIL (function not defined)**

```bash
bun test src/bot/bot-error-formatter.test.ts
```
Expected: fail with "Cannot find module" or "formatErrorForUser is not a function".

- [ ] **Step 3: Implement bot-error-formatter.ts**

```typescript
// src/bot/bot-error-formatter.ts
// Translates typed service errors into user-friendly Telegram messages

import { AppError, GoogleSheetsError, HuggingFaceError, AnthropicError, NetworkError, OAuthError } from '../errors';

export function formatErrorForUser(error: unknown): string {
  if (error instanceof OAuthError) {
    return 'Авторизация истекла. Запусти /reconnect чтобы переподключить Google.';
  }
  if (error instanceof GoogleSheetsError) {
    return 'Не удалось обратиться к Google Таблицам. Попробуй ещё раз через минуту.';
  }
  if (error instanceof NetworkError) {
    return 'Нет соединения с сервисом. Проверь интернет и попробуй снова.';
  }
  if (error instanceof AnthropicError || error instanceof HuggingFaceError) {
    return 'AI-сервис временно недоступен. Попробуй позже.';
  }
  if (error instanceof AppError) {
    return 'Произошла ошибка. Попробуй ещё раз.';
  }
  if (error instanceof Error) {
    return 'Произошла непредвиденная ошибка.';
  }
  return 'Неизвестная ошибка.';
}
```

- [ ] **Step 4: Run — expect ALL PASS**

```bash
bun test src/bot/bot-error-formatter.test.ts
```
Expected: ~30 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot/bot-error-formatter.ts src/bot/bot-error-formatter.test.ts
git commit -m "feat(bot): add bot-error-formatter via TDD — translates typed errors to Telegram messages"
```

---

### Task A5-2: Expand telegram-stream tests (+20 edge cases)

Read `src/services/ai/telegram-stream.test.ts` first (see what exists), then read `src/services/ai/telegram-stream.ts`.

**REQUIRED: Read `src/services/ai/telegram-stream.ts` fully before writing any test.** Find the class name, method names, and return types. Every test MUST have a real assertion — no empty bodies.

Add these missing edge cases (adapt method calls to actual API):

```typescript
// Add to existing telegram-stream.test.ts
// Read telegram-stream.ts first, then adapt these stubs to use real method names

describe('edge cases', () => {
  // Find the method that splits/truncates text (e.g. splitMessage, truncate, write)
  // Read telegram-stream.ts to find actual method name

  it('handles text at exactly the Telegram limit (4096 chars)', () => {
    const text = 'a'.repeat(4096);
    // After reading the source, call the appropriate method:
    // const chunks = splitForTelegram(text);
    // expect(chunks.every(c => c.length <= 4096)).toBe(true);
    // PLACEHOLDER — replace with real call after reading telegram-stream.ts
    expect(() => { /* real call here */ }).not.toThrow();
  });

  it('closes unclosed <b> tag when text is truncated mid-tag', () => {
    const text = '<b>' + 'x'.repeat(4100);
    // const result = truncateHtml(text, 4096); // adapt to real function name
    // expect(result).toContain('</b>');
    // expect(result).not.toMatch(/<b>[^<]*$/); // no unclosed bold at end
    expect(true).toBe(true); // REPLACE with real assertion after reading source
  });

  it('closes unclosed <i> tag at truncation boundary', () => {
    const text = '<i>' + 'x'.repeat(4100);
    // expect(truncated).toContain('</i>');
    expect(true).toBe(true); // REPLACE
  });

  it('handles deeply nested tags without throwing', () => {
    const text = '<b><i><code>' + 'x'.repeat(100) + '</code></i></b>';
    expect(() => { /* real call */ }).not.toThrow();
  });

  it('produces chunks all within 4096 char limit for very long text', () => {
    const text = 'x'.repeat(10000);
    // const chunks = splitForTelegram(text);
    // chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(4096));
    expect(true).toBe(true); // REPLACE
  });

  it('handles unicode text without splitting multibyte characters', () => {
    const text = 'привет '.repeat(700); // ~4900 chars
    // const chunks = splitForTelegram(text);
    // chunks.forEach(c => expect(Buffer.byteLength(c, 'utf8')).toBeGreaterThan(0));
    expect(true).toBe(true); // REPLACE
  });
});
```

**⚠️ Every `expect(true).toBe(true)` placeholder MUST be replaced with real assertions after reading telegram-stream.ts. Empty/trivial tests that always pass are not acceptable.**

```bash
bun test src/services/ai/telegram-stream.test.ts
git commit -m "test(ai): expand telegram-stream edge cases — HTML closing, boundary splitting"
```

---

### Task A5-3: AI agent tests with spyOn (~50 tests)

**`mock.module()` is banned** (pipeline.ts:148). Use **`spyOn`** to intercept the Anthropic client.

- [ ] **Step 1: Read `src/services/ai/agent.ts` fully before writing any tests**

Find: (a) exact shape of `this.anthropic.messages.stream()` call — does it use `for await`, `.on()`, or `.text()`; (b) whether `db` is accessed in constructor or `run()`; (c) all error paths.

- [ ] **Step 2: Write agent.test.ts using spyOn**

```typescript
// src/services/ai/agent.test.ts
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { ExpenseBotAgent } from './agent';
import { createTestDb } from '../../test-utils/db';
import type { Database } from 'bun:sqlite';

// Fake streaming response — shape MUST match what agent.ts actually iterates
// (read agent.ts first to verify the exact API used)
function makeFakeStream(chunks: string[] = ['Hello', ' world']) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const text of chunks) {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
      }
      yield { type: 'message_stop' };
    },
    // Add other methods agent.ts may call (e.g. .finalMessage(), .text())
    // Read agent.ts to know which ones are used
  };
}

const mockBot = {
  api: {
    sendMessage: mock(() => Promise.resolve({ message_id: 1, chat: { id: 1 }, date: 0, text: '' })),
    editMessageText: mock(() => Promise.resolve({ message_id: 1, chat: { id: 1 }, date: 0, text: '' })),
  },
};

let db: Database;
let agent: ExpenseBotAgent;

beforeEach(() => {
  db = createTestDb(); // real in-memory SQLite
  agent = new ExpenseBotAgent('test-api-key', {
    chatId: 123,
    groupId: 1,
    userId: 10,
    db,
  });
});

afterEach(() => {
  mock.restore();
  db.close();
});

describe('ExpenseBotAgent', () => {
  describe('construction', () => {
    it('creates instance', () => {
      expect(agent).toBeTruthy();
    });
  });

  describe('run', () => {
    it('returns a string response', async () => {
      // Use spyOn on the private anthropic field (cast to access)
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      spyOn(anthropic.messages, 'stream').mockReturnValue(makeFakeStream() as unknown as ReturnType<typeof anthropic.messages.stream>);

      const result = await agent.run('What are my expenses?', [], mockBot as unknown as import('gramio').Bot);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('calls Anthropic messages.stream with user message', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(makeFakeStream() as unknown as ReturnType<typeof anthropic.messages.stream>);

      await agent.run('How much did I spend?', [], mockBot as unknown as import('gramio').Bot);
      expect(streamSpy).toHaveBeenCalled();
    });

    it('handles empty conversation history', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      spyOn(anthropic.messages, 'stream').mockReturnValue(makeFakeStream() as unknown as ReturnType<typeof anthropic.messages.stream>);

      const result = await agent.run('Hello', [], mockBot as unknown as import('gramio').Bot);
      expect(result).toBeTruthy();
    });

    it('includes conversation history in Anthropic call', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(makeFakeStream() as unknown as ReturnType<typeof anthropic.messages.stream>);

      const history = [
        { id: 1, group_id: 1, user_id: 10, role: 'user' as const, content: 'Hi', created_at: '2026-01-01' },
        { id: 2, group_id: 1, user_id: 10, role: 'assistant' as const, content: 'Hello!', created_at: '2026-01-01' },
      ];
      await agent.run('Thanks', history, mockBot as unknown as import('gramio').Bot);

      const callArgs = streamSpy.mock.calls[0][0] as Anthropic.MessageStreamParams;
      expect(callArgs.messages.length).toBeGreaterThan(1); // history + new message
    });

    // TDD error handling: write FIRST (fail) → fix agent.ts → pass

    it('[TDD] wraps Anthropic 429 as AnthropicError', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const apiError = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      spyOn(anthropic.messages, 'stream').mockImplementation(() => { throw apiError; });

      // First: test FAILS because agent throws plain Error
      // Then: add try/catch in agent.ts that maps status:429 → AnthropicError
      const { AnthropicError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot)
      ).rejects.toBeInstanceOf(AnthropicError);
    });

    it('[TDD] wraps Anthropic 5xx as AnthropicError', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const serverErr = Object.assign(new Error('Internal server error'), { status: 500 });
      spyOn(anthropic.messages, 'stream').mockImplementation(() => { throw serverErr; });

      const { AnthropicError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot)
      ).rejects.toBeInstanceOf(AnthropicError);
    });

    it('[TDD] wraps timeout as NetworkError', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const timeoutErr = Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' });
      spyOn(anthropic.messages, 'stream').mockImplementation(() => { throw timeoutErr; });

      const { NetworkError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot)
      ).rejects.toBeInstanceOf(NetworkError);
    });
  });
});
```

**Aim for ~50 tests.** After the skeleton above compiles and runs, add more cases:
- Tool call loop: mock stream that yields a `tool_use` block, verify `executeTool` is called
- MAX_TOOL_ROUNDS: mock 11 consecutive tool calls, verify loop exits cleanly
- Timeout (AGENT_TIMEOUT_MS): use `setSystemTime` from `bun:test` to advance clock
- `buildHistoryMessages`: verify role mapping user/assistant, trimming long history

```bash
bun test src/services/ai/agent.test.ts
git commit -m "test(ai): add agent tests — streaming, tool calls, error handling"
```

---

### Task A5-4: Final run — all Agent 5 tests

```bash
bun test src/services/ai/agent.test.ts src/services/ai/telegram-stream.test.ts src/bot/bot-error-formatter.test.ts
```
Expected: ~130 tests, all green.

---

