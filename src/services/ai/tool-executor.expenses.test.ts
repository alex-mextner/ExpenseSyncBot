/**
 * get_expenses: detail/summary output, pagination, currency, batch periods and stats.
 * Shared mocks live in tool-executor.test-support.ts.
 */
import { beforeEach, describe, expect, test } from 'bun:test';
import type { Expense } from '../../database/types';
import { makeExpense } from '../../test-utils/fixtures';
import { convertCurrency, formatAmount } from '../currency/converter';
import {
  ctx,
  executeTool,
  mockExpenses,
  mockGroups,
  resetAllMocks,
} from './tool-executor.test-support';

describe('executeGetExpenses', () => {
  beforeEach(resetAllMocks);

  test('returns formatted expense list', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      makeExpense({
        id: 1,
        user_id: 123,
        date: '2026-03-01',
        comment: 'lunch',
        amount: 15,
        eur_amount: 15,
      }),
      makeExpense({
        id: 2,
        user_id: 123,
        date: '2026-03-02',
        category: 'Transport',
        comment: '',
        amount: 5,
        eur_amount: 5,
      }),
    ]);

    const result = await executeTool('get_expenses', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('[id:1]');
    expect(result.output).toContain('Food');
    expect(result.output).toContain('[id:2]');
    expect(result.output).toContain('Transport');
    expect(result.output).toContain('Total for all 2 expenses:');
  });

  test('expense with no comment shows (no comment) in output', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      makeExpense({
        id: 1,
        user_id: 123,
        date: '2026-03-14',
        category: 'Путешествия',
        comment: '',
        amount: 1149.47,
        eur_amount: 1149.47,
      }),
    ]);

    const result = await executeTool('get_expenses', {}, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('(no comment)');
  });

  test('expense with whitespace-only comment shows (no comment) in output', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      makeExpense({
        id: 2,
        user_id: 123,
        date: '2026-03-14',
        category: 'Лена',
        comment: '   ',
        amount: 94.37,
        eur_amount: 94.37,
      }),
    ]);

    const result = await executeTool('get_expenses', {}, ctx);
    expect(result.output).toContain('(no comment)');
  });

  test('expense with real comment shows the comment', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      makeExpense({
        id: 3,
        user_id: 123,
        date: '2026-03-14',
        category: 'Еда',
        comment: 'обед',
        amount: 25,
        eur_amount: 25,
      }),
    ]);

    const result = await executeTool('get_expenses', {}, ctx);
    expect(result.output).toContain('обед');
    expect(result.output).not.toContain('(no comment)');
  });

  test('respects category filter (case-insensitive)', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      makeExpense({
        id: 1,
        user_id: 123,
        date: '2026-03-01',
        comment: 'pizza',
        amount: 10,
        eur_amount: 10,
      }),
      makeExpense({
        id: 2,
        user_id: 123,
        date: '2026-03-02',
        category: 'Transport',
        comment: 'taxi',
        amount: 20,
        eur_amount: 20,
      }),
    ]);

    const result = await executeTool('get_expenses', { category: 'food' }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Food');
    expect(result.output).not.toContain('Transport');
    expect(result.output).toContain('Total for all 1 expenses:');
  });

  test('respects date range via period filter', async () => {
    mockExpenses.findByDateRange.mockReturnValue([]);

    await executeTool('get_expenses', { period: '2025-12' }, ctx);

    expect(mockExpenses.findByDateRange).toHaveBeenCalledWith(1, '2025-12-01', '2025-12-31');
  });

  test('paginates results with page and page_size', async () => {
    const expenses = Array.from({ length: 150 }, (_, i) =>
      makeExpense({
        id: i + 1,
        user_id: 123,
        date: '2026-03-01',
        comment: `item ${i + 1}`,
        amount: 10,
        eur_amount: 10,
      }),
    );
    mockExpenses.findByDateRange.mockReturnValue(expenses);

    const page1 = await executeTool('get_expenses', { page: 1 }, ctx);
    expect(page1.success).toBe(true);
    expect(page1.output).toContain('Total for all 150 expenses:');
    expect(page1.output).toContain('[id:1]');
    expect(page1.output).toContain('[id:100]');
    expect(page1.output).not.toContain('[id:101]');

    const page2 = await executeTool('get_expenses', { page: 2 }, ctx);
    expect(page2.success).toBe(true);
    expect(page2.output).toContain('Total for all 150 expenses:');
    expect(page2.output).toContain('[id:101]');
    expect(page2.output).toContain('[id:150]');
    expect(page2.output).not.toContain('[id:1]');
  });

  test('custom page_size works', async () => {
    const expenses = Array.from({ length: 30 }, (_, i) =>
      makeExpense({
        id: i + 1,
        user_id: 123,
        date: '2026-03-01',
        comment: '',
        amount: 10,
        eur_amount: 10,
      }),
    );
    mockExpenses.findByDateRange.mockReturnValue(expenses);

    const result = await executeTool('get_expenses', { page: 1, page_size: 10 }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toContain('Total for all 30 expenses:');
    expect(result.output).toContain('[id:10]');
    expect(result.output).not.toContain('[id:11]');
  });

  // Stage QA 2026-10-15 (PR #170, HYP-1716 / #166): with page_size 8 the model read page 1 of 8,
  // summed those rows and called it the total for May. Every page now says what it shows, the
  // authoritative total for the whole filtered set, and how to get the rest.
  describe('paginated detail output carries the whole-set total', () => {
    const sixtyThree = () =>
      Array.from({ length: 63 }, (_, i) =>
        makeExpense({ id: i + 1, date: '2026-05-01', amount: 10, eur_amount: 10 }),
      );

    test('page 1 of 8: what it shows, the total for all 63, and how to read the rest', async () => {
      mockExpenses.findByDateRange.mockReturnValue(sixtyThree());

      const result = await executeTool(
        'get_expenses',
        { period: '2026-05', page: 1, page_size: 8 },
        ctx,
      );

      const out = result.output ?? '';
      expect(out).toContain('Showing 1–8 of 63 expenses (page 1 of 8)');
      expect(out).toContain(`Total for all 63 expenses: ${formatAmount(630, 'EUR', true)}`);
      expect(out).toContain('More pages: 2–8 are not shown');
      expect(out).toContain('page=2 … page=8 with page_size=8');
    });

    test('fractional page numbers from the model are read as whole numbers', async () => {
      mockExpenses.findByDateRange.mockReturnValue(sixtyThree());

      const result = await executeTool(
        'get_expenses',
        { period: '2026-05', page: 1.5, page_size: 8.7 },
        ctx,
      );

      expect(result.output).toContain('Showing 1–8 of 63 expenses (page 1 of 8)');
      expect(result.output).toContain('page=2 … page=8 with page_size=8');
    });

    test('page 1 of 8 warns against summing one page', async () => {
      mockExpenses.findByDateRange.mockReturnValue(sixtyThree());
      const result = await executeTool(
        'get_expenses',
        { period: '2026-05', page: 1, page_size: 8 },
        ctx,
      );
      const out = result.output ?? '';
      expect(out).toContain('never add up the rows of one page as the total');
      // The whole-set total comes before the rows, the page's own stats are labelled as such.
      expect(out.indexOf('Total for all 63')).toBeLessThan(out.indexOf('[id:'));
      expect(out).toContain('=== Stats (this page only, not the total) ===');
      expect(out).not.toContain('Grand total:');
    });

    test('the last page has no "more pages" line', async () => {
      mockExpenses.findByDateRange.mockReturnValue(sixtyThree());

      const result = await executeTool(
        'get_expenses',
        { period: '2026-05', page: 8, page_size: 8 },
        ctx,
      );

      expect(result.output).toContain('Showing 57–63 of 63 expenses (page 8 of 8)');
      expect(result.output).toContain('Total for all 63 expenses:');
      expect(result.output).not.toContain('More pages');
    });

    test('a requested currency shows the total in it and in the group default', async () => {
      const group = mockGroups.findById();
      mockGroups.findById.mockReturnValue(group && { ...group, default_currency: 'RSD' });
      mockExpenses.findByDateRange.mockReturnValue(sixtyThree());

      const result = await executeTool(
        'get_expenses',
        { period: '2026-05', page: 1, page_size: 8, currency: 'EUR' },
        ctx,
      );

      const rsd = formatAmount(convertCurrency(630, 'EUR', 'RSD'), 'RSD', true);
      expect(result.output).toContain(
        `Total for all 63 expenses: ${formatAmount(630, 'EUR', true)} (= ${rsd})`,
      );
    });
  });
});

describe('executeGetExpenses — batch periods and stats', () => {
  beforeEach(resetAllMocks);

  test('summary_only includes stats block', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      makeExpense({
        id: 1,
        user_id: 123,
        date: '2026-01-05',
        category: 'Еда',
        comment: 'Хлеб',
        amount: 120,
        eur_amount: 1.02,
      }),
      makeExpense({
        id: 2,
        user_id: 123,
        date: '2026-01-10',
        category: 'Еда',
        comment: 'Молоко',
        amount: 250,
        eur_amount: 2.13,
      }),
      makeExpense({
        id: 3,
        user_id: 123,
        date: '2026-01-15',
        category: 'Развлечения',
        comment: 'Кино',
        amount: 1500,
        eur_amount: 12.77,
      }),
    ]);

    const result = await executeTool(
      'get_expenses',
      { period: '2026-01', summary_only: true },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('=== Stats ===');
    expect(result.output).toContain('count: 3');
    expect(result.output).toContain('median:');
    expect(result.output).toContain('min:');
    expect(result.output).toContain('max:');
    expect(result.output).toContain('Хлеб');
    expect(result.output).toContain('Кино');
  });

  // Prod incident 2026-10-12: per-category totals in EUR for an RSD group took one
  // `calculate` call per category and exhausted the agent's tool rounds. The summary now
  // returns the totals in the requested currency in one call.
  describe('summary_only with a requested currency', () => {
    function useRsdGroup() {
      mockGroups.findById.mockReturnValue({
        id: 1,
        telegram_group_id: 456,
        title: null,
        invite_link: null,
        google_refresh_token: 'token',
        spreadsheet_id: 'sheet',
        default_currency: 'RSD',
        enabled_currencies: ['RSD', 'EUR', 'USD'],
        custom_prompt: null,
        active_topic_id: null,
        oauth_client: 'legacy' as const,
        bank_panel_summary_message_id: null,
        bank_cards_enabled: 1,
        created_at: '',
        updated_at: '',
      });
      mockExpenses.findByDateRange.mockReturnValue([
        makeExpense({
          id: 1,
          date: '2026-10-01',
          category: 'Квартира',
          amount: 52829.45,
          currency: 'RSD',
          eur_amount: 450,
        }),
        makeExpense({
          id: 2,
          date: '2026-10-03',
          category: 'Алекс',
          amount: 48800,
          currency: 'RSD',
          eur_amount: 416.59,
        }),
        makeExpense({
          id: 3,
          date: '2026-10-04',
          category: 'Алекс',
          amount: 10,
          currency: 'USD',
          eur_amount: 8,
        }),
      ]);
    }

    test('returns per-category and grand totals in EUR from the stored eur_amount', async () => {
      useRsdGroup();
      const result = await executeTool(
        'get_expenses',
        { period: '2026-10', summary_only: true, currency: 'EUR' },
        ctx,
      );
      expect(result.success).toBe(true);
      expect(result.output).toContain('Total: 874.59 EUR');
      expect(result.output).toContain('Квартира: 450.00 EUR (1 ops)');
      expect(result.output).toContain('Алекс: 424.59 EUR (2 ops)');
      // Original amounts per currency stay visible
      expect(result.output).toContain('48800.00 RSD');
    });

    test('accepts a lowercase code', async () => {
      useRsdGroup();
      const result = await executeTool(
        'get_expenses',
        { period: '2026-10', summary_only: true, currency: 'eur' },
        ctx,
      );
      expect(result.output).toContain('Total: 874.59 EUR');
    });

    test('without currency keeps the group default currency', async () => {
      useRsdGroup();
      const result = await executeTool(
        'get_expenses',
        { period: '2026-10', summary_only: true },
        ctx,
      );
      const rsd = formatAmount(convertCurrency(874.59, 'EUR', 'RSD'), 'RSD', true);
      expect(result.output).toContain(`Total: ${rsd}`);
    });

    test('converts totals to a requested currency other than EUR from the EUR sum', async () => {
      useRsdGroup();
      const result = await executeTool(
        'get_expenses',
        { period: '2026-10', summary_only: true, currency: 'USD' },
        ctx,
      );
      const usd = (eur: number) => formatAmount(convertCurrency(eur, 'EUR', 'USD'), 'USD', true);
      expect(result.output).toContain(`Total: ${usd(874.59)}`);
      expect(result.output).toContain(`Квартира: ${usd(450)} (1 ops)`);
      expect(result.output).toContain(`Алекс: ${usd(424.59)} (2 ops)`);
    });

    test('treats a null or blank currency as not given', async () => {
      useRsdGroup();
      const rsd = formatAmount(convertCurrency(874.59, 'EUR', 'RSD'), 'RSD', true);
      for (const currency of [null, '', '  ']) {
        const result = await executeTool(
          'get_expenses',
          { period: '2026-10', summary_only: true, currency },
          ctx,
        );
        expect(result.success).toBe(true);
        expect(result.output).toContain(`Total: ${rsd}`);
      }
    });

    test('rejects an unsupported currency code', async () => {
      useRsdGroup();
      const result = await executeTool(
        'get_expenses',
        { period: '2026-10', summary_only: true, currency: 'XYZ' },
        ctx,
      );
      expect(result.success).toBe(false);
      expect(result.error).toContain('Unknown currency');
    });
  });

  test('empty period array falls back to current_month', async () => {
    mockExpenses.findByDateRange.mockReturnValue([]);
    const result = await executeTool('get_expenses', { period: [], summary_only: true }, ctx);
    expect(result.success).toBe(true);
    expect(result.output).toBeDefined();
  });

  test('batch periods returns per-period stats and diff', async () => {
    const januaryExpenses: Expense[] = [
      makeExpense({
        id: 1,
        user_id: 123,
        date: '2026-01-05',
        category: 'Еда',
        comment: 'Хлеб',
        amount: 120,
        eur_amount: 1.02,
      }),
      makeExpense({
        id: 2,
        user_id: 123,
        date: '2026-01-10',
        category: 'Еда',
        comment: 'Молоко',
        amount: 250,
        eur_amount: 2.13,
      }),
      makeExpense({
        id: 3,
        user_id: 123,
        date: '2026-01-15',
        category: 'Развлечения',
        comment: 'Кино',
        amount: 1500,
        eur_amount: 12.77,
      }),
    ];
    const februaryExpenses: Expense[] = [
      makeExpense({
        id: 4,
        user_id: 123,
        date: '2026-02-03',
        category: 'Еда',
        comment: 'Сыр',
        amount: 800,
        eur_amount: 6.88,
      }),
      makeExpense({
        id: 5,
        user_id: 123,
        date: '2026-02-14',
        category: 'Развлечения',
        comment: 'Ресторан',
        amount: 5000,
        eur_amount: 42.5,
      }),
    ];

    let callCount = 0;
    mockExpenses.findByDateRange.mockImplementation(() => {
      callCount++;
      // First call: January, second call: February
      if (callCount === 1) return januaryExpenses;
      if (callCount === 2) return februaryExpenses;
      return [];
    });

    const result = await executeTool(
      'get_expenses',
      { period: ['2026-01', '2026-02'], summary_only: true },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('=== 2026-01 ===');
    expect(result.output).toContain('=== 2026-02 ===');
    expect(result.output).toContain('count: 3');
    expect(result.output).toContain('count: 2');
    expect(result.output).toContain('=== Diff:');
    expect(result.output).toContain('=== Overall ===');
  });

  test('category array filters multiple categories', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      makeExpense({
        id: 1,
        user_id: 123,
        date: '2026-01-05',
        category: 'Еда',
        comment: 'Хлеб',
        amount: 120,
        eur_amount: 1.02,
      }),
      makeExpense({
        id: 2,
        user_id: 123,
        date: '2026-01-15',
        category: 'Развлечения',
        comment: 'Кино',
        amount: 1500,
        eur_amount: 12.77,
      }),
      makeExpense({
        id: 3,
        user_id: 123,
        date: '2026-01-20',
        category: 'Транспорт',
        comment: 'Такси',
        amount: 700,
        eur_amount: 5.95,
      }),
    ]);

    const result = await executeTool(
      'get_expenses',
      { period: '2026-01', category: ['Еда', 'Развлечения'], summary_only: true },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('Еда');
    expect(result.output).toContain('Развлечения');
    expect(result.output).not.toContain('Транспорт');
  });

  test('detail output includes stats for all expenses', async () => {
    mockExpenses.findByDateRange.mockReturnValue([
      makeExpense({
        id: 1,
        user_id: 123,
        date: '2026-01-05',
        category: 'Еда',
        comment: 'Хлеб',
        amount: 120,
        eur_amount: 1.02,
      }),
      makeExpense({
        id: 2,
        user_id: 123,
        date: '2026-01-10',
        category: 'Еда',
        comment: 'Молоко',
        amount: 250,
        eur_amount: 2.13,
      }),
      makeExpense({
        id: 3,
        user_id: 123,
        date: '2026-01-15',
        category: 'Развлечения',
        comment: 'Кино',
        amount: 1500,
        eur_amount: 12.77,
      }),
    ]);

    const result = await executeTool(
      'get_expenses',
      { period: '2026-01', summary_only: false },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('=== Stats (all) ===');
    expect(result.output).toContain('count: 3');
    expect(result.output).toContain('[id:1]');
    expect(result.output).toContain('[id:3]');
  });

  test('3+ periods returns trend instead of diff', async () => {
    const janExpenses: Expense[] = [
      makeExpense({
        id: 1,
        user_id: 123,
        date: '2026-01-05',
        category: 'Еда',
        comment: 'Хлеб',
        amount: 120,
        eur_amount: 1.02,
      }),
    ];
    const febExpenses: Expense[] = [
      makeExpense({
        id: 2,
        user_id: 123,
        date: '2026-02-03',
        category: 'Еда',
        comment: 'Сыр',
        amount: 800,
        eur_amount: 6.88,
      }),
    ];
    const marExpenses: Expense[] = [
      makeExpense({
        id: 3,
        user_id: 123,
        date: '2026-03-01',
        category: 'Транспорт',
        comment: 'Такси',
        amount: 700,
        eur_amount: 5.95,
      }),
    ];

    let trendCallCount = 0;
    mockExpenses.findByDateRange.mockImplementation(() => {
      trendCallCount++;
      if (trendCallCount === 1) return janExpenses;
      if (trendCallCount === 2) return febExpenses;
      if (trendCallCount === 3) return marExpenses;
      return [];
    });

    const result = await executeTool(
      'get_expenses',
      { period: ['2026-01', '2026-02', '2026-03'], summary_only: true },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('=== Trend');
    expect(result.output).not.toContain('=== Diff:');
    expect(result.output).toContain('=== Overall ===');
  });
});
