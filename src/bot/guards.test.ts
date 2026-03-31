// Tests for command guards — requireGroup and requireGoogle wrappers
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import { database } from '../database';
import type { Group } from '../database/types';

// Mock sendMessage before importing guards (which use it)
const sent: string[] = [];
const mockSendMessage = mock((text: string) => {
  sent.push(text);
  return Promise.resolve({ message_id: 1 });
});

mock.module('../services/bank/telegram-sender', () => ({
  sendMessage: mockSendMessage,
  sendDirect: mock(() => Promise.resolve(null)),
  editMessageText: mock(() => Promise.resolve()),
  deleteMessage: mock(() => Promise.resolve()),
  withChatContext: mock((_c: number, _t: number | null, fn: () => unknown) => fn()),
  initSender: () => {},
}));

import { requireGoogle, requireGroup } from './guards';

let findSpy: ReturnType<typeof spyOn<typeof database.groups, 'findByTelegramGroupId'>>;

function makeGroup(id: number, telegramGroupId: number): Group {
  return {
    id,
    telegram_group_id: telegramGroupId,
    google_refresh_token: null,
    spreadsheet_id: null,
    default_currency: 'EUR',
    enabled_currencies: ['EUR'],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'legacy' as const,
    bank_panel_summary_message_id: null,
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  };
}

function createMockCtx(overrides: { chatId?: number; chatType?: string } = {}) {
  return {
    ctx: {
      chat:
        overrides.chatId !== undefined
          ? { id: overrides.chatId, type: overrides.chatType ?? 'group' }
          : undefined,
    },
  };
}

describe('requireGroup', () => {
  beforeEach(() => {
    sent.length = 0;
    mockSendMessage.mockClear();
    findSpy = spyOn(database.groups, 'findByTelegramGroupId').mockReturnValue(null);
  });

  afterEach(() => {
    mock.restore();
  });

  test('rejects private chats', async () => {
    const handler = mock(() => Promise.resolve());
    const wrapped = requireGroup(handler);
    const { ctx } = createMockCtx({ chatId: 123, chatType: 'private' });

    await wrapped(ctx as never);

    expect(handler).not.toHaveBeenCalled();
    expect(sent).toEqual(['❌ Эта команда работает только в группах.']);
  });

  test('rejects when chat is undefined', async () => {
    const handler = mock(() => Promise.resolve());
    const wrapped = requireGroup(handler);
    const { ctx } = createMockCtx({});

    await wrapped(ctx as never);

    expect(handler).not.toHaveBeenCalled();
    expect(sent).toEqual(['❌ Эта команда работает только в группах.']);
  });

  test('rejects unconfigured group', async () => {
    const handler = mock(() => Promise.resolve());
    const wrapped = requireGroup(handler);
    const { ctx } = createMockCtx({ chatId: 123, chatType: 'group' });

    await wrapped(ctx as never);

    expect(handler).not.toHaveBeenCalled();
    expect(sent).toEqual(['❌ Группа не настроена. Используй /connect']);
  });

  test('calls handler with group for configured group chat', async () => {
    const fakeGroup = makeGroup(1, 123);
    const handler = mock(() => Promise.resolve());
    const wrapped = requireGroup(handler);
    findSpy.mockReturnValue(fakeGroup);
    const { ctx } = createMockCtx({ chatId: 123, chatType: 'group' });

    await wrapped(ctx as never);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(ctx, fakeGroup);
    expect(sent).toEqual([]);
  });

  test('works with supergroup chat type', async () => {
    const fakeGroup = makeGroup(2, 456);
    const handler = mock(() => Promise.resolve());
    const wrapped = requireGroup(handler);
    findSpy.mockReturnValue(fakeGroup);
    const { ctx } = createMockCtx({ chatId: 456, chatType: 'supergroup' });

    await wrapped(ctx as never);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(ctx, fakeGroup);
    expect(sent).toEqual([]);
  });
});

describe('requireGoogle', () => {
  beforeEach(() => {
    sent.length = 0;
    mockSendMessage.mockClear();
  });

  afterEach(() => {
    mock.restore();
  });

  test('rejects group without Google token', async () => {
    const group = makeGroup(1, 123);
    const handler = mock(() => Promise.resolve());
    const guarded = requireGoogle(handler);
    const { ctx } = createMockCtx({ chatId: 123, chatType: 'group' });

    await guarded(ctx as never, group);

    expect(handler).not.toHaveBeenCalled();
    expect(sent).toEqual(['❌ Google таблица не подключена. Используй /connect']);
  });

  test('rejects group with token but no spreadsheet', async () => {
    const group = { ...makeGroup(1, 123), google_refresh_token: 'tok' };
    const handler = mock(() => Promise.resolve());
    const guarded = requireGoogle(handler);
    const { ctx } = createMockCtx({ chatId: 123, chatType: 'group' });

    await guarded(ctx as never, group);

    expect(handler).not.toHaveBeenCalled();
    expect(sent).toEqual(['❌ Google таблица не подключена. Используй /connect']);
  });

  test('calls handler when Google is fully connected', async () => {
    const group = {
      ...makeGroup(1, 123),
      google_refresh_token: 'tok',
      spreadsheet_id: 'sheet123',
    };
    const handler = mock(() => Promise.resolve());
    const guarded = requireGoogle(handler);
    const { ctx } = createMockCtx({ chatId: 123, chatType: 'group' });

    await guarded(ctx as never, group);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(ctx, group);
    expect(sent).toEqual([]);
  });
});
