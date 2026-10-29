import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

const log = createMockLogger();
mock.module('../../utils/logger', () => ({ createLogger: () => log, logger: log }));
const env = {
  ANTHROPIC_API_KEY: 'zai-key',
  AI_BASE_URL: 'https://zai.test/v1',
  AI_MODEL: 'zai-fixture',
  CLAUDE_API_TOKEN: 'primary-key',
  CLAUDE_API_TOKEN2: 'secondary-key',
  CLAUDE_BASE_URL: 'https://claude.test/v1',
  CLAUDE_MODEL: 'claude-haiku-fixture',
  AI_SMART_CHAIN: { order: ['claude', 'zai'], fromEnv: true, fallback: ['claude', 'zai'] },
  AI_ROUTING: 'legacy',
};
mock.module('../../config/env', () => ({ env }));
const rows: { provider: string; outcome: string; httpStatus: number | null }[] = [];
mock.module('./usage-recorder', () => ({
  recordAiUsage: (events: typeof rows) => rows.push(...events),
}));
const { aiStreamRound } = await import('./streaming');
const breaker = await import('./provider-breaker');
const { resetClients, claudeClient } = await import('./clients');
const { openChatStream } = await import('./streaming/request-params');
const originalFetch = globalThis.fetch;
const request = {
  messages: [{ role: 'user' as const, content: 'Synthetic EUR 12.50' }],
  maxTokens: 32,
  purpose: 'probe' as const,
};
const response = () =>
  new Response(
    'data: ' +
      JSON.stringify({
        id: 'synthetic',
        object: 'chat.completion.chunk',
        created: 0,
        model: env.CLAUDE_MODEL,
        choices: [{ index: 0, delta: { content: '12.50 EUR' }, finish_reason: 'stop' }],
      }) +
      '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );

beforeEach(() => {
  resetClients();
  breaker.resetProviderBreaker();
  rows.length = 0;
  log.warn.mockClear();
  log.error.mockClear();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetClients();
  breaker.resetProviderBreaker();
});

test('cooling credentials skip without HTTP error rows or breaker responses, then recover', async () => {
  let now = Date.now();
  let recover = false;
  let claudeCalls = 0;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  const responded = spyOn(breaker, 'recordProviderResponded');
  try {
    globalThis.fetch = (async (url: string | URL | Request) => {
      if (String(url).includes('claude.test')) {
        claudeCalls++;
        if (!recover)
          return Response.json({ error: { message: 'synthetic unauthorized' } }, { status: 401 });
      }
      return response();
    }) as unknown as typeof fetch;
    expect((await aiStreamRound(request)).providerUsed).toBe('z.ai (zai-fixture)');
    expect(claudeCalls).toBe(2);
    expect(rows.filter((row) => row.provider === 'claude').map((row) => row.outcome)).toEqual([
      'error',
      'error',
    ]);
    const responseCount = responded.mock.calls.length;
    rows.length = 0;
    expect((await aiStreamRound(request)).providerUsed).toBe('z.ai (zai-fixture)');
    expect(claudeCalls).toBe(2);
    expect(rows.filter((row) => row.provider === 'claude')).toHaveLength(1);
    expect(rows.find((row) => row.provider === 'claude')?.outcome).toBe('skipped');
    expect(rows.find((row) => row.provider === 'claude')?.httpStatus).toBeNull();
    expect(responded.mock.calls.length).toBe(responseCount);
    now += 86_400_001;
    recover = true;
    rows.length = 0;
    expect((await aiStreamRound(request)).providerUsed).toBe('Claude (claude-haiku-fixture)');
    expect(claudeCalls).toBe(3);
    expect(rows.map((row) => row.outcome)).toEqual(['ok']);
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  } finally {
    responded.mockRestore();
    clock.mockRestore();
  }
});

test('request-specific moderation rejection does not rotate or cool either credential', async () => {
  const attempts: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    attempts.push(new Headers(init?.headers).get('authorization') ?? '');
    return Response.json(
      { error: { message: 'input was flagged by content policy' } },
      { status: 403 },
    );
  }) as unknown as typeof fetch;
  for (let index = 0; index < 2; index++) {
    await expect(
      openChatStream(
        claudeClient(),
        { messages: request.messages, max_tokens: 32, model: env.CLAUDE_MODEL, stream: true },
        undefined,
        'claude',
        env.CLAUDE_MODEL,
      ),
    ).rejects.toThrow();
  }
  expect(attempts).toEqual(['Bearer primary-key', 'Bearer primary-key']);
  expect(log.warn).not.toHaveBeenCalled();
  expect(log.error).not.toHaveBeenCalled();
});

test('provider demotion ends when the earliest Claude credential can recover', async () => {
  const now = Date.now();
  const clock = spyOn(Date, 'now').mockReturnValue(now);
  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes('claude.test')) return response();
      const primary = new Headers(init?.headers).get('authorization') === 'Bearer primary-key';
      return Response.json(
        { error: { message: 'synthetic rate limit' } },
        { status: 429, headers: { 'retry-after': primary ? '1' : '86400' } },
      );
    }) as unknown as typeof fetch;
    expect((await aiStreamRound(request)).providerUsed).toBe('z.ai (zai-fixture)');
    expect(breaker.isProviderDemoted('claude', now + 1500)).toBe(false);
    expect(rows.filter((row) => row.provider === 'claude').map((row) => row.httpStatus)).toEqual([
      429, 429,
    ]);
    expect(log.warn).toHaveBeenCalled();
    expect(log.error).toHaveBeenCalled();
  } finally {
    clock.mockRestore();
  }
});
