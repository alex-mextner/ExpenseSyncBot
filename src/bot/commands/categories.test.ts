// Tests for /categories — list view, empty state, error path

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Category, Group } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { Ctx } from '../types';

// ── Logger (import path MUST match source — categories.ts uses '../../utils/logger.ts') ───

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Database ──────────────────────────────────────────────────────────────

const mockCategories = {
  findByGroupId: mock((_groupId: number): Category[] => []),
};

mock.module('../../database', () => ({
  database: { categories: mockCategories },
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

// ── Import after mocks ────────────────────────────────────────────────────

const { handleCategoriesCommand } = await import('./categories');

// ── Fixtures ──────────────────────────────────────────────────────────────

function fakeCtx(): Ctx['Command'] {
  return { chat: { id: -100, type: 'supergroup' }, from: { id: 1 } } as unknown as Ctx['Command'];
}

function fakeGroup(): Group {
  return {
    id: 1,
    telegram_group_id: -100,
    title: null,
    invite_link: null,
    google_refresh_token: null,
    spreadsheet_id: null,
    default_currency: 'EUR',
    enabled_currencies: ['EUR'],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'current',
    bank_panel_summary_message_id: null,
    created_at: '',
    updated_at: '',
  } as Group;
}

function makeCategory(name: string, id = 1): Category {
  return { id, group_id: 1, name, created_at: '2026-01-01T00:00:00Z' };
}

beforeEach(() => {
  sendMessageMock.mockReset().mockResolvedValue(null);
  mockCategories.findByGroupId.mockReset().mockReturnValue([]);
  logMock.error.mockReset();
  logMock.warn.mockReset();
});

// ── Tests ─────────────────────────────────────────────────────────────────

describe('/categories', () => {
  test('shows empty-state message when no categories exist', async () => {
    mockCategories.findByGroupId.mockReturnValue([]);

    await handleCategoriesCommand(fakeCtx(), fakeGroup());

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Категории пока не созданы');
    expect(msg).toContain('автоматически');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('lists all categories when present', async () => {
    mockCategories.findByGroupId.mockReturnValue([
      makeCategory('Еда', 1),
      makeCategory('Транспорт', 2),
      makeCategory('Развлечения', 3),
    ]);

    await handleCategoriesCommand(fakeCtx(), fakeGroup());

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Категории группы');
    expect(msg).toContain('Еда');
    expect(msg).toContain('Транспорт');
    expect(msg).toContain('Развлечения');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('queries the correct group id', async () => {
    const group = fakeGroup();
    group.id = 42;
    mockCategories.findByGroupId.mockReturnValue([makeCategory('X')]);

    await handleCategoriesCommand(fakeCtx(), group);

    expect(mockCategories.findByGroupId).toHaveBeenCalledWith(42);
  });

  test('single category renders just that one bullet', async () => {
    mockCategories.findByGroupId.mockReturnValue([makeCategory('Solo')]);

    await handleCategoriesCommand(fakeCtx(), fakeGroup());

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('• Solo');
    // Rough check: only one bullet
    const bulletCount = (msg.match(/• /g) ?? []).length;
    expect(bulletCount).toBe(1);
  });

  test('logs and sends friendly error when repository throws', async () => {
    mockCategories.findByGroupId.mockImplementation(() => {
      throw new Error('db locked');
    });

    await handleCategoriesCommand(fakeCtx(), fakeGroup());

    expect(logMock.error).toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    // formatErrorForUser fallback for plain Error
    expect(msg).toContain('непредвиденная');
  });
});
