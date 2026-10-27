/** Tests for sheets.ts row deletion — criteria matching, queue serialization, index-based deletes */
import { beforeEach, describe, expect, test } from 'bun:test';
import {
  logMock,
  mockSpreadsheetsBatchUpdate,
  mockSpreadsheetsGet,
  mockValuesGet,
  resetSheetsMocks,
  TEST_CONN,
  TEST_SPREADSHEET,
} from './sheets-test-support';

// Dynamic import keeps './sheets' evaluated AFTER the mock.module calls in
// sheets-test-support (otherwise bun binds the real logger/googleapis).
const { deleteExpenseRowsByIndex, findAndDeleteExpenseRow } = await import('./sheets');

beforeEach(resetSheetsMocks);

// ── findAndDeleteExpenseRow ────────────────────────────────────────────────

describe('findAndDeleteExpenseRow', () => {
  beforeEach(() => {
    mockSpreadsheetsBatchUpdate.mockReset().mockResolvedValue({ data: {} });
  });

  test('finds matching row and deletes via batchUpdate; returns 1-based row index', async () => {
    // Headers row + 3 data rows. The match is on row 3 (1-based: header=1, data start=2).
    // Headers: Дата | Категория | Комментарий | EUR (calc) | RSD (дин.) | Rate (→EUR)
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
          ['2026-04-15', 'Алекс', 'Кофе', '4.3', 500, 0.0086], // row 2
          ['2026-04-15', 'Алекс', 'Ноут для умного дома', '348.5', 41000, 0.0085], // row 3 — match
          ['2026-04-15', 'Еда', 'Пицца', '8.5', 1000, 0.0085], // row 4
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Ноут для умного дома',
      amount: 41000,
      currency: 'RSD',
    });

    expect(result.deletedRowIndex).toBe(3);
    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
    const call = mockSpreadsheetsBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: {
        requests: Array<{
          deleteDimension: { range: { dimension: string; startIndex: number; endIndex: number } };
        }>;
      };
    };
    const req = call.requestBody.requests[0];
    expect(req?.deleteDimension.range.dimension).toBe('ROWS');
    expect(req?.deleteDimension.range.startIndex).toBe(2); // 0-based: row 3 -> startIndex 2
    expect(req?.deleteDimension.range.endIndex).toBe(3);
  });

  test('returns deletedRowIndex=null when no row matches', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
          ['2026-04-15', 'Еда', 'Пицца', '8.5', 1000, 0.0085],
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Ноут для умного дома',
      amount: 41000,
      currency: 'RSD',
    });

    expect(result.deletedRowIndex).toBeNull();
    expect(mockSpreadsheetsBatchUpdate).not.toHaveBeenCalled();
  });

  test('matches first row when multiple identical rows exist (delete-one-per-call semantics)', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
          ['2026-04-15', 'Алекс', 'Ноут', '348.5', 41000, 0.0085], // row 2 — first match
          ['2026-04-15', 'Алекс', 'Ноут', '348.5', 41000, 0.0085], // row 3 — also matches
          ['2026-04-15', 'Алекс', 'Ноут', '348.5', 41000, 0.0085], // row 4 — also matches
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Ноут',
      amount: 41000,
      currency: 'RSD',
    });

    // First match (row 2) is deleted — repeated calls handle dups
    expect(result.deletedRowIndex).toBe(2);
    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
  });

  test('does not match if comment differs (avoids deleting unrelated expense)', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
          ['2026-04-15', 'Алекс', 'Совершенно другой расход', '348.5', 41000, 0.0085],
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Ноут',
      amount: 41000,
      currency: 'RSD',
    });

    expect(result.deletedRowIndex).toBeNull();
    expect(mockSpreadsheetsBatchUpdate).not.toHaveBeenCalled();
  });

  test('tolerates float round-trip error for fractional amounts (regression)', async () => {
    // Sheets round-trip often drifts fractional floats by ~1e-14.
    // Strict === would miss the row and silently leave it in the sheet.
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'USD ($)', 'Rate (→EUR)'],
          // criteria.amount = 12.34; sheet returns what Sheets actually stores
          ['2026-04-15', 'Coffee', 'latte', 10.61, 12.339999999999996, 0.86],
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Coffee',
      comment: 'latte',
      amount: 12.34,
      currency: 'USD',
    });

    expect(result.deletedRowIndex).toBe(2);
    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
  });

  test('still rejects amounts that differ by more than half a cent', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'USD ($)', 'Rate (→EUR)'],
          ['2026-04-15', 'Coffee', 'latte', 10.61, 12.35, 0.86],
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Coffee',
      comment: 'latte',
      amount: 12.34, // sheet has 12.35 — a real different amount
      currency: 'USD',
    });

    expect(result.deletedRowIndex).toBeNull();
    expect(mockSpreadsheetsBatchUpdate).not.toHaveBeenCalled();
  });

  test('does NOT match "EUR (calc)" column when looking up EUR currency (regression)', async () => {
    // Layout where EUR (calc) comes BEFORE the EUR currency column —
    // defensive against future column reorders.
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'EUR (€)', 'Rate (→EUR)'],
          // EUR (calc) column holds the computed value 100.  EUR currency column holds 100 too.
          // Without the fix, findIndex would match "EUR (calc)" first (index 3)
          // and read the computed EUR from the wrong column.
          ['2026-04-15', 'Алекс', 'Coffee', 100, 100, 1.0],
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Coffee',
      amount: 100,
      currency: 'EUR',
    });

    // Even with both columns present in the wrong order, the correct row is found.
    expect(result.deletedRowIndex).toBe(2);
    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
  });

  test('serializes concurrent deletes through the per-spreadsheet queue (regression)', async () => {
    // Two concurrent deletes must not run read-then-delete in parallel —
    // otherwise both can read the pre-delete row numbers and the second
    // deleteDimension shifts a stale index, removing the wrong row.
    // The queue guarantees strict sequencing: second values.get runs only
    // after the first batchUpdate has resolved.
    const callOrder: string[] = [];

    mockValuesGet.mockImplementation(async () => {
      callOrder.push('read');
      // Small delay lets a racy implementation interleave reads
      await Bun.sleep(5);
      return {
        data: {
          values: [
            ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
            ['2026-04-15', 'Алекс', 'Coffee', 4.3, 500, 0.0086],
          ],
        },
      };
    });

    mockSpreadsheetsBatchUpdate.mockImplementation(async () => {
      callOrder.push('delete');
      return { data: {} };
    });

    const criteria = {
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Coffee',
      amount: 500,
      currency: 'RSD',
    };

    const p1 = findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, criteria);
    const p2 = findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, criteria);
    await Promise.all([p1, p2]);

    // Expected strict interleaving: read → delete → read → delete
    expect(callOrder).toEqual(['read', 'delete', 'read', 'delete']);
  });

  test('handles date stored as Sheets serial number (UNFORMATTED_VALUE)', async () => {
    // 2026-04-15 = serial 46127 (days since 1899-12-30)
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'RSD (дин.)', 'Rate (→EUR)'],
          [46127, 'Алекс', 'Ноут', '348.5', 41000, 0.0085],
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Алекс',
      comment: 'Ноут',
      amount: 41000,
      currency: 'RSD',
    });

    expect(result.deletedRowIndex).toBe(2);
  });
});

// ── findAndDeleteExpenseRow — additional edge cases ─────────────────────────

describe('findAndDeleteExpenseRow — edge cases', () => {
  test('returns null and does NOT delete when currency column not in headers', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [
          ['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'Rate (→EUR)'],
          ['2026-04-15', 'Coffee', 'latte', '4.3', '0.86'],
        ],
      },
    });

    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'Coffee',
      comment: 'latte',
      amount: 5,
      currency: 'USD',
    });

    expect(result.deletedRowIndex).toBeNull();
    expect(mockSpreadsheetsBatchUpdate).not.toHaveBeenCalled();
    expect(logMock.warn).toHaveBeenCalled();
  });

  test('returns null when sheet has only header row', async () => {
    mockValuesGet.mockResolvedValueOnce({
      data: {
        values: [['Дата', 'Категория', 'Комментарий', 'EUR (calc)', 'USD ($)', 'Rate (→EUR)']],
      },
    });
    const result = await findAndDeleteExpenseRow(TEST_CONN, TEST_SPREADSHEET, {
      date: '2026-04-15',
      category: 'x',
      comment: '',
      amount: 1,
      currency: 'USD',
    });
    expect(result.deletedRowIndex).toBeNull();
  });
});

// ── deleteExpenseRowsByIndex ────────────────────────────────────────────────

describe('deleteExpenseRowsByIndex', () => {
  test('no-op for empty indices', async () => {
    await deleteExpenseRowsByIndex(TEST_CONN, TEST_SPREADSHEET, []);
    expect(mockSpreadsheetsBatchUpdate).not.toHaveBeenCalled();
  });

  test('processes indices in reverse sorted order (avoids shifting)', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 0, title: 'Expenses' } }] },
    });

    await deleteExpenseRowsByIndex(TEST_CONN, TEST_SPREADSHEET, [3, 8, 5]);

    expect(mockSpreadsheetsBatchUpdate).toHaveBeenCalledTimes(1);
    const args = mockSpreadsheetsBatchUpdate.mock.calls[0]?.[0] as {
      requestBody: {
        requests: Array<{
          deleteDimension: { range: { startIndex: number; endIndex: number; dimension: string } };
        }>;
      };
    };
    const reqs = args.requestBody.requests;
    expect(reqs.map((r) => r.deleteDimension.range.startIndex)).toEqual([7, 4, 2]);
    for (const r of reqs) {
      expect(r.deleteDimension.range.endIndex - r.deleteDimension.range.startIndex).toBe(1);
      expect(r.deleteDimension.range.dimension).toBe('ROWS');
    }
  });

  test('throws when Expenses tab is missing from spreadsheet', async () => {
    mockSpreadsheetsGet.mockResolvedValueOnce({
      data: { sheets: [{ properties: { sheetId: 0, title: 'Other' } }] },
    });
    await expect(deleteExpenseRowsByIndex(TEST_CONN, TEST_SPREADSHEET, [2])).rejects.toThrow(
      /"Expenses" tab not found/,
    );
  });
});
