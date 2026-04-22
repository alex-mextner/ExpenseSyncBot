import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Group } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { Ctx } from '../types';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const sendMessageMock = mock(
  (_text: string, _opts?: unknown): Promise<{ message_id: number } | null> =>
    Promise.resolve({ message_id: 1 }),
);

mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  withChatContext: async <T>(_c: number, _t: number | null, fn: () => Promise<T>) => fn(),
}));

const sendPrivateChatRedirectMock = mock(async (_telegramId: number): Promise<void> => {});
mock.module('../handlers/message.handler', () => ({
  sendPrivateChatRedirect: sendPrivateChatRedirectMock,
}));

const mockGroups = {
  findByTelegramGroupId: mock((_id: number): Group | null => null),
  hasCompletedSetup: mock((_id: number): boolean => false),
};
mock.module('../../database', () => ({
  database: { groups: mockGroups },
}));

const { handleStartCommand } = await import('./start');

function fakeCtx(
  overrides: { chatId?: number; fromId?: number; chatType?: string } = {},
): Ctx['Command'] {
  return {
    from: overrides.fromId === undefined ? { id: 42 } : { id: overrides.fromId },
    chat:
      overrides.chatId === undefined
        ? { id: -100, type: overrides.chatType ?? 'supergroup' }
        : { id: overrides.chatId, type: overrides.chatType ?? 'supergroup' },
  } as unknown as Ctx['Command'];
}

function makeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1,
    telegram_group_id: -100,
    default_currency: 'EUR',
    enabled_currencies: ['EUR'],
    google_refresh_token: null,
    spreadsheet_id: null,
    custom_prompt: null,
    active_topic_id: null,
    bank_panel_summary_message_id: null,
    oauth_client: 'current',
    title: null,
    invite_link: null,
    created_at: '',
    updated_at: '',
    ...overrides,
  } as Group;
}

describe('handleStartCommand', () => {
  beforeEach(() => {
    sendMessageMock.mockClear();
    sendPrivateChatRedirectMock.mockClear();
    mockGroups.findByTelegramGroupId.mockReset();
    mockGroups.hasCompletedSetup.mockReset();
    mockGroups.findByTelegramGroupId.mockReturnValue(null);
    mockGroups.hasCompletedSetup.mockReturnValue(false);
    logMock.error.mockReset();
  });

  test('private chat → redirect, no main message', async () => {
    await handleStartCommand(fakeCtx({ chatType: 'private' }));

    expect(sendPrivateChatRedirectMock).toHaveBeenCalledTimes(1);
    expect(sendPrivateChatRedirectMock.mock.calls[0]?.[0]).toBe(42);
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test('group with completed setup + Google → shows ready + /reconnect hint', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(
      makeGroup({ google_refresh_token: 'tok', spreadsheet_id: 'SHEET' }),
    );
    mockGroups.hasCompletedSetup.mockReturnValue(true);

    await handleStartCommand(fakeCtx());

    const text = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(text).toContain('настроен');
    expect(text).toContain('/reconnect');
    expect(text).not.toContain('/connect —');
  });

  test('group with completed setup but NO Google → /connect hint', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockGroups.hasCompletedSetup.mockReturnValue(true);

    await handleStartCommand(fakeCtx());

    const text = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(text).toContain('/connect');
    expect(text).not.toContain('/reconnect');
  });

  test('new group (no setup) → welcome message + feature list', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(null);
    mockGroups.hasCompletedSetup.mockReturnValue(false);

    await handleStartCommand(fakeCtx());

    const text = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(text).toContain('Что умеет бот');
    expect(text).toContain('/connect');
    expect(text).toContain('Формат расходов');
  });

  test('missing telegramId → friendly error, no DB read', async () => {
    await handleStartCommand(fakeCtx({ fromId: 0 }));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const text = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(text).toContain('Не удалось');
    expect(mockGroups.findByTelegramGroupId).not.toHaveBeenCalled();
  });

  test('missing chatId → friendly error, no DB read', async () => {
    await handleStartCommand(fakeCtx({ chatId: 0 }));

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const text = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(text).toContain('Не удалось');
  });

  test('DB throws → error logged + user-facing message via formatErrorForUser', async () => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => {
      throw new Error('DB offline');
    });

    await handleStartCommand(fakeCtx());

    expect(logMock.error).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalled();
  });
});
