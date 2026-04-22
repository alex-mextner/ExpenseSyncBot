// Tests for merchant-agent.ts — AI normalizes unmatched merchants into pending_review rules.
// Covers: admin guard, happy path, AI failure, malformed response, invalid regex, batch cap,
// admin notification via sendDirect.

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { MerchantRule, MerchantRuleRequest } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';

// ── Logger ─────────────────────────────────────────────────────────────────

const logMock = createMockLogger();

mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Env (BOT_ADMIN_CHAT_ID toggle) ─────────────────────────────────────────

const envStub: { BOT_ADMIN_CHAT_ID: number | null } = { BOT_ADMIN_CHAT_ID: 999 };

mock.module('../../config/env', () => ({
  env: envStub,
}));

// ── AI streaming ───────────────────────────────────────────────────────────

const aiStreamRoundMock =
  mock<
    (opts: import('../ai/streaming').StreamRoundOptions) => Promise<{
      text: string;
      toolCalls: [];
      finishReason: 'stop';
      assistantMessage: { role: 'assistant'; content: string };
      providerUsed: string;
    }>
  >();

mock.module('../ai/streaming', () => ({
  aiStreamRound: aiStreamRoundMock,
  stripThinkingTags: (text: string) => text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim(),
}));

// ── Telegram sender ────────────────────────────────────────────────────────

const sendDirectMock = mock(async (..._args: unknown[]) => ({ message_id: 7 }));

mock.module('./telegram-sender', () => ({
  sendDirect: sendDirectMock,
}));

// ── Database ───────────────────────────────────────────────────────────────

interface RuleStore {
  requests: MerchantRuleRequest[];
  approved: MerchantRule[];
  insertedRules: MerchantRule[];
  processedRequestIds: number[];
  prunedCalled: boolean;
  nextRuleId: number;
}

const store: RuleStore = {
  requests: [],
  approved: [],
  insertedRules: [],
  processedRequestIds: [],
  prunedCalled: false,
  nextRuleId: 100,
};

const findUnprocessedRequestsMock = mock(() => store.requests);
const findApprovedMock = mock(() => store.approved);
const markRequestProcessedMock = mock((id: number) => {
  store.processedRequestIds.push(id);
});
const pruneOldRequestsMock = mock(() => {
  store.prunedCalled = true;
});
const insertMock = mock(
  (data: {
    pattern: string;
    replacement: string;
    category: string | null;
    confidence: number;
    source: MerchantRule['source'];
  }): MerchantRule => {
    const rule: MerchantRule = {
      id: store.nextRuleId++,
      pattern: data.pattern,
      flags: 'i',
      replacement: data.replacement,
      category: data.category,
      confidence: data.confidence,
      status: 'pending_review',
      source: data.source,
      created_at: '',
      updated_at: '',
    };
    store.insertedRules.push(rule);
    return rule;
  },
);

mock.module('../../database', () => ({
  database: {
    merchantRules: {
      findUnprocessedRequests: findUnprocessedRequestsMock,
      findApproved: findApprovedMock,
      markRequestProcessed: markRequestProcessedMock,
      pruneOldRequests: pruneOldRequestsMock,
      insert: insertMock,
    },
  },
}));

// ── Helpers ────────────────────────────────────────────────────────────────

function makeRequest(overrides: Partial<MerchantRuleRequest> = {}): MerchantRuleRequest {
  return {
    id: 1,
    merchant_raw: 'RAW MERCHANT',
    mcc: null,
    group_id: 1,
    user_category: null,
    user_comment: null,
    processed: 0,
    created_at: '',
    ...overrides,
  };
}

interface AiSuggestion {
  pattern: string;
  replacement: string;
  category: string | null;
  confidence: number;
}

function aiResponse(suggestions: AiSuggestion[]): {
  text: string;
  toolCalls: [];
  finishReason: 'stop';
  assistantMessage: { role: 'assistant'; content: string };
  providerUsed: string;
} {
  const text = JSON.stringify(suggestions);
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    assistantMessage: { role: 'assistant', content: text },
    providerUsed: 'mock',
  };
}

function resetStore(): void {
  store.requests = [];
  store.approved = [];
  store.insertedRules = [];
  store.processedRequestIds = [];
  store.prunedCalled = false;
  store.nextRuleId = 100;
  envStub.BOT_ADMIN_CHAT_ID = 999;
  logMock.trace.mockClear();
  logMock.debug.mockClear();
  logMock.info.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
  aiStreamRoundMock.mockReset();
  sendDirectMock.mockClear();
  findUnprocessedRequestsMock.mockClear();
  findApprovedMock.mockClear();
  markRequestProcessedMock.mockClear();
  pruneOldRequestsMock.mockClear();
  insertMock.mockClear();
}

describe('processMerchantRequests', () => {
  beforeEach(() => {
    resetStore();
  });

  it('admin guard: no-op when BOT_ADMIN_CHAT_ID is not set', async () => {
    envStub.BOT_ADMIN_CHAT_ID = null;
    store.requests = [makeRequest()];

    const { processMerchantRequests } = await import('./merchant-agent.ts');
    await processMerchantRequests();

    expect(findUnprocessedRequestsMock).not.toHaveBeenCalled();
    expect(aiStreamRoundMock).not.toHaveBeenCalled();
    expect(sendDirectMock).not.toHaveBeenCalled();
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('no-op when queue is empty', async () => {
    store.requests = [];

    const { processMerchantRequests } = await import('./merchant-agent.ts');
    await processMerchantRequests();

    expect(findUnprocessedRequestsMock).toHaveBeenCalledTimes(1);
    expect(aiStreamRoundMock).not.toHaveBeenCalled();
    expect(sendDirectMock).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('happy path: inserts rules, marks requests processed, sends admin cards, prunes', async () => {
    store.requests = [
      makeRequest({ id: 1, merchant_raw: 'GLOVO 12345', mcc: 5812, user_category: 'еда' }),
      makeRequest({ id: 2, merchant_raw: 'UBER TRIP', mcc: 4121 }),
    ];

    aiStreamRoundMock.mockResolvedValueOnce(
      aiResponse([
        { pattern: 'GLOVO.*', replacement: 'Glovo', category: 'еда', confidence: 0.95 },
        { pattern: 'UBER.*', replacement: 'Uber', category: 'транспорт', confidence: 0.9 },
      ]),
    );

    const { processMerchantRequests } = await import('./merchant-agent.ts');
    await processMerchantRequests();

    expect(insertMock).toHaveBeenCalledTimes(2);
    expect(store.insertedRules[0]?.pattern).toBe('GLOVO.*');
    expect(store.insertedRules[0]?.replacement).toBe('Glovo');
    expect(store.insertedRules[0]?.status).toBe('pending_review');
    expect(store.insertedRules[0]?.source).toBe('ai');
    expect(store.processedRequestIds).toEqual([1, 2]);
    expect(sendDirectMock).toHaveBeenCalledTimes(2);
    // First arg is admin chat id
    expect(sendDirectMock.mock.calls[0]?.[0]).toBe(999);
    // Message text includes pattern and example match
    const firstMsg = sendDirectMock.mock.calls[0]?.[1] as string;
    expect(firstMsg).toContain('GLOVO.*');
    expect(firstMsg).toContain('Glovo');
    expect(firstMsg).toContain('Примеры совпадений');
    // Admin keyboard
    const firstOpts = sendDirectMock.mock.calls[0]?.[2] as {
      reply_markup?: { inline_keyboard?: { callback_data: string }[][] };
    };
    const cbData = firstOpts?.reply_markup?.inline_keyboard?.[0]?.map((b) => b.callback_data);
    expect(cbData).toEqual(['merchant_approve:100', 'merchant_edit:100', 'merchant_reject:100']);
    expect(store.prunedCalled).toBe(true);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('AI error: logs error, inserts nothing, does not mark requests processed, still prunes', async () => {
    store.requests = [makeRequest({ id: 1, merchant_raw: 'X' })];

    aiStreamRoundMock.mockRejectedValueOnce(new Error('AI down'));

    const { processMerchantRequests } = await import('./merchant-agent.ts');
    await processMerchantRequests();

    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(insertMock).not.toHaveBeenCalled();
    expect(store.processedRequestIds).toEqual([]);
    expect(sendDirectMock).not.toHaveBeenCalled();
    // pruning is unconditional at end — will still run
    expect(store.prunedCalled).toBe(true);
  });

  it('malformed AI JSON: treats as error, no rules created', async () => {
    store.requests = [makeRequest({ id: 1, merchant_raw: 'X' })];

    aiStreamRoundMock.mockResolvedValueOnce({
      text: 'nope, no array here',
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: 'nope' },
      providerUsed: 'mock',
    });

    const { processMerchantRequests } = await import('./merchant-agent.ts');
    await processMerchantRequests();

    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(insertMock).not.toHaveBeenCalled();
    expect(store.processedRequestIds).toEqual([]);
  });

  it('AI returns wrong array length: treats as error', async () => {
    store.requests = [
      makeRequest({ id: 1, merchant_raw: 'A' }),
      makeRequest({ id: 2, merchant_raw: 'B' }),
    ];

    aiStreamRoundMock.mockResolvedValueOnce(
      aiResponse([{ pattern: 'A.*', replacement: 'A', category: null, confidence: 0.9 }]),
    );

    const { processMerchantRequests } = await import('./merchant-agent.ts');
    await processMerchantRequests();

    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(insertMock).not.toHaveBeenCalled();
  });

  it('invalid regex pattern: warns, marks processed, skips insert', async () => {
    store.requests = [
      makeRequest({ id: 1, merchant_raw: 'GOOD' }),
      makeRequest({ id: 2, merchant_raw: 'BAD' }),
    ];

    aiStreamRoundMock.mockResolvedValueOnce(
      aiResponse([
        { pattern: 'GOOD.*', replacement: 'Good', category: null, confidence: 0.8 },
        // Unterminated regex — new RegExp() throws
        { pattern: '[unterminated', replacement: 'Bad', category: null, confidence: 0.5 },
      ]),
    );

    const { processMerchantRequests } = await import('./merchant-agent.ts');
    await processMerchantRequests();

    expect(insertMock).toHaveBeenCalledTimes(1);
    expect(store.insertedRules[0]?.pattern).toBe('GOOD.*');
    // Both marked processed (invalid one still marked to avoid retry loop)
    expect(store.processedRequestIds.sort()).toEqual([1, 2]);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
    // Only one admin card (for the valid rule)
    expect(sendDirectMock).toHaveBeenCalledTimes(1);
  });

  it('overly long regex pattern (>200 chars): rejected as invalid', async () => {
    store.requests = [makeRequest({ id: 1, merchant_raw: 'X' })];

    const hugePattern = 'A'.repeat(201);
    aiStreamRoundMock.mockResolvedValueOnce(
      aiResponse([{ pattern: hugePattern, replacement: 'X', category: null, confidence: 0.9 }]),
    );

    const { processMerchantRequests } = await import('./merchant-agent.ts');
    await processMerchantRequests();

    expect(insertMock).not.toHaveBeenCalled();
    expect(store.processedRequestIds).toEqual([1]);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });

  it('batch cap: processes at most 20 requests in one cycle', async () => {
    store.requests = Array.from({ length: 25 }, (_, i) =>
      makeRequest({ id: i + 1, merchant_raw: `M${i + 1}` }),
    );

    aiStreamRoundMock.mockResolvedValueOnce(
      aiResponse(
        Array.from({ length: 20 }, (_, i) => ({
          pattern: `M${i + 1}.*`,
          replacement: `M${i + 1}`,
          category: null,
          confidence: 0.9,
        })),
      ),
    );

    const { processMerchantRequests } = await import('./merchant-agent.ts');
    await processMerchantRequests();

    expect(insertMock).toHaveBeenCalledTimes(20);
    expect(store.processedRequestIds).toHaveLength(20);
    expect(aiStreamRoundMock).toHaveBeenCalledTimes(1);
  });

  it('includes existing approved rules (capped at 10) in AI prompt for context', async () => {
    store.requests = [makeRequest({ id: 1, merchant_raw: 'NEW' })];
    store.approved = Array.from({ length: 15 }, (_, i) => ({
      id: i + 1,
      pattern: `OLD${i + 1}.*`,
      flags: 'i',
      replacement: `Old${i + 1}`,
      category: 'прочее',
      confidence: 1,
      status: 'approved' as const,
      source: 'ai' as const,
      created_at: '',
      updated_at: '',
    }));

    aiStreamRoundMock.mockResolvedValueOnce(
      aiResponse([{ pattern: 'NEW.*', replacement: 'New', category: null, confidence: 0.9 }]),
    );

    const { processMerchantRequests } = await import('./merchant-agent.ts');
    await processMerchantRequests();

    const prompt = aiStreamRoundMock.mock.calls[0]?.[0]?.messages[0]?.content as string;
    expect(prompt).toContain('OLD1.*');
    expect(prompt).toContain('OLD10.*');
    // 11th and beyond should not appear
    expect(prompt).not.toContain('OLD11.*');
  });

  it('continues processing remaining requests when sendDirect fails', async () => {
    store.requests = [
      makeRequest({ id: 1, merchant_raw: 'A' }),
      makeRequest({ id: 2, merchant_raw: 'B' }),
    ];

    aiStreamRoundMock.mockResolvedValueOnce(
      aiResponse([
        { pattern: 'A.*', replacement: 'A', category: null, confidence: 0.9 },
        { pattern: 'B.*', replacement: 'B', category: null, confidence: 0.9 },
      ]),
    );
    sendDirectMock.mockImplementationOnce(() => Promise.reject(new Error('telegram down')));

    const { processMerchantRequests } = await import('./merchant-agent.ts');
    await processMerchantRequests();

    // Both rules inserted, both requests marked processed
    expect(insertMock).toHaveBeenCalledTimes(2);
    expect(store.processedRequestIds).toEqual([1, 2]);
    // Error logged from caught sendDirect rejection
    expect(logMock.error).toHaveBeenCalled();
  });
});
