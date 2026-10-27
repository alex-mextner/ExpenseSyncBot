/**
 * Expense write tools: add_expense and delete_expense (single and batch).
 * Shared mocks live in tool-executor.test-support.ts.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { Expense } from '../../database/types';
import { makeExpense } from '../../test-utils/fixtures';
import {
  ctx,
  executeTool,
  mockDeleteFromSheet,
  mockExpenses,
  mockRecord,
  resetAllMocks,
} from './tool-executor.test-support';

describe('executeAddExpense', () => {
  beforeEach(resetAllMocks);

  test('creates expense with correct fields via ExpenseRecorder', async () => {
    mockRecord.mockResolvedValue({ expense: { id: 42 }, eurAmount: 25.5 });

    const result = await executeTool(
      'add_expense',
      { amount: 25.5, category: 'Food', comment: 'lunch', date: '2026-03-09' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(mockRecord).toHaveBeenCalledWith(1, 123, {
      date: '2026-03-09',
      category: 'Food',
      comment: 'lunch',
      amount: 25.5,
      currency: 'EUR',
    });
  });

  test('returns confirmation with amount and currency', async () => {
    mockRecord.mockResolvedValue({ expense: { id: 99 }, eurAmount: 43 });

    const result = await executeTool(
      'add_expense',
      { amount: 50, category: 'Transport', currency: 'USD' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('50.00 USD');
    expect(result.output).toContain('Transport');
    expect(result.output).toContain('ID: 99');
  });

  test('rejects invalid amount', async () => {
    const result = await executeTool('add_expense', { amount: 0, category: 'Food' }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid');
  });

  test('rejects missing category', async () => {
    const result = await executeTool('add_expense', { amount: 100 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Invalid');
  });
});

describe('add_expense batch', () => {
  beforeEach(resetAllMocks);

  test('batch add_expense with items array records each expense', async () => {
    const result = await executeTool(
      'add_expense',
      {
        items: [
          { amount: 300, category: 'Еда', comment: 'кофе' },
          { amount: 800, category: 'Еда', comment: 'обед' },
          { amount: 500, category: 'Транспорт', comment: 'такси' },
        ],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('3/3 succeeded');
    expect(mockRecord).toHaveBeenCalledTimes(3);
  });

  test('single add_expense still works (backward compat)', async () => {
    const result = await executeTool(
      'add_expense',
      { amount: 300, category: 'Еда', comment: 'кофе' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('Expense added');
  });

  test('batch over 20 items is rejected', async () => {
    const items = Array.from({ length: 21 }, (_, i) => ({
      amount: 100,
      category: `Cat${i}`,
    }));

    const result = await executeTool('add_expense', { items }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('20');
  });

  test('items array takes priority over top-level fields', async () => {
    const result = await executeTool(
      'add_expense',
      {
        amount: 999,
        category: 'IGNORED',
        items: [{ amount: 42, category: 'Real', comment: 'test' }],
      },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('1/1 succeeded');
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const calls = mockRecord.mock.calls as unknown as Array<
      [number, number, { category: string; amount: number }]
    >;
    expect(calls[0]?.[2].category).toBe('Real');
    expect(calls[0]?.[2].amount).toBe(42);
  });

  test('empty items array returns error', async () => {
    const result = await executeTool('add_expense', { items: [] }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });
});

describe('executeDeleteExpense', () => {
  beforeEach(resetAllMocks);

  test('deletes expense belonging to this group', async () => {
    const expense = makeExpense({
      id: 10,
      user_id: 123,
      date: '2026-03-01',
      comment: 'pizza',
      amount: 12,
      eur_amount: 12,
    });
    mockExpenses.findById.mockReturnValue(expense);

    const result = await executeTool('delete_expense', { expense_id: 10 }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Expense 10 deleted');
    // Removes the row from Google Sheets BEFORE deleting from DB
    expect(mockDeleteFromSheet).toHaveBeenCalledWith(1, expense);
    expect(mockExpenses.delete).toHaveBeenCalledWith(10);
  });

  test('removes legacy "run /sync" hint from response (regression)', async () => {
    mockExpenses.findById.mockReturnValue(
      makeExpense({ id: 10, user_id: 123, date: '2026-03-01', comment: 'pizza', amount: 12 }),
    );

    const result = await executeTool('delete_expense', { expense_id: 10 }, ctx);
    expect(result.output).not.toContain('/sync');
  });

  test('reports when sheet row was not found (already removed manually)', async () => {
    mockExpenses.findById.mockReturnValue(
      makeExpense({ id: 10, user_id: 123, date: '2026-03-01', comment: 'pizza', amount: 12 }),
    );
    mockDeleteFromSheet.mockReturnValueOnce(Promise.resolve({ deletedRowIndex: null }));

    const result = await executeTool('delete_expense', { expense_id: 10 }, ctx);
    // Still succeeds — DB delete is the authoritative action
    expect(result.success).toBe(true);
    expect(mockExpenses.delete).toHaveBeenCalledWith(10);
    // The output mentions sheet row was not present
    expect(result.output).toContain('not found in sheet');
  });

  test('preserves DB row when sheet delete fails — no silent resurrection via /sync', async () => {
    // If we deleted the DB row while sheet delete failed, the sheet still holds
    // the row, and the next /sync (or auto-sync) would re-import it. So we leave
    // DB untouched and surface a clear error that points at /repair.
    mockExpenses.findById.mockReturnValue(
      makeExpense({ id: 10, user_id: 123, date: '2026-03-01', comment: 'pizza', amount: 12 }),
    );
    mockDeleteFromSheet.mockReturnValueOnce(Promise.reject(new Error('Sheet API 404 — file gone')));

    const result = await executeTool('delete_expense', { expense_id: 10 }, ctx);

    expect(result.success).toBe(false);
    expect(mockExpenses.delete).not.toHaveBeenCalled();
    expect(result.error).toContain('sheet');
    expect((result.error ?? '').toLowerCase()).toMatch(/404|gone|failed|error/);
    expect(result.error).toContain('/repair');
  });

  test('rejects deletion of expense from different group', async () => {
    mockExpenses.findById.mockReturnValue(
      makeExpense({
        id: 10,
        group_id: 999,
        user_id: 456,
        date: '2026-03-01',
        comment: '',
        amount: 12,
        eur_amount: 12,
      }),
    );

    const result = await executeTool('delete_expense', { expense_id: 10 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('Access denied');
    expect(mockExpenses.delete).not.toHaveBeenCalled();
  });

  test('returns error when expense not found', async () => {
    mockExpenses.findById.mockReturnValue(null);

    const result = await executeTool('delete_expense', { expense_id: 999 }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('not found');
  });
});

describe('delete_expense batch', () => {
  beforeEach(resetAllMocks);

  test('batch delete with expense_id array', async () => {
    mockExpenses.findById.mockImplementation(((id: number) =>
      makeExpense({
        id,
        user_id: 123,
        date: '2026-03-01',
        comment: 'test',
        amount: 10,
        eur_amount: 10,
      })) as unknown as () => Expense | null);

    const result = await executeTool('delete_expense', { expense_id: [10, 11, 12] }, ctx);

    expect(result.success).toBe(true);
    expect(result.output).toContain('3/3 succeeded');
    expect(mockExpenses.delete).toHaveBeenCalledTimes(3);
  });

  test('batch delete rejects expense from another group', async () => {
    mockExpenses.findById
      .mockReturnValueOnce(
        makeExpense({
          id: 10,
          user_id: 123,
          date: '2026-03-01',
          comment: '',
          amount: 10,
          eur_amount: 10,
        }),
      )
      .mockReturnValueOnce(
        makeExpense({
          id: 11,
          group_id: 999,
          user_id: 123,
          date: '2026-03-01',
          comment: '',
          amount: 10,
          eur_amount: 10,
        }),
      );

    const result = await executeTool('delete_expense', { expense_id: [10, 11] }, ctx);

    expect(result.output).toContain('1/2 succeeded');
    expect(result.output).toContain('Access denied');
  });

  test('single delete still works', async () => {
    mockExpenses.findById.mockReturnValue(
      makeExpense({
        id: 10,
        user_id: 123,
        date: '2026-03-01',
        comment: 'lunch',
        amount: 15,
        eur_amount: 15,
      }),
    );

    const result = await executeTool('delete_expense', { expense_id: 10 }, ctx);
    expect(result.success).toBe(true);
    expect(mockExpenses.delete).toHaveBeenCalledWith(10);
    expect(result.output).toContain('Expense 10 deleted');
  });

  test('empty expense_id array returns error', async () => {
    const result = await executeTool('delete_expense', { expense_id: [] }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });
});
