// Tests for recurring-matcher — checks expense matching against patterns and auto-detection

import { beforeEach, describe, expect, it, mock } from 'bun:test';

const mockFindByGroupId = mock<() => unknown[]>(() => []);
const mockUpdateLastSeen = mock<(id: number, date: string, nextDate: string) => void>(() => {});
const mockCreate = mock<(data: unknown) => unknown>(() => ({ id: 1 }));

const mockDetectRecurringPatterns = mock<(groupId: number) => unknown[]>(() => []);
const mockComputeNextExpectedDate = mock<(lastDate: string, day: number) => string>(
  () => '2026-02-15',
);

mock.module('../../database', () => ({
  database: {
    recurringPatterns: {
      findByGroupId: mockFindByGroupId,
      updateLastSeen: mockUpdateLastSeen,
      create: mockCreate,
    },
  },
}));

mock.module('./recurring-detector', () => ({
  detectRecurringPatterns: mockDetectRecurringPatterns,
  computeNextExpectedDate: mockComputeNextExpectedDate,
}));

const { checkRecurringMatch } = await import('./recurring-matcher');

const GROUP_ID = 1;

describe('checkRecurringMatch', () => {
  beforeEach(() => {
    mockFindByGroupId.mockReset();
    mockUpdateLastSeen.mockReset();
    mockCreate.mockReset();
    mockDetectRecurringPatterns.mockReset();
    mockComputeNextExpectedDate.mockReset();

    mockFindByGroupId.mockReturnValue([]);
    mockDetectRecurringPatterns.mockReturnValue([]);
    mockComputeNextExpectedDate.mockReturnValue('2026-02-15');
  });

  it('does nothing when no active patterns and detection on cooldown', () => {
    checkRecurringMatch(GROUP_ID, 'Еда', 50, 'EUR', '2026-01-15');
    expect(mockUpdateLastSeen).not.toHaveBeenCalled();
  });

  it('matches expense to pattern with exact amount', () => {
    mockFindByGroupId.mockReturnValue([
      {
        id: 10,
        category: 'Netflix',
        currency: 'EUR',
        expected_amount: 9.99,
        expected_day: 15,
        status: 'active',
      },
    ]);

    checkRecurringMatch(GROUP_ID, 'Netflix', 9.99, 'EUR', '2026-01-14');

    expect(mockUpdateLastSeen).toHaveBeenCalledTimes(1);
    expect(mockUpdateLastSeen).toHaveBeenCalledWith(10, '2026-01-14', '2026-02-15');
  });

  it('matches expense within ±20% tolerance', () => {
    mockFindByGroupId.mockReturnValue([
      {
        id: 10,
        category: 'Gym',
        currency: 'EUR',
        expected_amount: 10,
        expected_day: 15,
        status: 'active',
      },
    ]);

    // 11.5 is within 20% of 10 (ratio = 1.5/11.5 ≈ 13%)
    checkRecurringMatch(GROUP_ID, 'Gym', 11.5, 'EUR', '2026-01-16');
    expect(mockUpdateLastSeen).toHaveBeenCalledTimes(1);
  });

  it('does NOT match when amount differs by >20%', () => {
    mockFindByGroupId.mockReturnValue([
      {
        id: 10,
        category: 'Gym',
        currency: 'EUR',
        expected_amount: 10,
        expected_day: 15,
        status: 'active',
      },
    ]);

    // 15 vs 10: ratio = 5/15 ≈ 33% — exceeds 20%
    checkRecurringMatch(GROUP_ID, 'Gym', 15, 'EUR', '2026-01-16');
    expect(mockUpdateLastSeen).not.toHaveBeenCalled();
  });

  it('does NOT match different category', () => {
    mockFindByGroupId.mockReturnValue([
      {
        id: 10,
        category: 'Netflix',
        currency: 'EUR',
        expected_amount: 9.99,
        expected_day: 15,
        status: 'active',
      },
    ]);

    checkRecurringMatch(GROUP_ID, 'Spotify', 9.99, 'EUR', '2026-01-14');
    expect(mockUpdateLastSeen).not.toHaveBeenCalled();
  });

  it('does NOT match different currency', () => {
    mockFindByGroupId.mockReturnValue([
      {
        id: 10,
        category: 'Netflix',
        currency: 'EUR',
        expected_amount: 9.99,
        expected_day: 15,
        status: 'active',
      },
    ]);

    checkRecurringMatch(GROUP_ID, 'Netflix', 9.99, 'USD', '2026-01-14');
    expect(mockUpdateLastSeen).not.toHaveBeenCalled();
  });

  it('returns after first match (does not update multiple patterns)', () => {
    mockFindByGroupId.mockReturnValue([
      {
        id: 10,
        category: 'Netflix',
        currency: 'EUR',
        expected_amount: 9.99,
        expected_day: 15,
        status: 'active',
      },
      {
        id: 11,
        category: 'Netflix',
        currency: 'EUR',
        expected_amount: 10.5,
        expected_day: 20,
        status: 'active',
      },
    ]);

    checkRecurringMatch(GROUP_ID, 'Netflix', 9.99, 'EUR', '2026-01-14');
    expect(mockUpdateLastSeen).toHaveBeenCalledTimes(1);
    expect(mockUpdateLastSeen.mock.calls[0]?.[0]).toBe(10);
  });

  it('skips match when both amounts are 0', () => {
    mockFindByGroupId.mockReturnValue([
      {
        id: 10,
        category: 'Free',
        currency: 'EUR',
        expected_amount: 0,
        expected_day: 15,
        status: 'active',
      },
    ]);

    checkRecurringMatch(GROUP_ID, 'Free', 0, 'EUR', '2026-01-14');
    expect(mockUpdateLastSeen).not.toHaveBeenCalled();
  });

  it('auto-saves newly detected patterns when detection runs', () => {
    // Use a different group to avoid cooldown from previous tests
    const freshGroupId = 999;
    mockDetectRecurringPatterns.mockReturnValue([
      {
        category: 'Rent',
        currency: 'EUR',
        expectedAmount: 700,
        expectedDay: 1,
        lastDate: '2026-01-01',
        occurrences: 4,
      },
    ]);
    mockComputeNextExpectedDate.mockReturnValue('2026-02-01');

    checkRecurringMatch(freshGroupId, 'Еда', 50, 'EUR', '2026-01-15');

    expect(mockDetectRecurringPatterns).toHaveBeenCalledWith(freshGroupId);
    expect(mockCreate).toHaveBeenCalledTimes(1);
    expect(mockCreate).toHaveBeenCalledWith({
      group_id: freshGroupId,
      category: 'Rent',
      expected_amount: 700,
      currency: 'EUR',
      expected_day: 1,
      last_seen_date: '2026-01-01',
      next_expected_date: '2026-02-01',
    });
  });

  it('respects detection cooldown — does not re-detect within 24h', () => {
    // Use a unique group ID to guarantee a fresh cooldown window
    const groupA = 1000;
    mockDetectRecurringPatterns.mockReturnValue([]);

    // First call — should trigger detection
    checkRecurringMatch(groupA, 'Еда', 50, 'EUR', '2026-01-15');
    expect(mockDetectRecurringPatterns).toHaveBeenCalledTimes(1);

    mockDetectRecurringPatterns.mockReset();
    mockDetectRecurringPatterns.mockReturnValue([]);

    // Second call — should be skipped (cooldown)
    checkRecurringMatch(groupA, 'Еда', 50, 'EUR', '2026-01-16');
    expect(mockDetectRecurringPatterns).not.toHaveBeenCalled();
  });

  it('auto-saves multiple detected patterns', () => {
    const freshGroupId = 2000;
    mockDetectRecurringPatterns.mockReturnValue([
      {
        category: 'Rent',
        currency: 'EUR',
        expectedAmount: 700,
        expectedDay: 1,
        lastDate: '2026-01-01',
        occurrences: 4,
      },
      {
        category: 'Netflix',
        currency: 'USD',
        expectedAmount: 14.99,
        expectedDay: 10,
        lastDate: '2026-01-10',
        occurrences: 3,
      },
    ]);

    checkRecurringMatch(freshGroupId, 'Еда', 50, 'EUR', '2026-01-15');

    expect(mockCreate).toHaveBeenCalledTimes(2);
  });
});
