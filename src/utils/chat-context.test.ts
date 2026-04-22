// Tests for AsyncLocalStorage-backed chat context: scoping, nesting, async boundaries, errors.
// Uses the real AsyncLocalStorage — no mocks.
import { describe, expect, test } from 'bun:test';
import { chatStorage, withChatContext } from './chat-context';

describe('withChatContext', () => {
  test('sets chatId and threadId inside the callback', async () => {
    let seen: { chatId: number; threadId: number | null } | undefined;
    await withChatContext(-1001, 42, async () => {
      seen = chatStorage.getStore();
    });
    expect(seen).toEqual({ chatId: -1001, threadId: 42 });
  });

  test('accepts threadId=null for the General topic', async () => {
    let seen: { chatId: number; threadId: number | null } | undefined;
    await withChatContext(-1001, null, async () => {
      seen = chatStorage.getStore();
    });
    expect(seen).toEqual({ chatId: -1001, threadId: null });
  });

  test('returns the value produced by the callback', async () => {
    const out = await withChatContext(-1, null, async () => 'payload');
    expect(out).toBe('payload');
  });

  test('getStore() returns undefined outside withChatContext', () => {
    // No wrapping context → AsyncLocalStorage returns undefined
    expect(chatStorage.getStore()).toBeUndefined();
  });

  test('nested context — inner overrides outer, outer restored after', async () => {
    const seen: Array<{ chatId: number; threadId: number | null } | undefined> = [];

    await withChatContext(-100, 7, async () => {
      seen.push(chatStorage.getStore());
      await withChatContext(-200, 9, async () => {
        seen.push(chatStorage.getStore());
      });
      seen.push(chatStorage.getStore());
    });

    expect(seen).toEqual([
      { chatId: -100, threadId: 7 },
      { chatId: -200, threadId: 9 },
      { chatId: -100, threadId: 7 },
    ]);
  });

  test('context is preserved across await boundaries', async () => {
    let observed: { chatId: number; threadId: number | null } | undefined;

    await withChatContext(-42, 3, async () => {
      // Yield to the event loop multiple times — each await must keep context
      await Promise.resolve();
      await new Promise((r) => setTimeout(r, 1));
      await Promise.resolve().then(() => Promise.resolve());
      observed = chatStorage.getStore();
    });

    expect(observed).toEqual({ chatId: -42, threadId: 3 });
  });

  test('context isolation — parallel contexts do not leak', async () => {
    const observed: Array<number | undefined> = [];

    await Promise.all(
      [-1, -2, -3].map((id) =>
        withChatContext(id, null, async () => {
          // Yield so the scheduler interleaves all three
          await new Promise((r) => setTimeout(r, id === -2 ? 3 : 1));
          observed.push(chatStorage.getStore()?.chatId);
        }),
      ),
    );

    expect(observed.sort((a, b) => (a ?? 0) - (b ?? 0))).toEqual([-3, -2, -1]);
  });

  test('context is cleared after the callback resolves', async () => {
    await withChatContext(-500, null, async () => {
      expect(chatStorage.getStore()?.chatId).toBe(-500);
    });
    expect(chatStorage.getStore()).toBeUndefined();
  });

  test('thrown error propagates and context is cleared', async () => {
    await expect(
      withChatContext(-1, null, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(chatStorage.getStore()).toBeUndefined();
  });

  test('synchronously-thrown error inside async callback still clears context', async () => {
    let observedInside: number | undefined;
    try {
      await withChatContext(-7, null, async () => {
        observedInside = chatStorage.getStore()?.chatId;
        throw new Error('sync throw inside async');
      });
    } catch {
      // expected
    }
    expect(observedInside).toBe(-7);
    expect(chatStorage.getStore()).toBeUndefined();
  });

  test('nested error in inner context does not corrupt outer context', async () => {
    const seenAfterInner: Array<number | undefined> = [];

    await withChatContext(-10, null, async () => {
      try {
        await withChatContext(-20, null, async () => {
          throw new Error('inner boom');
        });
      } catch {
        // expected
      }
      seenAfterInner.push(chatStorage.getStore()?.chatId);
    });

    expect(seenAfterInner).toEqual([-10]);
  });

  test('works with deeply nested callbacks using setImmediate/setTimeout', async () => {
    let deepSeen: number | undefined;

    await withChatContext(-77, 5, async () => {
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          // Still inside context after a setTimeout hop
          deepSeen = chatStorage.getStore()?.chatId;
          resolve();
        }, 2);
      });
    });

    expect(deepSeen).toBe(-77);
  });
});
