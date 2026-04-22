// Tests for /connect — group-only guard, onboarding flow, currency selection,
// default currency + spreadsheet creation (with and without Google token).

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import type { Group, User } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { Ctx } from '../types';

// ── Logger (connect.ts imports '../../utils/logger.ts') ───────────────────

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── env — must be importable (connect.ts reads env.MINIAPP_URL) ───────────

mock.module('../../config/env', () => ({
  env: {
    MINIAPP_URL: '',
    MINIAPP_SHORTNAME: '',
    BOT_USERNAME: 'ExpenseSyncBot',
  },
}));

// ── trackMembership stub — avoid loading the full message.handler ─────────

mock.module('../../bot/handlers/message.handler', () => ({
  trackMembership: mock(() => undefined),
}));

// ── Database ──────────────────────────────────────────────────────────────

const mockGroups = {
  findByTelegramGroupId: mock((_id: number): Group | null => null),
  findById: mock((_id: number): Group | null => null),
  create: mock((_data: { telegram_group_id: number }): Group => ({}) as Group),
  update: mock((_tgId: number, _data: Partial<Group>): void => {}),
  hasCompletedSetup: mock((_id: number): boolean => false),
};

const mockUsers = {
  findByTelegramId: mock((_id: number): User | null => null),
  create: mock((_data: { telegram_id: number; group_id: number }): User => ({}) as User),
  update: mock((_id: number, _data: { group_id: number }): void => {}),
};

mock.module('../../database', () => ({
  database: { groups: mockGroups, users: mockUsers },
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

// ── Google OAuth ──────────────────────────────────────────────────────────

const generateAuthUrlMock = mock(
  (gid: number): string => `https://accounts.google.com/o/oauth2/v2/auth?state=${gid}`,
);

mock.module('../../services/google/oauth', () => ({
  generateAuthUrl: generateAuthUrlMock,
}));

// ── Google Sheets ─────────────────────────────────────────────────────────

const createExpenseSpreadsheetMock = mock(
  async (): Promise<{ spreadsheetId: string; spreadsheetUrl: string }> => ({
    spreadsheetId: 'new-sheet-id',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/new-sheet-id',
  }),
);

const googleConnMock = mock(() => ({ refreshToken: 'tok', oauthClient: 'current' as const }));

mock.module('../../services/google/sheets', () => ({
  createExpenseSpreadsheet: createExpenseSpreadsheetMock,
  googleConn: googleConnMock,
}));

// ── Import after mocks ────────────────────────────────────────────────────

const {
  handleConnectCommand,
  handleCurrencyCallback,
  handleDefaultCurrencyCallback,
  handleCustomCurrencyInput,
  isAwaitingCustomCurrency,
  clearAwaitingCustomCurrency,
} = await import('./connect');

// ── Fixtures ──────────────────────────────────────────────────────────────

function fakeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1,
    telegram_group_id: -100,
    title: null,
    invite_link: null,
    google_refresh_token: null,
    spreadsheet_id: null,
    default_currency: 'EUR' as CurrencyCode,
    enabled_currencies: [] as CurrencyCode[],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'current',
    bank_panel_summary_message_id: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  } as Group;
}

function fakeUser(): User {
  return {
    id: 1,
    telegram_id: 1,
    group_id: 1,
    created_at: '',
    updated_at: '',
  };
}

function fakeCommandCtx(
  opts: { chatId?: number; chatType?: string; userId?: number } = {},
): Ctx['Command'] {
  const { chatId = -100, chatType = 'supergroup', userId = 1 } = opts;
  return {
    chat: { id: chatId, type: chatType },
    from: { id: userId },
    bot: { api: { setChatMenuButton: mock(async () => undefined) } },
  } as unknown as Ctx['Command'];
}

function fakeCallbackCtx() {
  return {
    chat: { id: -100, type: 'supergroup' },
    from: { id: 1 },
    answerCallbackQuery: mock(async () => undefined),
    editText: mock(async () => undefined),
    bot: { api: { setChatMenuButton: mock(async () => undefined) } },
  } as unknown as Ctx['CallbackQuery'];
}

function fakeMessageCtx(text: string): Ctx['Message'] {
  return {
    chat: { id: -100, type: 'supergroup' },
    from: { id: 1 },
    text,
  } as unknown as Ctx['Message'];
}

// ── Reset ─────────────────────────────────────────────────────────────────

beforeEach(() => {
  sendMessageMock.mockReset().mockResolvedValue(null);
  mockGroups.findByTelegramGroupId.mockReset().mockReturnValue(null);
  mockGroups.findById.mockReset().mockReturnValue(null);
  mockGroups.create
    .mockReset()
    .mockImplementation((data) => fakeGroup({ telegram_group_id: data.telegram_group_id }));
  mockGroups.update.mockReset();
  mockGroups.hasCompletedSetup.mockReset().mockReturnValue(false);
  mockUsers.findByTelegramId.mockReset().mockReturnValue(null);
  mockUsers.create.mockReset().mockReturnValue(fakeUser());
  mockUsers.update.mockReset();
  generateAuthUrlMock
    .mockReset()
    .mockImplementation((gid: number) => `https://accounts.google.com/?state=${gid}`);
  createExpenseSpreadsheetMock.mockReset().mockResolvedValue({
    spreadsheetId: 'new-sheet-id',
    spreadsheetUrl: 'https://docs.google.com/spreadsheets/d/new-sheet-id',
  });
  logMock.error.mockReset();
  logMock.warn.mockReset();
  // Clear any residual state from previous tests
  clearAwaitingCustomCurrency(-100);
});

// ── handleConnectCommand ──────────────────────────────────────────────────

describe('/connect — group-only guard', () => {
  test('private chat is refused with instructive message', async () => {
    await handleConnectCommand(fakeCommandCtx({ chatId: 42, chatType: 'private' }));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('работает только в группах');
    expect(mockGroups.create).not.toHaveBeenCalled();
    expect(generateAuthUrlMock).not.toHaveBeenCalled();
  });

  test('missing telegramId/chatId replies with error and returns', async () => {
    const ctx = { chat: undefined, from: undefined } as unknown as Ctx['Command'];
    await handleConnectCommand(ctx);
    expect(sendMessageMock).toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Не удалось определить');
  });
});

describe('/connect — onboarding flow', () => {
  test('creates new group + user when neither exists, sends OAuth URL', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(null);
    mockGroups.create.mockImplementation((data) =>
      fakeGroup({ id: 7, telegram_group_id: data.telegram_group_id }),
    );
    mockUsers.findByTelegramId.mockReturnValue(null);

    await handleConnectCommand(fakeCommandCtx());

    expect(mockGroups.create).toHaveBeenCalledWith({ telegram_group_id: -100 });
    expect(mockUsers.create).toHaveBeenCalledWith(
      expect.objectContaining({ telegram_id: 1, group_id: 7 }),
    );
    expect(generateAuthUrlMock).toHaveBeenCalledWith(7);

    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('Настройка бота для группы');
    expect(msg).toContain('Google Sheets');
  });

  test('already-configured group gets "уже подключена" short-circuit', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(
      fakeGroup({ id: 1, google_refresh_token: 'tok', spreadsheet_id: 'sheet-1' }),
    );
    mockUsers.findByTelegramId.mockReturnValue(fakeUser());

    await handleConnectCommand(fakeCommandCtx());

    expect(generateAuthUrlMock).not.toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('уже подключена');
    expect(msg).toContain('/reconnect');
  });

  test('group that completed setup but has no Google token — offers OAuth button only', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(
      fakeGroup({ id: 1, google_refresh_token: null }),
    );
    mockGroups.hasCompletedSetup.mockReturnValue(true);
    mockUsers.findByTelegramId.mockReturnValue(fakeUser());

    await handleConnectCommand(fakeCommandCtx());

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('разреши доступ к Google Sheets');
    expect(generateAuthUrlMock).toHaveBeenCalledWith(1);
  });

  test('migrates user to current group when group_id mismatches', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(fakeGroup({ id: 7 }));
    mockUsers.findByTelegramId.mockReturnValue({
      id: 1,
      telegram_id: 1,
      group_id: 999,
      created_at: '',
      updated_at: '',
    });

    await handleConnectCommand(fakeCommandCtx());

    expect(mockUsers.update).toHaveBeenCalledWith(1, { group_id: 7 });
  });
});

// ── handleCurrencyCallback ────────────────────────────────────────────────

describe('/connect currency toggle', () => {
  test('adds currency on first click, updates group', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(
      fakeGroup({ enabled_currencies: [] as CurrencyCode[] }),
    );
    const ctx = fakeCallbackCtx();

    await handleCurrencyCallback(ctx, 'EUR', -100);

    expect(mockGroups.update).toHaveBeenCalledWith(-100, { enabled_currencies: ['EUR'] });
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('EUR') }),
    );
  });

  test('removes currency when already selected', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(
      fakeGroup({ enabled_currencies: ['EUR', 'USD'] as CurrencyCode[] }),
    );
    const ctx = fakeCallbackCtx();

    await handleCurrencyCallback(ctx, 'USD', -100);

    expect(mockGroups.update).toHaveBeenCalledWith(-100, { enabled_currencies: ['EUR'] });
  });

  test('"next" with empty selection is rejected', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(
      fakeGroup({ enabled_currencies: [] as CurrencyCode[] }),
    );
    const ctx = fakeCallbackCtx();

    await handleCurrencyCallback(ctx, 'next', -100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('хотя бы одну') }),
    );
    expect(ctx.editText).not.toHaveBeenCalled();
  });

  test('"next" with selected currencies advances to step 2 (default currency)', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(
      fakeGroup({ enabled_currencies: ['EUR', 'USD'] as CurrencyCode[] }),
    );
    const ctx = fakeCallbackCtx();

    await handleCurrencyCallback(ctx, 'next', -100);

    expect(ctx.editText).toHaveBeenCalled();
    const editedText = (ctx.editText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    expect(editedText).toContain('Шаг 2/2');
    expect(editedText).toContain('EUR, USD');
  });

  test('"custom" flag set — bot awaits typed currency code', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(fakeGroup());
    const ctx = fakeCallbackCtx();

    await handleCurrencyCallback(ctx, 'custom', -100);

    expect(isAwaitingCustomCurrency(-100)).toBe(true);
    expect(sendMessageMock).toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('код валюты');
  });

  test('group not found returns rejection', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(null);
    const ctx = fakeCallbackCtx();

    await handleCurrencyCallback(ctx, 'EUR', -100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Группа не найдена' });
    expect(mockGroups.update).not.toHaveBeenCalled();
  });

  test('editText "message is not modified" 400 is swallowed', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(
      fakeGroup({ enabled_currencies: [] as CurrencyCode[] }),
    );
    const ctx = fakeCallbackCtx();
    (ctx.editText as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new Error('Bad Request: message is not modified');
    });

    // No throw — the callback must complete normally so the user sees the toast.
    await handleCurrencyCallback(ctx, 'EUR', -100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('EUR') }),
    );
  });

  test('editText other errors propagate (not swallowed)', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(
      fakeGroup({ enabled_currencies: [] as CurrencyCode[] }),
    );
    const ctx = fakeCallbackCtx();
    (ctx.editText as ReturnType<typeof mock>).mockImplementationOnce(async () => {
      throw new Error('Bad Request: chat not found');
    });

    await expect(handleCurrencyCallback(ctx, 'EUR', -100)).rejects.toThrow(/chat not found/);
  });
});

// ── handleDefaultCurrencyCallback ─────────────────────────────────────────

describe('/connect default currency callback', () => {
  test('no Google — completes setup without calling createSpreadsheet', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(
      fakeGroup({
        google_refresh_token: null,
        enabled_currencies: ['EUR'] as CurrencyCode[],
      }),
    );
    const ctx = fakeCallbackCtx();

    await handleDefaultCurrencyCallback(ctx, 'EUR', -100);

    expect(mockGroups.update).toHaveBeenCalledWith(-100, { default_currency: 'EUR' });
    expect(createExpenseSpreadsheetMock).not.toHaveBeenCalled();
    const editedText = (ctx.editText as ReturnType<typeof mock>).mock.calls[0]?.[0] as string;
    expect(editedText).toContain('Настройка завершена');
    expect(editedText).toContain('EUR');
  });

  test('with Google — creates spreadsheet and reports URL', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(
      fakeGroup({
        google_refresh_token: 'tok',
        enabled_currencies: ['EUR'] as CurrencyCode[],
      }),
    );
    const ctx = fakeCallbackCtx();

    await handleDefaultCurrencyCallback(ctx, 'EUR', -100);

    expect(createExpenseSpreadsheetMock).toHaveBeenCalledTimes(1);
    // Second editText call — after creation
    const calls = (ctx.editText as ReturnType<typeof mock>).mock.calls;
    const finalText = calls.at(-1)?.[0] as string;
    expect(finalText).toContain('new-sheet-id');
    expect(mockGroups.update).toHaveBeenCalledWith(-100, { spreadsheet_id: 'new-sheet-id' });
  });

  test('logs and shows error if createSpreadsheet throws', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(
      fakeGroup({
        google_refresh_token: 'tok',
        enabled_currencies: ['EUR'] as CurrencyCode[],
      }),
    );
    createExpenseSpreadsheetMock.mockRejectedValue(new Error('quota exceeded'));
    const ctx = fakeCallbackCtx();

    await handleDefaultCurrencyCallback(ctx, 'EUR', -100);

    expect(logMock.error).toHaveBeenCalled();
    const calls = (ctx.editText as ReturnType<typeof mock>).mock.calls;
    const finalText = calls.at(-1)?.[0] as string;
    expect(finalText).toContain('Ошибка при создании таблицы');
  });

  test('rejects currency not in enabled set', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(
      fakeGroup({ enabled_currencies: ['EUR'] as CurrencyCode[] }),
    );
    const ctx = fakeCallbackCtx();

    await handleDefaultCurrencyCallback(ctx, 'USD', -100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('не в наборе') }),
    );
    expect(mockGroups.update).not.toHaveBeenCalled();
  });
});

// ── handleCustomCurrencyInput ─────────────────────────────────────────────

describe('/connect custom currency input', () => {
  test('returns false when not awaiting input', async () => {
    clearAwaitingCustomCurrency(-100);

    const handled = await handleCustomCurrencyInput(fakeMessageCtx('USD'), -100);

    expect(handled).toBe(false);
    expect(mockGroups.update).not.toHaveBeenCalled();
  });

  test('rejects non-ISO input with friendly keyboard message', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(fakeGroup());
    // Prime the awaiting flag via 'custom' callback
    await handleCurrencyCallback(fakeCallbackCtx(), 'custom', -100);
    sendMessageMock.mockClear();

    const handled = await handleCustomCurrencyInput(fakeMessageCtx('хрень'), -100);

    expect(handled).toBe(true);
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('не похоже на код валюты');
    expect(mockGroups.update).not.toHaveBeenCalled();
  });

  test('accepts valid ISO code and adds to enabled list', async () => {
    // findByTelegramGroupId is called:
    //   1) inside handleCurrencyCallback('custom', ...) — empty list
    //   2) at the top of handleCustomCurrencyInput — still empty
    //   3) after db.update, to re-render keyboard — now with TRY
    mockGroups.findByTelegramGroupId
      .mockReturnValueOnce(fakeGroup({ enabled_currencies: [] as CurrencyCode[] }))
      .mockReturnValueOnce(fakeGroup({ enabled_currencies: [] as CurrencyCode[] }))
      .mockReturnValue(fakeGroup({ enabled_currencies: ['TRY' as CurrencyCode] }));

    await handleCurrencyCallback(fakeCallbackCtx(), 'custom', -100);
    sendMessageMock.mockClear();

    const handled = await handleCustomCurrencyInput(fakeMessageCtx('try'), -100);

    expect(handled).toBe(true);
    expect(mockGroups.update).toHaveBeenCalledWith(-100, { enabled_currencies: ['TRY'] });
  });
});
