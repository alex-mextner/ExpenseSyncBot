// Tests for private chat redirect — group buttons, instructions for new users

import { describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const sendMessageMock = mock();
const exportInviteLinkMock = mock((): Promise<string | null> => Promise.resolve(null));
mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  exportInviteLink: exportInviteLinkMock,
  withChatContext: mock(),
  initSender: mock(),
  editMessageText: mock(),
  deleteMessage: mock(),
  sendDirect: mock(),
  sendDocumentDirect: mock(),
}));

const findGroupsByTelegramIdMock = mock();
const updateGroupMock = mock();
mock.module('../../database', () => {
  const actual = require('../../database/types');
  return {
    ...actual,
    database: {
      groupMembers: {
        findGroupsByTelegramId: findGroupsByTelegramIdMock,
      },
      groups: {
        update: updateGroupMock,
      },
    },
    _budgetWriter: mock(),
  };
});

mock.module('../../config/env', () => ({
  env: { BOT_USERNAME: 'ExpenseSyncBot' },
}));

const { sendPrivateChatRedirect } = await import('./message.handler');

type ButtonRow = Array<{ text: string; url: string }>;
type SendCall = [string, { reply_markup: { inline_keyboard: ButtonRow[] } }];

describe('sendPrivateChatRedirect', () => {
  test('uses stored invite link when available', async () => {
    findGroupsByTelegramIdMock.mockReturnValue([
      {
        groupId: 1,
        telegramGroupId: -1001234567890,
        title: 'Семья',
        inviteLink: 'https://t.me/+abc123',
      },
    ]);
    sendMessageMock.mockReset();
    exportInviteLinkMock.mockReset();

    await sendPrivateChatRedirect(111);

    const [, opts] = sendMessageMock.mock.calls[0] as SendCall;
    expect(opts.reply_markup.inline_keyboard[0]?.[0]?.url).toBe('https://t.me/+abc123');
    // Should NOT call exportInviteLink when invite_link is already cached
    expect(exportInviteLinkMock).not.toHaveBeenCalled();
  });

  test('fetches and caches invite link when not stored', async () => {
    findGroupsByTelegramIdMock.mockReturnValue([
      { groupId: 1, telegramGroupId: -1001234567890, title: 'Семья', inviteLink: null },
    ]);
    exportInviteLinkMock.mockReset();
    exportInviteLinkMock.mockResolvedValue('https://t.me/+fetched456');
    updateGroupMock.mockReset();
    sendMessageMock.mockReset();

    await sendPrivateChatRedirect(222);

    expect(exportInviteLinkMock).toHaveBeenCalledWith(-1001234567890);
    expect(updateGroupMock).toHaveBeenCalledWith(-1001234567890, {
      invite_link: 'https://t.me/+fetched456',
    });

    const [, opts] = sendMessageMock.mock.calls[0] as SendCall;
    expect(opts.reply_markup.inline_keyboard[0]?.[0]?.url).toBe('https://t.me/+fetched456');
  });

  test('falls back to t.me/c/ deep link when invite link unavailable', async () => {
    findGroupsByTelegramIdMock.mockReturnValue([
      { groupId: 1, telegramGroupId: -1001234567890, title: 'Семья', inviteLink: null },
    ]);
    exportInviteLinkMock.mockReset();
    exportInviteLinkMock.mockResolvedValue(null);
    sendMessageMock.mockReset();

    await sendPrivateChatRedirect(333);

    const [, opts] = sendMessageMock.mock.calls[0] as SendCall;
    expect(opts.reply_markup.inline_keyboard[0]?.[0]?.url).toBe('https://t.me/c/1234567890');
  });

  test('shows buttons for multiple groups', async () => {
    findGroupsByTelegramIdMock.mockReturnValue([
      {
        groupId: 1,
        telegramGroupId: -1001234567890,
        title: 'Семья',
        inviteLink: 'https://t.me/+aaa',
      },
      {
        groupId: 2,
        telegramGroupId: -1009876543210,
        title: 'Работа',
        inviteLink: 'https://t.me/+bbb',
      },
    ]);
    sendMessageMock.mockReset();

    await sendPrivateChatRedirect(444);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [text, opts] = sendMessageMock.mock.calls[0] as SendCall;
    expect(text).toContain('перейди в группу');
    expect(opts.reply_markup.inline_keyboard).toHaveLength(2);
    expect(opts.reply_markup.inline_keyboard[0]?.[0]?.text).toBe('Семья');
    expect(opts.reply_markup.inline_keyboard[1]?.[0]?.text).toBe('Работа');
  });

  test('uses "Группа" fallback when group has no title', async () => {
    findGroupsByTelegramIdMock.mockReturnValue([
      { groupId: 1, telegramGroupId: -1001111111111, title: null, inviteLink: 'https://t.me/+x' },
    ]);
    sendMessageMock.mockReset();

    await sendPrivateChatRedirect(555);

    const [, opts] = sendMessageMock.mock.calls[0] as SendCall;
    expect(opts.reply_markup.inline_keyboard[0]?.[0]?.text).toBe('Группа');
  });

  test('sends instructions when user has no groups', async () => {
    findGroupsByTelegramIdMock.mockReturnValue([]);
    sendMessageMock.mockReset();

    await sendPrivateChatRedirect(666);

    expect(sendMessageMock).toHaveBeenCalledTimes(2);

    const [firstMsg] = sendMessageMock.mock.calls[0] as [string];
    expect(firstMsg).toContain('Бот работает только в группах');

    const [secondMsg] = sendMessageMock.mock.calls[1] as [string];
    expect(secondMsg).toContain('Создай группу');
    expect(secondMsg).toContain('@ExpenseSyncBot');
    expect(secondMsg).toContain('/connect');
  });

  test('no unexpected errors logged', async () => {
    findGroupsByTelegramIdMock.mockReturnValue([]);
    sendMessageMock.mockReset();

    await sendPrivateChatRedirect(777);

    expect(logMock.error).not.toHaveBeenCalled();
  });
});
