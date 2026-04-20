// Tests for prefill.ts — AI pre-fills category for unmatched bank transactions.
// Covers: happy path, empty input, AI failure fallback, malformed JSON, batch cap (10).

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { BankTransaction } from '../../database/types';
import { makeBankTransaction } from '../../test-utils/fixtures';
import { createMockLogger } from '../../test-utils/mocks/logger';

// ── Logger ─────────────────────────────────────────────────────────────────

const logMock = createMockLogger();

mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
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

// ── MCC labels — deterministic passthrough ─────────────────────────────────

mock.module('./mcc-labels.ts', () => ({
  getMccLabel: (mcc: number | null | undefined) => (mcc ? `MCC-${mcc}-label` : ''),
}));

// ── Database ───────────────────────────────────────────────────────────────

type MccHistoryKey = string;
const store: {
  categoriesByGroup: Map<number, string[]>;
  mccHistory: Map<MccHistoryKey, string[]>;
} = {
  categoriesByGroup: new Map(),
  mccHistory: new Map(),
};

const queryAllMock = mock(<T>(_sql: string, mcc: number, groupId: number): T[] => {
  const rows = store.mccHistory.get(`${groupId}:${mcc}`) ?? [];
  return rows.map((category) => ({ category })) as T[];
});

mock.module('../../database', () => ({
  database: {
    categories: {
      findByGroupId: (groupId: number) =>
        (store.categoriesByGroup.get(groupId) ?? []).map((name) => ({ name })),
    },
    queryAll: queryAllMock,
  },
}));

function aiResponse(categories: string[]): {
  text: string;
  toolCalls: [];
  finishReason: 'stop';
  assistantMessage: { role: 'assistant'; content: string };
  providerUsed: string;
} {
  const text = JSON.stringify(categories);
  return {
    text,
    toolCalls: [],
    finishReason: 'stop',
    assistantMessage: { role: 'assistant', content: text },
    providerUsed: 'mock',
  };
}

function resetStore(): void {
  store.categoriesByGroup.clear();
  store.mccHistory.clear();
  logMock.trace.mockClear();
  logMock.debug.mockClear();
  logMock.info.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
  aiStreamRoundMock.mockReset();
  queryAllMock.mockClear();
}

describe('preFillTransactions', () => {
  beforeEach(() => {
    resetStore();
  });

  it('returns empty array for empty input without calling AI', async () => {
    const { preFillTransactions } = await import('./prefill.ts');

    const result = await preFillTransactions([], 1);

    expect(result).toEqual([]);
    expect(aiStreamRoundMock).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it('happy path: assigns AI-returned categories in order for a full batch', async () => {
    store.categoriesByGroup.set(1, ['еда', 'транспорт', 'здоровье']);

    aiStreamRoundMock.mockResolvedValueOnce(aiResponse(['еда', 'транспорт', 'здоровье']));

    const txs: BankTransaction[] = [
      makeBankTransaction({ id: 1, external_id: 'a', merchant: 'Bolt Food', mcc: 5812 }),
      makeBankTransaction({ id: 2, external_id: 'b', merchant: 'Uber', mcc: 4121 }),
      makeBankTransaction({ id: 3, external_id: 'c', merchant: 'Pharmacy', mcc: 5912 }),
    ];

    const { preFillTransactions } = await import('./prefill.ts');
    const result = await preFillTransactions(txs, 1);

    expect(result).toEqual([
      { category: 'еда' },
      { category: 'транспорт' },
      { category: 'здоровье' },
    ]);
    expect(aiStreamRoundMock).toHaveBeenCalledTimes(1);
    expect(logMock.error).not.toHaveBeenCalled();
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it('falls back to "прочее" for every tx when AI throws', async () => {
    aiStreamRoundMock.mockRejectedValueOnce(new Error('AI boom'));

    const txs = [
      makeBankTransaction({ id: 1, external_id: 'a', merchant: 'X' }),
      makeBankTransaction({ id: 2, external_id: 'b', merchant: 'Y' }),
    ];

    const { preFillTransactions } = await import('./prefill.ts');
    const result = await preFillTransactions(txs, 1);

    expect(result).toEqual([{ category: 'прочее' }, { category: 'прочее' }]);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to "прочее" when AI response has no JSON array', async () => {
    aiStreamRoundMock.mockResolvedValueOnce({
      text: 'no json here, sorry',
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: 'no json' },
      providerUsed: 'mock',
    });

    const txs = [makeBankTransaction({ id: 1, external_id: 'a', merchant: 'X' })];

    const { preFillTransactions } = await import('./prefill.ts');
    const result = await preFillTransactions(txs, 1);

    expect(result).toEqual([{ category: 'прочее' }]);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to "прочее" when AI returns unparseable JSON', async () => {
    aiStreamRoundMock.mockResolvedValueOnce({
      text: '[not, valid, json,]',
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: '[not, valid, json,]' },
      providerUsed: 'mock',
    });

    const txs = [makeBankTransaction({ id: 1, external_id: 'a', merchant: 'X' })];

    const { preFillTransactions } = await import('./prefill.ts');
    const result = await preFillTransactions(txs, 1);

    expect(result).toEqual([{ category: 'прочее' }]);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });

  it('falls back to "прочее" when AI returns wrong-size array', async () => {
    // Asked for 3, AI gave 2
    aiStreamRoundMock.mockResolvedValueOnce(aiResponse(['еда', 'транспорт']));

    const txs = [
      makeBankTransaction({ id: 1, external_id: 'a' }),
      makeBankTransaction({ id: 2, external_id: 'b' }),
      makeBankTransaction({ id: 3, external_id: 'c' }),
    ];

    const { preFillTransactions } = await import('./prefill.ts');
    const result = await preFillTransactions(txs, 1);

    expect(result).toEqual([
      { category: 'прочее' },
      { category: 'прочее' },
      { category: 'прочее' },
    ]);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });

  it('coerces non-string items in AI response to "прочее"', async () => {
    aiStreamRoundMock.mockResolvedValueOnce({
      text: '["еда", 42, null]',
      toolCalls: [],
      finishReason: 'stop',
      assistantMessage: { role: 'assistant', content: '["еда", 42, null]' },
      providerUsed: 'mock',
    });

    const txs = [
      makeBankTransaction({ id: 1, external_id: 'a' }),
      makeBankTransaction({ id: 2, external_id: 'b' }),
      makeBankTransaction({ id: 3, external_id: 'c' }),
    ];

    const { preFillTransactions } = await import('./prefill.ts');
    const result = await preFillTransactions(txs, 1);

    expect(result).toEqual([{ category: 'еда' }, { category: 'прочее' }, { category: 'прочее' }]);
    // Happy path for JSON parse, no warn expected
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  it('chunks >10 transactions into multiple AI calls of max size 10', async () => {
    // 23 transactions → 3 batches (10 + 10 + 3)
    const txs: BankTransaction[] = Array.from({ length: 23 }, (_, i) =>
      makeBankTransaction({ id: i + 1, external_id: `tx${i + 1}`, merchant: `M${i + 1}` }),
    );

    aiStreamRoundMock.mockImplementationOnce(async () =>
      aiResponse(Array.from({ length: 10 }, () => 'еда')),
    );
    aiStreamRoundMock.mockImplementationOnce(async () =>
      aiResponse(Array.from({ length: 10 }, () => 'транспорт')),
    );
    aiStreamRoundMock.mockImplementationOnce(async () =>
      aiResponse(Array.from({ length: 3 }, () => 'здоровье')),
    );

    const { preFillTransactions } = await import('./prefill.ts');
    const result = await preFillTransactions(txs, 1);

    expect(aiStreamRoundMock).toHaveBeenCalledTimes(3);
    expect(result).toHaveLength(23);
    expect(result.slice(0, 10).every((r) => r.category === 'еда')).toBe(true);
    expect(result.slice(10, 20).every((r) => r.category === 'транспорт')).toBe(true);
    expect(result.slice(20).every((r) => r.category === 'здоровье')).toBe(true);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('includes group MCC history in context query (buildMccHistory)', async () => {
    store.categoriesByGroup.set(1, ['еда']);
    store.mccHistory.set('1:5812', ['еда', 'рестораны']);

    aiStreamRoundMock.mockResolvedValueOnce(aiResponse(['еда']));

    const txs = [makeBankTransaction({ id: 1, external_id: 'a', merchant: 'Cafe', mcc: 5812 })];

    const { preFillTransactions } = await import('./prefill.ts');
    await preFillTransactions(txs, 1);

    expect(queryAllMock).toHaveBeenCalledTimes(1);
    // Assert prompt includes historical categories
    const opts = aiStreamRoundMock.mock.calls[0]?.[0];
    expect(opts?.messages[0]?.content as string).toContain('ранее: еда, рестораны');
  });

  it('continues processing later batches when an earlier batch falls back', async () => {
    const txs: BankTransaction[] = Array.from({ length: 12 }, (_, i) =>
      makeBankTransaction({ id: i + 1, external_id: `tx${i + 1}` }),
    );

    // First batch fails, second batch succeeds
    aiStreamRoundMock.mockRejectedValueOnce(new Error('boom'));
    aiStreamRoundMock.mockResolvedValueOnce(aiResponse(['еда', 'транспорт']));

    const { preFillTransactions } = await import('./prefill.ts');
    const result = await preFillTransactions(txs, 1);

    expect(result).toHaveLength(12);
    // First 10 fallback
    expect(result.slice(0, 10).every((r) => r.category === 'прочее')).toBe(true);
    // Last 2 from second batch
    expect(result[10]?.category).toBe('еда');
    expect(result[11]?.category).toBe('транспорт');
    expect(aiStreamRoundMock).toHaveBeenCalledTimes(2);
    expect(logMock.warn).toHaveBeenCalledTimes(1);
  });
});
