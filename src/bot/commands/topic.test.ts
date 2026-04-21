// Tests for /topic — restrict bot to a Telegram forum topic; view/set/clear.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import type { Group } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { Ctx } from '../types';

// ── Logger ────────────────────────────────────────────────────────────────

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Database ──────────────────────────────────────────────────────────────

const mockGroups = {
  update: mock((_tgId: number, _data: Partial<Group>): void => {}),
};

mock.module('../../database', () => ({
  database: { groups: mockGroups },
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

// ── bot-error-formatter ───────────────────────────────────────────────────

mock.module('../bot-error-formatter', () => ({
  formatErrorForUser: (e: unknown) => `❌ ${e instanceof Error ? e.message : 'err'}`,
}));

// ── Import after mocks ────────────────────────────────────────────────────

const { handleTopicCommand } = await import('./topic');

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

function fakeCtx(text: string, threadId?: number): Ctx['Command'] {
  return {
    chat: { id: -100, type: 'supergroup' },
    from: { id: 1 },
    text,
    update: { message: { message_thread_id: threadId } },
  } as unknown as Ctx['Command'];
}

beforeEach(() => {
  sendMessageMock.mockReset().mockResolvedValue(null);
  mockGroups.update.mockReset();
  logMock.error.mockReset();
});

describe('/topic — setting restriction', () => {
  test('called inside a topic — sets active_topic_id to that thread', async () => {
    await handleTopicCommand(fakeCtx('/topic', 42), fakeGroup());

    expect(mockGroups.update).toHaveBeenCalledWith(-100, { active_topic_id: 42 });
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('#42');
    expect(msg).toContain('только этот топик');
  });
});

describe('/topic — viewing status (called from general chat)', () => {
  test('no topic set — shows "слушает все сообщения"', async () => {
    await handleTopicCommand(fakeCtx('/topic'), fakeGroup({ active_topic_id: null }));

    expect(mockGroups.update).not.toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('все сообщения');
  });

  test('topic already set — displays current restriction', async () => {
    await handleTopicCommand(fakeCtx('/topic'), fakeGroup({ active_topic_id: 7 }));

    expect(mockGroups.update).not.toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('#7');
  });
});

describe('/topic clear', () => {
  test('clears active_topic_id (case-insensitive)', async () => {
    await handleTopicCommand(fakeCtx('/topic CLEAR', 42), fakeGroup({ active_topic_id: 42 }));

    expect(mockGroups.update).toHaveBeenCalledWith(-100, { active_topic_id: null });
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Ограничение по топику снято');
  });

  test('clear works even when not in a topic', async () => {
    await handleTopicCommand(fakeCtx('/topic clear'), fakeGroup({ active_topic_id: 99 }));

    expect(mockGroups.update).toHaveBeenCalledWith(-100, { active_topic_id: null });
  });
});

describe('/topic — error handling', () => {
  test('DB error surfaces friendly message and logs', async () => {
    mockGroups.update.mockImplementation(() => {
      throw new Error('db locked');
    });

    await handleTopicCommand(fakeCtx('/topic', 42), fakeGroup());

    expect(logMock.error).toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('db locked');
  });
});
