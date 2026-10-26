/** TelegramStreamWriter flush: error cooldown, HTML fallback, 429 handling, mutex, placeholder reuse. */
import { describe, expect, mock, test } from 'bun:test';
import { makeTelegramError, TelegramStreamWriter } from './telegram-stream.test-helpers';

// ── flush: error cooldown ─────────────────────────────────────────────

describe('flush error cooldown', () => {
  test('sets lastErrorTime on generic API error to prevent rapid retries', async () => {
    let callCount = 0;
    const fakeBot = {
      api: {
        sendMessage: mock(() => {
          callCount++;
          return Promise.reject({
            payload: { error_code: 400, description: 'Bad Request: text must be non-empty' },
          });
        }),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock(() => Promise.resolve()),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;
    const writer = new TelegramStreamWriter(fakeBot, 123);

    // First flush: fails and sets lastErrorTime
    writer.appendText('some text that is definitely long enough to flush');
    await writer.flush(true);
    const firstCallCount = callCount;

    // Second flush immediately after: should be blocked by ERROR_COOLDOWN_MS
    writer.appendText(' more text');
    await writer.flush(true);
    const secondCallCount = callCount;

    // No additional send attempt should have been made
    expect(secondCallCount).toBe(firstCallCount);

    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });
});

// ── sendOrEdit: HTML error fallback ─────────────────────────────────

describe('sendOrEdit HTML error fallback', () => {
  test('falls back to plain text when editMessageText fails with HTML parse error', async () => {
    const calls: Array<{ text: string; parse_mode?: string }> = [];

    const fakeBot = {
      api: {
        sendMessage: mock((opts: { text: string; parse_mode?: string }) => {
          calls.push(opts);
          return Promise.resolve({ message_id: 1 });
        }),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock((opts: { text: string; parse_mode?: string }) => {
          calls.push(opts);
          if (opts.parse_mode === 'HTML') {
            return Promise.reject(
              makeTelegramError(
                'Bad Request: can\'t parse entities: Can\'t find end tag corresponding to start tag "i"',
                400,
              ),
            );
          }
          // Plain text retry succeeds
          return Promise.resolve();
        }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;

    const writer = new TelegramStreamWriter(fakeBot, 123);

    // Set fullText directly to avoid appendText's fire-and-forget flush timing issues
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'first text';
    await writer.flush(true); // sendMessage succeeds → sentMessageId set

    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'first text more text';
    // biome-ignore lint/suspicious/noExplicitAny: reset to force new edit
    (writer as any).lastSentText = '';
    await writer.flush(true); // editMessageText with HTML fails → plain text fallback

    // Should have a plain text call (no parse_mode) from sendPlainTextFallback
    const plainTextCall = calls.find(
      (c) => !c.parse_mode && c.text && c.text.includes('first text'),
    );
    expect(plainTextCall).toBeDefined();

    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });

  test('finalize succeeds even after multiple failed intermediate flushes', async () => {
    let editCallCount = 0;
    let lastSuccessText = '';

    const fakeBot = {
      api: {
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock((opts: { text: string; parse_mode?: string }) => {
          editCallCount++;
          if (opts.parse_mode === 'HTML' && editCallCount <= 2) {
            return Promise.reject(
              makeTelegramError("Bad Request: can't parse entities: Can't find end tag", 400),
            );
          }
          // Plain text fallback and later HTML edits succeed
          lastSuccessText = opts.text;
          return Promise.resolve();
        }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;

    const writer = new TelegramStreamWriter(fakeBot, 123);

    // First flush: sendMessage succeeds (sets sentMessageId)
    writer.appendText('<i>partial');
    await writer.flush(true);

    // Second flush: editMessageText fails → plain text fallback
    writer.appendText(' streaming');
    await writer.flush(true);

    // Finalize: AI finished, tags are closed now
    writer.appendText('</i> done.');
    await writer.finalize();

    // finalize should have sent something
    expect(lastSuccessText).toBeTruthy();
    expect(lastSuccessText).toContain('done');

    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });
});

// ── 429 rate limit handling ─────────────────────────────────────────

describe('429 rate limit handling', () => {
  test('retries after 429 and succeeds on second attempt', async () => {
    let editCount = 0;
    const fakeBot = {
      api: {
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock(() => {
          editCount++;
          if (editCount === 1) {
            // First edit: 429 with minimal retry_after for fast test
            return Promise.reject(
              makeTelegramError('Too Many Requests: retry after 1', 429, { retry_after: 1 }),
            );
          }
          // Retry succeeds
          return Promise.resolve();
        }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;
    const writer = new TelegramStreamWriter(fakeBot, 123);

    // Pre-set sentMessageId so the placeholder-adoption path is bypassed for this test
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).sentMessageId = 1;

    // Flush: editMessageText → 429 → wait → retry succeeds
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'updated text';
    const start = Date.now();
    await writer.flush(true);
    const elapsed = Date.now() - start;

    // Should have retried: 2 edit calls (original 429 + retry success)
    expect(editCount).toBe(2);
    // Should have waited ~1 second for retry_after
    expect(elapsed).toBeGreaterThanOrEqual(900);

    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });

  test('"message is not modified" is silently ignored (no cooldown)', async () => {
    let editCount = 0;
    const fakeBot = {
      api: {
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock(() => {
          editCount++;
          if (editCount === 1) {
            return Promise.reject(makeTelegramError('Bad Request: message is not modified', 400));
          }
          return Promise.resolve();
        }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;
    const writer = new TelegramStreamWriter(fakeBot, 123);

    // Pre-set sentMessageId so the placeholder-adoption path is bypassed for this test
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).sentMessageId = 1;

    // First flush: editMessageText → "not modified" (silently OK, no cooldown)
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'same text';
    await writer.flush(true);
    expect(editCount).toBe(1);

    // Third flush: should NOT be blocked — "not modified" doesn't set lastErrorTime
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'different text now';
    // biome-ignore lint/suspicious/noExplicitAny: reset to force new edit
    (writer as any).lastSentText = '';
    // biome-ignore lint/suspicious/noExplicitAny: reset flush time to bypass throttle
    (writer as any).lastFlushTime = 0;
    await writer.flush(true);
    expect(editCount).toBeGreaterThanOrEqual(2);

    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });
});

// ── flush mutex (concurrent call prevention) ─────────────────────────

describe('flush mutex prevents concurrent API calls', () => {
  test('concurrent flush(true) calls result in at most 1 editMessageText', async () => {
    let editCount = 0;
    const fakeBot = {
      api: {
        sendMessage: mock(() => Promise.resolve({ message_id: 1 })),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock(() => {
          editCount++;
          // Simulate network delay — while this is in flight, other flush calls arrive
          return new Promise((resolve) => setTimeout(resolve, 50));
        }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;
    const writer = new TelegramStreamWriter(fakeBot, 123);

    // Pre-set sentMessageId so the placeholder-adoption path is bypassed for this test
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).sentMessageId = 1;

    // Fire 20 concurrent flush(true) calls — simulating rapid token arrival
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'updated text with many tokens';
    // biome-ignore lint/suspicious/noExplicitAny: reset to force different text
    (writer as any).lastSentText = '';
    const promises: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      promises.push(writer.flush(true));
    }
    await Promise.all(promises);

    // Mutex ensures only 1 editMessageText call, not 20
    expect(editCount).toBe(1);

    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });
});

// ── placeholder reuse (double-message race prevention) ───────────────

describe('placeholder reuse prevents double-message race', () => {
  test('reuses placeholder when flush fires before placeholder resolves', async () => {
    let sendCount = 0;
    let editCount = 0;
    let resolvePlaceholder!: (id: number) => void;
    const slowPlaceholder = new Promise<{ message_id: number }>((resolve) => {
      resolvePlaceholder = (id) => resolve({ message_id: id });
    });

    const fakeBot = {
      api: {
        sendMessage: mock(async () => {
          sendCount++;
          return slowPlaceholder; // placeholder creation is artificially slow
        }),
        sendChatAction: () => Promise.resolve(),
        deleteMessage: () => Promise.resolve(),
        editMessageText: mock(() => {
          editCount++;
          return Promise.resolve();
        }),
      },
      // biome-ignore lint/suspicious/noExplicitAny: test stub
    } as any;

    const writer = new TelegramStreamWriter(fakeBot, 123);

    // Start a flush before the placeholder resolves — simulates the race
    // biome-ignore lint/suspicious/noExplicitAny: direct field access for deterministic test
    (writer as any).fullText = 'streaming content';
    const flushPromise = writer.flush(true);

    // Resolve placeholder while flush is awaiting it
    resolvePlaceholder(1);
    await flushPromise;

    // Only 1 sendMessage (the placeholder), no extra sendMessage
    expect(sendCount).toBe(1);
    // Content delivered via editMessageText (placeholder reused, no new sendMessage)
    expect(editCount).toBe(1);

    // biome-ignore lint/suspicious/noExplicitAny: access private method
    (writer as any).stopTyping();
  });
});
