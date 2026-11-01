import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';
import { createClaudeClient, withClaudeCredentials } from './claude-client-pool';

const logMock = createMockLogger();
mock.module('../../utils/logger', () => ({ createLogger: () => logMock, logger: logMock }));
const mockEnv = {
  ANTHROPIC_API_KEY: 'zai-key',
  AI_BASE_URL: 'https://zai.test/v1',
  CLAUDE_API_TOKEN: 'primary-key',
  CLAUDE_API_TOKEN2: 'secondary-key',
  CLAUDE_BASE_URL: 'https://claude.test/v1',
  CLAUDE_MODEL: 'claude-haiku-fixture',
  AI_SMART_CHAIN: { order: ['claude'], fromEnv: true, fallback: ['claude'] },
  AI_ROUTING: 'legacy',
};
mock.module('../../config/env', () => ({ env: mockEnv }));
const { claudeClient, zaiClient, resetClients } = await import('./clients');
const { openChatStream } = await import('./streaming/request-params');
const usageRows: { outcome: string; httpStatus: number | null }[] = [];
mock.module('./usage-recorder', () => ({
  recordAiUsage: (rows: { outcome: string; httpStatus: number | null }[]) =>
    usageRows.push(...rows),
}));
const { aiStreamRound } = await import('./streaming');

const completion = {
  id: 'synthetic-completion',
  object: 'chat.completion',
  created: 0,
  model: 'claude-haiku-fixture',
  choices: [
    {
      index: 0,
      finish_reason: 'stop',
      message: { role: 'assistant', content: '{"amount":12.5,"currency":"EUR"}' },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 },
};
const request = {
  model: 'claude-haiku-fixture',
  messages: [{ role: 'user' as const, content: 'Synthetic: EUR 12.50' }],
  max_tokens: 32,
};
const originalFetch = globalThis.fetch;
const response = () =>
  new Response(
    'data: ' +
      JSON.stringify({
        id: 'synthetic',
        object: 'chat.completion.chunk',
        created: 0,
        model: request.model,
        choices: [
          {
            index: 0,
            delta: { content: completion.choices[0]?.message.content },
            finish_reason: 'stop',
          },
        ],
      }) +
      '\n\ndata: [DONE]\n\n',
    { headers: { 'content-type': 'text/event-stream' } },
  );
async function readClaude() {
  const stream = await openChatStream(
    claudeClient(),
    { ...request, stream: true },
    undefined,
    'claude',
    request.model,
  );
  let text = '';
  for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? '';
  return text;
}

describe('Claude credential wiring through the real SDK', () => {
  beforeEach(() => {
    resetClients();
    usageRows.length = 0;
    logMock.warn.mockClear();
    logMock.error.mockClear();
    mockEnv.CLAUDE_API_TOKEN = 'primary-key';
    mockEnv.CLAUDE_API_TOKEN2 = 'secondary-key';
  });
  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetClients();
    expect(logMock.warn).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('repeats the identical model request with the secondary credential after rejected authentication', async () => {
    const attempts: { authorization: string | null; body: unknown }[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      attempts.push({
        authorization: new Headers(init?.headers).get('authorization'),
        body: init?.body,
      });
      if (attempts.length === 1)
        return Response.json(
          { error: { type: 'authentication_error', message: 'synthetic rejection' } },
          { status: 401 },
        );
      return response();
    }) as unknown as typeof fetch;
    expect(await readClaude()).toBe('{"amount":12.5,"currency":"EUR"}');
    expect(attempts.map((attempt) => attempt.authorization)).toEqual([
      'Bearer primary-key',
      'Bearer secondary-key',
    ]);
    expect(attempts[1]?.body).toBe(attempts[0]?.body);
  });

  it.each([
    'connection',
    'SDK timeout',
  ])('rotates and cools the primary after a real SDK %s error', async (failure) => {
    const attempts: { authorization: string | null; body: unknown }[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      attempts.push({
        authorization: new Headers(init?.headers).get('authorization'),
        body: init?.body,
      });
      if (attempts.length === 1) {
        if (failure === 'SDK timeout') throw new DOMException('synthetic timeout', 'AbortError');
        throw new TypeError('synthetic connection failure');
      }
      return response();
    }) as unknown as typeof fetch;
    expect(await readClaude()).toBe('{"amount":12.5,"currency":"EUR"}');
    expect(await readClaude()).toBe('{"amount":12.5,"currency":"EUR"}');
    expect(attempts.map((attempt) => attempt.authorization)).toEqual([
      'Bearer primary-key',
      'Bearer secondary-key',
      'Bearer secondary-key',
    ]);
    expect(attempts[1]?.body).toBe(attempts[0]?.body);
    expect(attempts[2]?.body).toBe(attempts[0]?.body);
  });

  it('rejects a request-specific 429 without rotating or cooling its credential', async () => {
    const authorizations: (string | null)[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('authorization'));
      if (authorizations.length === 1)
        return Response.json({ error: { message: 'request too large' } }, { status: 429 });
      return response();
    }) as unknown as typeof fetch;
    await expect(readClaude()).rejects.toThrow('request too large');
    expect(await readClaude()).toBe('{"amount":12.5,"currency":"EUR"}');
    expect(authorizations).toEqual(['Bearer primary-key', 'Bearer primary-key']);
  });

  it('accepts a configured secondary when the primary is absent', async () => {
    mockEnv.CLAUDE_API_TOKEN = '';
    const authorizations: (string | null)[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('authorization'));
      return response();
    }) as unknown as typeof fetch;
    expect(await readClaude()).toBe('{"amount":12.5,"currency":"EUR"}');
    expect(authorizations).toEqual(['Bearer secondary-key']);
  });

  it('records the rejected credential and successful secondary as separate provider attempts', async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      if (++calls === 1)
        return Response.json(
          { error: { type: 'authentication_error', message: 'synthetic rejection' } },
          { status: 401 },
        );
      return response();
    }) as unknown as typeof fetch;
    const result = await aiStreamRound({
      messages: request.messages,
      maxTokens: 32,
      purpose: 'probe',
    });
    expect(result.text).toBe('{"amount":12.5,"currency":"EUR"}');
    expect(usageRows.map((row) => row.outcome)).toEqual(['error', 'ok']);
    expect(usageRows[0]?.httpStatus).toBe(401);
    expect(calls).toBe(2);
  });

  it.each([
    true,
    false,
  ])('model permission denial does not disable permitted models (backup access: %s)', async (backupHasAccess) => {
    const attempts: { authorization: string | null; model: string }[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      const model = (JSON.parse(String(init?.body)) as { model: string }).model;
      attempts.push({ authorization, model });
      if (
        model === 'claude-sonnet-restricted' &&
        (authorization === 'Bearer primary-key' || !backupHasAccess)
      )
        return Response.json(
          { error: { message: 'API key does not have permission to use this model' } },
          { status: 403 },
        );
      return response();
    }) as unknown as typeof fetch;
    async function readModel(model: string) {
      const stream = await openChatStream(
        claudeClient(),
        { ...request, model, stream: true },
        undefined,
        'claude',
        model,
      );
      let text = '';
      for await (const chunk of stream) text += chunk.choices[0]?.delta.content ?? '';
      return text;
    }
    const restricted = readModel('claude-sonnet-restricted');
    if (backupHasAccess) expect(await restricted).toBe('{"amount":12.5,"currency":"EUR"}');
    else await expect(restricted).rejects.toThrow();
    expect(attempts.map((attempt) => attempt.authorization)).toEqual([
      'Bearer primary-key',
      'Bearer secondary-key',
    ]);
    expect(await readModel(request.model)).toBe('{"amount":12.5,"currency":"EUR"}');
    expect(attempts.at(-1)).toEqual({ authorization: 'Bearer primary-key', model: request.model });
  });

  it('local SDK serialization errors do not rotate or cool credentials', async () => {
    const authorizations: (string | null)[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      authorizations.push(new Headers(init?.headers).get('authorization'));
      return response();
    }) as unknown as typeof fetch;
    const circular: { self?: unknown } = {};
    circular.self = circular;
    await expect(
      openChatStream(
        claudeClient(),
        { ...request, stream: true, metadata: circular } as unknown as Parameters<
          typeof openChatStream
        >[1],
        undefined,
        'claude',
        request.model,
      ),
    ).rejects.toBeInstanceOf(TypeError);
    expect(authorizations).toEqual([]);
    expect(await readClaude()).toBe('{"amount":12.5,"currency":"EUR"}');
    expect(authorizations).toEqual(['Bearer primary-key']);
  });

  describe.each([
    ['bad\u200btoken', true],
    ['tok\u2026en', true],
    ['tok\r\nen', true],
    // The SDK still builds a request with these; a server refuses it, so they only leave rotation.
    ['tok\u0001en', false],
    ['tok\u001fen', false],
    ['tok\u007fen', false],
  ] as const)('header-invalid token %j', (malformed, sdkRejectsLocally) => {
    const recordAuthorizations = () => {
      const authorizations: (string | null)[] = [];
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get('authorization'));
        return response();
      }) as unknown as typeof fetch;
      return authorizations;
    };

    it('is skipped when it is the primary: the valid secondary serves the request', async () => {
      mockEnv.CLAUDE_API_TOKEN = malformed;
      const authorizations = recordAuthorizations();
      expect(await readClaude()).toBe('{"amount":12.5,"currency":"EUR"}');
      expect(authorizations).toEqual(['Bearer secondary-key']);
    });

    it('keeps single-key behavior when only the secondary is usable: a 529 is not a local cooldown', async () => {
      mockEnv.CLAUDE_API_TOKEN = malformed;
      const authorizations: (string | null)[] = [];
      globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
        authorizations.push(new Headers(init?.headers).get('authorization'));
        return authorizations.length === 1
          ? Response.json({ error: { message: 'synthetic overloaded' } }, { status: 529 })
          : response();
      }) as unknown as typeof fetch;
      await expect(readClaude()).rejects.toThrow();
      expect(await readClaude()).toBe('{"amount":12.5,"currency":"EUR"}');
      expect(authorizations).toEqual(['Bearer secondary-key', 'Bearer secondary-key']);
    });

    it('is never attempted when it is the secondary', async () => {
      mockEnv.CLAUDE_API_TOKEN2 = malformed;
      const authorizations = recordAuthorizations();
      expect(await readClaude()).toBe('{"amount":12.5,"currency":"EUR"}');
      expect(authorizations).toEqual(['Bearer primary-key']);
    });

    if (sdkRejectsLocally)
      it.each([
        ['a single malformed token', ''],
        ['two malformed tokens', `${malformed}2`],
      ])('fails fast without a fetch or the token value for %s', async (_name, secondary) => {
        mockEnv.CLAUDE_API_TOKEN = malformed;
        mockEnv.CLAUDE_API_TOKEN2 = secondary;
        const authorizations = recordAuthorizations();
        const error = await readClaude().catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(TypeError);
        const text = `${(error as Error).message}\n${(error as Error).stack}`;
        for (const token of [malformed, secondary])
          if (token.trim()) expect(text.includes(token.trim())).toBe(false);
        expect(authorizations).toEqual([]);
      });
  });

  it.each([
    'does not have permission to use the specified resource',
    'This organization has been disabled',
    'Your API key does not have permission to perform this action',
  ])('account-level 403 "%s" cools the primary and rotates, not mistaken for model permission', async (message) => {
    const authorizations: (string | null)[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      const authorization = new Headers(init?.headers).get('authorization');
      authorizations.push(authorization);
      if (authorization === 'Bearer primary-key')
        return Response.json({ error: { message } }, { status: 403 });
      return response();
    }) as unknown as typeof fetch;
    expect(await readClaude()).toBe('{"amount":12.5,"currency":"EUR"}');
    expect(await readClaude()).toBe('{"amount":12.5,"currency":"EUR"}');
    expect(authorizations).toEqual([
      'Bearer primary-key',
      'Bearer secondary-key',
      'Bearer secondary-key',
    ]);
  });

  it('keeps the z.ai credential and provider independent', async () => {
    const attempts: string[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      attempts.push(new Headers(init?.headers).get('authorization') ?? '');
      return Response.json({ error: { message: 'synthetic rate limit' } }, { status: 429 });
    }) as unknown as typeof fetch;
    await expect(Promise.resolve(zaiClient().chat.completions.create(request))).rejects.toThrow();
    expect(attempts).toEqual(['Bearer zai-key']);
  });

  it.each([
    'bad\u200btoken',
    'tok\u0001en',
    'tok\u001fen',
    'tok\u007fen',
  ])('all-invalid credential %j is rejected before the SDK operation or attempt callback', async (malformed) => {
    for (const tokens of [[malformed], [malformed, `${malformed}2`]]) {
      let operations = 0;
      let attempts = 0;
      const client = createClaudeClient({
        tokens,
        baseURL: 'https://claude.test/v1',
        timeout: 1000,
        fetch: async () => {
          throw new Error('Unexpected network request');
        },
      });
      const error = await withClaudeCredentials(
        client,
        async () => {
          operations++;
          return 'unexpected success';
        },
        { timeoutMs: 1000, onHttpAttempt: () => attempts++ },
      ).catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(TypeError);
      const text = `${(error as Error).message}\n${(error as Error).stack}`;
      for (const token of tokens) expect(text.includes(token)).toBe(false);
      expect(operations).toBe(0);
      expect(attempts).toBe(0);
    }
  });

  it('preserves caller cancellation when the only credential is malformed', async () => {
    const controller = new AbortController();
    const reason = new Error('Synthetic caller cancellation');
    controller.abort(reason);
    let operations = 0;
    const client = createClaudeClient({
      tokens: ['bad\u200btoken'],
      baseURL: 'https://claude.test/v1',
      timeout: 1000,
      fetch: async () => {
        throw new Error('Unexpected network request');
      },
    });
    const error = await withClaudeCredentials(
      client,
      async () => {
        operations++;
        return 'unexpected success';
      },
      { timeoutMs: 1000, signal: controller.signal },
    ).catch((caught: unknown) => caught);
    expect(error).toBe(reason);
    expect(operations).toBe(0);
  });
});
