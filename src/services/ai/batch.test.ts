/** Tests for batch execution helper */
import { describe, expect, test } from 'bun:test';
import { executeBatchItems, isBatchInput, MAX_BATCH_SIZE } from './batch';
import type { ToolResult } from './types';

describe('isBatchInput', () => {
  test('returns false for undefined', () => {
    expect(isBatchInput(undefined)).toBe(false);
  });

  test('returns false for a string', () => {
    expect(isBatchInput('hello')).toBe(false);
  });

  test('returns false for a number', () => {
    expect(isBatchInput(42)).toBe(false);
  });

  test('returns true for an array with items', () => {
    expect(isBatchInput([1, 2, 3])).toBe(true);
  });

  test('returns false for an empty array', () => {
    expect(isBatchInput([])).toBe(false);
  });
});

describe('executeBatchItems', () => {
  test('executes each item and collects results', async () => {
    const executor = async (item: { name: string }): Promise<ToolResult> => ({
      success: true,
      output: `Done: ${item.name}`,
    });

    const result = await executeBatchItems(
      [{ name: 'Еда' }, { name: 'Транспорт' }],
      'set_budget',
      executor,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('2/2 succeeded');
    expect(result.output).toContain('Done: Еда');
    expect(result.output).toContain('Done: Транспорт');
  });

  test('reports partial failures without aborting', async () => {
    const executor = async (item: { n: number }): Promise<ToolResult> => {
      if (item.n === 2) return { success: false, error: 'not found' };
      return { success: true, output: `ok #${item.n}` };
    };

    const result = await executeBatchItems(
      [{ n: 1 }, { n: 2 }, { n: 3 }],
      'delete_budget',
      executor,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('2/3 succeeded');
    expect(result.output).toContain('✗');
    expect(result.output).toContain('not found');
  });

  test('rejects batch over MAX_BATCH_SIZE', async () => {
    const items = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({ id: i }));
    const executor = async () => ({ success: true, output: 'ok' }) as ToolResult;

    const result = await executeBatchItems(items, 'test_tool', executor);

    expect(result.success).toBe(false);
    expect(result.error).toContain(`${MAX_BATCH_SIZE}`);
  });

  test('catches thrown exceptions and reports them as failures', async () => {
    const executor = async (item: { n: number }): Promise<ToolResult> => {
      if (item.n === 2) throw new Error('DB connection lost');
      return { success: true, output: `ok #${item.n}` };
    };

    const result = await executeBatchItems(
      [{ n: 1 }, { n: 2 }, { n: 3 }],
      'add_expense',
      executor,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('2/3 succeeded');
    expect(result.output).toContain('DB connection lost');
  });

  test('returns all-failed summary when everything fails', async () => {
    const executor = async (): Promise<ToolResult> => ({
      success: false,
      error: 'boom',
    });

    const result = await executeBatchItems([{ a: 1 }, { a: 2 }], 'tool', executor);

    expect(result.success).toBe(false);
    expect(result.output).toContain('0/2 succeeded');
  });
});
