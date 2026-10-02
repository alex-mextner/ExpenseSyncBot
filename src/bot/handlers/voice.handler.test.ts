import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { Group } from '../../database/types';

const sendMessageMock = mock(() => Promise.resolve(null));
mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
}));

const askQuestionMock = mock(() => Promise.resolve());
mock.module('../commands/ask', () => ({
  handleAskQuestion: askQuestionMock,
}));

const privateRedirectMock = mock(() => Promise.resolve());
mock.module('./message.handler', () => ({
  sendPrivateChatRedirect: privateRedirectMock,
}));

const group = (overrides: Partial<Group> = {}): Group => ({
  id: 1,
  telegram_group_id: -100123,
  title: 'Finance',
  invite_link: null,
  google_refresh_token: 'token',
  spreadsheet_id: 'sheet',
  default_currency: 'EUR',
  enabled_currencies: ['EUR'],
  custom_prompt: null,
  active_topic_id: 77,
  oauth_client: 'current',
  bank_panel_summary_message_id: null,
  bank_cards_enabled: 1,
  created_at: '',
  updated_at: '',
  ...overrides,
});

const findGroupMock = mock((_id: number): Group | null => group());
const hasCompletedSetupMock = mock(() => true);
mock.module('../../database', () => ({
  database: {
    groups: {
      findByTelegramGroupId: findGroupMock,
      hasCompletedSetup: hasCompletedSetupMock,
    },
  },
}));

const { handleVoiceMessage } = await import('./voice.handler');

function makeCtx(
  options: { chatType?: 'private' | 'group' | 'supergroup'; threadId?: number } = {},
) {
  const chatType = options.chatType ?? 'supergroup';
  return {
    from: { id: 42, username: 'alex', firstName: 'Alex' },
    chat:
      chatType === 'private'
        ? { id: 42, type: 'private' as const }
        : { id: -100123, type: chatType, title: 'Finance', isForum: true },
    update: {
      message: {
        message_thread_id: options.threadId,
      },
    },
    voice: { fileId: 'voice-file-id', duration: 7 },
  };
}

function makeDeps(transcript = 'добавь 3500 динар кофе') {
  return {
    botToken: 'bot-token',
    transcriptionService: { transcribe: mock(() => Promise.resolve(transcript)) },
    downloadVoiceBuffer: mock(() => Promise.resolve(Buffer.from('ogg'))),
  };
}

const bot = {} as never;

beforeEach(() => {
  sendMessageMock.mockClear();
  askQuestionMock.mockClear();
  privateRedirectMock.mockClear();
  findGroupMock.mockReset();
  findGroupMock.mockReturnValue(group());
  hasCompletedSetupMock.mockReset();
  hasCompletedSetupMock.mockReturnValue(true);
});

describe('handleVoiceMessage', () => {
  test('ignores a voice message from a different configured topic before STT', async () => {
    const deps = makeDeps();

    await handleVoiceMessage(makeCtx({ threadId: 99 }) as never, bot, deps);

    expect(deps.downloadVoiceBuffer).not.toHaveBeenCalled();
    expect(deps.transcriptionService.transcribe).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(askQuestionMock).not.toHaveBeenCalled();
  });

  test('transcribes in the configured topic and routes the transcript as voice input', async () => {
    const deps = makeDeps('кофе <b>3500</b> динар');

    await handleVoiceMessage(makeCtx({ threadId: 77 }) as never, bot, deps);

    expect(deps.transcriptionService.transcribe).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('кофе &lt;b&gt;3500&lt;/b&gt; динар'),
    );
    expect(askQuestionMock).toHaveBeenCalledWith(
      expect.anything(),
      'кофе <b>3500</b> динар',
      bot,
      false,
      'voice_message',
    );
  });

  test('accepts voice in a forum when no topic binding is configured', async () => {
    findGroupMock.mockReturnValue(group({ active_topic_id: null }));
    const deps = makeDeps('сколько я потратил сегодня');

    await handleVoiceMessage(makeCtx({ threadId: 99 }) as never, bot, deps);

    expect(deps.transcriptionService.transcribe).toHaveBeenCalledTimes(1);
    expect(askQuestionMock).toHaveBeenCalledTimes(1);
  });

  test('reacts to a private voice with transcription and group redirect, without running group AI', async () => {
    const deps = makeDeps('добавь кофе 500');

    await handleVoiceMessage(makeCtx({ chatType: 'private' }) as never, bot, deps);

    expect(deps.transcriptionService.transcribe).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(expect.stringContaining('добавь кофе 500'));
    expect(privateRedirectMock).toHaveBeenCalledWith(42);
    expect(askQuestionMock).not.toHaveBeenCalled();
  });

  test('redirects a private voice to the configured group even when STT is unavailable', async () => {
    const deps = { ...makeDeps(), transcriptionService: null };

    await handleVoiceMessage(makeCtx({ chatType: 'private' }) as never, bot, deps);

    expect(sendMessageMock).toHaveBeenCalledWith(
      expect.stringContaining('Голосовые сейчас недоступны'),
    );
    expect(privateRedirectMock).toHaveBeenCalledWith(42);
    expect(askQuestionMock).not.toHaveBeenCalled();
  });

  test('does not call the agent when speech recognition returns empty text', async () => {
    const deps = makeDeps('');

    await handleVoiceMessage(makeCtx({ threadId: 77 }) as never, bot, deps);

    expect(sendMessageMock).toHaveBeenCalledWith(expect.stringContaining('не удалось распознать'));
    expect(askQuestionMock).not.toHaveBeenCalled();
  });

  test('does not download audio for an unconfigured group', async () => {
    findGroupMock.mockReturnValue(null);
    const deps = makeDeps();

    await handleVoiceMessage(makeCtx({ threadId: 77 }) as never, bot, deps);

    expect(sendMessageMock).toHaveBeenCalledWith(expect.stringContaining('/connect'));
    expect(deps.downloadVoiceBuffer).not.toHaveBeenCalled();
  });
});
