// Tests for /settings — renders current group config, handles errors

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import type { Group } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { Ctx } from '../types';

// ── Logger (settings.ts imports from '../../utils/logger.ts') ─────────────

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
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

const { handleSettingsCommand } = await import('./settings');

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
    enabled_currencies: ['EUR', 'USD'] as CurrencyCode[],
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
  logMock.error.mockReset();
  logMock.warn.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('/settings', () => {
  test('renders default currency, enabled currencies, and spreadsheet status (connected)', async () => {
    await handleSettingsCommand(
      fakeCtx(),
      fakeGroup({
        default_currency: 'EUR' as CurrencyCode,
        enabled_currencies: ['EUR', 'USD', 'RSD'] as CurrencyCode[],
        spreadsheet_id: 'sheet-123',
      }),
    );

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Настройки группы');
    expect(msg).toContain('Валюта по умолчанию: EUR');
    expect(msg).toContain('EUR, USD, RSD');
    expect(msg).toContain('Таблица: настроена');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('reports spreadsheet "не настроена" when spreadsheet_id is null', async () => {
    await handleSettingsCommand(fakeCtx(), fakeGroup({ spreadsheet_id: null }));

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Таблица: не настроена');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('shows non-EUR default currency correctly', async () => {
    await handleSettingsCommand(
      fakeCtx(),
      fakeGroup({
        default_currency: 'RSD' as CurrencyCode,
        enabled_currencies: ['RSD'] as CurrencyCode[],
      }),
    );

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Валюта по умолчанию: RSD');
    expect(msg).toContain('Включенные валюты: RSD');
  });

  test('single enabled currency renders without extra commas', async () => {
    await handleSettingsCommand(
      fakeCtx(),
      fakeGroup({ enabled_currencies: ['USD'] as CurrencyCode[] }),
    );

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Включенные валюты: USD\n');
    expect(msg).not.toContain('USD,');
  });

  test('sends friendly error message and logs when sender throws', async () => {
    sendMessageMock.mockImplementationOnce(() => {
      throw new Error('network down');
    });

    await handleSettingsCommand(fakeCtx(), fakeGroup());

    // First call threw; catch block should call sendMessage again
    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(logMock.error).toHaveBeenCalled();

    const errMsg = sendMessageMock.mock.calls[1]?.[0] as string;
    expect(errMsg).toContain('непредвиденная');
  });
});
