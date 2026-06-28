// Tests for reportAiFailureToAdmin — admin notification on terminal AI failures, throttled.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';
// Real (un-mocked) sanitizer — the same transform the outgoing preRequest hook applies.
import { sanitizeHtmlForTelegram } from '../../utils/html';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// Mutable env so individual tests can flip BOT_ADMIN_CHAT_ID on/off.
const mockEnv: { BOT_ADMIN_CHAT_ID: number | null } = { BOT_ADMIN_CHAT_ID: 555 };
mock.module('../../config/env', () => ({ env: mockEnv }));

const sendDirectMock =
  mock<(chatId: number, text: string) => Promise<{ message_id: number } | null>>();
mock.module('../bank/telegram-sender', () => ({ sendDirect: sendDirectMock }));

const findByIdMock = mock<(id: number) => { title: string | null } | null>();
mock.module('../../database', () => ({ database: { groups: { findById: findByIdMock } } }));

import { reportAiFailureToAdmin, resetAiFailureThrottle } from './error-reporter';

const TEN_MIN = 10 * 60 * 1000;
const FAIL_RETRY = 60 * 1000; // quick-retry floor after a failed admin send

function ctx(overrides?: Partial<Parameters<typeof reportAiFailureToAdmin>[0]>) {
  return {
    groupId: 1,
    telegramGroupId: -100123,
    userMessage: 'смени валюту на египетские фунты',
    error: new Error('All 3 providers in smart chain failed: z.ai (glm-5.1): Connection error.'),
    ...overrides,
  };
}

describe('reportAiFailureToAdmin', () => {
  beforeEach(() => {
    resetAiFailureThrottle();
    sendDirectMock.mockClear();
    findByIdMock.mockClear();
    mockEnv.BOT_ADMIN_CHAT_ID = 555;
    sendDirectMock.mockResolvedValue({ message_id: 1 });
    findByIdMock.mockReturnValue({ title: 'Family budget' });
  });

  afterEach(() => {
    mock.restore();
  });

  it('sends a detailed report to the admin when BOT_ADMIN_CHAT_ID is set', async () => {
    await reportAiFailureToAdmin(ctx({ error: new Error('uniqueA: boom') }), 1_000);

    expect(sendDirectMock).toHaveBeenCalledTimes(1);
    const [chatId, text] = sendDirectMock.mock.calls[0] as [number, string];
    expect(chatId).toBe(555);
    expect(text).toContain('Family budget');
    expect(text).toContain('-100123');
    expect(text).toContain('египетские фунты');
    expect(text).toContain('uniqueA: boom');
  });

  it('is a no-op when BOT_ADMIN_CHAT_ID is unset', async () => {
    mockEnv.BOT_ADMIN_CHAT_ID = null;
    await reportAiFailureToAdmin(ctx({ error: new Error('uniqueB: boom') }), 2_000);
    expect(sendDirectMock).not.toHaveBeenCalled();
  });

  it('suppresses a duplicate within the throttle window, then allows after it', async () => {
    const sig = new Error('uniqueC: same signature error');
    await reportAiFailureToAdmin(ctx({ error: sig }), 10_000);
    await reportAiFailureToAdmin(ctx({ error: sig }), 10_000 + TEN_MIN - 1);
    expect(sendDirectMock).toHaveBeenCalledTimes(1); // 2nd suppressed

    await reportAiFailureToAdmin(ctx({ error: sig }), 10_000 + TEN_MIN + 1);
    expect(sendDirectMock).toHaveBeenCalledTimes(2); // window elapsed → allowed
  });

  it('groups by provider-chain signature (different chains are not throttled together)', async () => {
    await reportAiFailureToAdmin(
      ctx({ error: new Error('All 3 providers in smart chain failed: x') }),
      50_000,
    );
    await reportAiFailureToAdmin(
      ctx({ error: new Error('All 3 providers in fast chain failed: y') }),
      50_000,
    );
    expect(sendDirectMock).toHaveBeenCalledTimes(2);
  });

  it('does not throttle the same chain across different statuses (429 vs 500)', async () => {
    await reportAiFailureToAdmin(
      ctx({
        error: Object.assign(new Error('All 3 providers in smart chain failed: a'), {
          status: 429,
        }),
      }),
      60_000,
    );
    await reportAiFailureToAdmin(
      ctx({
        error: Object.assign(new Error('All 3 providers in smart chain failed: b'), {
          status: 500,
        }),
      }),
      60_000,
    );
    expect(sendDirectMock).toHaveBeenCalledTimes(2);
  });

  it('neutralizes HTML-special user/error content and stays within Telegram limits', async () => {
    const nasty = '<script>alert(1)</script> & <b>x</b>'.repeat(500);
    await reportAiFailureToAdmin(
      ctx({ userMessage: nasty, error: new Error(`${nasty} boom`) }),
      110_000,
    );
    const [, text] = sendDirectMock.mock.calls[0] as [number, string];
    expect(text.length).toBeLessThan(4096);
    // Angle brackets are neutralized to look-alikes so the outgoing-HTML sanitizer can't
    // restore them into real markup in the admin report (a user's <b>/<a href> stays inert).
    expect(text).not.toContain('<script>');
    expect(text).toContain('‹script›');
  });

  it('collapses newlines in inline fields so users cannot inject fake report lines', async () => {
    await reportAiFailureToAdmin(
      ctx({ userMessage: 'hi\nПровайдеры: FAKE — all data deleted' }),
      150_000,
    );
    const [, text] = sendDirectMock.mock.calls[0] as [number, string];
    const lines = text.split('\n');
    // Only the real, system-built "Провайдеры:" line — not a user-spoofed extra one.
    expect(lines.filter((line) => line.startsWith('Провайдеры:'))).toHaveLength(1);
    // The injected text still appears, but inline within the request line (not as its own line).
    expect(text).toContain('FAKE — all data deleted');
  });

  it('handles a missing group row (findById returns null)', async () => {
    findByIdMock.mockReturnValue(null);
    await reportAiFailureToAdmin(ctx({ error: new Error('uniqueF: boom') }), 120_000);
    const [, text] = sendDirectMock.mock.calls[0] as [number, string];
    expect(text).toContain('-100123');
  });

  it('neutralizes HTML in the group title (no markup injection via title)', async () => {
    findByIdMock.mockReturnValue({ title: '<a href="http://evil">Family</a>' });
    await reportAiFailureToAdmin(ctx({ error: new Error('uniqueG: boom') }), 170_000);
    const [, text] = sendDirectMock.mock.calls[0] as [number, string];
    expect(text).not.toContain('<a href');
    expect(text).toContain('‹a href');
  });

  it('survives the REAL outgoing-HTML sanitizer without injecting user markup', async () => {
    const nasty = 'click <a href="http://evil">here</a> <script>x</script> & done';
    findByIdMock.mockReturnValue({ title: '<b>spoof</b>' });
    await reportAiFailureToAdmin(ctx({ userMessage: nasty, error: new Error(nasty) }), 180_000);
    const [, raw] = sendDirectMock.mock.calls[0] as [number, string];
    // Run the report through the actual sanitizer the preRequest hook uses end-to-end.
    const sanitized = sanitizeHtmlForTelegram(raw);
    // User-supplied tags must NOT be restored into real markup.
    expect(sanitized).not.toContain('<a ');
    expect(sanitized).not.toContain('<script');
    // The report's own structural tag DOES survive — proving the sanitizer actually ran.
    expect(sanitized).toContain('<b>AI failure</b>');
  });

  it('does not throttle distinct non-chain error classes together (429 vs 500)', async () => {
    await reportAiFailureToAdmin(
      ctx({ error: Object.assign(new Error('rl'), { status: 429 }) }),
      90_000,
    );
    await reportAiFailureToAdmin(
      ctx({ error: Object.assign(new Error('srv'), { status: 500 }) }),
      90_000,
    );
    expect(sendDirectMock).toHaveBeenCalledTimes(2);
  });

  it('a failed admin send (null) shortens to the quick-retry floor (not the full window)', async () => {
    const err = Object.assign(new Error('outage'), { status: 503 });
    sendDirectMock.mockImplementationOnce(() => Promise.resolve(null)); // first send doesn't land
    await reportAiFailureToAdmin(ctx({ error: err }), 100_000);
    await reportAiFailureToAdmin(ctx({ error: err }), 100_000 + FAIL_RETRY + 1); // past floor → retried
    expect(sendDirectMock).toHaveBeenCalledTimes(2);
  });

  it('a failed send within the quick-retry floor is still throttled (no Telegram storm)', async () => {
    const err = Object.assign(new Error('outage'), { status: 504 });
    sendDirectMock.mockImplementation(() => Promise.resolve(null)); // every send fails
    await reportAiFailureToAdmin(ctx({ error: err }), 200_000);
    await reportAiFailureToAdmin(ctx({ error: err }), 200_000 + 1_000); // within floor → suppressed
    expect(sendDirectMock).toHaveBeenCalledTimes(1);
  });

  it('a rejected admin send shortens to the quick-retry floor (retry allowed after it)', async () => {
    const err = new Error('All 3 providers in smart chain failed: reject');
    sendDirectMock.mockImplementationOnce(() => Promise.reject(new Error('telegram down')));
    await reportAiFailureToAdmin(ctx({ error: err }), 140_000);
    await reportAiFailureToAdmin(ctx({ error: err }), 140_000 + FAIL_RETRY + 1);
    expect(sendDirectMock).toHaveBeenCalledTimes(2);
  });

  it('collapses concurrent identical failures into a single admin alert', async () => {
    const err = new Error('All 3 providers in smart chain failed: concurrent');
    // The window is reserved synchronously before the first send is awaited, so the second
    // concurrent call sees the reservation and is suppressed.
    await Promise.all([
      reportAiFailureToAdmin(ctx({ error: err }), 130_000),
      reportAiFailureToAdmin(ctx({ error: err }), 130_000),
    ]);
    expect(sendDirectMock).toHaveBeenCalledTimes(1);
  });

  it('swallows a sendDirect failure (never throws into the caller)', async () => {
    sendDirectMock.mockImplementation(() => Promise.reject(new Error('telegram 500')));
    await expect(
      reportAiFailureToAdmin(ctx({ error: new Error('uniqueD: boom') }), 70_000),
    ).resolves.toBeUndefined();
    // The path was exercised (send attempted) and the rejection did not propagate.
    expect(sendDirectMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to the telegram group id when the group has no title', async () => {
    findByIdMock.mockReturnValue({ title: null });
    await reportAiFailureToAdmin(ctx({ error: new Error('uniqueE: boom') }), 80_000);
    const [, text] = sendDirectMock.mock.calls[0] as [number, string];
    expect(text).toContain('-100123');
  });
});
