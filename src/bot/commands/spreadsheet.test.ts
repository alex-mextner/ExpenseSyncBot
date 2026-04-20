// Tests for /spreadsheet — lists current and past-year spreadsheet URLs

import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import type { Group } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { Ctx } from '../types';

// ── Logger (spreadsheet.ts imports from '../../utils/logger.ts') ──────────

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Database ──────────────────────────────────────────────────────────────

const mockGroupSpreadsheets = {
  getByYear: mock((_groupId: number, _year: number): string | null => null),
  listAll: mock((_groupId: number): { year: number; spreadsheetId: string }[] => []),
};

mock.module('../../database', () => ({
  database: { groupSpreadsheets: mockGroupSpreadsheets },
}));

// ── Google Sheets ─────────────────────────────────────────────────────────

const getSpreadsheetUrlMock = mock(
  (id: string): string => `https://docs.google.com/spreadsheets/d/${id}`,
);

mock.module('../../services/google/sheets', () => ({
  getSpreadsheetUrl: getSpreadsheetUrlMock,
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
  deleteMessage: mock(() => Promise.resolve()),
}));

// ── Import after mocks ────────────────────────────────────────────────────

const { handleSpreadsheetCommand } = await import('./spreadsheet');

// ── Fixtures ──────────────────────────────────────────────────────────────

function fakeCtx(): Ctx['Command'] {
  return { chat: { id: -100, type: 'supergroup' }, from: { id: 1 } } as unknown as Ctx['Command'];
}

function fakeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1,
    telegram_group_id: -100,
    title: null,
    invite_link: null,
    google_refresh_token: null,
    spreadsheet_id: null,
    default_currency: 'EUR' as CurrencyCode,
    enabled_currencies: ['EUR'] as CurrencyCode[],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'current',
    bank_panel_summary_message_id: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  } as Group;
}

beforeEach(() => {
  sendMessageMock.mockReset().mockResolvedValue(null);
  mockGroupSpreadsheets.getByYear.mockReset().mockReturnValue(null);
  mockGroupSpreadsheets.listAll.mockReset().mockReturnValue([]);
  getSpreadsheetUrlMock
    .mockReset()
    .mockImplementation((id: string) => `https://docs.google.com/spreadsheets/d/${id}`);
  logMock.error.mockReset();
  logMock.warn.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('/spreadsheet', () => {
  test('shows "Таблица не создана" when group has no spreadsheets at all', async () => {
    mockGroupSpreadsheets.getByYear.mockReturnValue(null);
    mockGroupSpreadsheets.listAll.mockReturnValue([]);

    await handleSpreadsheetCommand(fakeCtx(), fakeGroup());

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Таблица не создана');
    expect(msg).toContain('/connect');
    expect(getSpreadsheetUrlMock).not.toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('shows current-year spreadsheet URL when available', async () => {
    const currentYear = new Date().getFullYear();
    mockGroupSpreadsheets.getByYear.mockReturnValue('sheet-current');
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: currentYear, spreadsheetId: 'sheet-current' },
    ]);

    await handleSpreadsheetCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain(`Таблица ${currentYear}`);
    expect(msg).toContain('https://docs.google.com/spreadsheets/d/sheet-current');
    expect(getSpreadsheetUrlMock).toHaveBeenCalledWith('sheet-current');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('lists previous years below current when both exist', async () => {
    const currentYear = 2026;
    const yearSpy = spyOn(Date.prototype, 'getFullYear').mockReturnValue(currentYear);

    mockGroupSpreadsheets.getByYear.mockReturnValue('sheet-2026');
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: 2026, spreadsheetId: 'sheet-2026' },
      { year: 2025, spreadsheetId: 'sheet-2025' },
      { year: 2024, spreadsheetId: 'sheet-2024' },
    ]);

    await handleSpreadsheetCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Таблица 2026');
    expect(msg).toContain('Предыдущие годы');
    expect(msg).toContain('• 2025:');
    expect(msg).toContain('• 2024:');
    expect(msg).toContain('sheet-2025');
    expect(msg).toContain('sheet-2024');

    yearSpy.mockRestore();
  });

  test('notes current year is missing when only past years exist', async () => {
    const currentYear = 2026;
    const yearSpy = spyOn(Date.prototype, 'getFullYear').mockReturnValue(currentYear);

    mockGroupSpreadsheets.getByYear.mockReturnValue(null);
    mockGroupSpreadsheets.listAll.mockReturnValue([{ year: 2025, spreadsheetId: 'sheet-2025' }]);

    await handleSpreadsheetCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain(`Таблица за ${currentYear} ещё не создана`);
    expect(msg).toContain('2025');
    expect(msg).toContain('sheet-2025');

    yearSpy.mockRestore();
  });

  test('includes /sync and /budget sync reminders in output', async () => {
    mockGroupSpreadsheets.getByYear.mockReturnValue('sheet-x');
    mockGroupSpreadsheets.listAll.mockReturnValue([
      { year: new Date().getFullYear(), spreadsheetId: 'sheet-x' },
    ]);

    await handleSpreadsheetCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('/sync');
    expect(msg).toContain('/budget sync');
  });

  test('handles repository error: logs and sends friendly error', async () => {
    mockGroupSpreadsheets.getByYear.mockImplementation(() => {
      throw new Error('db failure');
    });

    await handleSpreadsheetCommand(fakeCtx(), fakeGroup());

    expect(logMock.error).toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('непредвиденная');
  });

  test('queries group by the correct id', async () => {
    const group = fakeGroup();
    group.id = 77;
    mockGroupSpreadsheets.getByYear.mockReturnValue(null);
    mockGroupSpreadsheets.listAll.mockReturnValue([]);

    await handleSpreadsheetCommand(fakeCtx(), group);

    expect(mockGroupSpreadsheets.getByYear).toHaveBeenCalledWith(77, expect.any(Number));
    expect(mockGroupSpreadsheets.listAll).toHaveBeenCalledWith(77);
  });
});
