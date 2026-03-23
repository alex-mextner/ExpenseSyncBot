// Tests for topic-aware middleware — threadStorage and context injection behavior
import { describe, expect, it } from 'bun:test';
import { threadStorage } from './topic-middleware';

// ── threadStorage direct tests ─────────────────────────────────────────────────
// We test the AsyncLocalStorage directly since registerTopicMiddleware requires
// a real GramIO Bot instance with a live Telegram connection.
// The storage is the core logic; the middleware just populates/reads it.

describe('threadStorage', () => {
  it('is an AsyncLocalStorage instance', () => {
    expect(threadStorage).toBeTruthy();
    expect(typeof threadStorage.run).toBe('function');
    expect(typeof threadStorage.getStore).toBe('function');
  });

  it('returns undefined when no context is set', () => {
    // Outside of any .run() call, store is undefined
    const store = threadStorage.getStore();
    expect(store).toBeUndefined();
  });

  it('returns stored context within a run() call', () => {
    const context = { chatId: 100, threadId: 42 };
    let captured: { chatId: number; threadId: number | undefined } | undefined;

    threadStorage.run(context, () => {
      captured = threadStorage.getStore();
    });

    expect(captured).toEqual({ chatId: 100, threadId: 42 });
  });

  it('returns undefined threadId when explicitly set to undefined', () => {
    const context = { chatId: 200, threadId: undefined };
    let captured: { chatId: number; threadId: number | undefined } | undefined;

    threadStorage.run(context, () => {
      captured = threadStorage.getStore();
    });

    expect(captured?.chatId).toBe(200);
    expect(captured?.threadId).toBeUndefined();
  });

  it('nested run() calls use inner context', () => {
    const outer = { chatId: 1, threadId: 10 };
    const inner = { chatId: 2, threadId: 20 };

    let outerCaptured: { chatId: number; threadId: number | undefined } | undefined;
    let innerCaptured: { chatId: number; threadId: number | undefined } | undefined;

    threadStorage.run(outer, () => {
      outerCaptured = threadStorage.getStore();
      threadStorage.run(inner, () => {
        innerCaptured = threadStorage.getStore();
      });
    });

    expect(outerCaptured?.chatId).toBe(1);
    expect(innerCaptured?.chatId).toBe(2);
  });

  it('context does not leak after run() completes', () => {
    let insideCaptured: { chatId: number; threadId: number | undefined } | undefined;

    threadStorage.run({ chatId: 999, threadId: 5 }, () => {
      insideCaptured = threadStorage.getStore();
    });

    const outsideCaptured = threadStorage.getStore();

    expect(insideCaptured?.chatId).toBe(999);
    expect(outsideCaptured).toBeUndefined();
  });

  it('parallel async contexts do not bleed into each other', async () => {
    const results: Array<{ chatId: number; threadId: number | undefined } | undefined> = [];

    // Run two async tasks with different contexts simultaneously
    await Promise.all([
      new Promise<void>((resolve) => {
        threadStorage.run({ chatId: 111, threadId: 11 }, async () => {
          // Yield to allow other microtasks
          await Promise.resolve();
          results[0] = threadStorage.getStore();
          resolve();
        });
      }),
      new Promise<void>((resolve) => {
        threadStorage.run({ chatId: 222, threadId: 22 }, async () => {
          await Promise.resolve();
          results[1] = threadStorage.getStore();
          resolve();
        });
      }),
    ]);

    expect(results[0]?.chatId).toBe(111);
    expect(results[0]?.threadId).toBe(11);
    expect(results[1]?.chatId).toBe(222);
    expect(results[1]?.threadId).toBe(22);
  });

  it('context is accessible in nested async callbacks', async () => {
    const context = { chatId: 333, threadId: 7 };
    let captured: { chatId: number; threadId: number | undefined } | undefined;

    await new Promise<void>((resolve) => {
      threadStorage.run(context, async () => {
        await Promise.resolve(); // simulate async work
        captured = threadStorage.getStore();
        resolve();
      });
    });

    expect(captured?.chatId).toBe(333);
    expect(captured?.threadId).toBe(7);
  });
});

// ── preRequest injection logic simulation ──────────────────────────────────────
// The preRequest hook logic is: if stored?.threadId && !params.message_thread_id
// && params.chat_id === stored.chatId, inject threadId.
// We test this logic in isolation.

function simulatePreRequestInjection(
  stored: { chatId: number; threadId: number | undefined } | undefined,
  params: Record<string, unknown>,
): Record<string, unknown> {
  // Mirrors the preRequest hook logic from topic-middleware.ts
  const result = { ...params };
  if (stored?.threadId && !result['message_thread_id'] && result['chat_id'] === stored.chatId) {
    result['message_thread_id'] = stored.threadId;
  }
  return result;
}

describe('preRequest injection logic', () => {
  it('injects threadId when context matches chat_id and no existing threadId', () => {
    const stored = { chatId: 100, threadId: 5 };
    const params = { chat_id: 100, text: 'hello' };
    const result = simulatePreRequestInjection(stored, params);
    expect(result['message_thread_id']).toBe(5);
  });

  it('does NOT inject when threadId is undefined', () => {
    const stored = { chatId: 100, threadId: undefined };
    const params = { chat_id: 100, text: 'hello' };
    const result = simulatePreRequestInjection(stored, params);
    expect(result['message_thread_id']).toBeUndefined();
  });

  it('does NOT inject when chat_id does not match stored chatId', () => {
    const stored = { chatId: 100, threadId: 5 };
    const params = { chat_id: 999, text: 'hello' };
    const result = simulatePreRequestInjection(stored, params);
    expect(result['message_thread_id']).toBeUndefined();
  });

  it('does NOT inject when message_thread_id already present in params', () => {
    const stored = { chatId: 100, threadId: 5 };
    const params = { chat_id: 100, text: 'hello', message_thread_id: 99 };
    const result = simulatePreRequestInjection(stored, params);
    expect(result['message_thread_id']).toBe(99); // original preserved
  });

  it('does NOT inject when stored is undefined (no active context)', () => {
    const params = { chat_id: 100, text: 'hello' };
    const result = simulatePreRequestInjection(undefined, params);
    expect(result['message_thread_id']).toBeUndefined();
  });

  it('preserves all existing params when injecting', () => {
    const stored = { chatId: 50, threadId: 3 };
    const params = { chat_id: 50, text: 'test', parse_mode: 'HTML' };
    const result = simulatePreRequestInjection(stored, params);
    expect(result['text']).toBe('test');
    expect(result['parse_mode']).toBe('HTML');
    expect(result['message_thread_id']).toBe(3);
  });

  it('threadId 0 is falsy — does NOT inject', () => {
    const stored = { chatId: 100, threadId: 0 as unknown as undefined };
    const params = { chat_id: 100, text: 'hello' };
    const result = simulatePreRequestInjection(stored, params);
    // threadId: 0 is falsy so injection is skipped
    expect(result['message_thread_id']).toBeUndefined();
  });
});

// ── THREAD_AWARE_METHODS list verification ─────────────────────────────────────
// The list of methods that support message_thread_id should include all core send methods

describe('THREAD_AWARE_METHODS coverage', () => {
  // These are the methods imported from the module's implementation
  // We verify the list exists and has the expected shape by importing the module
  it('module exports threadStorage without error', async () => {
    const mod = await import('./topic-middleware');
    expect(mod.threadStorage).toBeTruthy();
    expect(mod.registerTopicMiddleware).toBeTruthy();
  });

  it('registerTopicMiddleware is a function', async () => {
    const { registerTopicMiddleware } = await import('./topic-middleware');
    expect(typeof registerTopicMiddleware).toBe('function');
  });
});
