// New currency entries traverse the real message handler, pending repository and batch saver.
// SQLite stays in memory; only Google, Telegram and unrelated conversation flows are stubbed.
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { CurrencyCode } from '../config/constants';
import type { PendingExpense } from '../database/types';
import type { ExpenseRowData, GoogleConn } from '../services/google/sheets';
import { clearTestDb } from '../test-utils/db';
import { createMockLogger } from '../test-utils/mocks/logger';

const log = createMockLogger();
mock.module('../utils/logger.ts', () => ({ createLogger: () => log, logger: log }));

const sentMessages: string[] = [];
mock.module('../services/bank/telegram-sender', () => ({
  sendMessage: async (text: string) => {
    sentMessages.push(text);
    return { message_id: sentMessages.length };
  },
  createInviteLink: async () => null,
  removeInlineKeyboard: async () => {},
}));

interface SheetWrite {
  spreadsheetId: string;
  rows: ExpenseRowData[];
  pending: PendingExpense[];
}
const sheetWrites: SheetWrite[] = [];
let userId: number;
mock.module('../services/google/sheets', () => ({
  appendExpenseRows: async (conn: GoogleConn, spreadsheetId: string, rows: ExpenseRowData[]) => {
    expect(conn.refreshToken).toBe('synthetic-token');
    sheetWrites.push({
      spreadsheetId,
      rows,
      pending: database.pendingExpenses.findByUserId(userId),
    });
  },
  googleConn: (group: { google_refresh_token: string; oauth_client: string }) => ({
    refreshToken: group.google_refresh_token,
    oauthClient: group.oauth_client,
  }),
  writeMonthBudgetRow: async () => true,
}));
mock.module('../services/google/oauth', () => ({ isTokenExpiredError: () => false }));
mock.module('../bot/services/budget-sync', () => ({ silentSyncBudgets: async () => 0 }));
mock.module('../bot/commands/ask', () => ({
  maybeSmartAdvice: async () => {},
  handleAskQuestion: async () => {},
}));
mock.module('../bot/commands/dev', () => ({
  consumePendingDesignEdit: () => null,
  getPipelineInstance: () => null,
}));
mock.module('../bot/commands/feedback', () => ({
  consumePendingFeedback: () => null,
  submitFeedback: async () => {},
}));
mock.module('../bot/commands/connect', () => ({
  isAwaitingCustomCurrency: () => false,
  handleCustomCurrencyInput: async () => true,
}));
mock.module('../bot/commands/bank', () => ({
  handleWizardInput: async () => false,
  handleBankEditReply: async () => false,
}));
mock.module('../services/bank/otp-manager', () => ({ resolveOtpForGroup: () => false }));
mock.module('../services/receipt/link-analyzer', () => ({
  extractURLsFromText: () => [],
  processPaymentLinks: async () => false,
}));

// The test runner sets NODE_ENV=test, which makes the actual singleton use :memory:.
if (process.env['NODE_ENV'] !== 'test') throw new Error('Run with bun test; no on-disk DB allowed');
const network = spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected network call'));
const { database } = await import('../database');
const { handleExpenseMessage } = await import('../bot/handlers/message.handler');

beforeEach(() => {
  clearTestDb(database.getDb());
  sentMessages.length = 0;
  sheetWrites.length = 0;
  log.error.mockClear();
  log.warn.mockClear();
  network.mockClear();
});
afterAll(() => {
  database.close();
  network.mockRestore();
});

function seed(defaultCurrency: CurrencyCode = 'EUR'): number {
  const group = database.groups.create({
    telegram_group_id: -100250,
    default_currency: defaultCurrency,
  });
  database.groups.update(-100250, {
    enabled_currencies: ['EUR', 'USD', 'RSD', 'GEL', 'OMR', 'THB', 'MYR', 'KHR', 'TRY'],
    google_refresh_token: 'synthetic-token',
    spreadsheet_id: 'sheet-currency-test',
  });
  userId = database.users.create({ telegram_id: 250, group_id: group.id }).id;
  database.categories.create({ group_id: group.id, name: 'Еда' });
  return group.id;
}

async function sendExpenseText(text: string): Promise<boolean> {
  const ctx = {
    id: 250,
    chat: { id: -100250, type: 'group', title: 'Currency integration' },
    from: { id: 250, firstName: 'Test' },
    text,
    update: { message: {} },
  } as unknown as Parameters<typeof handleExpenseMessage>[0];
  const bot = {
    api: { setMessageReaction: async () => true, sendChatAction: async () => {} },
  } as unknown as Parameters<typeof handleExpenseMessage>[1];
  return handleExpenseMessage(ctx, bot);
}

const cases = [
  {
    name: 'MYR symbol',
    text: 'RM12.34 еда поездка',
    currency: 'MYR',
    amount: 12.34,
    display: '12.34 RM',
  },
  {
    name: 'MYR Russian name',
    text: '12,34 малайзийских ринггитов еда поездка',
    currency: 'MYR',
    amount: 12.34,
    display: '12.34 RM',
  },
  {
    name: 'KHR symbol',
    text: '1\u00a0234,56៛ еда поездка',
    currency: 'KHR',
    amount: 1234.56,
    display: '1234.56 ៛',
  },
  {
    name: 'KHR local name',
    text: 'រៀល12.34 еда поездка',
    currency: 'KHR',
    amount: 12.34,
    display: '12.34 ៛',
  },
  {
    name: 'TRY symbol',
    text: '₺12.34 еда поездка',
    currency: 'TRY',
    amount: 12.34,
    display: '12.34 ₺',
  },
  {
    name: 'TRY local uppercase name',
    text: '12.34 TÜRK LİRASI еда поездка',
    currency: 'TRY',
    amount: 12.34,
    display: '12.34 ₺',
  },
  {
    name: 'GEL symbol',
    text: '₾12.34 еда поездка',
    currency: 'GEL',
    amount: 12.34,
    display: '12.34 ₾',
  },
  {
    name: 'GEL Russian name',
    text: '12.34 лари еда поездка',
    currency: 'GEL',
    amount: 12.34,
    display: '12.34 ₾',
  },
  {
    name: 'THB symbol',
    text: '56.78฿ еда поездка',
    currency: 'THB',
    amount: 56.78,
    display: '56.78 ฿',
  },
  {
    name: 'THB English name',
    text: '56.78 baht еда поездка',
    currency: 'THB',
    amount: 56.78,
    display: '56.78 ฿',
  },
  {
    name: 'OMR code',
    text: '1.234 OMR еда поездка',
    currency: 'OMR',
    amount: 1.234,
    display: '1.234 OMR',
  },
  {
    name: 'OMR one baisa',
    text: '0.001 ر.ع. еда поездка',
    currency: 'OMR',
    amount: 0.001,
    display: '0.001 OMR',
  },
  {
    name: 'OMR Russian name and decimal comma',
    text: '1,234 оманских риалов еда поездка',
    currency: 'OMR',
    amount: 1.234,
    display: '1.234 OMR',
  },
];

describe('new currencies through pending expense and batch save', () => {
  test.each(cases)('$name retains its currency and amount without changing the default', async ({
    text,
    currency,
    amount,
    display,
  }) => {
    const groupId = seed();
    expect(await sendExpenseText(`${text}\n2.50 еда без валюты`)).toBe(true);

    const saved = database.expenses.findByGroupId(groupId, 10);
    expect(saved).toHaveLength(2);
    expect(saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          currency,
          amount,
          category: 'Еда',
          comment: 'Поездка',
          user_id: userId,
        }),
        expect.objectContaining({
          currency: 'EUR',
          amount: 2.5,
          category: 'Еда',
          comment: 'Без валюты',
        }),
      ]),
    );
    expect(sheetWrites).toHaveLength(1);
    const write = sheetWrites[0];
    expect(write?.spreadsheetId).toBe('sheet-currency-test');
    expect(write?.rows).toHaveLength(2);
    expect(write?.rows[0]?.amounts).toMatchObject({ [currency]: amount, EUR: null });
    expect(write?.rows[1]?.amounts).toMatchObject({ [currency]: null, EUR: 2.5 });
    expect(write?.rows[0]?.rate).toBeGreaterThan(0);
    expect(write?.pending).toHaveLength(2);
    expect(write?.pending).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          parsed_currency: currency,
          parsed_amount: amount,
          status: 'confirmed',
        }),
      ]),
    );
    expect(database.pendingExpenses.findByUserId(userId)).toHaveLength(0);
    expect(database.groups.findById(groupId)?.default_currency).toBe('EUR');
    expect(sentMessages.join('\n')).toContain(display);
    expect(sentMessages.join('\n')).toContain('2.50 €');
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  test.each([
    '100 USD',
    '100 GEL',
    '100 OMR',
    '0.001 OMR',
    '100 THB',
    '100 MYR',
    'RM100',
    '100 KHR',
    '៛100',
    '100 TRY',
    '100₺',
    '₾100',
    '100฿',
    'ر.ع. 0.001',
  ])('incomplete entry %s does not create a currency-named category or financial records', async (text) => {
    const groupId = seed();
    expect(await sendExpenseText(text)).toBe(false);
    expect(database.expenses.findByGroupId(groupId, 10)).toHaveLength(0);
    expect(database.pendingExpenses.findByUserId(userId)).toHaveLength(0);
    expect(database.categories.getCategoryNames(groupId)).toEqual(['Еда']);
    expect(sheetWrites).toEqual([]);
    expect(sentMessages).toEqual([]);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  test('records travel currencies alongside EUR, USD and RSD in one batch', async () => {
    const groupId = seed();
    const currencyAmounts = [
      ['EUR', 1.11],
      ['USD', 2.22],
      ['RSD', 333.33],
      ['GEL', 4.44],
      ['OMR', 5.555],
      ['THB', 66.66],
      ['MYR', 7.77],
      ['KHR', 8888.88],
      ['TRY', 99.99],
    ] as const;
    const text = currencyAmounts
      .map(([code, amount]) => `${amount} ${code} еда synthetic`)
      .join('\n');
    expect(await sendExpenseText(text)).toBe(true);
    const saved = database.expenses.findByGroupId(groupId, 20);
    expect(saved).toHaveLength(currencyAmounts.length);
    expect(sheetWrites).toHaveLength(1);
    for (const [currency, amount] of currencyAmounts) {
      expect(saved).toContainEqual(expect.objectContaining({ currency, amount, category: 'Еда' }));
      expect(sheetWrites[0]?.rows).toContainEqual(
        expect.objectContaining({ amounts: expect.objectContaining({ [currency]: amount }) }),
      );
    }
    expect(database.pendingExpenses.findByUserId(userId)).toHaveLength(0);
    expect(database.groups.findById(groupId)?.default_currency).toBe('EUR');
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  test.each([
    'MYR',
    'KHR',
    'TRY',
  ] as const)('%s default keeps original hundredths when the currency is omitted', async (currency) => {
    const groupId = seed(currency);
    expect(await sendExpenseText('0.01 еда fee\n1.23 еда lunch')).toBe(true);
    const saved = database.expenses.findByGroupId(groupId, 10);
    expect(saved).toHaveLength(2);
    expect(saved).toContainEqual(expect.objectContaining({ currency, amount: 0.01 }));
    expect(saved).toContainEqual(expect.objectContaining({ currency, amount: 1.23 }));
    expect(sheetWrites[0]?.rows.map((row) => row.amounts[currency])).toEqual([0.01, 1.23]);
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });

  test('an OMR default preserves one baisa and three decimals when no code is typed', async () => {
    const groupId = seed('OMR');
    expect(await sendExpenseText('0.001 еда байса\n1.234 еда обед')).toBe(true);

    const saved = database.expenses.findByGroupId(groupId, 10);
    expect(saved).toHaveLength(2);
    expect(saved).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ currency: 'OMR', amount: 0.001, comment: 'Байса' }),
        expect.objectContaining({ currency: 'OMR', amount: 1.234, comment: 'Обед' }),
      ]),
    );
    expect(sheetWrites).toHaveLength(1);
    expect(sheetWrites[0]?.rows.map((row) => row.amounts['OMR'])).toEqual([0.001, 1.234]);
    expect(database.pendingExpenses.findByUserId(userId)).toHaveLength(0);
    expect(sentMessages.join('\n')).toContain('0.001 OMR');
    expect(sentMessages.join('\n')).toContain('1.234 OMR');
    expect(log.error).not.toHaveBeenCalled();
    expect(log.warn).not.toHaveBeenCalled();
    expect(network).not.toHaveBeenCalled();
  });
});
