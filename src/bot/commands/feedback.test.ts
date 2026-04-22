// Tests for /feedback command — pending state, submit flow, admin notification, error paths

import { afterEach, beforeEach, describe, expect, it, mock, test } from 'bun:test';
import type { TelegramMessage } from '@gramio/types';
import type { Group } from '../../database/types';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { BotInstance, Ctx } from '../types';

// ── Logger ──────────────────────────────────────────────────────────────

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── Telegram sender ─────────────────────────────────────────────────────

const sendMessageMock = mock(
  (_text: string, _opts?: unknown): Promise<TelegramMessage | null> =>
    Promise.resolve({ message_id: 777 } as TelegramMessage),
);
const sendDirectMock = mock(
  (_chatId: number, _text: string): Promise<TelegramMessage | null> =>
    Promise.resolve({ message_id: 888 } as TelegramMessage),
);

mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  sendDirect: sendDirectMock,
  editMessageText: mock(() => Promise.resolve()),
  deleteMessage: mock(() => Promise.resolve()),
  withChatContext: async <T>(_c: number, _t: number | null, fn: () => Promise<T>) => fn(),
}));

// ── feedback service ────────────────────────────────────────────────────

interface SendFeedbackParams {
  message: string;
  groupId: number;
  chatId: number;
  userName?: string;
}
interface SendFeedbackResult {
  success: boolean;
  error?: string;
}

const sendFeedbackMock = mock(
  async (_p: SendFeedbackParams): Promise<SendFeedbackResult> => ({ success: true }),
);
mock.module('../../services/feedback', () => ({
  sendFeedback: sendFeedbackMock,
}));

// Import AFTER all mocks
const {
  cancelPendingFeedback,
  consumePendingFeedback,
  setPendingFeedback,
  handleFeedbackCommand,
  submitFeedback,
} = await import('./feedback');

// ── Fixtures ────────────────────────────────────────────────────────────

function fakeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1,
    telegram_group_id: -100,
    default_currency: 'EUR',
    enabled_currencies: ['EUR'],
    google_refresh_token: null,
    spreadsheet_id: null,
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'current',
    bank_panel_summary_message_id: null,
    created_at: '',
    updated_at: '',
    title: null,
    invite_link: null,
    ...overrides,
  } as unknown as Group;
}

function fakeCtx(text: string, chatId = -100, userId = 1): Ctx['Command'] {
  return {
    chat: { id: chatId, type: 'supergroup' },
    from: { id: userId, firstName: 'Alex', username: 'alexultra' },
    text,
  } as unknown as Ctx['Command'];
}

function fakeBot(): BotInstance {
  const deleteMessageMock = mock(async () => undefined);
  const bot = {
    api: {
      deleteMessage: deleteMessageMock,
    },
  } as unknown as BotInstance;
  return bot;
}

// ── Pending state tests (existing) ──────────────────────────────────────

afterEach(() => {
  cancelPendingFeedback(100);
  cancelPendingFeedback(200);
});

describe('consumePendingFeedback', () => {
  it('returns null when no pending feedback exists', () => {
    expect(consumePendingFeedback(100, 1)).toBeNull();
  });

  it('returns null when pending feedback is for a different user', () => {
    setPendingFeedback(100, 1, 42);
    expect(consumePendingFeedback(100, 999)).toBeNull();
  });

  it('returns prompt message ID and clears state for the correct user', () => {
    setPendingFeedback(100, 1, 42);
    expect(consumePendingFeedback(100, 1)).toBe(42);
    // Consumed — second call returns null
    expect(consumePendingFeedback(100, 1)).toBeNull();
  });
});

describe('cancelPendingFeedback', () => {
  it('does not throw when no pending feedback exists', () => {
    expect(() => cancelPendingFeedback(100)).not.toThrow();
  });

  it('clears pending state', () => {
    setPendingFeedback(100, 1, 42);
    cancelPendingFeedback(100);
    expect(consumePendingFeedback(100, 1)).toBeNull();
  });

  it('does not leak state across different chats', () => {
    setPendingFeedback(100, 1, 42);
    cancelPendingFeedback(200); // different chat
    // chat 100 still has pending state
    expect(consumePendingFeedback(100, 1)).toBe(42);
  });
});

describe('setPendingFeedback', () => {
  it('overwrites existing pending state for the same chat', () => {
    setPendingFeedback(100, 1, 42);
    setPendingFeedback(100, 2, 99);
    // New state — first user can no longer consume
    expect(consumePendingFeedback(100, 1)).toBeNull();
    // Reset for next test via afterEach
    setPendingFeedback(100, 2, 99);
    expect(consumePendingFeedback(100, 2)).toBe(99);
  });
});

// ── handleFeedbackCommand tests ─────────────────────────────────────────

describe('handleFeedbackCommand — with argument', () => {
  beforeEach(() => {
    sendMessageMock.mockReset().mockResolvedValue({ message_id: 777 } as TelegramMessage);
    sendDirectMock.mockReset().mockResolvedValue({ message_id: 888 } as TelegramMessage);
    sendFeedbackMock.mockReset().mockResolvedValue({ success: true });
    logMock.error.mockReset();
    logMock.warn.mockReset();
  });

  test('submits feedback to service and replies with success', async () => {
    await handleFeedbackCommand(fakeCtx('/feedback отличный бот'), fakeGroup());

    expect(sendFeedbackMock).toHaveBeenCalledTimes(1);
    const params = sendFeedbackMock.mock.calls[0]?.[0] as SendFeedbackParams;
    expect(params.message).toBe('отличный бот');
    expect(params.groupId).toBe(1);

    const sent = sendMessageMock.mock.calls.map((c) => c[0] as string);
    expect(sent.some((t) => t.includes('Фидбек отправлен'))).toBe(true);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('strips "/feedback" prefix correctly', async () => {
    await handleFeedbackCommand(fakeCtx('/feedback баг в боте'), fakeGroup());

    const params = sendFeedbackMock.mock.calls[0]?.[0] as SendFeedbackParams;
    expect(params.message).toBe('баг в боте');
  });

  test('strips "/feedback@BotName" prefix correctly', async () => {
    await handleFeedbackCommand(fakeCtx('/feedback@ExpenseSyncBot проблема'), fakeGroup());

    const params = sendFeedbackMock.mock.calls[0]?.[0] as SendFeedbackParams;
    expect(params.message).toBe('проблема');
  });

  test('passes user name from ctx.from.firstName', async () => {
    await handleFeedbackCommand(fakeCtx('/feedback test'), fakeGroup());

    const params = sendFeedbackMock.mock.calls[0]?.[0] as SendFeedbackParams;
    expect(params.userName).toBe('Alex');
  });

  test('falls back to username when firstName is missing', async () => {
    const ctx = {
      chat: { id: -100, type: 'supergroup' },
      from: { id: 1, username: 'alexultra' },
      text: '/feedback hi',
    } as unknown as Ctx['Command'];

    await handleFeedbackCommand(ctx, fakeGroup());

    const params = sendFeedbackMock.mock.calls[0]?.[0] as SendFeedbackParams;
    expect(params.userName).toBe('alexultra');
  });

  test('shows error message when sendFeedback returns {success: false}', async () => {
    sendFeedbackMock.mockResolvedValue({ success: false, error: 'Фидбек не настроен.' });

    await handleFeedbackCommand(fakeCtx('/feedback test'), fakeGroup());

    const sent = sendMessageMock.mock.calls.map((c) => c[0] as string);
    expect(sent.some((t) => t.includes('Не удалось отправить'))).toBe(true);
    expect(sent.some((t) => t.includes('Фидбек не настроен.'))).toBe(true);
  });
});

describe('handleFeedbackCommand — without argument (prompt flow)', () => {
  beforeEach(() => {
    sendMessageMock.mockReset().mockResolvedValue({ message_id: 777 } as TelegramMessage);
    sendFeedbackMock.mockReset().mockResolvedValue({ success: true });
    cancelPendingFeedback(-100);
    logMock.error.mockReset();
  });

  test('sends a prompt with cancel button and does NOT submit', async () => {
    await handleFeedbackCommand(fakeCtx('/feedback'), fakeGroup());

    expect(sendFeedbackMock).not.toHaveBeenCalled();
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [text, opts] = sendMessageMock.mock.calls[0] as [string, unknown];
    expect(text).toContain('Напиши сообщение');
    // Cancel button present
    expect(JSON.stringify(opts)).toContain('feedback_cancel');
  });

  test('handles "/feedback   " (trailing whitespace) as empty', async () => {
    await handleFeedbackCommand(fakeCtx('/feedback   '), fakeGroup());

    expect(sendFeedbackMock).not.toHaveBeenCalled();
    const text = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(text).toContain('Напиши сообщение');
  });

  test('records pending state with correct prompt message id', async () => {
    sendMessageMock.mockResolvedValue({ message_id: 555 } as TelegramMessage);

    await handleFeedbackCommand(fakeCtx('/feedback'), fakeGroup());

    expect(consumePendingFeedback(-100, 1)).toBe(555);
  });

  test('does not crash when sendMessage returns null (sender failure)', async () => {
    sendMessageMock.mockResolvedValue(null);

    await expect(handleFeedbackCommand(fakeCtx('/feedback'), fakeGroup())).resolves.toBeUndefined();

    // No pending state written when we couldn't get a message_id
    expect(consumePendingFeedback(-100, 1)).toBeNull();
  });
});

describe('submitFeedback', () => {
  beforeEach(() => {
    sendMessageMock.mockReset().mockResolvedValue({ message_id: 777 } as TelegramMessage);
    sendFeedbackMock.mockReset().mockResolvedValue({ success: true });
    logMock.error.mockReset();
  });

  test('calls sendFeedback with correct params', async () => {
    await submitFeedback(fakeCtx('/feedback test'), fakeGroup(), 'my message');

    expect(sendFeedbackMock).toHaveBeenCalledTimes(1);
    const params = sendFeedbackMock.mock.calls[0]?.[0] as SendFeedbackParams;
    expect(params.message).toBe('my message');
    expect(params.chatId).toBe(-100);
    expect(params.groupId).toBe(1);
  });

  test('deletes prompt message after successful submit when opts provided', async () => {
    const bot = fakeBot();
    await submitFeedback(fakeCtx('/feedback x'), fakeGroup(), 'hi', {
      promptMessageId: 42,
      bot,
    });

    expect(bot.api.deleteMessage).toHaveBeenCalledTimes(1);
    const callArg = (bot.api.deleteMessage as ReturnType<typeof mock>).mock.calls[0]?.[0];
    expect(callArg).toMatchObject({ chat_id: -100, message_id: 42 });
  });

  test('deleteMessage failure is swallowed silently', async () => {
    const bot = {
      api: {
        deleteMessage: mock(async () => {
          throw new Error('message not found');
        }),
      },
    } as unknown as BotInstance;

    await expect(
      submitFeedback(fakeCtx('/feedback x'), fakeGroup(), 'hi', {
        promptMessageId: 42,
        bot,
      }),
    ).resolves.toBeUndefined();
  });

  test('no deletion attempted when opts.bot is absent', async () => {
    await submitFeedback(fakeCtx('/feedback'), fakeGroup(), 'hi', { promptMessageId: 42 });
    // Should not throw; we only verify success path runs
    expect(sendFeedbackMock).toHaveBeenCalledTimes(1);
  });

  test('does not delete prompt after failed submit', async () => {
    sendFeedbackMock.mockResolvedValue({ success: false, error: 'down' });
    const bot = fakeBot();

    await submitFeedback(fakeCtx('/feedback'), fakeGroup(), 'hi', {
      promptMessageId: 42,
      bot,
    });

    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
    const sent = sendMessageMock.mock.calls.map((c) => c[0] as string);
    expect(sent.some((t) => t.includes('Не удалось отправить'))).toBe(true);
  });
});
