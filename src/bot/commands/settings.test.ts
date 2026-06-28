// Tests for /settings — registry-driven editable menu: rendering, currency edit, toggles.

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

// ── Database (shared by settings.ts AND the registry it calls) ─────────────

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

const { handleSettingsCommand, handleSettingsCallback, buildSettingsView } = await import(
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
  };
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

// ── Rendering ─────────────────────────────────────────────────────────────

describe('/settings rendering', () => {
  test('renders every registry setting plus the spreadsheet status', async () => {
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
    expect(msg).toContain('AI-промпт: не задан');
    expect(msg).toContain('Топик: не задан');
    expect(msg).toContain('Таблица: настроена');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('reports spreadsheet "не настроена" when spreadsheet_id is null', async () => {
    await handleSettingsCommand(fakeCtx(), fakeGroup({ spreadsheet_id: null }));

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Таблица: не настроена');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('main keyboard exposes an action per setting', () => {
    const view = buildSettingsView(fakeGroup({ bank_cards_enabled: 0 }));
    const json = JSON.stringify(view.keyboard);
    expect(json).toContain('Сменить валюту по умолчанию');
    expect(json).toContain('settings:edit:default_currency');
    expect(json).toContain('Изменить набор валют');
    expect(json).toContain('settings:medit:enabled_currencies');
    expect(json).toContain('Включить карточки банка');
    expect(json).toContain('settings:set:bank_cards_enabled:on');
  });

  test('bank-cards button reflects current state and clarifies off = balance only', () => {
    const off = buildSettingsView(fakeGroup({ bank_cards_enabled: 0 }));
    expect(off.text).toContain('Карточки банковских транзакций: выкл (только баланс)');
    expect(JSON.stringify(off.keyboard)).toContain('Включить карточки банка');

    const on = buildSettingsView(fakeGroup({ bank_cards_enabled: 1 }));
    expect(on.text).toContain('Карточки банковских транзакций: вкл');
    expect(JSON.stringify(on.keyboard)).toContain('Выключить карточки банка');
  });

  test('clear buttons appear only when custom_prompt / topic are set', () => {
    const empty = buildSettingsView(fakeGroup({ custom_prompt: null, active_topic_id: null }));
    expect(JSON.stringify(empty.keyboard)).not.toContain('Очистить AI-промпт');
    expect(JSON.stringify(empty.keyboard)).not.toContain('Сбросить топик');

    const set = buildSettingsView(fakeGroup({ custom_prompt: 'Be brief', active_topic_id: 42 }));
    const json = JSON.stringify(set.keyboard);
    expect(json).toContain('settings:set:custom_prompt:clear');
    expect(json).toContain('settings:set:active_topic_id:clear');
  });

  test('sends friendly error message and logs when sender throws', async () => {
    sendMessageMock.mockImplementationOnce(() => {
      throw new Error('network down');
    });

    await handleSettingsCommand(fakeCtx(), fakeGroup());

    expect(sendMessageMock).toHaveBeenCalledTimes(2);
    expect(logMock.error).toHaveBeenCalled();
    const errMsg = sendMessageMock.mock.calls[1]?.[0] as string;
    expect(errMsg).toContain('непредвиденная');
  });
});

// ── Callback flow ───────────────────────────────────────────────────────────

describe('/settings callbacks', () => {
  test('set bank_cards_enabled:on writes 1 and re-renders in place', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup({ bank_cards_enabled: 0 }));

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['set', 'bank_cards_enabled', 'on']);

    expect(groupsUpdateMock).toHaveBeenCalledWith(-100, { bank_cards_enabled: 1 });
    const editText = ctx.editText as ReturnType<typeof mock>;
    expect(editText).toHaveBeenCalled();
    expect(logMock.error).not.toHaveBeenCalled();
    expect(logMock.warn).not.toHaveBeenCalled();
  });

  test('legacy bankcards sub-action flips the current state', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup({ bank_cards_enabled: 1 }));

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['bankcards']);

    expect(groupsUpdateMock).toHaveBeenCalledWith(-100, { bank_cards_enabled: 0 });
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('set default_currency changes it and keeps it enabled', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(
      fakeGroup({ default_currency: 'EUR', enabled_currencies: ['EUR', 'USD'] }),
    );

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['set', 'default_currency', 'rsd']);

    expect(groupsUpdateMock).toHaveBeenCalledWith(-100, {
      default_currency: 'RSD',
      enabled_currencies: ['EUR', 'USD', 'RSD'],
    });
    const answer = ctx.answerCallbackQuery as ReturnType<typeof mock>;
    expect(answer.mock.calls[0]?.[0]).toMatchObject({ text: '✅ Сохранено' });
  });

  test('invalid currency shows a Russian error and writes nothing', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup());

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['set', 'default_currency', 'zzz']);

    expect(groupsUpdateMock).not.toHaveBeenCalled();
    const answer = ctx.answerCallbackQuery as ReturnType<typeof mock>;
    const text = (answer.mock.calls[0]?.[0] as { text: string }).text;
    expect(text).toContain('ZZZ');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('edit opens the default-currency picker sub-view', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup({ default_currency: 'EUR' }));

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['edit', 'default_currency']);

    const editText = ctx.editText as ReturnType<typeof mock>;
    const kbJson = JSON.stringify(editText.mock.calls[0]?.[1]);
    expect(kbJson).toContain('settings:set:default_currency:RSD');
    expect(kbJson).toContain('settings:back');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('medit opens the multi-currency picker sub-view', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(
      fakeGroup({ enabled_currencies: ['EUR', 'USD'] }),
    );

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['medit', 'enabled_currencies']);

    const editText = ctx.editText as ReturnType<typeof mock>;
    const kbJson = JSON.stringify(editText.mock.calls[0]?.[1]);
    expect(kbJson).toContain('settings:mtog:enabled_currencies:RSD');
    expect(kbJson).toContain('settings:back');
  });

  test('mtog adds a currency to the enabled set', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(
      fakeGroup({ default_currency: 'EUR', enabled_currencies: ['EUR', 'USD'] }),
    );

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['mtog', 'enabled_currencies', 'RSD']);

    expect(groupsUpdateMock).toHaveBeenCalledWith(-100, {
      enabled_currencies: ['EUR', 'USD', 'RSD'],
    });
  });

  test('mtog refuses to remove the default currency', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(
      fakeGroup({ default_currency: 'EUR', enabled_currencies: ['EUR', 'USD'] }),
    );

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['mtog', 'enabled_currencies', 'EUR']);

    expect(groupsUpdateMock).not.toHaveBeenCalled();
    const answer = ctx.answerCallbackQuery as ReturnType<typeof mock>;
    expect((answer.mock.calls[0]?.[0] as { text: string }).text).toContain('по умолчанию');
  });

  test('back answers the callback and re-renders the main view', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup());

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['back']);

    const answer = ctx.answerCallbackQuery as ReturnType<typeof mock>;
    expect(answer).toHaveBeenCalled();
    const editText = ctx.editText as ReturnType<typeof mock>;
    const renderedText = editText.mock.calls[0]?.[0] as string;
    expect(renderedText).toContain('Настройки группы');
  });

  test('multi-select keeps custom (non-built-in) currencies editable', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(
      fakeGroup({ default_currency: 'EUR', enabled_currencies: ['EUR', 'GEL'] as CurrencyCode[] }),
    );

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['medit', 'enabled_currencies']);

    const editText = ctx.editText as ReturnType<typeof mock>;
    const kbJson = JSON.stringify(editText.mock.calls[0]?.[1]);
    expect(kbJson).toContain('settings:mtog:enabled_currencies:GEL');
  });

  test('answers "Группа не настроена" when the group is missing', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(null);

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['edit', 'default_currency']);

    expect(groupsUpdateMock).not.toHaveBeenCalled();
    const answer = ctx.answerCallbackQuery as ReturnType<typeof mock>;
    expect(answer.mock.calls[0]?.[0]).toMatchObject({ text: 'Группа не настроена' });
  });
});
