import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { ChatMessage, Group, User } from '../../database/types';
import { AgentError } from '../../errors';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { Ctx } from '../types';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const mockEnv = {
  ANTHROPIC_API_KEY: 'test-key',
  AUTO_ADVICE_ENABLED: false,
  AI_DEBUG_LOGS: false,
};
mock.module('../../config/env', () => ({ env: mockEnv }));

function makeGroup(activeTopicId: number | null): Group {
  return {
    id: 1,
    telegram_group_id: -100,
    default_currency: 'EUR',
    active_topic_id: activeTopicId,
    custom_prompt: null,
  } as Group;
}
const user = { id: 10, telegram_id: 99, group_id: 1 } as User;
let activeGroup = makeGroup(null);
let nextHistoryId = 100;

const createHistoryMock = mock((data: Record<string, unknown>) => ({
  id: nextHistoryId++,
  group_id: data['group_id'] as number,
  user_id: data['user_id'] as number,
  role: data['role'] as 'user' | 'assistant',
  content: data['content'] as string,
  message_thread_id: (data['message_thread_id'] as number | null | undefined) ?? null,
  created_at: '2026-10-01 00:00:00',
}));
const getRecentBeforeMock = mock(
  (_groupId: number, _beforeId: number, _limit: number, _threadId: number | null) =>
    [] as ChatMessage[],
);
const pruneMock = mock(() => 0);

mock.module('../../database', () => ({
  database: {
    groups: {
      findByTelegramGroupId: mock(() => activeGroup),
      findById: mock(() => activeGroup),
    },
    users: {
      findByTelegramId: mock(() => user),
      create: mock(() => user),
    },
    chatMessages: {
      create: createHistoryMock,
      getRecentMessagesBefore: getRecentBeforeMock,
      pruneOldMessagesIfNeeded: pruneMock,
    },
    adviceLogs: { create: mock(), getRecentTopics: mock(() => []) },
  },
}));

const capturedHistories: ChatMessage[][] = [];
const agentRunMock = mock(async (_question: string, history: ChatMessage[]): Promise<string> => {
  capturedHistories.push(history);
  return 'ok';
});
class FakeAgent {
  run(question: string, history: ChatMessage[]): Promise<string> {
    return agentRunMock(question, history);
  }
}
mock.module('../../services/ai/agent', () => ({ ExpenseBotAgent: FakeAgent }));
mock.module('../../services/analytics/spending-analytics', () => ({
  spendingAnalytics: { getFinancialSnapshot: mock(() => ({})) },
}));
const checkSmartTriggersMock = mock(
  () => null as import('../../services/analytics/types').TriggerResult | null,
);
const recordAdviceSentMock = mock(() => undefined);
mock.module('../../services/analytics/advice-triggers', () => ({
  checkSmartTriggers: checkSmartTriggersMock,
  recordAdviceSent: recordAdviceSentMock,
}));
mock.module('../../services/analytics/formatters', () => ({
  computeOverallSeverity: mock(() => 'good'),
  formatSnapshotForPrompt: mock(() => ''),
}));
const aiStreamRoundMock = mock(async () => ({
  text: 'Useful smart advice for this test',
  toolCalls: [],
  finishReason: 'stop',
  assistantMessage: { role: 'assistant', content: 'Useful smart advice for this test' },
  providerUsed: 'test',
}));
mock.module('../../services/ai/streaming', () => ({
  aiStreamRound: aiStreamRoundMock,
  stripThinkingTags: (text: string) => text,
}));
mock.module('../../services/ai/advice-validator', () => ({
  validateAdvice: mock(async () => ({ approved: true })),
}));
class FakeStatusWriter {
  append(_delta: string): void {}
  async finalize(_text: string): Promise<void> {}
  async finalizeError(_text: string): Promise<void> {}
  async close(): Promise<void> {}
}
mock.module('../../services/receipt/status-writer', () => ({ StatusWriter: FakeStatusWriter }));

const sendMessageMock = mock(
  async (_text: string): Promise<{ message_id: number } | null> => ({
    message_id: 1,
  }),
);
mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  sendDirect: mock(async () => null),
  editMessageText: mock(async () => undefined),
  deleteMessage: mock(async () => undefined),
  sendChatAction: mock(async () => undefined),
  withChatContext: async <T>(_chatId: number, _threadId: number | null, fn: () => Promise<T>) =>
    fn(),
}));

const { handleAskQuestion } = await import('./ask');

function fakeCtx(isForum: boolean, threadId?: number): Ctx['Message'] {
  return {
    chat: { id: -100, type: 'supergroup', isForum },
    from: { id: 99, username: 'alex', firstName: 'Alex', lastName: '' },
    update: { message: { message_thread_id: threadId } },
  } as unknown as Ctx['Message'];
}

function fakeBot() {
  return {
    api: {
      sendChatAction: mock(async () => undefined),
      sendPhoto: mock(async () => undefined),
    },
  } as never;
}

function historyRow(id: number, content: string, threadId: number | null): ChatMessage {
  return {
    id,
    group_id: 1,
    user_id: 10,
    role: 'user',
    content,
    message_thread_id: threadId,
    created_at: '2026-10-01 00:00:00',
  };
}

beforeEach(() => {
  activeGroup = makeGroup(null);
  nextHistoryId = 100;
  capturedHistories.length = 0;
  agentRunMock.mockReset().mockImplementation(async (_question, history) => {
    capturedHistories.push(history);
    return 'ok';
  });
  createHistoryMock.mockClear().mockImplementation((data: Record<string, unknown>) => ({
    id: nextHistoryId++,
    group_id: data['group_id'] as number,
    user_id: data['user_id'] as number,
    role: data['role'] as 'user' | 'assistant',
    content: data['content'] as string,
    message_thread_id: (data['message_thread_id'] as number | null | undefined) ?? null,
    created_at: '2026-10-01 00:00:00',
  }));
  sendMessageMock.mockClear();
  logMock.error.mockClear();
  logMock.info.mockClear();
  getRecentBeforeMock.mockReset().mockReturnValue([]);
  pruneMock.mockClear();
  mockEnv.AUTO_ADVICE_ENABLED = false;
  checkSmartTriggersMock.mockReset().mockReturnValue(null);
  recordAdviceSentMock.mockClear();
  aiStreamRoundMock.mockReset().mockResolvedValue({
    text: 'Useful smart advice for this test',
    toolCalls: [],
    finishReason: 'stop',
    assistantMessage: { role: 'assistant', content: 'Useful smart advice for this test' },
    providerUsed: 'test',
  });
});

describe('handleAskQuestion — recent history scoping', () => {
  test('configured forum reads only the current Telegram topic', async () => {
    activeGroup = makeGroup(42);
    const prior = historyRow(90, 'topic 42 prior', 42);
    getRecentBeforeMock.mockReturnValue([prior]);

    await handleAskQuestion(fakeCtx(true, 42), 'question', fakeBot(), true);

    expect(getRecentBeforeMock).toHaveBeenCalledWith(1, 100, 20, 42);
    expect(capturedHistories[0]).toEqual([prior]);
    expect(createHistoryMock.mock.calls[0]?.[0]).toMatchObject({ message_thread_id: 42 });
    expect(createHistoryMock.mock.calls[1]?.[0]).toMatchObject({ message_thread_id: 42 });
  });

  test('unconfigured forum mention is stateless', async () => {
    activeGroup = makeGroup(null);

    await handleAskQuestion(fakeCtx(true, 77), 'question', fakeBot(), true);

    expect(createHistoryMock).not.toHaveBeenCalled();
    expect(getRecentBeforeMock).not.toHaveBeenCalled();
    expect(capturedHistories[0]).toEqual([]);
  });

  test('anchors causal history to the exact newly-created current row id', async () => {
    const older = historyRow(99, 'older', null);
    getRecentBeforeMock.mockReturnValue([older]);

    await handleAskQuestion(fakeCtx(false), 'question', fakeBot());

    expect(getRecentBeforeMock).toHaveBeenCalledWith(1, 100, 20, null);
    expect(capturedHistories[0]).toEqual([older]);
  });
  test('non-forum group keeps legacy NULL-scope history available', async () => {
    const legacy = historyRow(7, 'legacy context', null);
    getRecentBeforeMock.mockReturnValue([legacy]);

    await handleAskQuestion(fakeCtx(false), 'question', fakeBot());

    expect(getRecentBeforeMock).toHaveBeenCalledWith(1, 100, 20, null);
    expect(capturedHistories[0]?.map((message) => message.content)).toEqual(['legacy context']);
  });

  test('post-answer smart advice does not hold the ordered conversation queue', async () => {
    mockEnv.AUTO_ADVICE_ENABLED = true;
    checkSmartTriggersMock.mockReturnValue({
      type: 'anomaly',
      tier: 'quick',
      topic: 'test-advice',
      data: {},
    });

    let releaseAdvice!: () => void;
    const adviceGate = new Promise<void>((resolve) => {
      releaseAdvice = resolve;
    });
    let adviceCallCount = 0;
    aiStreamRoundMock.mockImplementation(async () => {
      adviceCallCount += 1;
      if (adviceCallCount === 1) await adviceGate;
      return {
        text: 'Useful smart advice for this test',
        toolCalls: [],
        finishReason: 'stop',
        assistantMessage: { role: 'assistant', content: 'Useful smart advice for this test' },
        providerUsed: 'test',
      };
    });

    const first = handleAskQuestion(fakeCtx(false), 'first', fakeBot());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(aiStreamRoundMock).toHaveBeenCalledTimes(1);

    const second = handleAskQuestion(fakeCtx(false), 'second', fakeBot());
    await new Promise((resolve) => setTimeout(resolve, 0));

    // The second primary answer must start while the first turn is still waiting
    // for its optional post-answer advice stream.
    expect(agentRunMock).toHaveBeenCalledTimes(2);

    releaseAdvice();
    await Promise.all([first, second]);
  });

  test('serializes concurrent AI turns so replies stay paired with request order', async () => {
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    agentRunMock.mockImplementation(async (question, history) => {
      capturedHistories.push(history);
      if (question.includes('first')) await firstGate;
      return question.includes('first') ? 'first reply' : 'second reply';
    });

    const first = handleAskQuestion(fakeCtx(false), 'first', fakeBot());
    await new Promise((resolve) => setTimeout(resolve, 0));
    const second = handleAskQuestion(fakeCtx(false), 'second', fakeBot());
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(agentRunMock).toHaveBeenCalledTimes(1);
    expect(createHistoryMock).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([first, second]);

    expect(agentRunMock).toHaveBeenCalledTimes(2);
    expect(createHistoryMock.mock.calls.map((call) => call[0]?.['content'])).toEqual([
      'alex: first',
      'first reply',
      'alex: second',
      'second reply',
    ]);
  });

  // Prod incident 2026-10-12: failed turns left the user's question without an assistant
  // row, so the next run saw a pile of unanswered questions and redid the old task.
  test('stores the AI error the user saw as the assistant reply, so the question is answered', async () => {
    agentRunMock.mockImplementation(async (_question, history) => {
      capturedHistories.push(history);
      throw new AgentError('⏳ Время ожидания истекло. Попробуй ещё раз.');
    });

    await handleAskQuestion(fakeCtx(false), 'сколько в евро?', fakeBot(), true);

    expect(createHistoryMock.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ role: 'user', content: 'alex: сколько в евро?' }),
      expect.objectContaining({
        role: 'assistant',
        content: '⏳ Время ожидания истекло. Попробуй ещё раз.',
      }),
    ]);
    // History stays bounded on the error path too (user row + assistant row).
    expect(pruneMock).toHaveBeenCalledTimes(2);
    expect(pruneMock).toHaveBeenLastCalledWith(1, null, 50, 10);
    expect(logMock.info).toHaveBeenCalledWith(expect.stringContaining('Agent error'));
  });

  test('stores the generic failure message the user was sent after an unexpected agent error', async () => {
    agentRunMock.mockImplementation(async () => {
      throw new Error('db exploded');
    });

    await handleAskQuestion(fakeCtx(false), 'вопрос', fakeBot(), true);

    const sentText = sendMessageMock.mock.calls.at(-1)?.[0];
    expect(sentText).toContain('Ошибка');
    expect(createHistoryMock.mock.calls.map((call) => call[0])).toEqual([
      expect.objectContaining({ role: 'user' }),
      expect.objectContaining({ role: 'assistant', content: sentText }),
    ]);
    expect(logMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      '[ASK] Anthropic agent error',
    );
  });

  test('stores the failure message even when its Telegram send looked failed', async () => {
    // A lost response can hide a message Telegram did show; an open question would be redone.
    agentRunMock.mockImplementation(async () => {
      throw new Error('db exploded');
    });
    sendMessageMock.mockResolvedValueOnce(null);

    await handleAskQuestion(fakeCtx(false), 'вопрос', fakeBot(), true);

    expect(createHistoryMock.mock.calls.map((call) => call[0]?.['role'])).toEqual([
      'user',
      'assistant',
    ]);
  });

  test('a failure to store the reply does not turn a delivered answer into an error', async () => {
    createHistoryMock.mockImplementation((data: Record<string, unknown>) => {
      if (data['role'] === 'assistant') throw new Error('database is locked');
      return {
        id: nextHistoryId++,
        group_id: 1,
        user_id: 10,
        role: 'user',
        content: String(data['content']),
        message_thread_id: null,
        created_at: '2026-10-01 00:00:00',
      };
    });

    await handleAskQuestion(fakeCtx(false), 'вопрос', fakeBot(), true);

    // The answer reached the user; no extra "❌ Ошибка" message follows it.
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      '[ASK] Failed to store the assistant reply',
    );
  });

  test('an unscoped forum stores no rows even when the agent fails', async () => {
    agentRunMock.mockImplementation(async () => {
      throw new AgentError('❌ Ошибка AI. Попробуй позже.');
    });

    await handleAskQuestion(fakeCtx(true, 77), 'вопрос', fakeBot(), true);

    expect(createHistoryMock).not.toHaveBeenCalled();
  });

  test('an intentional silent run ([SKIP]) stores no assistant row', async () => {
    agentRunMock.mockImplementation(async () => '');

    await handleAskQuestion(fakeCtx(false), 'ок', fakeBot());

    expect(createHistoryMock.mock.calls.map((call) => call[0]?.['role'])).toEqual(['user']);
  });
});
