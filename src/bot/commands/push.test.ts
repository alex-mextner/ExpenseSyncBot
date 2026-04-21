// Tests for /push — reconciles DB expenses to Google Sheet (idempotency, errors).

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import type { Expense } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { GoogleConnectedGroup } from '../guards';
import type { Ctx } from '../types';

// ── Logger ────────────────────────────────────────────────────────────────

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Database ──────────────────────────────────────────────────────────────

const mockExpenses = {
  findByGroupId: mock((_gid: number, _limit: number): Expense[] => []),
};

mock.module('../../database', () => ({
  database: { expenses: mockExpenses },
}));

// ── Telegram sender ───────────────────────────────────────────────────────

const sendMessageMock = mock(
  (_text: string, _options?: unknown): Promise<null> => Promise.resolve(null),
);

mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  withChatContext: async <T>(_c: number, _t: number | null, fn: () => Promise<T>) => fn(),
  editMessageText: mock(() => Promise.resolve()),
  sendDirect: mock(() => Promise.resolve(null)),
}));

// ── ExpenseRecorder ───────────────────────────────────────────────────────

const pushToSheetMock = mock(
  async (_gid: number, _expenses: Expense[]): Promise<void> => undefined,
);

mock.module('../../services/expense-recorder', () => ({
  getExpenseRecorder: () => ({ pushToSheet: pushToSheetMock }),
}));

// ── Google Sheets ─────────────────────────────────────────────────────────

type SheetPayload = {
  expenses: Array<{
    date: string;
    amounts: Record<string, number>;
    eurAmount: number;
    rate: number | null;
    category: string;
    comment: string;
  }>;
  errors: unknown[];
  eurMismatches: unknown[];
};

const readExpensesFromSheetMock = mock(
  async (): Promise<SheetPayload> => ({ expenses: [], errors: [], eurMismatches: [] }),
);

const googleConnMock = mock(() => ({ refreshToken: 'tok', oauthClient: 'current' as const }));

mock.module('../../services/google/sheets', () => ({
  readExpensesFromSheet: readExpensesFromSheetMock,
  googleConn: googleConnMock,
}));

// ── Import after mocks ────────────────────────────────────────────────────

const { handlePushCommand } = await import('./push');

// ── Fixtures ──────────────────────────────────────────────────────────────

function fakeCtx(): Ctx['Command'] {
  return { chat: { id: -100, type: 'supergroup' }, from: { id: 1 } } as unknown as Ctx['Command'];
}

function fakeGroup(): GoogleConnectedGroup {
  return {
    id: 1,
    telegram_group_id: -100,
    title: null,
    invite_link: null,
    google_refresh_token: 'tok',
    spreadsheet_id: 'sheet-123',
    default_currency: 'EUR' as CurrencyCode,
    enabled_currencies: ['EUR' as CurrencyCode],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'current',
    bank_panel_summary_message_id: null,
    created_at: '',
    updated_at: '',
  } as GoogleConnectedGroup;
}

function fakeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 1,
    group_id: 1,
    user_id: 1,
    date: '01.01.2026',
    category: 'Food',
    comment: '',
    amount: 10,
    currency: 'EUR' as CurrencyCode,
    eur_amount: 10,
    receipt_id: null,
    receipt_file_id: null,
    created_at: '',
    ...overrides,
  };
}

beforeEach(() => {
  sendMessageMock.mockReset().mockResolvedValue(null);
  mockExpenses.findByGroupId.mockReset().mockReturnValue([]);
  readExpensesFromSheetMock
    .mockReset()
    .mockResolvedValue({ expenses: [], errors: [], eurMismatches: [] });
  pushToSheetMock.mockReset().mockResolvedValue(undefined);
  logMock.error.mockReset();
  logMock.warn.mockReset();
  logMock.info.mockReset();
});

describe('/push — happy path', () => {
  test('pushes DB expenses that are not yet in the sheet', async () => {
    mockExpenses.findByGroupId.mockReturnValue([
      fakeExpense({ id: 1, date: '01.01.2026', category: 'Food', amount: 10, currency: 'EUR' }),
      fakeExpense({ id: 2, date: '02.01.2026', category: 'Taxi', amount: 20, currency: 'EUR' }),
    ]);
    readExpensesFromSheetMock.mockResolvedValue({
      expenses: [],
      errors: [],
      eurMismatches: [],
    });

    await handlePushCommand(fakeCtx(), fakeGroup());

    expect(pushToSheetMock).toHaveBeenCalledTimes(2);
    // Last progress message mentions 2 added
    const finalMsg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(finalMsg).toContain('Push завершён');
    expect(finalMsg).toContain('Добавлено: 2');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('idempotent — skips expenses already present in sheet (same key)', async () => {
    mockExpenses.findByGroupId.mockReturnValue([
      fakeExpense({ id: 1, date: '01.01.2026', category: 'Food', amount: 10, currency: 'EUR' }),
      fakeExpense({ id: 2, date: '02.01.2026', category: 'Taxi', amount: 20, currency: 'EUR' }),
    ]);
    readExpensesFromSheetMock.mockResolvedValue({
      expenses: [
        {
          date: '01.01.2026',
          amounts: { EUR: 10 },
          eurAmount: 10,
          rate: 1,
          category: 'Food',
          comment: '',
        },
      ],
      errors: [],
      eurMismatches: [],
    });

    await handlePushCommand(fakeCtx(), fakeGroup());

    // Only the taxi row is missing → one push call
    expect(pushToSheetMock).toHaveBeenCalledTimes(1);
    const pushedExpenses = pushToSheetMock.mock.calls[0]?.[1] as Expense[];
    expect(pushedExpenses[0]?.id).toBe(2);
  });

  test('all rows already synced — reports zero added, does not call recorder', async () => {
    mockExpenses.findByGroupId.mockReturnValue([
      fakeExpense({ id: 1, date: '01.01.2026', category: 'Food', amount: 10, currency: 'EUR' }),
    ]);
    readExpensesFromSheetMock.mockResolvedValue({
      expenses: [
        {
          date: '01.01.2026',
          amounts: { EUR: 10 },
          eurAmount: 10,
          rate: 1,
          category: 'Food',
          comment: '',
        },
      ],
      errors: [],
      eurMismatches: [],
    });

    await handlePushCommand(fakeCtx(), fakeGroup());

    expect(pushToSheetMock).not.toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('уже синхронизированы');
    expect(msg).toContain('Добавлено: 0');
  });
});

describe('/push — error paths', () => {
  test('readExpensesFromSheet throws → friendly error, logged', async () => {
    mockExpenses.findByGroupId.mockReturnValue([fakeExpense()]);
    readExpensesFromSheetMock.mockRejectedValue(new Error('quota exceeded'));

    await handlePushCommand(fakeCtx(), fakeGroup());

    expect(logMock.error).toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Ошибка push');
    expect(msg).toContain('quota exceeded');
    expect(pushToSheetMock).not.toHaveBeenCalled();
  });

  test('individual pushToSheet failures are counted and reported', async () => {
    mockExpenses.findByGroupId.mockReturnValue([
      fakeExpense({ id: 1, amount: 10 }),
      fakeExpense({ id: 2, amount: 20 }),
    ]);
    readExpensesFromSheetMock.mockResolvedValue({
      expenses: [],
      errors: [],
      eurMismatches: [],
    });
    pushToSheetMock
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('sheet locked'));

    await handlePushCommand(fakeCtx(), fakeGroup());

    expect(logMock.error).toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Добавлено: 1');
    expect(msg).toContain('Ошибок: 1');
  });

  test('warns (not errors) when sheet has multi-currency rows', async () => {
    mockExpenses.findByGroupId.mockReturnValue([]);
    readExpensesFromSheetMock.mockResolvedValue({
      expenses: [],
      errors: [{ row: 5, date: '01.01.2026', currencies: ['USD', 'RSD'] }],
      eurMismatches: [],
    });

    await handlePushCommand(fakeCtx(), fakeGroup());

    expect(logMock.warn).toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
