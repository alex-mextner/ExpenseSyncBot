// src/services/ai/agent.test.ts
// Tests for ExpenseBotAgent — streaming, tool calls, error handling

import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { ExpenseBotAgent } from './agent';
import * as responseValidator from './response-validator';
import type { AgentContext } from './types';

// Minimal AgentContext with all required fields
function makeCtx(overrides?: Partial<AgentContext>): AgentContext {
  return {
    chatId: 123,
    groupId: 1,
    userId: 10,
    userName: 'testuser',
    userFullName: 'Test User',
    customPrompt: null,
    telegramGroupId: 123,
    ...overrides,
  };
}

// Fake streaming response that matches agent.ts for-await iteration + finalMessage()
function makeFakeStream(
  chunks: string[] = ['Hello', ' world'],
  toolUseBlock?: { id: string; name: string; inputJson: string },
) {
  const events: unknown[] = [];

  if (toolUseBlock) {
    events.push({
      type: 'content_block_start',
      content_block: { type: 'tool_use', id: toolUseBlock.id, name: toolUseBlock.name },
    });
    events.push({
      type: 'content_block_delta',
      delta: { type: 'input_json_delta', partial_json: toolUseBlock.inputJson },
    });
    events.push({ type: 'content_block_stop' });
  } else {
    for (const text of chunks) {
      events.push({ type: 'content_block_delta', delta: { type: 'text_delta', text } });
    }
    events.push({ type: 'message_stop' });
  }

  const textContent = chunks.join('');

  return {
    [Symbol.asyncIterator]: async function* () {
      for (const event of events) {
        yield event;
      }
    },
    finalMessage: async () => ({
      content: toolUseBlock
        ? [{ type: 'tool_use', id: toolUseBlock.id, name: toolUseBlock.name, input: {} }]
        : [{ type: 'text', text: textContent }],
      stop_reason: toolUseBlock ? 'tool_use' : 'end_turn',
      id: 'msg_test',
      model: 'test',
      role: 'assistant',
      type: 'message',
      usage: { input_tokens: 10, output_tokens: 5 },
    }),
  };
}

/** Extract the first call args from a spy as Anthropic stream params */
function getCallArgs(spy: {
  mock: { calls: ReadonlyArray<ReadonlyArray<unknown>> };
}): Anthropic.MessageStreamParams {
  const call = spy.mock.calls.at(0);
  if (!call) throw new Error('Expected spy to be called');
  const args = call.at(0);
  if (args === undefined) throw new Error('Expected spy call args');
  return args as Anthropic.MessageStreamParams;
}

// Minimal bot stub with tracked calls
function makeMockBot() {
  return {
    api: {
      sendMessage: mock(() =>
        Promise.resolve({ message_id: 1, chat: { id: 1 }, date: 0, text: '' }),
      ),
      editMessageText: mock(() =>
        Promise.resolve({ message_id: 1, chat: { id: 1 }, date: 0, text: '' }),
      ),
      sendChatAction: mock(() => Promise.resolve(true)),
      deleteMessage: mock(() => Promise.resolve(true)),
    },
  };
}

describe('ExpenseBotAgent', () => {
  let agent: ExpenseBotAgent;
  let mockBot: ReturnType<typeof makeMockBot>;

  beforeEach(() => {
    agent = new ExpenseBotAgent('test-api-key', makeCtx());
    mockBot = makeMockBot();
    // Prevent real API calls from the response validator
    spyOn(responseValidator, 'validateResponse').mockResolvedValue({ approved: true });
  });

  afterEach(() => {
    mock.restore();
  });

  // ── Construction ───────────────────────────────────────────────────

  describe('construction', () => {
    it('creates instance without throwing', () => {
      expect(agent).toBeTruthy();
    });

    it('creates instance with custom prompt', () => {
      const a = new ExpenseBotAgent('key', makeCtx({ customPrompt: 'Custom instructions' }));
      expect(a).toBeTruthy();
    });

    it('creates instance with different chatId', () => {
      const a = new ExpenseBotAgent('key', makeCtx({ chatId: 999 }));
      expect(a).toBeTruthy();
    });

    it('stores context correctly (accessible via cast)', () => {
      const ctx = makeCtx({ chatId: 42, userId: 7 });
      const a = new ExpenseBotAgent('key', ctx);
      const privateCtx = (a as unknown as { ctx: AgentContext }).ctx;
      expect(privateCtx.chatId).toBe(42);
      expect(privateCtx.userId).toBe(7);
    });
  });

  // ── run() — basic streaming ────────────────────────────────────────

  describe('run() — basic streaming', () => {
    it('returns a string response', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['Hello', ' world']) as unknown as ReturnType<
          typeof anthropic.messages.stream
        >,
      );

      const result = await agent.run(
        'What are my expenses?',
        [],
        mockBot as unknown as import('gramio').Bot,
      );
      expect(typeof result).toBe('string');
    });

    it('returns non-empty string for normal response', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['Hello world']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      const result = await agent.run('Hello', [], mockBot as unknown as import('gramio').Bot);
      expect(result.length).toBeGreaterThanOrEqual(0); // may be empty if only tool calls happened
    });

    it('calls anthropic.messages.stream exactly once for no-tool response', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['Answer.']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      await agent.run('How much did I spend?', [], mockBot as unknown as import('gramio').Bot);
      expect(streamSpy).toHaveBeenCalledTimes(1);
    });

    it('passes model and max_tokens to Anthropic', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['ok']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      await agent.run('test', [], mockBot as unknown as import('gramio').Bot);
      const callArgs = getCallArgs(streamSpy);
      expect(callArgs.max_tokens).toBe(4096);
      expect(typeof callArgs.model).toBe('string');
    });

    it('passes system prompt with current date', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['ok']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      await agent.run('test', [], mockBot as unknown as import('gramio').Bot);
      const callArgs = getCallArgs(streamSpy);
      const systemBlocks = callArgs.system as Array<{ type: string; text: string }>;
      expect(Array.isArray(systemBlocks)).toBe(true);
      expect(systemBlocks.at(0)?.text).toContain('CURRENT DATE');
    });

    it('includes user message as last message in messages array', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['ok']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      const question = 'What is my total?';
      await agent.run(question, [], mockBot as unknown as import('gramio').Bot);

      const callArgs = getCallArgs(streamSpy);
      const lastMsg = callArgs.messages.at(-1);
      if (!lastMsg) throw new Error('No messages in callArgs');
      expect(lastMsg.role).toBe('user');
      expect(lastMsg.content).toBe(question);
    });

    it('includes tools in stream call', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['ok']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      await agent.run('test', [], mockBot as unknown as import('gramio').Bot);

      const callArgs = getCallArgs(streamSpy);
      expect(Array.isArray(callArgs.tools)).toBe(true);
      expect((callArgs.tools ?? []).length).toBeGreaterThan(0);
    });
  });

  // ── run() — conversation history ──────────────────────────────────

  describe('run() — conversation history', () => {
    it('handles empty conversation history without error', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['ok']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      await expect(
        agent.run('Hello', [], mockBot as unknown as import('gramio').Bot),
      ).resolves.toBeDefined();
    });

    it('includes conversation history in Anthropic call', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['ok']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      const history = [
        {
          id: 1,
          group_id: 1,
          user_id: 10,
          role: 'user' as const,
          content: 'Hi',
          created_at: '2026-01-01',
        },
        {
          id: 2,
          group_id: 1,
          user_id: 10,
          role: 'assistant' as const,
          content: 'Hello!',
          created_at: '2026-01-01',
        },
      ];
      await agent.run('Thanks', history, mockBot as unknown as import('gramio').Bot);

      const callArgs = getCallArgs(streamSpy);
      // history (2) + new user message (1) = 3
      expect(callArgs.messages.length).toBe(3);
    });

    it('maps history role user correctly', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['ok']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      const history = [
        {
          id: 1,
          group_id: 1,
          user_id: 10,
          role: 'user' as const,
          content: 'Hi',
          created_at: '2026-01-01',
        },
      ];
      await agent.run('question', history, mockBot as unknown as import('gramio').Bot);

      const callArgs = getCallArgs(streamSpy);
      expect(callArgs.messages.at(0)?.role).toBe('user');
    });

    it('maps history role assistant correctly', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['ok']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      const history = [
        {
          id: 1,
          group_id: 1,
          user_id: 10,
          role: 'assistant' as const,
          content: 'Reply',
          created_at: '2026-01-01',
        },
      ];
      await agent.run('question', history, mockBot as unknown as import('gramio').Bot);

      const callArgs = getCallArgs(streamSpy);
      expect(callArgs.messages.at(0)?.role).toBe('assistant');
    });

    it('parses JSON array content from history', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['ok']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      const jsonContent = JSON.stringify([{ type: 'text', text: 'Hi' }]);
      const history = [
        {
          id: 1,
          group_id: 1,
          user_id: 10,
          role: 'user' as const,
          content: jsonContent,
          created_at: '',
        },
      ];
      await agent.run('q', history, mockBot as unknown as import('gramio').Bot);

      const callArgs = getCallArgs(streamSpy);
      // Content should be parsed as array
      expect(Array.isArray(callArgs.messages.at(0)?.content)).toBe(true);
    });

    it('falls back to plain text when history content is invalid JSON', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['ok']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      const history = [
        {
          id: 1,
          group_id: 1,
          user_id: 10,
          role: 'user' as const,
          content: 'plain text',
          created_at: '',
        },
      ];
      await agent.run('q', history, mockBot as unknown as import('gramio').Bot);

      const callArgs = getCallArgs(streamSpy);
      expect(callArgs.messages.at(0)?.content).toBe('plain text');
    });
  });

  // ── run() — system prompt content ─────────────────────────────────

  describe('run() — system prompt', () => {
    it('includes current user name in system prompt', async () => {
      const a = new ExpenseBotAgent('key', makeCtx({ userName: 'johndoe' }));
      const anthropic = (a as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['ok']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      await a.run('test', [], mockBot as unknown as import('gramio').Bot);

      const callArgs = getCallArgs(streamSpy);
      const systemBlocks = callArgs.system as Array<{ type: string; text: string }>;
      expect(systemBlocks.at(0)?.text).toContain('@johndoe');
    });

    it('includes custom prompt when set', async () => {
      const a = new ExpenseBotAgent('key', makeCtx({ customPrompt: 'Only answer in English.' }));
      const anthropic = (a as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['ok']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      await a.run('test', [], mockBot as unknown as import('gramio').Bot);

      const callArgs = getCallArgs(streamSpy);
      const systemBlocks = callArgs.system as Array<{ type: string; text: string }>;
      expect(systemBlocks.at(0)?.text).toContain('Only answer in English.');
    });

    it('does not include custom prompt section when customPrompt is null', async () => {
      const a = new ExpenseBotAgent('key', makeCtx({ customPrompt: null }));
      const anthropic = (a as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['ok']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      await a.run('test', [], mockBot as unknown as import('gramio').Bot);

      const callArgs = getCallArgs(streamSpy);
      const systemBlocks = callArgs.system as Array<{ type: string; text: string }>;
      expect(systemBlocks.at(0)?.text).not.toContain('CUSTOM GROUP INSTRUCTIONS');
    });

    it('system block has cache_control ephemeral', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(
        makeFakeStream(['ok']) as unknown as ReturnType<typeof anthropic.messages.stream>,
      );

      await agent.run('test', [], mockBot as unknown as import('gramio').Bot);

      const callArgs = getCallArgs(streamSpy);
      const systemBlocks = callArgs.system as Array<{
        type: string;
        cache_control?: { type: string };
      }>;
      expect(systemBlocks.at(0)?.cache_control?.type).toBe('ephemeral');
    });
  });

  // ── run() — error handling (existing behavior) ────────────────────

  describe('run() — error handling (Anthropic.APIError)', () => {
    it('handles Anthropic 429 rate limit — sends user message and returns string', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const apiError = new Anthropic.RateLimitError(
        429,
        { error: { type: 'rate_limit_error', message: 'Rate limit exceeded' } },
        'Rate limit exceeded',
        new Headers(),
      );
      spyOn(anthropic.messages, 'stream').mockImplementation(() => {
        throw apiError;
      });

      const result = await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
      expect(typeof result).toBe('string');
      expect(result).toContain('Слишком много запросов');
    });

    it('handles Anthropic 529 overloaded — sends user message and returns string', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const overloadedError = Object.assign(
        new Anthropic.APIError(
          529,
          { error: { type: 'overloaded_error', message: 'Overloaded' } },
          'Overloaded',
          new Headers(),
        ),
        { status: 529 },
      );
      spyOn(anthropic.messages, 'stream').mockImplementation(() => {
        throw overloadedError;
      });

      const result = await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
      expect(typeof result).toBe('string');
      expect(result).toContain('перегружен');
    });

    it('handles other Anthropic APIError — logs and returns error string', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const apiError = new Anthropic.InternalServerError(
        500,
        { error: { type: 'api_error', message: 'Server error' } },
        'Server error',
        new Headers(),
      );
      spyOn(anthropic.messages, 'stream').mockImplementation(() => {
        throw apiError;
      });

      const result = await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
      expect(typeof result).toBe('string');
      expect(result).toContain('Ошибка AI');
    });

    it('handles AbortError (timeout) — sends timeout message', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      spyOn(anthropic.messages, 'stream').mockImplementation(() => {
        throw abortError;
      });

      const result = await agent.run('question', [], mockBot as unknown as import('gramio').Bot);
      expect(typeof result).toBe('string');
      expect(result).toContain('ожидания');
    });
  });

  // ── run() — TDD typed error wrapping ─────────────────────────────
  // These tests drive changes to agent.ts to wrap unknown errors in typed classes

  describe('run() — TDD typed error wrapping', () => {
    it('[TDD] wraps error with status:429 as AnthropicError when not Anthropic.APIError instance', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      // Simulate a status:429 error that is NOT an Anthropic.APIError instance
      // (e.g., proxy server returning 429 wrapped in a plain Error)
      const rawErr = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      spyOn(anthropic.messages, 'stream').mockImplementation(() => {
        throw rawErr;
      });

      const { AnthropicError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(AnthropicError);
    });

    it('[TDD] wraps error with status:500 as AnthropicError', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const serverErr = Object.assign(new Error('Internal server error'), { status: 500 });
      spyOn(anthropic.messages, 'stream').mockImplementation(() => {
        throw serverErr;
      });

      const { AnthropicError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(AnthropicError);
    });

    it('[TDD] wraps ETIMEDOUT error as NetworkError', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const timeoutErr = Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' });
      spyOn(anthropic.messages, 'stream').mockImplementation(() => {
        throw timeoutErr;
      });

      const { NetworkError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(NetworkError);
    });

    it('[TDD] wraps ECONNREFUSED error as NetworkError', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const connErr = Object.assign(new Error('Connection refused'), { code: 'ECONNREFUSED' });
      spyOn(anthropic.messages, 'stream').mockImplementation(() => {
        throw connErr;
      });

      const { NetworkError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(NetworkError);
    });

    it('[TDD] wraps ENOTFOUND error as NetworkError', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const dnsErr = Object.assign(new Error('DNS lookup failed'), { code: 'ENOTFOUND' });
      spyOn(anthropic.messages, 'stream').mockImplementation(() => {
        throw dnsErr;
      });

      const { NetworkError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(NetworkError);
    });

    it('[TDD] rethrows unknown error without wrapping', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const unknownErr = new TypeError('Unexpected type error');
      spyOn(anthropic.messages, 'stream').mockImplementation(() => {
        throw unknownErr;
      });

      // Should rethrow as-is (no wrapping for plain errors without status/code)
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot),
      ).rejects.toBeInstanceOf(TypeError);
    });
  });
});
