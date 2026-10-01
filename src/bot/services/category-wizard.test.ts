import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { PendingExpense } from '../../database/types';

const findByIdMock = mock((_id: number): PendingExpense | null => null);
const findByUserIdMock = mock((_userId: number): PendingExpense[] => []);
mock.module('../../database', () => ({
  database: {
    pendingExpenses: { findById: findByIdMock, findByUserId: findByUserIdMock },
  },
}));
const sendMessageMock = mock((_text: string, _options?: unknown) => Promise.resolve(null));
mock.module('../../services/bank/telegram-sender', () => ({ sendMessage: sendMessageMock }));
const createKeyboardMock = mock((pendingExpenseId: number) => ({ pendingExpenseId }));
mock.module('../keyboards', () => ({ createCategoryConfirmKeyboard: createKeyboardMock }));

const {
  getPendingCategoryExpense,
  getPendingCategorySiblings,
  queueCategoryBudgetPrompt,
  showNextPendingCategoryStep,
  takeQueuedCategoryBudgetPrompts,
} = await import('./category-wizard');

function pending(id: number, category: string, messageId = 100): PendingExpense {
  return {
    id,
    user_id: 10,
    message_id: messageId,
    parsed_amount: 100,
    parsed_currency: 'EUR',
    detected_category: category,
    comment: '',
    status: 'pending_category',
    created_at: '2026-10-01 00:00:00',
  };
}

beforeEach(() => {
  findByIdMock.mockReset().mockReturnValue(null);
  findByUserIdMock.mockReset().mockReturnValue([]);
  sendMessageMock.mockClear();
  createKeyboardMock.mockClear();
});

describe('category wizard', () => {
  test('shows only the oldest pending category step for the same message', async () => {
    findByUserIdMock.mockReturnValue([
      pending(9, 'later', 100),
      pending(3, 'first', 100),
      pending(1, 'other-message', 99),
    ]);

    expect(await showNextPendingCategoryStep(10, 100)).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(String(sendMessageMock.mock.calls[0]?.[0])).toContain('first');
    expect(createKeyboardMock).toHaveBeenCalledWith(3);
  });

  test('validates pending expense ownership and status by exact id', () => {
    findByIdMock.mockReturnValue(pending(7, 'Food'));
    expect(getPendingCategoryExpense(10, 7)?.id).toBe(7);
    expect(getPendingCategoryExpense(999, 7)).toBeNull();
  });

  test('groups duplicate unknown-category rows from one original message', () => {
    const current = pending(7, 'Pets', 100);
    findByUserIdMock.mockReturnValue([
      pending(9, 'Pets', 100),
      pending(7, 'Pets', 100),
      pending(8, 'Other', 100),
      pending(5, 'Pets', 99),
    ]);
    expect(getPendingCategorySiblings(10, current).map((item) => item.id)).toEqual([7, 9]);
  });

  test('queues budget prompts until the wizard finishes and deduplicates categories', () => {
    queueCategoryBudgetPrompt(10, 100, 'Pets');
    queueCategoryBudgetPrompt(10, 100, 'Pets');
    queueCategoryBudgetPrompt(10, 100, 'Car');
    expect(takeQueuedCategoryBudgetPrompts(10, 100)).toEqual(['Pets', 'Car']);
    expect(takeQueuedCategoryBudgetPrompts(10, 100)).toEqual([]);
  });
});
