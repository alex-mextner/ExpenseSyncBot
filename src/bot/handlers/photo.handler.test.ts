// Tests for handlePhotoMessage — queues incoming photos for receipt OCR worker.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import type { CreatePhotoQueueData, Group, PhotoQueueItem, User } from '../../database/types';
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
  findByTelegramGroupId: mock((_id: number): Group | null => null),
};

const mockUsers = {
  findByTelegramId: mock((_id: number): User | null => null),
  create: mock(
    (data: { telegram_id: number; group_id: number }): User =>
      ({
        id: 99,
        telegram_id: data.telegram_id,
        group_id: data.group_id,
        created_at: '',
        updated_at: '',
      }) as User,
  ),
};

const mockPhotoQueue = {
  create: mock(
    (data: CreatePhotoQueueData): PhotoQueueItem =>
      ({
        id: 1,
        group_id: data.group_id,
        user_id: data.user_id,
        message_id: data.message_id,
        message_thread_id: data.message_thread_id ?? null,
        file_id: data.file_id,
        status: data.status,
        error_message: null,
        created_at: '',
        summary_mode: 0,
        ai_summary: null,
        correction_history: null,
        waiting_for_bulk_correction: 0,
        summary_message_id: null,
      }) as PhotoQueueItem,
  ),
};

mock.module('../../database', () => ({
  database: {
    groups: mockGroups,
    users: mockUsers,
    photoQueue: mockPhotoQueue,
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

// ── trackMembership (avoid loading full message.handler) ──────────────────

const trackMembershipMock = mock((_t: number, _g: number) => undefined);
mock.module('./message.handler', () => ({
  trackMembership: trackMembershipMock,
}));

// ── Import after mocks ────────────────────────────────────────────────────

const { handlePhotoMessage } = await import('./photo.handler');

// ── Fixtures ──────────────────────────────────────────────────────────────

function fakeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1,
    telegram_group_id: -100,
    title: null,
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

function fakeUser(): User {
  return { id: 42, telegram_id: 7, group_id: 1, created_at: '', updated_at: '' } as User;
}

interface FakePhoto {
  fileId: string;
  width: number;
  height: number;
  fileSize: number;
}

function fakeCtx(opts: {
  telegramId?: number;
  messageId?: number;
  photos?: FakePhoto[] | null;
  chatId?: number;
  chatType?: 'private' | 'group' | 'supergroup';
  threadId?: number | undefined;
}): Ctx['Message'] {
  const {
    telegramId = 7,
    messageId = 500,
    chatId = -100,
    chatType = 'supergroup',
    threadId,
  } = opts;
  // Distinguish "unset" (default) from "explicit null" (missing payload)
  const photoField =
    'photos' in opts ? opts.photos : [{ fileId: 'small', width: 100, height: 100, fileSize: 1000 }];
  return {
    from: { id: telegramId },
    id: messageId,
    photo: photoField,
    chat: { id: chatId, type: chatType },
    update: { message: { message_thread_id: threadId } },
  } as unknown as Ctx['Message'];
}

beforeEach(() => {
  sendMessageMock.mockReset().mockResolvedValue(null);
  mockGroups.findByTelegramGroupId.mockReset().mockReturnValue(null);
  mockUsers.findByTelegramId.mockReset().mockReturnValue(null);
  mockUsers.create.mockReset().mockImplementation(
    (data) =>
      ({
        id: 99,
        telegram_id: data.telegram_id,
        group_id: data.group_id,
        created_at: '',
        updated_at: '',
      }) as User,
  );
  mockPhotoQueue.create.mockReset().mockImplementation(
    (data: CreatePhotoQueueData) =>
      ({
        id: 1,
        group_id: data.group_id,
        user_id: data.user_id,
        message_id: data.message_id,
        message_thread_id: data.message_thread_id ?? null,
        file_id: data.file_id,
        status: data.status,
        error_message: null,
        created_at: '',
        summary_mode: 0,
        ai_summary: null,
        correction_history: null,
        waiting_for_bulk_correction: 0,
        summary_message_id: null,
      }) as PhotoQueueItem,
  );
  trackMembershipMock.mockReset();
  logMock.error.mockReset();
});

describe('handlePhotoMessage — happy path', () => {
  test('queues the largest photo with status=pending and sends confirmation', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(fakeGroup({ id: 7 }));
    mockUsers.findByTelegramId.mockReturnValue(fakeUser());

    await handlePhotoMessage(
      fakeCtx({
        telegramId: 7,
        messageId: 500,
        photos: [
          { fileId: 'small-file', width: 100, height: 100, fileSize: 1000 },
          { fileId: 'medium-file', width: 400, height: 400, fileSize: 50000 },
          { fileId: 'large-file', width: 1200, height: 1200, fileSize: 500000 },
        ],
      }),
    );

    expect(mockPhotoQueue.create).toHaveBeenCalledTimes(1);
    const payload = mockPhotoQueue.create.mock.calls[0]?.[0] as CreatePhotoQueueData;
    expect(payload.file_id).toBe('large-file');
    expect(payload.status).toBe('pending');
    expect(payload.group_id).toBe(7);
    expect(payload.user_id).toBe(42);
    expect(payload.message_id).toBe(500);
    expect(payload.message_thread_id).toBeNull();

    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('добавлено в очередь');
    expect(trackMembershipMock).toHaveBeenCalledWith(7, 7);
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('preserves message_thread_id when photo arrives in a forum topic', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(fakeGroup({ id: 1, active_topic_id: null }));
    mockUsers.findByTelegramId.mockReturnValue(fakeUser());

    await handlePhotoMessage(fakeCtx({ threadId: 42 }));

    const payload = mockPhotoQueue.create.mock.calls[0]?.[0] as CreatePhotoQueueData;
    expect(payload.message_thread_id).toBe(42);
  });

  test('creates missing user row before queuing', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(fakeGroup({ id: 7 }));
    mockUsers.findByTelegramId.mockReturnValue(null); // no existing user

    await handlePhotoMessage(fakeCtx({ telegramId: 500 }));

    expect(mockUsers.create).toHaveBeenCalledWith({ telegram_id: 500, group_id: 7 });
    expect(mockPhotoQueue.create).toHaveBeenCalled();
  });
});

describe('handlePhotoMessage — guards', () => {
  test('private chat — refused with error message, nothing queued', async () => {
    await handlePhotoMessage(fakeCtx({ chatType: 'private', chatId: 42 }));

    expect(mockPhotoQueue.create).not.toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('только в группах');
  });

  test('group has no DB row — tells user to run /connect, nothing queued', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(null);

    await handlePhotoMessage(fakeCtx({}));

    expect(mockPhotoQueue.create).not.toHaveBeenCalled();
    const msg = sendMessageMock.mock.calls[0]?.[0] as string;
    expect(msg).toContain('Группа не настроена');
    expect(msg).toContain('/connect');
  });

  test('topic restriction — photo from wrong topic is silently ignored', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(fakeGroup({ id: 1, active_topic_id: 10 }));
    mockUsers.findByTelegramId.mockReturnValue(fakeUser());

    await handlePhotoMessage(fakeCtx({ threadId: 99 })); // wrong topic

    expect(mockPhotoQueue.create).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test('empty photos array — bails out silently', async () => {
    await handlePhotoMessage(fakeCtx({ photos: [] }));

    expect(mockPhotoQueue.create).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test('missing photos payload — bails out silently', async () => {
    await handlePhotoMessage(fakeCtx({ photos: null }));

    expect(mockPhotoQueue.create).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});
