// Tests for /disconnect command handlers — confirmation prompt, confirm, cancel.
// The existing disconnect.test.ts covers DB-level cascading; this file
// covers handler-level behaviour with mocked dependencies.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import type { Group } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { BotInstance, Ctx } from '../types';

// ── Logger ────────────────────────────────────────────────────────────────

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Database ──────────────────────────────────────────────────────────────

const mockGroups = {
  findByTelegramGroupId: mock((_id: number): Group | null => null),
  delete: mock((_id: number): boolean => true),
};

const mockGroupSpreadsheets = {
  deleteByGroupId: mock((_gid: number): void => {}),
};

// Runs the callback synchronously, simulating a SQLite transaction.
const transactionMock = mock(<T>(fn: () => T): T => fn());

mock.module('../../database', () => ({
  database: {
    groups: mockGroups,
    groupSpreadsheets: mockGroupSpreadsheets,
    transaction: transactionMock,
  },
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

// ── Keyboards ─────────────────────────────────────────────────────────────

mock.module('../keyboards', () => ({
  createConfirmKeyboard: (action: string) => ({ __kind: 'confirm', action }),
}));

// ── Import after mocks ────────────────────────────────────────────────────

const { handleDisconnectCommand, handleDisconnectConfirm, handleDisconnectCancel } = await import(
  './disconnect'
);

// ── Fixtures ──────────────────────────────────────────────────────────────

function fakeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1,
    telegram_group_id: -100,
    title: 'Test Group',
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
    ...overrides,
  } as Group;
}

function fakeCommandCtx(chatTitle: string | undefined = 'Test Group'): Ctx['Command'] {
  return {
    chat: { id: -100, type: 'supergroup', title: chatTitle },
    from: { id: 1 },
  } as unknown as Ctx['Command'];
}

function fakeCallbackCtx() {
  return {
    message: { chat: { id: -100 }, id: 555 },
    answerCallbackQuery: mock(async () => undefined),
  } as unknown as Ctx['CallbackQuery'];
}

function fakeBot() {
  return {
    api: {
      editMessageText: mock(async () => undefined),
      deleteMessage: mock(async () => undefined),
    },
  } as unknown as BotInstance;
}

beforeEach(() => {
  sendMessageMock.mockReset().mockResolvedValue(null);
  mockGroups.findByTelegramGroupId.mockReset().mockReturnValue(null);
  mockGroups.delete.mockReset().mockReturnValue(true);
  mockGroupSpreadsheets.deleteByGroupId.mockReset();
  transactionMock.mockReset().mockImplementation(<T>(fn: () => T): T => fn());
  logMock.error.mockReset();
  logMock.info.mockReset();
});

describe('/disconnect — confirmation prompt', () => {
  test('shows warning with group title and confirm keyboard', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(fakeGroup());

    await handleDisconnectCommand(fakeCommandCtx('Test Group'));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [text, opts] = sendMessageMock.mock.calls[0] ?? [];
    expect(text).toContain('Отключение бота');
    expect(text).toContain('Test Group');
    expect(text).toContain('не будет удалена');
    expect((opts as { reply_markup?: unknown })?.reply_markup).toEqual({
      __kind: 'confirm',
      action: 'disconnect',
    });
  });

  test('no group row — still shows prompt but without title suffix', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(null);

    await handleDisconnectCommand(fakeCommandCtx('Some Chat'));

    const [text] = sendMessageMock.mock.calls[0] ?? [];
    expect(text).toContain('Отключение бота');
    expect(text).not.toContain('из группы «<b>Some Chat</b>»');
  });
});

describe('/disconnect — confirm callback', () => {
  test('happy path — deletes spreadsheets + group, edits message, answers callback', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(fakeGroup({ id: 7 }));
    const ctx = fakeCallbackCtx();
    const bot = fakeBot();

    await handleDisconnectConfirm(ctx, bot);

    expect(mockGroupSpreadsheets.deleteByGroupId).toHaveBeenCalledWith(7);
    expect(mockGroups.delete).toHaveBeenCalledWith(-100);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: '✅ Все данные удалены' });
    expect(bot.api.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({
        chat_id: -100,
        message_id: 555,
        parse_mode: 'HTML',
      }),
    );
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('no group found — tells user already disconnected, skips writes', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(null);
    const ctx = fakeCallbackCtx();
    const bot = fakeBot();

    await handleDisconnectConfirm(ctx, bot);

    expect(mockGroups.delete).not.toHaveBeenCalled();
    expect(mockGroupSpreadsheets.deleteByGroupId).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Группа уже отключена' });
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
  });

  test('missing chat id — answers with error, no delete', async () => {
    const ctx = {
      message: { chat: {}, id: 555 },
      answerCallbackQuery: mock(async () => undefined),
    } as unknown as Ctx['CallbackQuery'];
    const bot = fakeBot();

    await handleDisconnectConfirm(ctx, bot);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: 'Ошибка: чат не найден' });
    expect(mockGroups.delete).not.toHaveBeenCalled();
  });

  test('DB throw → logs error, answers with failure text, does not edit message', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(fakeGroup({ id: 7 }));
    transactionMock.mockImplementation(() => {
      throw new Error('disk full');
    });
    const ctx = fakeCallbackCtx();
    const bot = fakeBot();

    await handleDisconnectConfirm(ctx, bot);

    expect(logMock.error).toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: '❌ Ошибка при удалении данных' });
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
  });
});

describe('/disconnect — cancel callback', () => {
  test('deletes the prompt message and answers', async () => {
    const ctx = fakeCallbackCtx();
    const bot = fakeBot();

    await handleDisconnectCancel(ctx, bot);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: '❌ Отменено' });
    expect(bot.api.deleteMessage).toHaveBeenCalledWith({ chat_id: -100, message_id: 555 });
  });

  test('missing messageId — still answers but skips deleteMessage', async () => {
    const ctx = {
      message: { chat: { id: -100 }, id: undefined },
      answerCallbackQuery: mock(async () => undefined),
    } as unknown as Ctx['CallbackQuery'];
    const bot = fakeBot();

    await handleDisconnectCancel(ctx, bot);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith({ text: '❌ Отменено' });
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
  });
});
