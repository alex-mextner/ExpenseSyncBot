// Tests for /prompt — view / set / clear custom AI system prompt for a group.

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

const { handlePromptCommand } = await import('./prompt');

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

function fakeCtx(text: string, chatId = -100): Ctx['Command'] {
  return {
    chat: { id: chatId, type: 'supergroup' },
    from: { id: 1 },
    text,
  } as unknown as Ctx['Command'];
}

beforeEach(() => {
  sendMessageMock.mockReset().mockResolvedValue(null);
  mockGroups.update.mockReset();
  logMock.error.mockReset();
});

describe('/prompt — view current', () => {
  test('no custom prompt — prints hint', async () => {
    await handlePromptCommand(fakeCtx('/prompt'), fakeGroup({ custom_prompt: null }));

    expect(mockGroups.update).not.toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('не установлен');
    expect(msg).toContain('/prompt');
  });

  test('has custom prompt — displays it and clear hint', async () => {
    await handlePromptCommand(fakeCtx('/prompt'), fakeGroup({ custom_prompt: 'отвечай коротко' }));

    expect(mockGroups.update).not.toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('отвечай коротко');
    expect(msg).toContain('/prompt clear');
  });
});

describe('/prompt — set', () => {
  test('sets new prompt from command arguments', async () => {
    await handlePromptCommand(
      fakeCtx('/prompt будь вежлив и краток'),
      fakeGroup({ custom_prompt: null }),
    );

    expect(mockGroups.update).toHaveBeenCalledWith(-100, {
      custom_prompt: 'будь вежлив и краток',
    });
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('установлен');
    expect(msg).toContain('будь вежлив и краток');
  });

  test('preserves multi-word prompt with internal whitespace', async () => {
    await handlePromptCommand(
      fakeCtx('/prompt   отвечай    как  пират  '),
      fakeGroup({ custom_prompt: null }),
    );

    // split(/\s+/).slice(1).join(' ') collapses whitespace — that's the expected behavior
    const call = mockGroups.update.mock.calls[0];
    expect(call?.[1]).toEqual({ custom_prompt: 'отвечай как пират' });
  });
});

describe('/prompt clear', () => {
  test('clear removes custom prompt (case-insensitive)', async () => {
    await handlePromptCommand(fakeCtx('/prompt CLEAR'), fakeGroup({ custom_prompt: 'stale' }));

    expect(mockGroups.update).toHaveBeenCalledWith(-100, { custom_prompt: null });
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('очищен');
  });
});

describe('/prompt — error handling', () => {
  test('DB error surfaces as user-facing message, logged', async () => {
    mockGroups.update.mockImplementation(() => {
      throw new Error('db locked');
    });

    await handlePromptCommand(fakeCtx('/prompt новый промпт'), fakeGroup());

    expect(logMock.error).toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls.at(-1)?.[0] as string;
    expect(msg).toContain('db locked');
  });
});
