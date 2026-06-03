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

// ── Database ──────────────────────────────────────────────────────────────

const groupsFindByTelegramGroupIdMock = mock((_id: number): Group | null => null);
const groupsUpdateMock = mock((_id: number, _data: Partial<Group>): Group | null => null);
mock.module('../../database', () => ({
  database: {
    groups: {
      findByTelegramGroupId: groupsFindByTelegramGroupIdMock,
      update: groupsUpdateMock,
    },
  },
}));

// ── Import after mocks ────────────────────────────────────────────────────

const { handleSettingsCommand, handleSettingsBankCardsToggle, buildSettingsView } = await import(
  './settings'
);

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
    bank_cards_enabled: 0,
    created_at: '',
    updated_at: '',
    ...overrides,
  } as Group;
}

function fakeCallbackCtx(): Ctx['CallbackQuery'] {
  return {
    message: { chat: { id: -100, type: 'supergroup' } },
    from: { id: 1 },
    answerCallbackQuery: mock(() => Promise.resolve()),
    editText: mock(() => Promise.resolve()),
  } as unknown as Ctx['CallbackQuery'];
}

beforeEach(() => {
  sendMessageMock.mockReset().mockResolvedValue(null);
  groupsFindByTelegramGroupIdMock.mockReset().mockReturnValue(null);
  groupsUpdateMock.mockReset().mockReturnValue(null);
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

  test('renders bank-cards state and a toggle button reflecting it', async () => {
    await handleSettingsCommand(fakeCtx(), fakeGroup({ bank_cards_enabled: 0 }));

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Карточки банковских транзакций: выкл');

    const opts = sendMessageMock.mock.calls[0]?.[1] as { reply_markup?: unknown } | undefined;
    expect(opts?.reply_markup).toBeDefined();
    const view = buildSettingsView(fakeGroup({ bank_cards_enabled: 0 }));
    expect(view.text).toContain('выкл');
    expect(JSON.stringify(view.keyboard)).toContain('Включить карточки банка');

    const onView = buildSettingsView(fakeGroup({ bank_cards_enabled: 1 }));
    expect(onView.text).toContain('Карточки банковских транзакций: вкл');
    expect(JSON.stringify(onView.keyboard)).toContain('Выключить карточки банка');
  });
});

describe('/settings bank-cards toggle', () => {
  test('flips bank_cards_enabled from 0 to 1 and re-renders', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup({ bank_cards_enabled: 0 }));
    groupsUpdateMock.mockReturnValue(fakeGroup({ bank_cards_enabled: 1 }));

    const ctx = fakeCallbackCtx();
    await handleSettingsBankCardsToggle(ctx);

    expect(groupsUpdateMock).toHaveBeenCalledWith(-100, { bank_cards_enabled: 1 });
    const editText = ctx.editText as ReturnType<typeof mock>;
    const editedText = editText.mock.calls[0]?.[0] as string;
    expect(editedText).toContain('Карточки банковских транзакций: вкл');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('flips bank_cards_enabled from 1 to 0 and re-renders', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup({ bank_cards_enabled: 1 }));
    groupsUpdateMock.mockReturnValue(fakeGroup({ bank_cards_enabled: 0 }));

    const ctx = fakeCallbackCtx();
    await handleSettingsBankCardsToggle(ctx);

    expect(groupsUpdateMock).toHaveBeenCalledWith(-100, { bank_cards_enabled: 0 });
    const editText = ctx.editText as ReturnType<typeof mock>;
    const editedText = editText.mock.calls[0]?.[0] as string;
    expect(editedText).toContain('Карточки банковских транзакций: выкл');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('answers with error and does not update when group is missing', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(null);

    const ctx = fakeCallbackCtx();
    await handleSettingsBankCardsToggle(ctx);

    expect(groupsUpdateMock).not.toHaveBeenCalled();
    const answer = ctx.answerCallbackQuery as ReturnType<typeof mock>;
    expect(answer.mock.calls[0]?.[0]).toMatchObject({ text: 'Группа не настроена' });
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
