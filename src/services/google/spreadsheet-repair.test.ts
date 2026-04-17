// Tests for spreadsheet-repair: classify sheet errors, audit access, recreate lost sheets

import { describe, expect, mock, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import type { Budget, Expense } from '../../database/types';
import { OAuthError } from '../../errors';
import type { GoogleConn } from './sheets';
import {
  auditAllYears,
  classifySheetError,
  type RecreateDeps,
  recreateLostSpreadsheets,
  recreateSpreadsheet,
} from './spreadsheet-repair';

describe('classifySheetError', () => {
  test('classifies 404 (file not found / no access) — common after scope downgrade', () => {
    const err = {
      code: 404,
      response: {
        data: {
          error: {
            code: 404,
            errors: [{ reason: 'notFound', message: 'File not found: abc123.' }],
          },
        },
      },
    };
    const result = classifySheetError(err);
    expect(result.status).toBe('not_found');
    expect(result.errorMessage).toContain('not found');
  });

  test('classifies 403 (forbidden)', () => {
    const err = {
      code: 403,
      response: { data: { error: { code: 403, message: 'The caller does not have permission' } } },
    };
    const result = classifySheetError(err);
    expect(result.status).toBe('forbidden');
  });

  test('classifies OAuth token expiry', () => {
    const err = new OAuthError('Token revoked', 'TOKEN_EXPIRED');
    const result = classifySheetError(err);
    expect(result.status).toBe('token_expired');
  });

  test('classifies unknown errors as unknown_error with the message preserved', () => {
    const err = new Error('ECONNRESET — network glitch');
    const result = classifySheetError(err);
    expect(result.status).toBe('unknown_error');
    expect(result.errorMessage).toContain('ECONNRESET');
  });

  test('classifies non-Error values without throwing', () => {
    expect(classifySheetError(null).status).toBe('unknown_error');
    expect(classifySheetError(undefined).status).toBe('unknown_error');
    expect(classifySheetError('plain string').status).toBe('unknown_error');
  });
});

describe('auditAllYears', () => {
  const conn: GoogleConn = { refreshToken: 'tok', oauthClient: 'current' };

  test('classifies each spreadsheet via the probe and preserves order', async () => {
    const probe = mock(async (_c: GoogleConn, id: string) => {
      if (id === 'good-2025') return;
      if (id === 'lost-2026') {
        throw {
          code: 404,
          response: { data: { error: { code: 404, errors: [{ reason: 'notFound' }] } } },
        };
      }
      throw new Error('boom');
    });

    const result = await auditAllYears(probe, conn, [
      { year: 2025, spreadsheetId: 'good-2025' },
      { year: 2026, spreadsheetId: 'lost-2026' },
      { year: 2027, spreadsheetId: 'flaky-2027' },
    ]);

    expect(result).toHaveLength(3);
    expect(result[0]).toEqual({ year: 2025, spreadsheetId: 'good-2025', status: 'ok' });
    expect(result[1]?.year).toBe(2026);
    expect(result[1]?.status).toBe('not_found');
    expect(result[2]?.year).toBe(2027);
    expect(result[2]?.status).toBe('unknown_error');
    expect(probe).toHaveBeenCalledTimes(3);
  });

  test('returns empty array for empty input without calling probe', async () => {
    const probe = mock(async () => {});
    const result = await auditAllYears(probe, conn, []);
    expect(result).toEqual([]);
    expect(probe).not.toHaveBeenCalled();
  });
});

describe('recreateSpreadsheet', () => {
  const conn: GoogleConn = { refreshToken: 'tok', oauthClient: 'current' };
  const group = {
    id: 1,
    default_currency: 'RSD' as CurrencyCode,
    enabled_currencies: ['EUR', 'RSD'] as CurrencyCode[],
  };

  function buildDeps(overrides: Partial<RecreateDeps> = {}): RecreateDeps {
    return {
      createExpenseSpreadsheet: mock(async () => ({
        spreadsheetId: 'NEW-2026',
        spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/NEW-2026',
      })),
      appendExpenseRows: mock(async () => {}),
      writeMonthBudgetRow: mock(async () => {}),
      loadExpensesForYear: mock((): Expense[] => []),
      loadBudgetsForYear: mock((): Budget[] => []),
      setSpreadsheetIdForYear: mock(() => {}),
      getExchangeRate: mock(() => 0.0085),
      ...overrides,
    };
  }

  test('creates new sheet, updates DB pointer, returns RecreateResult', async () => {
    const deps = buildDeps();

    const result = await recreateSpreadsheet(deps, conn, group, {
      year: 2026,
      spreadsheetId: 'OLD-2026',
      status: 'not_found',
    });

    expect(result.year).toBe(2026);
    expect(result.oldSpreadsheetId).toBe('OLD-2026');
    expect(result.newSpreadsheetId).toBe('NEW-2026');
    expect(result.newSpreadsheetUrl).toBe('https://docs.google.com/spreadsheets/d/NEW-2026');
    expect(result.expensesCopied).toBe(0);
    expect(result.budgetsCopied).toBe(0);

    expect(deps.createExpenseSpreadsheet).toHaveBeenCalledWith(conn, 'RSD', ['EUR', 'RSD']);
    expect(deps.setSpreadsheetIdForYear).toHaveBeenCalledWith(1, 2026, 'NEW-2026');
  });

  test('copies expenses for the lost year into the new sheet', async () => {
    const expenses: Expense[] = [
      {
        id: 1,
        group_id: 1,
        user_id: 1,
        date: '2026-04-15',
        category: 'Алекс',
        comment: 'Ноут',
        amount: 41000,
        currency: 'RSD',
        eur_amount: 348.5,
        receipt_id: null,
        receipt_file_id: null,
        created_at: '',
      },
      {
        id: 2,
        group_id: 1,
        user_id: 1,
        date: '2026-04-16',
        category: 'Еда',
        comment: 'Пицца',
        amount: 1000,
        currency: 'RSD',
        eur_amount: 8.5,
        receipt_id: null,
        receipt_file_id: null,
        created_at: '',
      },
    ];

    const deps = buildDeps({
      loadExpensesForYear: mock(() => expenses),
    });

    const result = await recreateSpreadsheet(deps, conn, group, {
      year: 2026,
      spreadsheetId: 'OLD-2026',
      status: 'not_found',
    });

    expect(result.expensesCopied).toBe(2);
    expect(deps.appendExpenseRows).toHaveBeenCalledTimes(1);
    const call = (deps.appendExpenseRows as ReturnType<typeof mock>).mock.calls[0];
    if (!call) throw new Error('Expected appendExpenseRows call');
    expect(call[0]).toEqual(conn);
    expect(call[1]).toBe('NEW-2026');
    const rows = call[2] as Array<{
      date: string;
      category: string;
      amounts: Record<string, unknown>;
    }>;
    expect(rows).toHaveLength(2);
    expect(rows[0]?.amounts['RSD']).toBe(41000);
    expect(rows[0]?.amounts['EUR']).toBeNull();
  });

  test('copies budgets for the lost year, one writeMonthBudgetRow per budget', async () => {
    const budgets: Budget[] = [
      {
        id: 1,
        group_id: 1,
        category: 'Алекс',
        month: '2026-04',
        limit_amount: 700,
        currency: 'EUR',
        created_at: '',
        updated_at: '',
      },
      {
        id: 2,
        group_id: 1,
        category: 'Еда',
        month: '2026-04',
        limit_amount: 500,
        currency: 'EUR',
        created_at: '',
        updated_at: '',
      },
      {
        id: 3,
        group_id: 1,
        category: 'Транспорт',
        month: '2026-05',
        limit_amount: 100,
        currency: 'EUR',
        created_at: '',
        updated_at: '',
      },
    ];
    const deps = buildDeps({ loadBudgetsForYear: mock(() => budgets) });

    const result = await recreateSpreadsheet(deps, conn, group, {
      year: 2026,
      spreadsheetId: 'OLD-2026',
      status: 'not_found',
    });

    expect(result.budgetsCopied).toBe(3);
    expect(result.budgetTabsCreated).toEqual(['Apr', 'May']);
    expect(deps.writeMonthBudgetRow).toHaveBeenCalledTimes(3);
  });

  test('recreateLostSpreadsheets only recreates not_found and forbidden, skips ok and others', async () => {
    let creates = 0;
    const deps = buildDeps({
      createExpenseSpreadsheet: mock(async () => {
        creates++;
        return {
          spreadsheetId: `NEW-${creates}`,
          spreadsheetUrl: `https://docs.google.com/spreadsheets/d/NEW-${creates}`,
        };
      }),
    });

    const audits = [
      { year: 2024, spreadsheetId: 'OK-2024', status: 'ok' as const },
      { year: 2025, spreadsheetId: 'LOST-2025', status: 'not_found' as const },
      { year: 2026, spreadsheetId: 'FORBIDDEN-2026', status: 'forbidden' as const },
      { year: 2027, spreadsheetId: 'TX-2027', status: 'token_expired' as const },
      { year: 2028, spreadsheetId: 'WTF-2028', status: 'unknown_error' as const },
    ];

    const results = await recreateLostSpreadsheets(deps, conn, group, audits);

    // Only 2025 and 2026 should be recreated
    expect(results).toHaveLength(2);
    expect(results[0]?.year).toBe(2025);
    expect(results[1]?.year).toBe(2026);
    expect(deps.createExpenseSpreadsheet).toHaveBeenCalledTimes(2);
  });

  test('does NOT update DB pointer if createExpenseSpreadsheet fails', async () => {
    const deps = buildDeps({
      createExpenseSpreadsheet: mock(() => {
        throw new Error('Drive quota exceeded');
      }),
    });

    await expect(
      recreateSpreadsheet(deps, conn, group, {
        year: 2026,
        spreadsheetId: 'OLD-2026',
        status: 'not_found',
      }),
    ).rejects.toThrow('Drive quota exceeded');

    expect(deps.setSpreadsheetIdForYear).not.toHaveBeenCalled();
    expect(deps.appendExpenseRows).not.toHaveBeenCalled();
  });
});
