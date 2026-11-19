// Native Claude wire, usage and opaque tool-loop regression contracts; synthetic HTTP only.

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import OpenAI from 'openai';
import { z } from 'zod';
import { probeCompletion } from '../../../scripts/ai-probe-completion';
import {
  type AiUsageEventInput,
  AiUsageEventsRepository,
} from '../../database/repositories/ai-usage-events.repository';
import { runMigrations } from '../../database/schema';
import { sanitizeAssistantToolCalls } from './agent-helpers';
import { cacheableSystemMessage } from './claude-cache-prefix';
import { createClaudeClient } from './claude-client-pool';
import { nativeRequest } from './claude-native-request';
import { classifyAttemptFailure } from './streaming/failure-policy';
import { openChatStream } from './streaming/request-params';
import { streamingSlot } from './streaming/slot';
import type { TokenUsage } from './streaming/token-usage';
import { buildSystemPrompt, buildSystemPromptPrefix } from './system-prompt';
import { aggregateUsage } from './usage-report';

// Bun's Request.clone() exposes the standard Fetch request shape, without Bun-only helpers.
type WireRequest = ReturnType<Request['clone']>;
function captureRequest(input: string | URL | Request, init?: RequestInit): WireRequest {
  if (typeof input !== 'string' && !(input instanceof URL))
    throw new Error('Expected SDK URL and RequestInit');
  return new Request(String(input), init);
}
const wireBodySchema = z.looseObject({
  stream: z.literal(true),
  model: z.string(),
  max_tokens: z.number(),
  messages: z.array(z.looseObject({ role: z.string(), content: z.array(z.unknown()) })),
  system: z
    .array(z.looseObject({ text: z.string(), cache_control: z.unknown().optional() }))
    .optional(),
  tools: z.array(z.looseObject({ cache_control: z.unknown().optional() })).optional(),
  cache_control: z.unknown().optional(),
  thinking: z.unknown().optional(),
  tool_choice: z.unknown().optional(),
  temperature: z.number().optional(),
});
async function requestBody(request: WireRequest) {
  return wireBodySchema.parse(await request.json());
}

function requestAt(requests: readonly WireRequest[], index: number): WireRequest {
  const request = requests[index];
  if (!request) throw new Error('Expected synthetic HTTP request');
  return request;
}

function sse(events: readonly { type: string; [key: string]: unknown }[]): Response {
  return new Response(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
}
function nativeAnswer(): Response {
  return sse([
    {
      type: 'message_start',
      message: {
        id: 'synthetic',
        model: 'claude-synthetic',
        usage: {
          input_tokens: 7,
          cache_creation_input_tokens: 100,
          cache_read_input_tokens: 200,
          output_tokens: 1,
        },
      },
    },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]);
}

test('native finance requests preserve receipt images, cache boundaries and all token categories', async () => {
  const requests: WireRequest[] = [];
  const client = createClaudeClient({
    tokens: ['synthetic-primary'],
    baseURL: 'https://api.anthropic.com/v1',
    timeout: 1000,
    transport: 'native',
    fetch: async (input, init) => {
      const request = captureRequest(input, init);
      requests.push(request.clone());
      if (new URL(request.url).pathname.endsWith('/messages')) return nativeAnswer();
      return new Response(
        `data: ${JSON.stringify({ id: 'synthetic', object: 'chat.completion.chunk', created: 0, model: 'claude-synthetic', choices: [{ index: 0, delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\ndata: [DONE]\n\n`,
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-sonnet-5-5', {
    anthropic: true,
  });
  const output = await slot.stream(
    {
      messages: [
        { role: 'system', content: 'Fixed receipt extraction rules.' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Synthetic image only.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,YQ==' } },
          ],
        },
      ],
      maxTokens: 50,
      purpose: 'ocr',
    },
    {},
  );
  expect(requests).toHaveLength(1);
  expect(new URL(requestAt(requests, 0).url).pathname).toBe('/v1/messages');
  expect(requestAt(requests, 0).headers.get('x-api-key')).toBe('synthetic-primary');
  const body = await requestBody(requestAt(requests, 0));
  expect(body.stream).toBe(true);
  expect(body.system?.[0]).toMatchObject({ type: 'text' });
  expect(body.cache_control).toBeUndefined();
  expect(body.system?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  expect(body.messages[0]?.content[1]).toEqual({
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'YQ==' },
  });
  expect(output.result.text).toBe('ok');
  expect(output.usage).toMatchObject({
    promptTokens: 307,
    completionTokens: 3,
    freshInputTokens: 7,
    cacheWriteTokens: 100,
    cachedTokens: 200,
  });
});

test('finance tool continuation retains signed content after sanitization and disables new tool calls', async () => {
  const content = [
    { type: 'thinking', thinking: '', signature: 'opaque-signature' },
    { type: 'redacted_thinking', data: 'opaque-redacted' },
    { type: 'text', text: 'Checking.' },
    { type: 'tool_use', id: 'one', name: 'read_one', input: { day: 'synthetic' } },
  ];
  const requests: WireRequest[] = [];
  const client = createClaudeClient({
    tokens: ['synthetic-primary'],
    baseURL: 'https://api.anthropic.com/v1',
    timeout: 1000,
    transport: 'native',
    fetch: async (input, init) => {
      requests.push(captureRequest(input, init).clone());
      if (requests.length > 1) return nativeAnswer();
      return sse([
        {
          type: 'message_start',
          message: {
            id: 'synthetic',
            model: 'claude-synthetic',
            usage: {
              input_tokens: 1,
              cache_read_input_tokens: 2,
              cache_creation_input_tokens: 3,
              output_tokens: 1,
            },
          },
        },
        ...content.flatMap((content_block, index) => [
          { type: 'content_block_start', index, content_block },
          { type: 'content_block_stop', index },
        ]),
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
        { type: 'message_stop' },
      ]);
    },
  });
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-sonnet-5-5', {
    anthropic: true,
  });
  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: 'Stable.' },
    { role: 'user', content: 'Synthetic.' },
  ];
  const tool = (name: string): OpenAI.ChatCompletionTool => ({
    type: 'function',
    function: { name, parameters: { type: 'object', properties: {} } },
  });
  const tools = [tool('read_one')];
  const first = await slot.stream({ messages, tools, maxTokens: 100, purpose: 'agent' }, {});
  const assistant = sanitizeAssistantToolCalls(first.result.assistantMessage);
  expect(assistant).toBe(first.result.assistantMessage);
  expect(JSON.stringify(first)).not.toContain('opaque-');
  await slot.stream(
    {
      messages: [
        ...messages,
        assistant,
        { role: 'tool', tool_call_id: 'one', content: 'Synthetic result.' },
      ],
      tools: [...tools, tool('later')],
      toolChoice: 'none',
      maxTokens: 100,
      purpose: 'agent_final',
    },
    {},
  );
  const before = await requestBody(requestAt(requests, 0));
  const after = await requestBody(requestAt(requests, 1));
  expect(after.messages[1]?.content).toEqual(content);
  expect(after.tools).toEqual(before.tools);
  expect(after.system).toEqual(before.system);
  expect(after.messages[3]).toMatchObject({
    role: 'system',
    content: [
      { type: 'tool_addition', tool: { type: 'tool_definition', definition: { name: 'later' } } },
    ],
  });
  expect(after.tool_choice).toEqual({ type: 'none' });
  expect(requestAt(requests, 1).headers.get('anthropic-beta')).toBe('inline-tools-2026-09-15');
});

test('finance stable system prefix ends before date, user and group instructions', () => {
  const prefix = buildSystemPromptPrefix('Fixed synthetic tool index.');
  const bodies = ['Alice', 'Bob'].map((userName) =>
    nativeRequest({
      model: 'claude-synthetic',
      max_tokens: 100,
      stream: true,
      messages: [
        cacheableSystemMessage(
          buildSystemPrompt(
            { userName, userFullName: userName, customPrompt: userName },
            new Date('2026-11-19T00:00:00Z'),
            'Fixed synthetic tool index.',
          ),
          prefix,
        ),
        { role: 'user', content: 'Synthetic.' },
      ],
    }),
  );
  expect(bodies[0]?.system?.[0]).toEqual(bodies[1]?.system?.[0]);
  expect(bodies[0]?.system?.[0]?.text).toBe(prefix);
  expect(bodies[0]?.system?.[1]?.text).not.toBe(bodies[1]?.system?.[1]?.text);
});

const eventBase: AiUsageEventInput = {
  at: 1,
  provider: 'claude',
  model: 'claude-synthetic',
  chain: 'smart',
  purpose: 'probe',
  outcome: 'ok',
  errorClass: null,
  httpStatus: null,
  durationMs: 10,
  promptTokens: 307,
  completionTokens: 3,
  reasoningTokens: null,
  cachedTokens: 200,
  firstTokenMs: null,
  generationMs: null,
  promptSize: null,
  requestId: 'synthetic',
  role: null,
  preset: null,
  costMicroUsd: null,
};
test('finance ledger and report retain native account/cache components without inventing historical attribution', () => {
  const db = new Database(':memory:');
  try {
    runMigrations(db);
    const repository = new AiUsageEventsRepository(db);
    repository.recordMany([
      { ...eventBase, freshInputTokens: 7, cacheWriteTokens: 100, credentialId: '123456789abc' },
      { ...eventBase, at: 2, cachedTokens: null },
    ]);
    const rows = repository.listSince(0);
    expect(rows[0]).toMatchObject({
      freshInputTokens: 7,
      cacheWriteTokens: 100,
      credentialId: '123456789abc',
    });
    expect(rows[1]?.freshInputTokens ?? null).toBeNull();
    const report = aggregateUsage(rows, { now: 3, days: 1 });
    expect(report.claudeAccounts).toHaveLength(2);
    expect(report.claudeAccounts?.find((row) => row.credentialId === '123456789abc')).toMatchObject(
      {
        freshInput: { sum: 7, rowsWithValue: 1, rowsUnknown: 0 },
        cacheWrite: { sum: 100, rowsWithValue: 1, rowsUnknown: 0 },
      },
    );
    expect(report.claudeAccounts?.find((row) => row.credentialId === null)).toMatchObject({
      freshInput: { sum: null, rowsWithValue: 0, rowsUnknown: 1 },
      cacheWrite: { sum: null, rowsWithValue: 0, rowsUnknown: 1 },
    });
  } finally {
    db.close();
  }
});

test('finance native failures retain the latest reported usage and never retry a consumed stream', async () => {
  let observed: TokenUsage | null = null;
  let calls = 0;
  const client = createClaudeClient({
    tokens: ['synthetic-primary', 'synthetic-backup'],
    baseURL: 'https://api.anthropic.com/v1',
    timeout: 1000,
    transport: 'native',
    fetch: async () => {
      calls++;
      return sse([
        {
          type: 'message_start',
          message: {
            id: 'synthetic',
            model: 'claude-synthetic',
            usage: {
              input_tokens: 7,
              cache_read_input_tokens: 200,
              cache_creation_input_tokens: 100,
              output_tokens: 1,
            },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'text', text: 'Partial.' },
        },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'unexpected_reason' },
          usage: { output_tokens: 5, output_tokens_details: { thinking_tokens: 2 } },
        },
      ]);
    },
  });
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-sonnet-5-5', {
    anthropic: true,
  });
  let failure: unknown;
  try {
    await slot.stream(
      {
        messages: [{ role: 'user', content: 'Synthetic.' }],
        maxTokens: 100,
        purpose: 'probe',
        onNativeUsage: (usage) => {
          observed = usage;
        },
      },
      {},
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(calls).toBe(1);
  expect(observed).toMatchObject({
    promptTokens: 307,
    completionTokens: 5,
    reasoningTokens: 2,
    freshInputTokens: 7,
    cacheWriteTokens: 100,
    cachedTokens: 200,
  });
});

test('finance Haiku keeps its disabled-thinking budget and missing cache metrics stay unknown', async () => {
  const requests: WireRequest[] = [];
  const client = createClaudeClient({
    tokens: ['synthetic-primary'],
    baseURL: 'https://api.anthropic.com/v1',
    timeout: 1000,
    transport: 'native',
    fetch: async (input, init) => {
      requests.push(captureRequest(input, init).clone());
      return sse([
        {
          type: 'message_start',
          message: {
            id: 'synthetic',
            model: 'claude-haiku-5-5',
            usage: { input_tokens: 7, output_tokens: 1 },
          },
        },
        { type: 'content_block_start', index: 0, content_block: { type: 'text', text: 'ok' } },
        { type: 'content_block_stop', index: 0 },
        {
          type: 'message_delta',
          delta: { stop_reason: 'end_turn' },
          usage: { output_tokens: 3, output_tokens_details: { thinking_tokens: 0 } },
        },
        { type: 'message_stop' },
      ]);
    },
  });
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-haiku-5-5', {
    anthropic: true,
  });
  const output = await slot.stream(
    { messages: [{ role: 'user', content: 'Synthetic.' }], maxTokens: 50, purpose: 'validator' },
    {},
  );
  const body = await requestBody(requestAt(requests, 0));
  expect(body.thinking).toEqual({ type: 'disabled' });
  expect(body.max_tokens).toBe(50);
  expect(body.temperature).toBeUndefined();
  expect(output.usage).toMatchObject({
    promptTokens: null,
    completionTokens: 3,
    reasoningTokens: 0,
    freshInputTokens: 7,
    cacheWriteTokens: null,
    cachedTokens: null,
  });
});

test('finance native credential timeout identifies the failed key and the successful backup', async () => {
  let observed: TokenUsage | null = null;
  const failedUsage: (TokenUsage | null)[] = [];
  const requests: WireRequest[] = [];
  const client = createClaudeClient({
    tokens: ['synthetic-primary', 'synthetic-backup'],
    baseURL: 'https://api.anthropic.com/v1',
    timeout: 1000,
    transport: 'native',
    fetch: async (input, init) => {
      const request = captureRequest(input, init);
      requests.push(request.clone());
      if (request.headers.get('x-api-key') === 'synthetic-primary')
        return new Promise<Response>((_resolve, reject) => {
          request.signal.addEventListener('abort', () => reject(request.signal.reason), {
            once: true,
          });
        });
      return nativeAnswer();
    },
  });
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-sonnet-5-5', {
    anthropic: true,
  });
  const failures: unknown[] = [];
  const output = await slot.stream(
    {
      messages: [{ role: 'user', content: 'Synthetic.' }],
      maxTokens: 50,
      purpose: 'probe',
      onNativeUsage: (usage) => {
        observed = usage;
      },
      perProviderTimeoutMs: 1000,
      onCredentialRetry: (attempt) => {
        failures.push(attempt.error);
        failedUsage.push(observed);
      },
    },
    {},
  );
  expect(requests).toHaveLength(2);
  expect(failures).toHaveLength(1);
  const id = (key: string) => createHash('sha256').update(key).digest('hex').slice(0, 12);
  expect(failedUsage[0]).toMatchObject({
    credentialId: id('synthetic-primary'),
    promptTokens: null,
    cachedTokens: null,
  });
  expect(output.usage.credentialId).toBe(id('synthetic-backup'));
});

test('finance native cancellation retains known input and never rotates after stream creation', async () => {
  let observed: TokenUsage | null = null;
  const controller = new AbortController();
  let calls = 0;
  const client = createClaudeClient({
    tokens: ['synthetic-primary', 'synthetic-backup'],
    baseURL: 'https://api.anthropic.com/v1',
    timeout: 1000,
    transport: 'native',
    fetch: async () => {
      calls++;
      return nativeAnswer();
    },
  });
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-sonnet-5-5', {
    anthropic: true,
  });
  let failure: unknown;
  try {
    await slot.stream(
      {
        messages: [{ role: 'user', content: 'Synthetic.' }],
        maxTokens: 50,
        purpose: 'probe',
        onNativeUsage: (usage) => {
          observed = usage;
        },
        signal: controller.signal,
      },
      { onTextDelta: () => controller.abort() },
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(Error);
  expect(calls).toBe(1);
  expect(observed).toMatchObject({
    freshInputTokens: 7,
    cacheWriteTokens: 100,
    cachedTokens: 200,
  });
});

test('finance automatic history caching is limited to explicitly marked agent prompts', () => {
  const build = (system: OpenAI.ChatCompletionSystemMessageParam) =>
    nativeRequest({
      model: 'claude-synthetic',
      stream: true,
      max_tokens: 100,
      messages: [system, { role: 'user', content: 'Unique receipt or validation input.' }],
    });
  const oneShot = build({ role: 'system', content: 'Fixed rules.' });
  expect(oneShot.cache_control).toBeUndefined();
  expect(oneShot.system?.[0]?.cache_control).toEqual({ type: 'ephemeral' });
  const batch = build(
    cacheableSystemMessage('Fixed rules. Dynamic context.', 'Fixed rules.', false),
  );
  expect(batch.cache_control).toBeUndefined();
  expect(batch.system?.[0]).toEqual({
    type: 'text',
    text: 'Fixed rules.',
    cache_control: { type: 'ephemeral' },
  });
  expect(batch.system?.[1]?.cache_control).toBeUndefined();
  const agent = build(cacheableSystemMessage('Fixed rules. Dynamic context.', 'Fixed rules.'));
  expect(agent.cache_control).toEqual({ type: 'ephemeral' });
  expect(agent.system?.[1]?.cache_control).toBeUndefined();
});

test('incomplete native finance content blocks cannot publish executable tool calls', async () => {
  const client = createClaudeClient({
    tokens: ['synthetic-primary'],
    baseURL: 'https://api.anthropic.com/v1',
    timeout: 1000,
    transport: 'native',
    fetch: async () =>
      sse([
        {
          type: 'message_start',
          message: {
            id: 'synthetic',
            model: 'claude-synthetic',
            usage: {
              input_tokens: 7,
              cache_creation_input_tokens: 100,
              cache_read_input_tokens: 200,
              output_tokens: 1,
            },
          },
        },
        {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: 'one', name: 'read_one', input: {} },
        },
        {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{"day":"synthetic"}' },
        },
        { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 5 } },
        { type: 'message_stop' },
      ]),
  });
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-sonnet-5-5', {
    anthropic: true,
  });
  await expect(
    slot.stream(
      { messages: [{ role: 'user', content: 'Synthetic.' }], maxTokens: 100, purpose: 'probe' },
      {},
    ),
  ).rejects.toThrow('incomplete content blocks');
});

test('native pending SDK reads preserve the exact cancellation reason and classify premature EOF', async () => {
  const controller = new AbortController();
  const reason = new DOMException('Synthetic pending read cancellation', 'AbortError');
  const client = createClaudeClient({
    tokens: ['synthetic-primary'],
    baseURL: 'https://api.anthropic.com/v1',
    timeout: 1000,
    transport: 'native',
    fetch: async (input, init) => {
      const request = captureRequest(input, init);
      return new Response(
        new ReadableStream({
          start(stream) {
            stream.enqueue(
              new TextEncoder().encode(
                'event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic","model":"claude-synthetic","usage":{"input_tokens":7}}}\n\n',
              ),
            );
            request.signal.addEventListener('abort', () => stream.error(request.signal.reason), {
              once: true,
            });
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const params = {
    model: 'claude-synthetic',
    stream: true as const,
    max_tokens: 100,
    messages: [{ role: 'user' as const, content: 'Synthetic.' }],
  };
  const stream = await openChatStream(client, params, controller.signal, 'claude', params.model);
  const iterator = stream[Symbol.asyncIterator]();
  await iterator.next();
  const pending = iterator.next();
  controller.abort(reason);
  await expect(pending).rejects.toBe(reason);

  const eofClient = createClaudeClient({
    tokens: ['synthetic-eof'],
    baseURL: 'https://api.anthropic.com/v1',
    timeout: 1000,
    transport: 'native',
    fetch: async () =>
      sse([
        {
          type: 'message_start',
          message: { id: 'synthetic', model: 'claude-synthetic', usage: {} },
        },
      ]),
  });
  const eof = await openChatStream(eofClient, params, undefined, 'claude', params.model);
  const drain = async () => {
    for await (const _chunk of eof) {
      /* consume synthetic stream */
    }
  };
  await expect(drain()).rejects.toBeInstanceOf(OpenAI.APIConnectionError);
});

test('Claude diagnostic probes use the runtime native adapter with SDK logging disabled', async () => {
  const paths: string[] = [];
  const client = createClaudeClient({
    tokens: ['synthetic-probe'],
    baseURL: 'https://api.anthropic.com/v1',
    timeout: 1000,
    transport: 'native',
    fetch: async (input, init) => {
      paths.push(new URL(captureRequest(input, init).url).pathname);
      return nativeAnswer();
    },
  });
  const result = await probeCompletion(
    client,
    {
      model: 'claude-synthetic',
      max_tokens: 100,
      messages: [{ role: 'user', content: 'Synthetic.' }],
    },
    true,
  );
  expect(paths).toEqual(['/v1/messages']);
  expect(client.logLevel).toBe('off');
  expect(result.choices[0]?.message.content).toBe('ok');
  expect(result.usage?.prompt_tokens).toBe(307);
});

test('native conversion accepts foreign no-argument null tool calls without altering IDs', () => {
  const body = nativeRequest({
    model: 'claude-synthetic',
    max_tokens: 128,
    stream: true,
    messages: [
      { role: 'user', content: 'Synthetic.' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          {
            id: 'foreign-null',
            type: 'function',
            function: { name: 'read_all', arguments: 'null' },
          },
        ],
      },
      { role: 'tool', tool_call_id: 'foreign-null', content: 'Synthetic result.' },
    ],
  });
  expect(body.messages[1]?.content).toEqual([
    { type: 'tool_use', id: 'foreign-null', name: 'read_all', input: {} },
  ]);
  expect(body.messages[2]?.content).toEqual([
    {
      type: 'tool_result',
      tool_use_id: 'foreign-null',
      content: [{ type: 'text', text: 'Synthetic result.' }],
    },
  ]);
});

test.each([
  ['overloaded_error', 'server'],
  ['rate_limit_error', 'rate_limit'],
] as const)('native finance SSE %s retains known usage without inventing an HTTP status', async (type, errorClass) => {
  let observed: TokenUsage | null = null;
  const client = createClaudeClient({
    tokens: ['synthetic-primary'],
    baseURL: 'https://api.anthropic.com/v1',
    timeout: 1000,
    transport: 'native',
    fetch: async () =>
      sse([
        {
          type: 'message_start',
          message: {
            id: 'synthetic',
            model: 'claude-synthetic',
            usage: {
              input_tokens: 7,
              cache_creation_input_tokens: 100,
              cache_read_input_tokens: 200,
              output_tokens: 1,
            },
          },
        },
        { type: 'error', error: { type, message: 'Synthetic provider failure.' } },
      ]),
  });
  const slot = streamingSlot('Claude', 'claude', () => client, 'claude-sonnet-5-5', {
    anthropic: true,
  });
  let failure: unknown;
  try {
    await slot.stream(
      {
        messages: [{ role: 'user', content: 'Synthetic.' }],
        maxTokens: 50,
        purpose: 'probe',
        onNativeUsage: (usage) => {
          observed = usage;
        },
      },
      {},
    );
  } catch (error) {
    failure = error;
  }
  expect(failure).toBeInstanceOf(OpenAI.APIError);
  expect(
    classifyAttemptFailure(failure, { callerAborted: false, providerTimedOut: false }),
  ).toEqual({ errorClass, httpStatus: null });
  expect(observed).toMatchObject({
    promptTokens: 307,
    freshInputTokens: 7,
    cacheWriteTokens: 100,
    cachedTokens: 200,
    completionTokens: 1,
  });
});

test('diagnostic native streams remain bounded after response headers', async () => {
  let closeStream = () => {};
  let pending = true;
  const client = createClaudeClient({
    tokens: ['synthetic-probe'],
    baseURL: 'https://api.anthropic.com/v1',
    timeout: 20,
    transport: 'native',
    fetch: async (input, init) => {
      const request = captureRequest(input, init);
      return new Response(
        new ReadableStream({
          start(stream) {
            closeStream = () => stream.close();
            stream.enqueue(
              new TextEncoder().encode(
                'event: message_start\ndata: {"type":"message_start","message":{"id":"synthetic","model":"claude-synthetic","usage":{"input_tokens":7}}}\n\n',
              ),
            );
            request.signal.addEventListener('abort', () => stream.error(request.signal.reason), {
              once: true,
            });
          },
        }),
        { headers: { 'content-type': 'text/event-stream' } },
      );
    },
  });
  const outcome = probeCompletion(
    client,
    {
      model: 'claude-synthetic',
      max_tokens: 32,
      messages: [{ role: 'user', content: 'Synthetic.' }],
    },
    true,
  )
    .then(
      () => null,
      (error: unknown) => error,
    )
    .finally(() => {
      pending = false;
    });
  try {
    const result = await Promise.race([outcome, Bun.sleep(150).then(() => 'still waiting')]);
    expect(result).toMatchObject({ name: 'TimeoutError' });
  } finally {
    if (pending) closeStream();
    await outcome;
  }
});
