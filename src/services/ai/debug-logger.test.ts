// Tests for AiDebugLogger and AiDebugRunContext — file-per-chat session logging.
// Mocks node:fs to avoid real filesystem writes.
import { beforeEach, describe, expect, mock, test } from 'bun:test';

// ── fs mock ───────────────────────────────────────────────────────────────
// Track all fs calls; individual tests can override behavior per-call.

type AppendCall = { file: string; data: string };
type MkdirCall = { dir: string };

const appendCalls: AppendCall[] = [];
const mkdirCalls: MkdirCall[] = [];

let appendImpl: (file: string, data: string) => void = () => {};
let mkdirImpl: (dir: string) => void = () => {};

mock.module('node:fs', () => ({
  appendFileSync: (file: string, data: string) => {
    appendCalls.push({ file, data: String(data) });
    appendImpl(file, String(data));
  },
  mkdirSync: (dir: string) => {
    mkdirCalls.push({ dir });
    mkdirImpl(dir);
  },
}));

const { AiDebugLogger, AiDebugRunContext } = await import('./debug-logger');

function resetFsMock(): void {
  appendCalls.length = 0;
  mkdirCalls.length = 0;
  appendImpl = () => {};
  mkdirImpl = () => {};
}

beforeEach(() => {
  resetFsMock();
});

// ── AiDebugLogger.createRunContext ────────────────────────────────────────

describe('AiDebugLogger.createRunContext', () => {
  test('returns null when disabled', () => {
    const logger = new AiDebugLogger(false, '/tmp/logs');
    const ctx = logger.createRunContext(1, -100, 'alice', 'Alice A', 'hello');
    expect(ctx).toBeNull();
    // When disabled we must not touch the filesystem at all
    expect(mkdirCalls).toHaveLength(0);
    expect(appendCalls).toHaveLength(0);
  });

  test('returns a run context and creates the chat directory when enabled', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(42, -1001, 'alice', 'Alice A', 'hello');
    expect(ctx).toBeInstanceOf(AiDebugRunContext);
    // Creates logs/chats/{chatId} with recursive: true
    expect(mkdirCalls).toHaveLength(1);
    expect(mkdirCalls[0]?.dir).toContain('/tmp/logs');
    expect(mkdirCalls[0]?.dir).toContain('chats');
    expect(mkdirCalls[0]?.dir).toContain('-1001');
  });

  test('reuses the same session file within the 30-min window (same chat)', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx1 = logger.createRunContext(1, -500, undefined, 'U', 'a');
    const ctx2 = logger.createRunContext(1, -500, undefined, 'U', 'b');
    expect(ctx1).not.toBeNull();
    expect(ctx2).not.toBeNull();

    ctx1?.flush();
    ctx2?.flush();

    expect(appendCalls).toHaveLength(2);
    // Both writes must target the same file
    expect(appendCalls[0]?.file).toBe(appendCalls[1]?.file as string);
    // And mkdir is called each time (it's idempotent on disk but the logger doesn't cache that)
  });

  test('different chats get different session files', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctxA = logger.createRunContext(1, -100, undefined, 'U', 'a');
    const ctxB = logger.createRunContext(2, -200, undefined, 'U', 'b');

    ctxA?.flush();
    ctxB?.flush();

    expect(appendCalls).toHaveLength(2);
    expect(appendCalls[0]?.file).not.toBe(appendCalls[1]?.file as string);
    expect(appendCalls[0]?.file).toContain('-100');
    expect(appendCalls[1]?.file).toContain('-200');
  });

  test('mkdirSync failures do not crash createRunContext', () => {
    mkdirImpl = () => {
      throw new Error('EACCES');
    };
    const logger = new AiDebugLogger(true, '/tmp/logs');
    expect(() => logger.createRunContext(1, -1, undefined, 'U', 'x')).not.toThrow();
  });

  test('produced file path ends with .log and carries a timestamp', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(1, -999, undefined, 'U', 'x');
    ctx?.flush();
    expect(appendCalls[0]?.file).toMatch(/\.log$/);
    // Timestamp format: YYYY-MM-DD_HH-MM-SS
    expect(appendCalls[0]?.file).toMatch(/\d{4}-\d{2}-\d{2}_\d{2}-\d{2}-\d{2}\.log$/);
  });
});

// ── AiDebugRunContext: content shape ──────────────────────────────────────

describe('AiDebugRunContext content', () => {
  test('header contains chatId, user label, and message', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(42, -1001, 'alice', 'Alice A', 'say hi');
    ctx?.flush();

    const written = appendCalls[0]?.data ?? '';
    expect(written).toContain('CHAT: -1001');
    expect(written).toContain('uid:42');
    expect(written).toContain('@alice');
    expect(written).toContain('Alice A');
    expect(written).toContain('MESSAGE: say hi');
  });

  test('header omits @username when username is undefined', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(42, -1001, undefined, 'Alice A', 'hi');
    ctx?.flush();
    const written = appendCalls[0]?.data ?? '';
    expect(written).not.toContain('@');
    expect(written).toContain('uid:42');
    expect(written).toContain('Alice A');
  });

  test('logSystemPrompt wraps the prompt in SYSTEM PROMPT markers', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(1, -1, undefined, 'U', 'x');
    ctx?.logSystemPrompt('You are a helpful bot');
    ctx?.flush();

    const written = appendCalls[0]?.data ?? '';
    expect(written).toContain('## SYSTEM PROMPT');
    expect(written).toContain('You are a helpful bot');
    expect(written).toContain('## END SYSTEM PROMPT');
  });

  test('logHistory records count and per-message content (truncated to 500 chars)', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(1, -1, undefined, 'U', 'x');
    const long = 'a'.repeat(700);
    ctx?.logHistory([
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: long },
    ]);
    ctx?.flush();

    const written = appendCalls[0]?.data ?? '';
    expect(written).toContain('## HISTORY [2 messages]');
    expect(written).toContain('[user]');
    expect(written).toContain('[assistant]');
    // Long content truncated — 700 chars reduced to 500
    expect(written).toContain('a'.repeat(500));
    expect(written).not.toContain('a'.repeat(501));
    expect(written).toContain('## END HISTORY');
  });

  test('logRound emits a ROUND N marker', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(1, -1, undefined, 'U', 'x');
    ctx?.logRound(1);
    ctx?.logRound(2);
    ctx?.flush();

    const written = appendCalls[0]?.data ?? '';
    expect(written).toContain('## ROUND 1');
    expect(written).toContain('## ROUND 2');
  });

  test('logToolCall records name + indented JSON input', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(1, -1, undefined, 'U', 'x');
    ctx?.logToolCall('get_expenses', { limit: 10, from: '2026-01-01' });
    ctx?.flush();

    const written = appendCalls[0]?.data ?? '';
    expect(written).toContain('TOOL CALL: get_expenses');
    expect(written).toContain('"limit": 10');
    expect(written).toContain('"from": "2026-01-01"');
  });

  test('logToolResult: output path uses output, truncated to 400 chars', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(1, -1, undefined, 'U', 'x');
    const long = 'x'.repeat(600);
    ctx?.logToolResult('tool_a', true, long);
    ctx?.flush();

    const written = appendCalls[0]?.data ?? '';
    expect(written).toContain('TOOL RESULT: tool_a → OK');
    expect(written).toContain('x'.repeat(400));
    expect(written).not.toContain('x'.repeat(401));
  });

  test('logToolResult: data path uses summary + JSON when output undefined', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(1, -1, undefined, 'U', 'x');
    ctx?.logToolResult('tool_b', true, undefined, undefined, { value: 7 }, 'got value');
    ctx?.flush();

    const written = appendCalls[0]?.data ?? '';
    expect(written).toContain('TOOL RESULT: tool_b → OK');
    expect(written).toContain('got value');
    expect(written).toContain('"value":7');
  });

  test('logToolResult: error path for success=false with no output/data', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(1, -1, undefined, 'U', 'x');
    ctx?.logToolResult('tool_c', false, undefined, 'boom');
    ctx?.flush();

    const written = appendCalls[0]?.data ?? '';
    expect(written).toContain('TOOL RESULT: tool_c → ERROR');
    expect(written).toContain('boom');
  });

  test('logAiText skips empty/whitespace text', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(1, -1, undefined, 'U', 'x');
    ctx?.logAiText('   ');
    ctx?.logAiText('');
    ctx?.logAiText('\n\n');
    ctx?.flush();

    const written = appendCalls[0]?.data ?? '';
    expect(written).not.toContain('AI TEXT:');
  });

  test('logAiText indents and truncates to 600 chars', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(1, -1, undefined, 'U', 'x');
    const long = 'y'.repeat(800);
    ctx?.logAiText(long);
    ctx?.flush();

    const written = appendCalls[0]?.data ?? '';
    expect(written).toContain('AI TEXT:');
    expect(written).toContain('y'.repeat(600));
    expect(written).not.toContain('y'.repeat(601));
  });

  test('logFinal records tool count and response preview', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(1, -1, undefined, 'U', 'x');
    ctx?.logFinal('final answer to user', 3);
    ctx?.flush();

    const written = appendCalls[0]?.data ?? '';
    expect(written).toContain('## FINAL');
    expect(written).toContain('Tools called: 3');
    expect(written).toContain('Response (20 chars):');
    expect(written).toContain('final answer to user');
  });

  test('flush writes everything accumulated as a single appendFileSync call', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(1, -1, undefined, 'U', 'hi');
    ctx?.logRound(1);
    ctx?.logAiText('response');
    ctx?.logFinal('response', 0);

    expect(appendCalls).toHaveLength(0);
    ctx?.flush();
    expect(appendCalls).toHaveLength(1);

    // Single payload ends with a newline
    expect(appendCalls[0]?.data.endsWith('\n')).toBe(true);
  });

  test('flush swallows appendFileSync errors (non-critical logging)', () => {
    appendImpl = () => {
      throw new Error('ENOSPC');
    };
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctx = logger.createRunContext(1, -1, undefined, 'U', 'x');
    expect(() => ctx?.flush()).not.toThrow();
  });

  test('concurrent flushes from different contexts do not interleave data', () => {
    const logger = new AiDebugLogger(true, '/tmp/logs');
    const ctxA = logger.createRunContext(1, -100, undefined, 'A', 'msg-a');
    const ctxB = logger.createRunContext(2, -200, undefined, 'B', 'msg-b');

    ctxA?.logAiText('answer A');
    ctxB?.logAiText('answer B');

    // Flush in reversed order
    ctxB?.flush();
    ctxA?.flush();

    expect(appendCalls).toHaveLength(2);
    const [writeB, writeA] = appendCalls;
    expect(writeB?.data).toContain('answer B');
    expect(writeB?.data).not.toContain('answer A');
    expect(writeA?.data).toContain('answer A');
    expect(writeA?.data).not.toContain('answer B');
  });
});

// ── AiDebugRunContext: direct construction (no logger) ────────────────────

describe('AiDebugRunContext direct use', () => {
  test('can be constructed directly and flushed to a provided file path', () => {
    const ctx = new AiDebugRunContext(
      '/tmp/logs/chats/-42/2026-04-19_12-00-00.log',
      1,
      -42,
      'alice',
      'Alice A',
      'hello',
    );
    ctx.flush();

    expect(appendCalls).toHaveLength(1);
    expect(appendCalls[0]?.file).toBe('/tmp/logs/chats/-42/2026-04-19_12-00-00.log');
    expect(appendCalls[0]?.data).toContain('uid:1');
    expect(appendCalls[0]?.data).toContain('@alice');
    expect(appendCalls[0]?.data).toContain('MESSAGE: hello');
  });
});
