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
const { aiStreamRound, isRetryableError } = await import('./streaming');
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

test('an earlier credential rate limit keeps an exhausted chain retryable', async () => {
  let now = Date.now();
  let recovered = false;
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes('claude.test'))
        return Response.json({ error: { message: 'synthetic billing' } }, { status: 402 });
      const primary = new Headers(init?.headers).get('authorization') === 'Bearer primary-key';
      if (primary && recovered) return response();
      return Response.json(
        { error: { message: primary ? 'synthetic rate limit' : 'synthetic unauthorized' } },
        { status: primary ? 429 : 401, headers: { 'retry-after': '1' } },
      );
    }) as unknown as typeof fetch;
    let failure: unknown;
    await aiStreamRound(request).catch((error: unknown) => {
      failure = error;
    });
    expect(isRetryableError(failure)).toBe(true);
    expect((failure as { status?: number }).status).toBe(429);
    expect(rows.map((row) => row.httpStatus)).toEqual([429, 401, 402]);
    now += 5000;
    recovered = true;
    expect((await aiStreamRound(request)).providerUsed).toBe('Claude (claude-haiku-fixture)');
  } finally {
    clock.mockRestore();
  }
});

test('caller timeout reasons never accumulate provider connection failures', async () => {
  let calls = 0;
  for (let index = 0; index < 3; index++) {
    const controller = new AbortController();
    globalThis.fetch = (async () => {
      calls++;
      controller.abort(new DOMException('The operation timed out.', 'TimeoutError'));
      throw new DOMException('synthetic abort', 'AbortError');
    }) as unknown as typeof fetch;
    await expect(aiStreamRound({ ...request, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
  }
  expect(calls).toBe(3);
  expect(breaker.isProviderDemoted('claude', Date.now())).toBe(false);
});

test('caller cancellation wins a local all-credentials-cooling race', async () => {
  const savedChain = env.AI_SMART_CHAIN;
  env.AI_SMART_CHAIN = { order: ['claude'], fromEnv: true, fallback: ['claude'] };
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ error: { message: 'synthetic unauthorized' } }, { status: 401 });
    }) as unknown as typeof fetch;
    await expect(aiStreamRound(request)).rejects.toThrow();
    const controller = new AbortController();
    const pending = aiStreamRound({ ...request, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(calls).toBe(2);
  } finally {
    env.AI_SMART_CHAIN = savedChain;
  }
});

test.each([
  400, 401, 402,
])('local cooldown after HTTP %s does not invent a retryable 429', async (status) => {
  const savedChain = env.AI_SMART_CHAIN;
  env.AI_SMART_CHAIN = { order: ['claude'], fromEnv: true, fallback: ['claude'] };
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ error: { message: 'insufficient credit balance' } }, { status });
    }) as unknown as typeof fetch;
    await expect(aiStreamRound(request)).rejects.toThrow();
    rows.length = 0;
    let failure: unknown;
    await aiStreamRound(request).catch((error: unknown) => {
      failure = error;
    });
    expect((failure as { status?: number }).status).not.toBe(429);
    expect(isRetryableError(failure)).toBe(false);
    expect(calls).toBe(2);
    expect(rows.map((row) => [row.outcome, row.httpStatus])).toEqual([['skipped', null]]);
  } finally {
    env.AI_SMART_CHAIN = savedChain;
  }
});

function statusOf(error: unknown): number | undefined {
  return typeof error === 'object' &&
    error !== null &&
    'status' in error &&
    typeof error.status === 'number'
    ? error.status
    : undefined;
}

async function failureOf(promise: Promise<unknown>): Promise<unknown> {
  let failure: unknown;
  await promise.catch((error: unknown) => {
    failure = error;
  });
  return failure;
}

test('a transient failure on the primary key stays visible when the backup answers 401', async () => {
  const savedChain = env.AI_SMART_CHAIN;
  env.AI_SMART_CHAIN = { order: ['claude'], fromEnv: true, fallback: ['claude'] };
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      if (calls === 1) throw new TypeError('synthetic connection failure');
      return Response.json({ error: { message: 'synthetic unauthorized' } }, { status: 401 });
    }) as unknown as typeof fetch;
    const failure = await failureOf(aiStreamRound(request));
    expect(failure).toBeInstanceOf(Error);
    expect(calls).toBe(2);
    expect(isRetryableError(failure)).toBe(true);
  } finally {
    env.AI_SMART_CHAIN = savedChain;
  }
});

test.each([
  429, 500, 529,
])('local cooldown after transient HTTP %s keeps that status and stays retryable', async (status) => {
  const savedChain = env.AI_SMART_CHAIN;
  env.AI_SMART_CHAIN = { order: ['claude'], fromEnv: true, fallback: ['claude'] };
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      return Response.json({ error: { message: 'synthetic transient failure' } }, { status });
    }) as unknown as typeof fetch;
    await expect(aiStreamRound(request)).rejects.toThrow();
    rows.length = 0;
    const failure = await failureOf(aiStreamRound(request));
    expect(statusOf(failure)).toBe(status);
    expect(isRetryableError(failure)).toBe(true);
    expect(calls).toBe(2);
    expect(rows.map((row) => [row.outcome, row.httpStatus])).toEqual([['skipped', null]]);
  } finally {
    env.AI_SMART_CHAIN = savedChain;
  }
});

test('local cooldown after connection failures stays retryable', async () => {
  const savedChain = env.AI_SMART_CHAIN;
  env.AI_SMART_CHAIN = { order: ['claude'], fromEnv: true, fallback: ['claude'] };
  let calls = 0;
  try {
    globalThis.fetch = (async () => {
      calls++;
      throw new TypeError('synthetic connection failure');
    }) as unknown as typeof fetch;
    await expect(aiStreamRound(request)).rejects.toThrow();
    const failure = await failureOf(aiStreamRound(request));
    expect(calls).toBe(2);
    expect(isRetryableError(failure)).toBe(true);
  } finally {
    env.AI_SMART_CHAIN = savedChain;
  }
});

test.each([
  'ready',
  'probing',
] as const)('a concurrently %s credential prevents whole-provider demotion', async (state) => {
  let now = Date.now();
  let primaryCalls = 0;
  let releaseBackup = () => {};
  let releasePrimary = () => {};
  let signalBackup = () => {};
  let signalPrimary = () => {};
  const backupStarted = new Promise<void>((resolve) => {
    signalBackup = resolve;
  });
  const primaryStarted = new Promise<void>((resolve) => {
    signalPrimary = resolve;
  });
  const backupPending = new Promise<void>((resolve) => {
    releaseBackup = resolve;
  });
  const primaryPending = new Promise<void>((resolve) => {
    releasePrimary = resolve;
  });
  const clock = spyOn(Date, 'now').mockImplementation(() => now);
  let recovery: Promise<void> | undefined;
  try {
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      if (!String(url).includes('claude.test')) return response();
      if (new Headers(init?.headers).get('authorization') === 'Bearer primary-key') {
        if (++primaryCalls === 1)
          return Response.json(
            { error: { message: 'synthetic rate limit' } },
            { status: 429, headers: { 'retry-after': '1' } },
          );
        signalPrimary();
        await primaryPending;
        return response();
      }
      signalBackup();
      await backupPending;
      return Response.json(
        { error: { message: 'synthetic rate limit' } },
        { status: 429, headers: { 'retry-after': '300' } },
      );
    }) as unknown as typeof fetch;
    const result = aiStreamRound(request);
    await backupStarted;
    now += 1001;
    recovery = (async () => {
      const stream = await openChatStream(
        claudeClient(),
        { messages: request.messages, max_tokens: 32, model: env.CLAUDE_MODEL, stream: true },
        undefined,
        'claude',
        env.CLAUDE_MODEL,
      );
      for await (const chunk of stream) expect(chunk.choices).toHaveLength(1);
    })();
    await primaryStarted;
    if (state === 'ready') {
      releasePrimary();
      await recovery;
    }
    releaseBackup();
    expect((await result).providerUsed).toBe('z.ai (zai-fixture)');
    expect(breaker.isProviderDemoted('claude', now + 500)).toBe(false);
    expect(primaryCalls).toBe(2);
    expect(rows.filter((row) => row.provider === 'claude').map((row) => row.httpStatus)).toEqual([
      429, 429,
    ]);
  } finally {
    releasePrimary();
    releaseBackup();
    await recovery?.catch(() => {});
    clock.mockRestore();
  }
});

test('a backup that rejects stream_options is retried without it on that credential, never by restarting rotation', async () => {
  const model = 'claude-usage-compat-fixture';
  const sent: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const authorization = new Headers(init?.headers).get('authorization') ?? '';
    const withUsage = String(init?.body).includes('stream_options');
    sent.push(`${authorization}${withUsage ? ' +usage' : ''}`);
    if (authorization === 'Bearer primary-key')
      return Response.json(
        { error: { message: `This key does not have access to the model ${model}` } },
        { status: 403 },
      );
    return withUsage
      ? Response.json(
          { error: { message: "Unknown parameter: 'stream_options'." } },
          { status: 400 },
        )
      : response();
  }) as unknown as typeof fetch;
  let httpAttempts = 0;
  const stream = await openChatStream(
    claudeClient(),
    { messages: request.messages, max_tokens: 32, model, stream: true },
    undefined,
    'claude',
    model,
    { timeoutMs: 5000, onHttpAttempt: () => httpAttempts++ },
  );
  for await (const chunk of stream) expect(chunk.choices).toHaveLength(1);
  expect(sent).toEqual([
    'Bearer primary-key +usage',
    'Bearer secondary-key +usage',
    'Bearer secondary-key',
  ]);
  expect(httpAttempts).toBe(3);
});

test('a single Claude key keeps reporting no per-HTTP attempts when it retries without stream_options', async () => {
  const model = 'claude-usage-single-key-fixture';
  env.CLAUDE_API_TOKEN2 = '';
  resetClients();
  const sent: string[] = [];
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    const withUsage = String(init?.body).includes('stream_options');
    sent.push(withUsage ? 'usage' : 'plain');
    return withUsage
      ? Response.json(
          { error: { message: "Unknown parameter: 'stream_options'." } },
          { status: 400 },
        )
      : response();
  }) as unknown as typeof fetch;
  let httpAttempts = 0;
  try {
    const stream = await openChatStream(
      claudeClient(),
      { messages: request.messages, max_tokens: 32, model, stream: true },
      undefined,
      'claude',
      model,
      { timeoutMs: 5000, onHttpAttempt: () => httpAttempts++ },
    );
    for await (const chunk of stream) expect(chunk.choices).toHaveLength(1);
    expect(sent).toEqual(['usage', 'plain']);
    expect(httpAttempts).toBe(0);
  } finally {
    env.CLAUDE_API_TOKEN2 = 'secondary-key';
  }
});
