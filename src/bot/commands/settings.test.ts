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
const { GROUP_SETTINGS } = await import('../../services/settings/group-settings-registry');

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
  // Default: update persists (returns the row). Tests for failed writes override this.
  groupsUpdateMock.mockReset().mockReturnValue(fakeGroup());
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

  // Menu-side analogue of the registry enforcement test: EVERY registry setting must
  // produce a reachable button. A new GROUP_SETTINGS entry that gets no button fails here.
  test('every GROUP_SETTINGS key produces a reachable menu button', () => {
    const json = JSON.stringify(buildSettingsView(fakeGroup()).keyboard);
    for (const key of Object.keys(GROUP_SETTINGS)) {
      expect(json).toContain(key);
    }
  });

  test('main keyboard dispatches the right sub-action per kind', () => {
    const json = JSON.stringify(buildSettingsView(fakeGroup({ bank_cards_enabled: 0 })).keyboard);
    expect(json).toContain('settings:edit:default_currency'); // currency
    expect(json).toContain('settings:medit:enabled_currencies'); // currency_multi
    expect(json).toContain('settings:set:bank_cards_enabled:on'); // toggle (off → "on")
    expect(json).toContain('settings:tedit:active_topic_id'); // topic
    expect(json).toContain('settings:xedit:custom_prompt'); // text
  });

  test('bank-cards button reflects current state and clarifies off = balance only', () => {
    const off = buildSettingsView(fakeGroup({ bank_cards_enabled: 0 }));
    expect(off.text).toContain('Карточки банковских транзакций: выкл (только баланс)');
    expect(JSON.stringify(off.keyboard)).toContain('settings:set:bank_cards_enabled:on');

    const on = buildSettingsView(fakeGroup({ bank_cards_enabled: 1 }));
    expect(on.text).toContain('Карточки банковских транзакций: вкл');
    expect(JSON.stringify(on.keyboard)).toContain('settings:set:bank_cards_enabled:off');
  });

  // The global sanitizeOutgoingMessages hook re-decodes &lt;…&gt; and restores whitelisted
  // tags, so entity-escaping would be undone. We neutralize tag chars with guillemets so a
  // user's custom_prompt can never render as active formatting / a link in the menu.
  test('neutralizes angle brackets in user-controlled values (no injection survives sanitizer)', () => {
    const view = buildSettingsView(fakeGroup({ custom_prompt: '<b>x</b> <a href="z">l</a>' }));
    expect(view.text).not.toContain('<b>');
    expect(view.text).not.toContain('<a ');
    expect(view.text).not.toContain('</');
    // Look-alike guillemets are not tag characters; the sanitizer leaves them untouched.
    expect(view.text).toContain('‹b›x‹/b›');
  });

  test('neutralizes PRE-ENCODED tag delimiters too (sanitizer would decode &lt;…&gt;)', () => {
    const view = buildSettingsView(
      fakeGroup({ custom_prompt: '&lt;a href="https://x"&gt;click&lt;/a&gt;' }),
    );
    // No &lt;/&gt; left for the outgoing HTML sanitizer to decode back into a real tag.
    expect(view.text).not.toContain('&lt;');
    expect(view.text).not.toContain('&gt;');
    expect(view.text).toContain('‹a href=');
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
    // Re-render must use HTML parse mode to match sendMessage, so escapeHtml is consistent.
    expect(editText.mock.calls[0]?.[1]).toMatchObject({ parse_mode: 'HTML' });
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

  test('set bank_cards_enabled:off writes 0', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup({ bank_cards_enabled: 1 }));

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['set', 'bank_cards_enabled', 'off']);

    expect(groupsUpdateMock).toHaveBeenCalledWith(-100, { bank_cards_enabled: 0 });
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('set custom_prompt:clear writes null', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup({ custom_prompt: 'old note' }));

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['set', 'custom_prompt', 'clear']);

    expect(groupsUpdateMock).toHaveBeenCalledWith(-100, { custom_prompt: null });
  });

  test('set active_topic_id:clear writes null', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup({ active_topic_id: 99 }));

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['set', 'active_topic_id', 'clear']);

    expect(groupsUpdateMock).toHaveBeenCalledWith(-100, { active_topic_id: null });
  });

  test('menu cannot set active_topic_id to a number (clear-only)', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup());

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['set', 'active_topic_id', '42']);

    expect(groupsUpdateMock).not.toHaveBeenCalled();
    const answer = ctx.answerCallbackQuery as ReturnType<typeof mock>;
    expect((answer.mock.calls[0]?.[0] as { text: string }).text).toContain('/topic');
  });

  test('tedit opens the topic sub-view with a reset + back keyboard', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup({ active_topic_id: 5 }));

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['tedit', 'active_topic_id']);

    const editText = ctx.editText as ReturnType<typeof mock>;
    expect(editText.mock.calls[0]?.[0] as string).toContain('/topic');
    const kbJson = JSON.stringify(editText.mock.calls[0]?.[1]);
    expect(kbJson).toContain('settings:set:active_topic_id:clear');
    expect(kbJson).toContain('settings:back');
  });

  test('xedit opens the text sub-view with a clear + back keyboard', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup({ custom_prompt: 'note' }));

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['xedit', 'custom_prompt']);

    const editText = ctx.editText as ReturnType<typeof mock>;
    const kbJson = JSON.stringify(editText.mock.calls[0]?.[1]);
    expect(kbJson).toContain('settings:set:custom_prompt:clear');
    expect(kbJson).toContain('settings:back');
  });

  test('set with an unknown setting key answers "Неверные данные"', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup());

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['set', 'spreadsheet_id', 'x']);

    expect(groupsUpdateMock).not.toHaveBeenCalled();
    const answer = ctx.answerCallbackQuery as ReturnType<typeof mock>;
    expect(answer.mock.calls[0]?.[0]).toMatchObject({ text: 'Неверные данные' });
  });

  test('unknown sub-action answers "Неизвестное действие"', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup());

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['garbage']);

    const answer = ctx.answerCallbackQuery as ReturnType<typeof mock>;
    expect(answer.mock.calls[0]?.[0]).toMatchObject({ text: 'Неизвестное действие' });
  });

  test('edit/medit with a wrong-kind key answer "Неверные данные"', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup());

    const editCtx = fakeCallbackCtx();
    await handleSettingsCallback(editCtx, ['edit', 'enabled_currencies']); // not a 'currency' kind
    expect(
      (editCtx.answerCallbackQuery as ReturnType<typeof mock>).mock.calls[0]?.[0],
    ).toMatchObject({ text: 'Неверные данные' });

    const meditCtx = fakeCallbackCtx();
    await handleSettingsCallback(meditCtx, ['medit', 'default_currency']); // not 'currency_multi'
    expect(
      (meditCtx.answerCallbackQuery as ReturnType<typeof mock>).mock.calls[0]?.[0],
    ).toMatchObject({ text: 'Неверные данные' });
  });

  test('reports failure when the update does not persist', async () => {
    groupsFindByTelegramGroupIdMock.mockReturnValue(fakeGroup({ bank_cards_enabled: 0 }));
    groupsUpdateMock.mockReturnValue(null); // write fails

    const ctx = fakeCallbackCtx();
    await handleSettingsCallback(ctx, ['set', 'bank_cards_enabled', 'on']);

    const answer = ctx.answerCallbackQuery as ReturnType<typeof mock>;
    expect((answer.mock.calls[0]?.[0] as { text: string }).text).toContain('Не удалось');
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
