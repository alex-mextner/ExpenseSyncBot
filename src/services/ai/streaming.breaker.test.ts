// Tests for how aiStreamRound feeds the provider breaker: demotion after repeated connection
// failures, 402/429 cooldowns, what must NOT demote (4xx, mid-stream drops, aborts), and the retryable
// aggregate of a connection outage.

import { beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import OpenAI from 'openai';
import {
  aiStreamRound,
  isProviderDemoted,
  resetFallbackEnv,
  streamingModule,
} from './streaming.test-support';

const { classifyAiError, isRetryableError } = streamingModule;

describe('aiStreamRound fallback chain', () => {
  beforeEach(() => {
    resetFallbackEnv();
  });

  it('demotes a provider to the back of the chain after repeated connection failures', async () => {
    const clientsMod = await import('./clients');
    const order: string[] = [];
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      order.push(params.model);
      if (params.model === 'test-model') {
        // z.ai unreachable (connection-type failure the breaker counts).
        throw Object.assign(new Error('connection refused'), { code: 'ECONNREFUSED' });
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    const round = () =>
      aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });

    // Three rounds where z.ai connection-fails first each time (Claude answers).
    for (let i = 0; i < 3; i++) {
      order.length = 0;
      await round();
      expect(order[0]).toBe('test-model'); // still tried first while it has < 3 failures
    }

    // 4th round: z.ai is now demoted → Claude is tried first, z.ai is not the head of the chain.
    order.length = 0;
    const result = await round();
    expect(order[0]).toBe('claude-smart');
    expect(order).not.toContain('test-model'); // Claude answered, so the demoted z.ai isn't reached
    expect(result.text).toBe('ok');
  });

  it('does not demote a provider for response-level (4xx) failures', async () => {
    const clientsMod = await import('./clients');
    const order: string[] = [];
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      order.push(params.model);
      if (params.model === 'test-model') {
        // A 4xx is a response, not a connection failure — the breaker must NOT count it.
        throw new OpenAI.APIError(400, { message: 'bad' }, 'bad', new Headers());
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    const round = () =>
      aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    for (let i = 0; i < 4; i++) {
      order.length = 0;
      await round();
      expect(order[0]).toBe('test-model'); // never demoted for 4xx — always tried first
    }
  });

  // The HF router answers 402 "no remaining credits" (HYP-1667) and stays that way until the
  // owner tops up — like an exhausted quota, the slot must cool down at the back of the chain
  // instead of being retried in its normal position on every request.
  const NO_CREDITS =
    'You have no remaining credits. Purchase pre-paid credits to continue using Inference Providers.';
  const noCredits = () =>
    new OpenAI.APIError(402, { message: NO_CREDITS }, NO_CREDITS, new Headers());

  it('a 402 (no credits) demotes the provider for an hour, so the next round skips past it', async () => {
    const clientsMod = await import('./clients');
    const order: string[] = [];
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      order.push(params.model);
      if (params.model === 'test-model') throw noCredits();
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    const round = () =>
      aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });

    await round();
    expect(order).toEqual(['test-model', 'claude-smart']);

    order.length = 0;
    await round();
    expect(order).toEqual(['claude-smart']); // the out-of-credits z.ai is not paid for again
    expect(isProviderDemoted('zai', Date.now() + 59 * 60_000)).toBe(true);
    expect(isProviderDemoted('zai', Date.now() + 61 * 60_000)).toBe(false);
  });

  it('a 402 from the HF fallback slot demotes HF for an hour', async () => {
    const clientsMod = await import('./clients');
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'hf-test') throw noCredits();
      throw new OpenAI.APIError(503, { message: 'down' }, 'down', new Headers());
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }

    await expect(
      aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      }),
    ).rejects.toThrow('All 3 providers in smart chain failed');
    expect(isProviderDemoted('hf', Date.now() + 59 * 60_000)).toBe(true);
  });

  it('does not demote a provider for a 4xx whose message mentions "connection"', async () => {
    const clientsMod = await import('./clients');
    const order: string[] = [];
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      order.push(params.model);
      if (params.model === 'test-model') {
        // A real response (status 400) whose text mentions "connection" — provider WAS reachable,
        // so the breaker must not count it (status defined → not an unreachable failure).
        throw new OpenAI.APIError(
          400,
          { message: 'connection error' },
          'connection error',
          new Headers(),
        );
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    const round = () =>
      aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    for (let i = 0; i < 4; i++) {
      order.length = 0;
      await round();
      expect(order[0]).toBe('test-model'); // 400 response never demotes — always tried first
    }
  });

  it('does not demote a provider when the connection failure happens mid-stream', async () => {
    // Text already emitted means the connection was fine up to that point — a later drop must NOT
    // count toward the breaker, or a flaky-late provider would wrongly get demoted.
    const clientsMod = await import('./clients');
    const create = mock(async () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      },
    }));
    spyOn(clientsMod, 'zaiClient').mockReturnValue({
      chat: { completions: { create } },
    } as unknown as OpenAI);
    for (let i = 0; i < 4; i++) {
      await expect(
        aiStreamRound(
          { messages: [{ role: 'user', content: 'hi' }], maxTokens: 50, chain: 'smart' },
          { onTextDelta: () => {} },
        ),
      ).rejects.toThrow();
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(false);
  });

  it('does not demote a provider that streamed a tool-call before dropping mid-stream', async () => {
    // The provider emitted a tool-call (proof of reachability), then dropped with ECONNRESET — that
    // late drop must NOT count toward the breaker even though no TEXT was emitted.
    const clientsMod = await import('./clients');
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        return {
          [Symbol.asyncIterator]: async function* () {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [
                      { index: 0, id: 'call_1', function: { name: 'foo', arguments: '{}' } },
                    ],
                  },
                  finish_reason: null,
                },
              ],
            };
            throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
          },
        };
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    for (let i = 0; i < 4; i++) {
      await aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(false);
  });

  it('does not demote a provider that streamed a nameless tool-call chunk before dropping', async () => {
    // Tool-call id/arguments can arrive before the function name; that chunk is still proof of
    // reachability. A subsequent ECONNRESET must not demote (the breaker reads the error tag, not
    // onToolCallStart which only fires once a name is present).
    const clientsMod = await import('./clients');
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        return {
          [Symbol.asyncIterator]: async function* () {
            yield {
              choices: [
                {
                  delta: {
                    tool_calls: [{ index: 0, id: 'call_1', function: { arguments: '{}' } }],
                  },
                  finish_reason: null,
                },
              ],
            };
            throw Object.assign(new Error('reset'), { code: 'ECONNRESET' });
          },
        };
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    for (let i = 0; i < 4; i++) {
      await aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(false);
  });

  it('an abort does not mutate breaker state (does not reset accrued connection failures)', async () => {
    // An abort (the agent's 60s timeout / caller cancellation) is not evidence about the provider —
    // it must neither demote nor clear accrued connection failures.
    const clientsMod = await import('./clients');
    let round = 0;
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        if (round === 2) {
          const abort = new Error('The operation was aborted');
          abort.name = 'AbortError';
          throw abort; // a real connection failure would be ECONNREFUSED; this is a cancellation
        }
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    // conn(1), conn(2), abort(ignored), conn(3) — the abort must not reset, so the 3rd demotes.
    for (round = 0; round < 4; round++) {
      await aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(true);
  });

  it('text-then-drop resets the accrued connection-failure cluster', async () => {
    // A provider that streams text then drops mid-stream proved it was reachable, so its accrued
    // connection-failure cluster must reset — even though the round bails out (cannot fallback).
    const clientsMod = await import('./clients');
    let round = 0;
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        if (round === 2) {
          return {
            [Symbol.asyncIterator]: async function* () {
              yield { choices: [{ delta: { content: 'partial' }, finish_reason: null }] };
              throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
            },
          };
        }
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    // conn(1), conn(2), text-then-drop(RESET), conn(1) — the reset means the 4th round is only count 1.
    for (round = 0; round < 4; round++) {
      const pending = aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
      if (round === 2) {
        await expect(pending).rejects.toThrow(); // text emitted → cannot fallback
      } else {
        await pending;
      }
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(false);
  });

  it('an all-provider connection outage yields a retryable aggregate', async () => {
    // Every provider throws a real OpenAI.APIConnectionError (status undefined, no code). The
    // aggregate is a plain Error, but isRetryableError must still retry the chain-level outage.
    const clientsMod = await import('./clients');
    const create = mock(async () => {
      throw new OpenAI.APIConnectionError({ message: 'Connection error.' });
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    let thrown: unknown;
    try {
      await aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    } catch (error) {
      thrown = error;
    }
    expect(isRetryableError(thrown)).toBe(true);
  });

  it('demotes a provider after 3 real APIConnectionError outages', async () => {
    // APIConnectionError has status undefined and no code — it must still count as unreachable (and
    // must NOT be mistaken for an abort, which would skip the breaker).
    const clientsMod = await import('./clients');
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        throw new OpenAI.APIConnectionError({ message: 'Connection error.' });
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    for (let i = 0; i < 3; i++) {
      await aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(true);
  });

  it('an APIUserAbortError does not mutate breaker state', async () => {
    // The SDK abort error has status undefined and name "Error" (matched only by its "was aborted"
    // message) — it must be treated as an abort and leave accrued connection failures intact.
    const clientsMod = await import('./clients');
    let round = 0;
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        if (round === 2) throw new OpenAI.APIUserAbortError();
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    // conn(1), conn(2), abort(ignored), conn(3) — the abort must not reset, so the 3rd demotes.
    for (round = 0; round < 4; round++) {
      await aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(true);
  });

  it('a mixed transient+4xx chain intentionally retries and reads as provider_down', async () => {
    // Documents the deliberate choice (pickRepresentativeError): a transient signal outranks a
    // co-occurring 4xx, so a chain that is mostly down but has one provider 4xx still retries rather
    // than reading as a (non-retryable) bad request — failing safe toward "try later".
    const clientsMod = await import('./clients');
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model')
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      throw new OpenAI.APIError(400, { message: 'bad' }, 'bad', new Headers());
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    let thrown: unknown;
    try {
      await aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    } catch (error) {
      thrown = error;
    }
    expect(isRetryableError(thrown)).toBe(true);
    expect(classifyAiError(thrown)?.kind).toBe('provider_down');
  });

  it('a 5xx response does not lift an existing connection-demotion', async () => {
    const clientsMod = await import('./clients');
    const conn = () => Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
    const ok = () => ({
      [Symbol.asyncIterator]: async function* () {
        yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
      },
    });
    let round = 0;
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (round < 3) {
        if (params.model === 'test-model') throw conn(); // z.ai unreachable → accrues toward demotion
        return ok(); // Claude answers
      }
      // Final round: the whole chain fails and the demoted z.ai is reached, returning a 503.
      if (params.model === 'test-model') {
        throw new OpenAI.APIError(503, { message: 'down' }, 'down', new Headers());
      }
      throw conn();
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    const runRound = () =>
      aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    for (round = 0; round < 3; round++) await runRound();
    expect(isProviderDemoted('zai', Date.now())).toBe(true); // demoted after 3 connection failures
    await expect(runRound()).rejects.toThrow(); // round 3: z.ai returns a 503 (reachable)
    // The 503 only reset the connection counter — it did NOT rehabilitate the demoted provider.
    expect(isProviderDemoted('zai', Date.now())).toBe(true);
  });

  it('a reachable empty-response between connection failures resets the breaker streak', async () => {
    // The empty-response fallback throws a plain Error (no status, not connection-like) — it proves
    // the provider was reachable, so it must break the connection streak, not be ignored.
    const clientsMod = await import('./clients');
    let round = 0;
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        if (round === 2) {
          // Reachable but empty → streamingSlot throws the plain "empty response" Error.
          return {
            [Symbol.asyncIterator]: async function* () {
              yield { choices: [{ delta: {}, finish_reason: 'stop' }] };
            },
          };
        }
        throw Object.assign(new Error('refused'), { code: 'ECONNREFUSED' });
      }
      return {
        [Symbol.asyncIterator]: async function* () {
          yield { choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] };
        },
      };
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    // conn, conn, empty(reset), conn — the empty response resets, so the final conn is only count 1.
    for (round = 0; round < 4; round++) {
      await aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    }
    expect(isProviderDemoted('zai', Date.now())).toBe(false);
  });

  it('aggregate error prefers a transient (5xx) signal over a co-occurring 4xx (keeps retry)', async () => {
    const clientsMod = await import('./clients');
    const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
      if (params.model === 'test-model') {
        throw new OpenAI.APIError(400, { message: 'bad' }, 'bad', new Headers()); // one provider 4xx
      }
      throw new OpenAI.APIError(503, { message: 'down' }, 'down', new Headers()); // the rest 5xx
    });
    for (const fn of ['zaiClient', 'claudeClient', 'hfClient'] as const) {
      spyOn(clientsMod, fn).mockReturnValue({
        chat: { completions: { create } },
      } as unknown as OpenAI);
    }
    let thrown: unknown;
    try {
      await aiStreamRound({
        messages: [{ role: 'user', content: 'hi' }],
        maxTokens: 50,
        chain: 'smart',
      });
    } catch (error) {
      thrown = error;
    }
    // The transient 503 is carried, NOT the 400 — so the chain reads as provider_down, not a
    // (non-retryable) "bad request", independent of which provider failed last.
    expect((thrown as { status?: number }).status).toBe(503);
    // The aggregate is a plain Error, but isRetryableError reads status structurally → still retried.
    expect(isRetryableError(thrown)).toBe(true);
  });
});
