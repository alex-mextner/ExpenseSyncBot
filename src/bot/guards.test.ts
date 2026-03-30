// Tests for command guards — requireGroup wrapper
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Group } from '../database/types';
import { requireGroup } from './guards';

// Mock database
const mockFindByTelegramGroupId = mock((): Group | null => null);
mock.module('../database', () => ({
  database: {
    groups: {
      findByTelegramGroupId: mockFindByTelegramGroupId,
    },
  },
}));

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
    bank_panel_summary_message_id: null,
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
  };
}

function createMockCtx(overrides: { chatId?: number; chatType?: string } = {}) {
  const sent: string[] = [];
  return {
    ctx: {
      chat:
        overrides.chatId !== undefined
          ? { id: overrides.chatId, type: overrides.chatType ?? 'group' }
          : undefined,
      send: mock((msg: string) => {
        sent.push(msg);
        return Promise.resolve();
      }),
    },
    sent,
  };
}

describe('requireGroup', () => {
  beforeEach(() => {
    mockFindByTelegramGroupId.mockReset();
  });

  test('rejects private chats', async () => {
    const handler = mock(() => Promise.resolve());
    const wrapped = requireGroup(handler);
    const { ctx, sent } = createMockCtx({ chatId: 123, chatType: 'private' });

    await wrapped(ctx as never);

    expect(handler).not.toHaveBeenCalled();
    expect(sent).toEqual(['❌ Эта команда работает только в группах.']);
  });

  test('rejects when chat is undefined', async () => {
    const handler = mock(() => Promise.resolve());
    const wrapped = requireGroup(handler);
    const { ctx, sent } = createMockCtx({});

    await wrapped(ctx as never);

    expect(handler).not.toHaveBeenCalled();
    expect(sent).toEqual(['❌ Эта команда работает только в группах.']);
  });

  test('rejects unconfigured group', async () => {
    const handler = mock(() => Promise.resolve());
    const wrapped = requireGroup(handler);
    mockFindByTelegramGroupId.mockReturnValue(null);
    const { ctx, sent } = createMockCtx({ chatId: 123, chatType: 'group' });

    await wrapped(ctx as never);

    expect(handler).not.toHaveBeenCalled();
    expect(sent).toEqual(['❌ Группа не настроена. Используй /connect']);
  });

  test('calls handler with group for configured group chat', async () => {
    const fakeGroup = makeGroup(1, 123);
    const handler = mock(() => Promise.resolve());
    const wrapped = requireGroup(handler);
    mockFindByTelegramGroupId.mockReturnValue(fakeGroup);
    const { ctx, sent } = createMockCtx({ chatId: 123, chatType: 'group' });

    await wrapped(ctx as never);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(ctx, fakeGroup);
    expect(sent).toEqual([]);
  });

  test('works with supergroup chat type', async () => {
    const fakeGroup = makeGroup(2, 456);
    const handler = mock(() => Promise.resolve());
    const wrapped = requireGroup(handler);
    mockFindByTelegramGroupId.mockReturnValue(fakeGroup);
    const { ctx, sent } = createMockCtx({ chatId: 456, chatType: 'supergroup' });

    await wrapped(ctx as never);

    expect(handler).toHaveBeenCalledTimes(1);
    expect(handler).toHaveBeenCalledWith(ctx, fakeGroup);
    expect(sent).toEqual([]);
  });
});
