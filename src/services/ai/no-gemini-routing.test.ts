// Regression tests proving all runtime AI chains exclude Gemini without network calls.
import { beforeEach, expect, it, mock } from 'bun:test';
import type OpenAI from 'openai';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger', () => ({ createLogger: () => logMock, logger: logMock }));
const config = {
  GROQ_API_KEY: 'synthetic',
  CLAUDE_API_TOKEN: 'synthetic',
  GEMINI_API_KEY: 'synthetic',
  GROQ_MODEL: 'groq-smart',
  GROQ_FAST_MODEL: 'groq-fast',
  AI_MODEL: 'zai-smart',
  AI_FAST_MODEL: 'zai-fast',
  CLAUDE_MODEL: 'claude-sonnet-5-5',
  CLAUDE_FAST_MODEL: 'claude-haiku-5-5',
  GEMINI_MODEL: 'gemini-smart',
  GEMINI_FAST_MODEL: 'gemini-fast',
  GEMINI_VISION_MODEL: 'gemini-vision',
  HF_MODEL: 'hf-smart',
  HF_FAST_MODEL: 'hf-fast',
  HF_VISION_MODEL: 'hf-vision',
};
mock.module('../../config/env', () => ({ env: config }));
const calls: string[] = [];
let successModel = '';
const create = mock(async (params: OpenAI.ChatCompletionCreateParamsStreaming) => {
  calls.push(params.model);
  if (params.model !== successModel) throw new Error('synthetic provider failure');
  return {
    [Symbol.asyncIterator]: async function* () {
      yield { choices: [{ delta: { content: 'synthetic result' }, finish_reason: 'stop' }] };
    },
  };
});
const client = { chat: { completions: { create } } };
const geminiClient = mock(() => client);
mock.module('./clients', () => ({
  zaiClient: () => client,
  groqClient: () => client,
  claudeClient: () => client,
  hfClient: () => client,
  geminiClient,
}));
const { aiStreamRound } = await import('./streaming');
const { resetProviderBreaker } = await import('./provider-breaker');
beforeEach(() => {
  calls.length = 0;
  successModel = '';
  geminiClient.mockClear();
  logMock.error.mockClear();
  logMock.warn.mockClear();
  resetProviderBreaker();
});
it.each([
  'smart',
  'fast',
  'ocr',
] as const)('exhausts %s without reaching Gemini even with its key configured', async (chain) => {
  await expect(
    aiStreamRound({ chain, messages: [{ role: 'user', content: 'synthetic' }], maxTokens: 100 }),
  ).rejects.toThrow('providers');
  expect(geminiClient).not.toHaveBeenCalled();
  expect(calls.some((model) => model.includes('gemini'))).toBe(false);
  expect(calls).toEqual(
    chain === 'ocr'
      ? ['hf-vision']
      : chain === 'smart'
        ? ['groq-smart', 'zai-smart', 'claude-sonnet-5-5', 'hf-smart']
        : ['groq-fast', 'zai-fast', 'claude-haiku-5-5', 'hf-fast'],
  );
  expect(logMock.error).toHaveBeenCalled();
});
it.each(['smart', 'fast'] as const)('keeps working Claude in %s fallback', async (chain) => {
  successModel = chain === 'smart' ? config.CLAUDE_MODEL : config.CLAUDE_FAST_MODEL;
  const result = await aiStreamRound({
    chain,
    messages: [{ role: 'user', content: 'synthetic' }],
    maxTokens: 100,
  });
  expect(result.providerUsed).toContain('Claude');
  expect(result.text).toBe('synthetic result');
  expect(geminiClient).not.toHaveBeenCalled();
  expect(logMock.error).toHaveBeenCalled();
});
it('uses existing HF vision model for OCR', async () => {
  successModel = config.HF_VISION_MODEL;
  const result = await aiStreamRound({
    chain: 'ocr',
    messages: [{ role: 'user', content: 'synthetic image' }],
    maxTokens: 100,
  });
  expect(result.providerUsed).toContain('HF');
  expect(calls).toEqual(['hf-vision']);
  expect(geminiClient).not.toHaveBeenCalled();
  expect(logMock.error).not.toHaveBeenCalled();
  expect(logMock.warn).not.toHaveBeenCalled();
});
