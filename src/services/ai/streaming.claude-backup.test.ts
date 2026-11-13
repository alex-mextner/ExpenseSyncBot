/**
 * End-to-end guarantees of the second Claude credential, driven through aiStreamRound with the real
 * OpenAI SDK and a fake network: the secondary key alone serves every chain and role, z.ai and Claude
 * credentials never cross, request-specific rejections never rotate, one shared deadline covers every
 * credential attempt, and a stream that was already returned is never opened again.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { Role } from './model-presets';
import type { RoleChainEntry } from './role-routing';

const log = createMockLogger();
mock.module('../../utils/logger', () => ({ createLogger: () => log, logger: log }));

const defaultOrder = () => ({
  order: ['claude', 'zai', 'hf'],
  fromEnv: false,
  fallback: ['claude', 'zai', 'hf'],
});
const env = {
  ANTHROPIC_API_KEY: 'zai-key',
  AI_BASE_URL: 'https://zai.test/v1',
  AI_MODEL: 'zai-smart',
  AI_FAST_MODEL: 'zai-fast',
  AI_SMART_CHAIN: defaultOrder(),
  AI_FAST_CHAIN: defaultOrder(),
  CLAUDE_API_TOKEN: '',
  CLAUDE_API_TOKEN2: 'secondary-key',
  CLAUDE_BASE_URL: 'https://claude.test/v1',
  CLAUDE_MODEL: 'claude-smart',
  CLAUDE_FAST_MODEL: 'claude-fast',
  CLAUDE_VISION_MODEL: 'claude-vision',
  HF_TOKEN: 'hf-key',
  HF_BASE_URL: 'https://hf.test/v1',
  HF_MODEL: 'hf-smart',
  HF_FAST_MODEL: 'hf-fast',
  HF_VISION_MODEL: 'hf-vision',
  OPENROUTER_API_KEY: '',
  OPENROUTER_BASE_URL: 'https://openrouter.test/v1',
  OPENROUTER_MODEL: '',
  OPENROUTER_FAST_MODEL: '',
  AI_ROUTING: 'legacy' as 'legacy' | 'roles',
  AI_ROLE_CHAINS: { planner: [], executor: [], repair: [] } as Record<Role, RoleChainEntry[]>,
};
mock.module('../../config/env', () => ({ env }));
const rows: {
  provider: string;
  outcome: string;
  httpStatus: number | null;
  errorClass: string | null;
}[] = [];
mock.module('./usage-recorder', () => ({
  recordAiUsage: (events: typeof rows) => rows.push(...events),
}));
const { aiStreamRound } = await import('./streaming');
const breaker = await import('./provider-breaker');
const { resetClients } = await import('./clients');
const originalFetch = globalThis.fetch;

interface Call {
  host: string;
  authorization: string;
  model: string;
}
const calls: Call[] = [];
const encoder = new TextEncoder();
const chunk = (delta: Record<string, unknown>, finishReason: string | null = null) =>
  `data: ${JSON.stringify({
    id: 'synthetic',
    object: 'chat.completion.chunk',
    created: 0,
    model: 'synthetic',
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`;
const sse = (body: string) =>
  new Response(body, { headers: { 'content-type': 'text/event-stream' } });
const okResponse = () => sse(`${chunk({ content: '12.50 EUR' }, 'stop')}data: [DONE]\n\n`);
const errorResponse = (status: number, message: string) =>
  Response.json({ error: { message } }, { status });

function requestedModel(body: unknown): string {
  const parsed: unknown = JSON.parse(String(body));
  return parsed &&
    typeof parsed === 'object' &&
    'model' in parsed &&
    typeof parsed.model === 'string'
    ? parsed.model
    : '';
}

/** Records every request, then lets `respond` answer it. */
function fakeNetwork(respond: (call: Call, init: RequestInit | undefined) => Promise<Response>) {
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    const call: Call = {
      host: new URL(String(url)).host,
      authorization: new Headers(init?.headers).get('authorization') ?? '',
      model: requestedModel(init?.body),
    };
    calls.push(call);
    return respond(call, init);
  }) as unknown as typeof fetch;
}
const claudeCalls = () => calls.filter((call) => call.host === 'claude.test');
const request = {
  messages: [{ role: 'user' as const, content: 'Synthetic EUR 12.50' }],
  maxTokens: 32,
  purpose: 'probe' as const,
};

beforeEach(() => {
  resetClients();
  breaker.resetProviderBreaker();
  env.AI_SMART_CHAIN = defaultOrder();
  env.AI_FAST_CHAIN = defaultOrder();
  env.CLAUDE_API_TOKEN = '';
  env.CLAUDE_API_TOKEN2 = 'secondary-key';
  env.AI_ROUTING = 'legacy';
  env.AI_ROLE_CHAINS = { planner: [], executor: [], repair: [] };
  calls.length = 0;
  rows.length = 0;
  log.warn.mockClear();
  log.error.mockClear();
});
afterEach(() => {
  globalThis.fetch = originalFetch;
  resetClients();
  breaker.resetProviderBreaker();
});

const claudeOnly = { order: ['claude'], fromEnv: true, fallback: ['claude'] };
const claudeThenHf = { order: ['claude', 'hf'], fromEnv: true, fallback: ['claude', 'hf'] };
const bareClaude: RoleChainEntry[] = [{ provider: 'claude', preset: null }];

describe('the secondary Claude credential alone', () => {
  // A working secondary Claude key serves the primary route without contacting another provider.
  test.each([
    ['smart', 'smart' as const, undefined, 'claude-smart'],
    ['fast', 'fast' as const, undefined, 'claude-fast'],
    ['ocr', 'ocr' as const, undefined, 'claude-vision'],
    ['planner role', 'smart' as const, 'planner' as const, 'claude-fast'],
    ['executor role', 'smart' as const, 'executor' as const, 'claude-smart'],
    ['repair role', 'smart' as const, 'repair' as const, 'claude-smart'],
  ])('serves the %s chain and keeps the z.ai key out of Claude requests', async (_name, chain, role, claudeModel) => {
    if (role) {
      env.AI_ROUTING = 'roles';
      env.AI_ROLE_CHAINS = { planner: bareClaude, executor: bareClaude, repair: bareClaude };
    }
    fakeNetwork(async (call) =>
      call.host === 'zai.test' ? errorResponse(429, 'synthetic quota') : okResponse(),
    );
    const result = await aiStreamRound({ ...request, chain, ...(role ? { role } : {}) });
    expect(result.providerUsed).toBe(`Claude (${claudeModel})`);
    expect(claudeCalls()).toEqual([
      { host: 'claude.test', authorization: 'Bearer secondary-key', model: claudeModel },
    ]);
    expect(calls.filter((call) => call.host === 'zai.test')).toEqual([]);
  });

  test('a rejected secondary is not retried and never replaced by the z.ai key', async () => {
    env.AI_SMART_CHAIN = claudeOnly;
    fakeNetwork(async () => errorResponse(401, 'synthetic rejection'));
    await expect(aiStreamRound(request)).rejects.toThrow();
    expect(calls).toEqual([
      { host: 'claude.test', authorization: 'Bearer secondary-key', model: 'claude-smart' },
    ]);
  });
});

describe('request-specific rejections', () => {
  test.each([
    [400, 'messages: text content blocks must be non-empty'],
    [400, 'prompt is too long: 250000 tokens > 200000 maximum'],
    [403, 'input was flagged by content policy'],
    [404, 'model: claude-smart not found'],
    [413, 'request_too_large'],
    [422, 'synthetic unprocessable request'],
    [429, 'request too large for this model'],
  ])('HTTP %s (%s) stays on the first key and leaves both keys usable', async (status, message) => {
    env.CLAUDE_API_TOKEN = 'primary-key';
    env.AI_SMART_CHAIN = claudeOnly;
    fakeNetwork(async () => errorResponse(status, message));
    for (let round = 0; round < 2; round++) await expect(aiStreamRound(request)).rejects.toThrow();
    expect(claudeCalls().map((call) => call.authorization)).toEqual([
      'Bearer primary-key',
      'Bearer primary-key',
    ]);
    expect(rows.map((row) => row.outcome)).toEqual(['error', 'error']);
  });
});

describe('retired Claude model failover', () => {
  test('records HTTP 404, keeps the credential usable, and serves HF only after priority routes fail', async () => {
    env.CLAUDE_API_TOKEN = 'primary-key';
    env.AI_SMART_CHAIN = claudeThenHf;
    fakeNetwork(async (call) =>
      call.host === 'claude.test'
        ? errorResponse(404, 'model: claude-smart not found')
        : okResponse(),
    );
    expect((await aiStreamRound(request)).providerUsed).toBe('HF (hf-smart)');
    expect(claudeCalls().map((call) => call.authorization)).toEqual(['Bearer primary-key']);
    expect(rows).toContainEqual(
      expect.objectContaining({
        provider: 'claude',
        outcome: 'error',
        httpStatus: 404,
      }),
    );
    expect(log.warn).toHaveBeenCalled();
    fakeNetwork(async () => okResponse());
    expect((await aiStreamRound(request)).providerUsed).toBe('Claude (claude-smart)');
    expect(claudeCalls().map((call) => call.authorization)).toEqual([
      'Bearer primary-key',
      'Bearer primary-key',
    ]);
  });
});

describe('one shared deadline', () => {
  /** A request that stays open until the SDK aborts it. */
  const hang = (init: RequestInit | undefined) =>
    new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () =>
        reject(new DOMException('aborted', 'AbortError')),
      );
    });

  test('two silent keys together never outlast the provider budget, and each attempt has its own row', async () => {
    env.CLAUDE_API_TOKEN = 'primary-key';
    env.AI_SMART_CHAIN = claudeThenHf;
    fakeNetwork(async (call, init) => (call.host === 'claude.test' ? hang(init) : okResponse()));
    const startedAt = performance.now();
    const result = await aiStreamRound({ ...request, perProviderTimeoutMs: 400 });
    expect(result.providerUsed).toBe('HF (hf-smart)');
    expect(performance.now() - startedAt).toBeLessThan(1200);
    expect(claudeCalls().map((call) => call.authorization)).toEqual([
      'Bearer primary-key',
      'Bearer secondary-key',
    ]);
    expect(
      rows.filter((row) => row.provider === 'claude').map((row) => [row.outcome, row.errorClass]),
    ).toEqual([
      ['error', 'timeout'],
      ['error', 'timeout'],
    ]);
  });

  test('caller cancellation stops rotation and leaves the primary key usable', async () => {
    env.CLAUDE_API_TOKEN = 'primary-key';
    env.AI_SMART_CHAIN = claudeOnly;
    const controller = new AbortController();
    fakeNetwork(async (_call, init) => {
      queueMicrotask(() => controller.abort());
      return hang(init);
    });
    await expect(aiStreamRound({ ...request, signal: controller.signal })).rejects.toMatchObject({
      name: 'AbortError',
    });
    expect(claudeCalls().map((call) => call.authorization)).toEqual(['Bearer primary-key']);
    calls.length = 0;
    fakeNetwork(async () => okResponse());
    expect((await aiStreamRound(request)).providerUsed).toBe('Claude (claude-smart)');
    expect(claudeCalls().map((call) => call.authorization)).toEqual(['Bearer primary-key']);
  });
});

describe('a returned stream', () => {
  test('that breaks mid-way is never opened again with the other key and does not cool its own', async () => {
    env.CLAUDE_API_TOKEN = 'primary-key';
    env.AI_SMART_CHAIN = claudeThenHf;
    const toolCall = chunk({
      tool_calls: [
        { index: 0, id: 'call-1', type: 'function', function: { name: 'record', arguments: '{' } },
      ],
    });
    let broken = true;
    fakeNetwork(async (call) => {
      if (call.host !== 'claude.test' || !broken) return okResponse();
      let pulls = 0;
      return new Response(
        new ReadableStream({
          pull(controller) {
            // The tool-call start reaches the caller; only then does the connection drop.
            if (pulls++ === 0) controller.enqueue(encoder.encode(toolCall));
            else controller.error(new Error('synthetic socket drop'));
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    });
    const toolsStarted: string[] = [];
    const result = await aiStreamRound(
      { ...request, chain: 'smart' },
      { onToolCallStart: (name) => toolsStarted.push(name) },
    );
    expect(result.providerUsed).toBe('HF (hf-smart)');
    expect(claudeCalls().map((call) => call.authorization)).toEqual(['Bearer primary-key']);
    broken = false;
    env.AI_SMART_CHAIN = claudeOnly;
    expect((await aiStreamRound(request)).providerUsed).toBe('Claude (claude-smart)');
    expect(claudeCalls().map((call) => call.authorization)).toEqual([
      'Bearer primary-key',
      'Bearer primary-key',
    ]);
    expect(toolsStarted).toEqual(['record']);
  });
});
