// Tests for recurring-matcher.ts — matches new expenses against stored recurring patterns
// and periodically auto-saves newly detected patterns.

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import type { RecurringPattern } from '../../database/types';
import { mockDatabase } from '../../test-utils/mocks/database';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();

mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const mockFindByGroupId = mock<(groupId: number) => RecurringPattern[]>(() => []);
const mockUpdateLastSeen = mock<(id: number, date: string, nextDate: string) => void>(() => {});
const mockCreate = mock<(data: unknown) => RecurringPattern>(
  () =>
    ({
      id: 99,
      group_id: 1,
      category: 'auto',
      expected_amount: 10,
      currency: 'EUR',
      interval_days: 30,
      expected_day: 15,
      tolerance_days: 5,
      last_seen_date: '2026-01-15',
      next_expected_date: '2026-02-15',
      status: 'active',
      created_at: '',
      updated_at: '',
    }) as RecurringPattern,
);

mock.module('../../database', () => ({
  database: mockDatabase({
    recurringPatterns: {
      findByGroupId: mockFindByGroupId,
      updateLastSeen: mockUpdateLastSeen,
      create: mockCreate,
    },
  }),
}));

import type { DetectedPattern } from './recurring-detector';

const mockDetectRecurringPatterns = mock<(groupId: number) => DetectedPattern[]>(() => []);
const mockComputeNextExpectedDate = mock<(date: string, day: number) => string>(
  (date: string) => date,
);

mock.module('./recurring-detector', () => ({
  detectRecurringPatterns: mockDetectRecurringPatterns,
  computeNextExpectedDate: mockComputeNextExpectedDate,
}));

// Import after all mocks are set up
const { checkRecurringMatch } = await import('./recurring-matcher');

const GROUP_ID = 1;

function makePattern(overrides: Partial<RecurringPattern> = {}): RecurringPattern {
  return {
    id: 1,
    group_id: GROUP_ID,
    category: 'Подписки',
    expected_amount: 10,
    currency: 'EUR',
    interval_days: 30,
    expected_day: 15,
    tolerance_days: 5,
    last_seen_date: '2026-01-15',
    next_expected_date: '2026-02-15',
    status: 'active',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

describe('checkRecurringMatch', () => {
  beforeEach(() => {
    mockFindByGroupId.mockReset();
    mockUpdateLastSeen.mockReset();
    mockCreate.mockReset();
    mockDetectRecurringPatterns.mockReset();
    mockComputeNextExpectedDate.mockReset();
    logMock.info.mockReset();
    logMock.error.mockReset();
    logMock.warn.mockReset();

    mockFindByGroupId.mockReturnValue([]);
    mockDetectRecurringPatterns.mockReturnValue([]);
    mockComputeNextExpectedDate.mockImplementation((date: string, _day: number) => `${date}-next`);
  });

  it('matches exact amount + category + currency and updates last_seen', () => {
    const pattern = makePattern({
      id: 7,
      category: 'Netflix',
      expected_amount: 9.99,
      currency: 'EUR',
      expected_day: 20,
    });
    mockFindByGroupId.mockReturnValue([pattern]);
    mockComputeNextExpectedDate.mockReturnValueOnce('2026-03-20');

    checkRecurringMatch(GROUP_ID, 'Netflix', 9.99, 'EUR', '2026-02-20');

    expect(mockComputeNextExpectedDate).toHaveBeenCalledWith('2026-02-20', 20);
    expect(mockUpdateLastSeen).toHaveBeenCalledWith(7, '2026-02-20', '2026-03-20');
    expect(mockDetectRecurringPatterns).not.toHaveBeenCalled();
    expect(logMock.info).toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  it('falls back to day 15 when pattern.expected_day is null', () => {
    const pattern = makePattern({ expected_day: null });
    mockFindByGroupId.mockReturnValue([pattern]);

    checkRecurringMatch(GROUP_ID, 'Подписки', 10, 'EUR', '2026-02-15');

    expect(mockComputeNextExpectedDate).toHaveBeenCalledWith('2026-02-15', 15);
    expect(mockUpdateLastSeen).toHaveBeenCalled();
  });

  it('matches when amount drifts within ±20% tolerance', () => {
    // 10 vs 11.5 → ratio = 1.5 / 11.5 ≈ 0.13 → within tolerance
    const pattern = makePattern({ expected_amount: 10 });
    mockFindByGroupId.mockReturnValue([pattern]);

    checkRecurringMatch(GROUP_ID, 'Подписки', 11.5, 'EUR', '2026-02-15');

    expect(mockUpdateLastSeen).toHaveBeenCalled();
  });

  it('does NOT match when amount drift exceeds 20%', () => {
    // 10 vs 15 → ratio = 5/15 ≈ 0.33 → exceeds 0.2
    const pattern = makePattern({ expected_amount: 10 });
    mockFindByGroupId.mockReturnValue([pattern]);

    checkRecurringMatch(GROUP_ID, 'Подписки', 15, 'EUR', '2026-02-15');

    expect(mockUpdateLastSeen).not.toHaveBeenCalled();
  });

  it('does NOT match when category differs', () => {
    const pattern = makePattern({ category: 'Netflix' });
    mockFindByGroupId.mockReturnValue([pattern]);

    checkRecurringMatch(GROUP_ID, 'Кафе', 10, 'EUR', '2026-02-15');

    expect(mockUpdateLastSeen).not.toHaveBeenCalled();
  });

  it('does NOT match when currency differs', () => {
    const pattern = makePattern({ currency: 'EUR' });
    mockFindByGroupId.mockReturnValue([pattern]);

    checkRecurringMatch(GROUP_ID, 'Подписки', 10, 'USD', '2026-02-15');

    expect(mockUpdateLastSeen).not.toHaveBeenCalled();
  });

  it('skips patterns where both pattern.expected_amount and incoming amount are 0', () => {
    const pattern = makePattern({ expected_amount: 0 });
    mockFindByGroupId.mockReturnValue([pattern]);

    checkRecurringMatch(GROUP_ID, 'Подписки', 0, 'EUR', '2026-02-15');

    expect(mockUpdateLastSeen).not.toHaveBeenCalled();
  });

  it('picks the first matching pattern when multiple candidates exist', () => {
    // Both patterns are in the same category/currency — first match wins (for-loop with return)
    const p1 = makePattern({ id: 1, expected_amount: 10 });
    const p2 = makePattern({ id: 2, expected_amount: 10 });
    mockFindByGroupId.mockReturnValue([p1, p2]);

    checkRecurringMatch(GROUP_ID, 'Подписки', 10, 'EUR', '2026-02-15');

    expect(mockUpdateLastSeen).toHaveBeenCalledTimes(1);
    expect(mockUpdateLastSeen.mock.calls[0]?.[0]).toBe(1);
  });

  it('returns null-like (no match, no detection) when no patterns exist and cooldown is active', () => {
    // First call — triggers detection, no patterns detected
    mockFindByGroupId.mockReturnValue([]);
    mockDetectRecurringPatterns.mockReturnValue([]);

    checkRecurringMatch(2001, 'Новое', 10, 'EUR', '2026-02-15');
    expect(mockDetectRecurringPatterns).toHaveBeenCalledTimes(1);

    // Second call within 24h — skipped by cooldown
    checkRecurringMatch(2001, 'Новое', 10, 'EUR', '2026-02-16');
    expect(mockDetectRecurringPatterns).toHaveBeenCalledTimes(1);

    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdateLastSeen).not.toHaveBeenCalled();
  });

  it('runs detection and auto-saves new patterns when none match', () => {
    mockFindByGroupId.mockReturnValue([]);
    mockDetectRecurringPatterns.mockReturnValueOnce([
      {
        category: 'Gym',
        expectedAmount: 25,
        currency: 'EUR',
        expectedDay: 10,
        occurrences: 3,
        lastDate: '2026-02-10',
      },
      {
        category: 'Spotify',
        expectedAmount: 9.99,
        currency: 'EUR',
        expectedDay: 5,
        occurrences: 4,
        lastDate: '2026-02-05',
      },
    ]);
    mockComputeNextExpectedDate.mockReturnValueOnce('2026-03-10').mockReturnValueOnce('2026-03-05');

    // Use a fresh groupId to bypass the cooldown Map (per-process state)
    const freshGroup = 3001;
    checkRecurringMatch(freshGroup, 'Кафе', 5, 'EUR', '2026-02-15');

    expect(mockCreate).toHaveBeenCalledTimes(2);
    const firstArg = mockCreate.mock.calls[0]?.[0] as {
      group_id: number;
      category: string;
      expected_amount: number;
      currency: string;
      expected_day: number;
      last_seen_date: string;
      next_expected_date: string;
    };
    expect(firstArg.group_id).toBe(freshGroup);
    expect(firstArg.category).toBe('Gym');
    expect(firstArg.expected_amount).toBe(25);
    expect(firstArg.next_expected_date).toBe('2026-03-10');
    expect(logMock.info).toHaveBeenCalled();
  });

  it('no-op when pattern list empty, detection runs, but nothing detected', () => {
    mockFindByGroupId.mockReturnValue([]);
    mockDetectRecurringPatterns.mockReturnValue([]);

    // Fresh groupId to avoid cooldown pollution from other tests
    checkRecurringMatch(4001, 'Что-то', 10, 'EUR', '2026-02-15');

    expect(mockDetectRecurringPatterns).toHaveBeenCalledTimes(1);
    expect(mockCreate).not.toHaveBeenCalled();
    expect(mockUpdateLastSeen).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
