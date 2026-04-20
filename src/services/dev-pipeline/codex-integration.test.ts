// Tests for codex-integration — AI code review wrapper around aiStreamRound.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { StreamRoundResult } from '../ai/streaming';

// ─── Mocks ──────────────────────────────────────────────────────────────
const logMock = createMockLogger();

mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const mockAiStreamRound =
  mock<(opts: import('../ai/streaming').StreamRoundOptions) => Promise<StreamRoundResult>>();

const mockStripThinkingTags = mock<(text: string) => string>((text: string) =>
  text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(),
);

mock.module('../ai/streaming', () => ({
  aiStreamRound: mockAiStreamRound,
  stripThinkingTags: mockStripThinkingTags,
}));

// Dynamic import AFTER mocks
const { runCodexReview } = await import('./codex-integration');

function makeTextResult(text: string): StreamRoundResult {
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    assistantMessage: { role: 'assistant', content: text },
    providerUsed: 'mock',
  };
}

beforeEach(() => {
  mockAiStreamRound.mockReset();
  mockStripThinkingTags.mockClear();
  logMock.error.mockClear();
  logMock.info.mockClear();
  logMock.warn.mockClear();
});

describe('runCodexReview', () => {
  test('returns early message when diff is empty', async () => {
    const result = await runCodexReview('');
    expect(result).toBe('No changes to review.');
    expect(mockAiStreamRound).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('returns early message for whitespace-only diff', async () => {
    const result = await runCodexReview('   \n\t\n  ');
    expect(result).toBe('No changes to review.');
    expect(mockAiStreamRound).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('returns AI review text on success', async () => {
    mockAiStreamRound.mockResolvedValueOnce(
      makeTextResult('- Looks good\n- Minor nit: rename foo'),
    );
    const result = await runCodexReview('diff --git a/file b/file');
    expect(result).toBe('- Looks good\n- Minor nit: rename foo');
    expect(mockAiStreamRound).toHaveBeenCalledTimes(1);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('passes diff content to aiStreamRound via user message', async () => {
    mockAiStreamRound.mockResolvedValueOnce(makeTextResult('ok'));
    const diff = 'diff --git a/foo.ts b/foo.ts\n+console.log(1)';
    await runCodexReview(diff);

    const call = mockAiStreamRound.mock.calls.at(-1);
    expect(call).toBeDefined();
    const opts = call?.[0] as import('../ai/streaming').StreamRoundOptions;
    expect(opts.chain).toBe('smart');
    expect(opts.maxTokens).toBe(4096);
    expect(opts.messages).toHaveLength(1);
    const userMsg = opts.messages[0];
    expect(userMsg?.role).toBe('user');
    expect(String(userMsg?.content)).toContain(diff);
  });

  test('truncates very large diffs to 50k chars and appends truncation marker', async () => {
    mockAiStreamRound.mockResolvedValueOnce(makeTextResult('review'));
    const hugeDiff = 'a'.repeat(60000);
    await runCodexReview(hugeDiff);

    const opts = mockAiStreamRound.mock.calls.at(-1)?.[0] as
      | import('../ai/streaming').StreamRoundOptions
      | undefined;
    const userMsg = opts?.messages[0];
    const content = String(userMsg?.content);
    expect(content).toContain('[... diff truncated ...]');
    // full diff was 60k, sent body should have been truncated to around 50k + marker,
    // not the full 60k
    expect(content).not.toContain('a'.repeat(55000));
  });

  test('strips <think> tags from reasoning models', async () => {
    mockAiStreamRound.mockResolvedValueOnce(
      makeTextResult('<think>internal reasoning</think>\nFinal verdict: ok'),
    );
    const result = await runCodexReview('some diff');
    expect(result).toBe('Final verdict: ok');
    expect(mockStripThinkingTags).toHaveBeenCalled();
  });

  test('returns placeholder when AI returns empty text after stripping', async () => {
    mockAiStreamRound.mockResolvedValueOnce(makeTextResult('<think>just thinking</think>'));
    const result = await runCodexReview('some diff');
    expect(result).toBe('No review comments.');
  });

  test('returns error message and logs on AI failure', async () => {
    mockAiStreamRound.mockRejectedValueOnce(new Error('provider down'));
    const result = await runCodexReview('diff content');
    expect(result).toBe('Review failed: provider down');
    expect(logMock.error).toHaveBeenCalled();
  });

  test('handles non-Error rejections without crashing', async () => {
    mockAiStreamRound.mockRejectedValueOnce('string error');
    const result = await runCodexReview('diff content');
    expect(result.startsWith('Review failed:')).toBe(true);
    expect(logMock.error).toHaveBeenCalled();
  });
});
