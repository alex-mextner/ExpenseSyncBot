import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

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

  it('keeps the z.ai credential and provider independent', async () => {
    const attempts: string[] = [];
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      attempts.push(new Headers(init?.headers).get('authorization') ?? '');
      return Response.json({ error: { message: 'synthetic rate limit' } }, { status: 429 });
    }) as unknown as typeof fetch;
    await expect(Promise.resolve(zaiClient().chat.completions.create(request))).rejects.toThrow();
    expect(attempts).toEqual(['Bearer zai-key']);
  });
});
