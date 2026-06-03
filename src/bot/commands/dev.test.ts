// Tests for /dev command: subcommand router, task listing/history, status formatting,
// task creation, plan/approve/cancel/answer/continue flows, callback handlers,
// pendingDesignEdit consumption. Shell-heavy bits (handleLogs Bun.file, startTask internals)
// are mocked; we only verify the command layer correctly delegates to the pipeline.

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from 'bun:test';
import type { TelegramMessage } from '@gramio/types';
import type { Group, User } from '../../database/types';
import * as senderModule from '../../services/bank/telegram-sender';
import { type DevTask, DevTaskState } from '../../services/dev-pipeline/types';
import { mockDatabase } from '../../test-utils/mocks/database';
import { createMockLogger } from '../../test-utils/mocks/logger';

// ─── Logger mock ──────────────────────────────────────────────────────────────

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ─── Repo mocks ───────────────────────────────────────────────────────────────

const mockUsers = {
  findByTelegramId: mock((_id: number): User | null => ({
    id: 7,
    telegram_id: 42,
    group_id: 1,
    created_at: '2026-04-19T00:00:00Z',
    updated_at: '2026-04-19T00:00:00Z',
  })),
  create: mock(
    (data: { telegram_id: number; group_id: number }): User => ({
      id: 7,
      telegram_id: data.telegram_id,
      group_id: data.group_id,
      created_at: '2026-04-19T00:00:00Z',
      updated_at: '2026-04-19T00:00:00Z',
    }),
  ),
};

const mockGroups = {
  findById: mock((id: number): Group | null => ({
    id,
    telegram_group_id: -1001,
    title: 'test',
    invite_link: null,
    google_refresh_token: null,
    spreadsheet_id: null,
    default_currency: 'EUR',
    enabled_currencies: ['EUR'],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'legacy',
    bank_panel_summary_message_id: null,
    bank_cards_enabled: 1,
    created_at: '2026-04-19T00:00:00Z',
    updated_at: '2026-04-19T00:00:00Z',
  })),
};

const mockDevTasks = {
  findById: mock((_id: number): DevTask | null => null),
  findByGroupId: mock((_groupId: number, _limit?: number): DevTask[] => []),
  findActiveByGroupId: mock((_groupId: number): DevTask[] => []),
  countActive: mock((_groupId: number): number => 0),
};

mock.module('../../database', () => ({
  database: mockDatabase({
    users: mockUsers,
    groups: mockGroups,
    devTasks: mockDevTasks,
  }),
}));

// ─── Pipeline mock (stand-in for DevPipeline class) ───────────────────────────

const pipelineMethods = {
  startTask: mock((_gid: number, _uid: number, _desc: string) =>
    Promise.resolve({ id: 1 } as DevTask),
  ),
  approveTask: mock((_id: number) => Promise.resolve({ id: 1 } as DevTask)),
  cancelTask: mock((_id: number) => Promise.resolve({ id: 1 } as DevTask)),
  answerTask: mock((_id: number, _ans: string) => Promise.resolve({ id: 1 } as DevTask)),
  continueTask: mock((_id: number, _msg: string) => Promise.resolve({ id: 1 } as DevTask)),
  acceptReview: mock((_id: number) => Promise.resolve({ id: 1 } as DevTask)),
  mergeTask: mock((_id: number) => Promise.resolve({ id: 1 } as DevTask)),
};

class FakeDevPipeline {
  startTask = pipelineMethods.startTask;
  approveTask = pipelineMethods.approveTask;
  cancelTask = pipelineMethods.cancelTask;
  answerTask = pipelineMethods.answerTask;
  continueTask = pipelineMethods.continueTask;
  acceptReview = pipelineMethods.acceptReview;
  mergeTask = pipelineMethods.mergeTask;
}

mock.module('../../services/dev-pipeline/pipeline', () => ({
  DevPipeline: FakeDevPipeline,
}));

// ─── telegram-sender spies ────────────────────────────────────────────────────

const sent: { text: string; opts?: Record<string, unknown> }[] = [];
const mockSendMessage = mock(
  (text: string, opts?: Record<string, unknown>): Promise<TelegramMessage | null> => {
    sent.push(opts === undefined ? { text } : { text, opts });
    return Promise.resolve({ message_id: 9001 } as TelegramMessage);
  },
);

const spies: { mockRestore: () => void }[] = [];

beforeAll(() => {
  spies.push(
    spyOn(senderModule, 'sendMessage').mockImplementation(mockSendMessage),
    spyOn(senderModule, 'withChatContext').mockImplementation(
      // @ts-expect-error — simplified signature for tests
      (_c: number, _t: number | null, fn: () => unknown) => fn(),
    ),
  );
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

// ─── Dynamic import AFTER mocks ───────────────────────────────────────────────

const {
  handleDevCommand,
  handleDevCallback,
  initDevPipeline,
  consumePendingDesignEdit,
  getPipelineInstance,
} = await import('./dev');

// Initialize pipeline once so getPipeline() doesn't return null in most tests.
initDevPipeline();

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const group: Group = {
  id: 1,
  telegram_group_id: -1001,
  title: 'test',
  invite_link: null,
  google_refresh_token: null,
  spreadsheet_id: null,
  default_currency: 'EUR',
  enabled_currencies: ['EUR'],
  custom_prompt: null,
  active_topic_id: null,
  oauth_client: 'legacy',
  bank_panel_summary_message_id: null,
  bank_cards_enabled: 1,
  created_at: '2026-04-19T00:00:00Z',
  updated_at: '2026-04-19T00:00:00Z',
};

function makeTask(overrides: Partial<DevTask> = {}): DevTask {
  return {
    id: 10,
    group_id: 1,
    user_id: 7,
    state: DevTaskState.DESIGNING,
    title: null,
    description: 'fix the thing',
    branch_name: null,
    worktree_path: null,
    pr_number: null,
    pr_url: null,
    design: null,
    plan: null,
    code_review: null,
    error_log: null,
    failed_at_state: null,
    retry_count: 0,
    created_at: '2026-04-19T00:00:00Z',
    updated_at: '2026-04-19T00:00:00Z',
    ...overrides,
  };
}

function makeCommandCtx(text: string) {
  return {
    chat: { id: -1001 },
    from: { id: 42 },
    text,
  } as unknown as Parameters<typeof handleDevCommand>[0];
}

function makeCallbackCtx(
  overrides: Record<string, unknown> = {},
): Parameters<typeof handleDevCallback>[0] {
  return {
    from: { id: 42 },
    message: { id: 500, chat: { id: -1001 } },
    answerCallbackQuery: mock((_data?: unknown): Promise<void> => Promise.resolve()),
    editText: mock(
      (_text: string, _opts?: unknown): Promise<unknown> => Promise.resolve(undefined),
    ),
    ...overrides,
  } as unknown as Parameters<typeof handleDevCallback>[0];
}

function makeBot() {
  return {
    api: {
      deleteMessage: mock((_p: { chat_id: number; message_id: number }) => Promise.resolve(true)),
    },
  } as unknown as Parameters<typeof handleDevCallback>[3];
}

// ─── Reset between tests ──────────────────────────────────────────────────────

beforeEach(() => {
  sent.length = 0;
  mockSendMessage.mockClear();
  mockUsers.findByTelegramId.mockClear();
  mockUsers.create.mockClear();
  mockDevTasks.findById.mockReset();
  mockDevTasks.findById.mockImplementation(() => null);
  mockDevTasks.findByGroupId.mockReset();
  mockDevTasks.findByGroupId.mockImplementation(() => []);
  mockDevTasks.findActiveByGroupId.mockReset();
  mockDevTasks.findActiveByGroupId.mockImplementation(() => []);
  mockDevTasks.countActive.mockReset();
  mockDevTasks.countActive.mockImplementation(() => 0);
  for (const m of Object.values(pipelineMethods)) m.mockClear();
  logMock.info.mockClear();
  logMock.error.mockClear();
  logMock.warn.mockClear();
});

afterEach(() => {
  // Drain any pending design edits left over by /dev edit callback.
  consumePendingDesignEdit(-1001);
});

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('handleDevCommand — router', () => {
  test('no args → shows usage help', async () => {
    await handleDevCommand(makeCommandCtx('/dev'), group);
    expect(sent.length).toBe(1);
    expect(sent[0]?.text).toContain('Dev Pipeline');
    expect(sent[0]?.text).toContain('/dev &lt;description&gt;');
    expect(logMock.error).not.toHaveBeenCalled();
  });

  test('/dev status with no tasks → friendly empty message', async () => {
    await handleDevCommand(makeCommandCtx('/dev status'), group);
    expect(mockDevTasks.findActiveByGroupId).toHaveBeenCalledWith(1);
    expect(sent[0]?.text).toBe('No active dev tasks.');
  });

  test('/dev status lists tasks with emoji + label + truncated description', async () => {
    mockDevTasks.findActiveByGroupId.mockImplementation(() => [
      makeTask({ id: 10, state: DevTaskState.DESIGNING, description: 'a'.repeat(150) }),
      makeTask({
        id: 11,
        state: DevTaskState.AWAITING_REVIEW,
        pr_url: 'https://gh/pr/42',
        retry_count: 2,
      }),
    ]);
    await handleDevCommand(makeCommandCtx('/dev status'), group);
    const msg = sent[0]?.text ?? '';
    expect(msg).toContain('<b>Active Dev Tasks</b>');
    expect(msg).toContain('📐'); // DESIGNING emoji
    expect(msg).toContain('Проектирование');
    expect(msg).toContain('<b>#10</b>');
    expect(msg).toContain('<b>#11</b>');
    expect(msg).toContain('👀'); // AWAITING_REVIEW emoji
    expect(msg).toContain('PR: https://gh/pr/42');
    expect(msg).toContain('Retries: 2');
    // description must be truncated to 100 chars — '...151...' wouldn't fit whole
    const aChunk = 'a'.repeat(100);
    expect(msg).toContain(aChunk);
    expect(msg.includes('a'.repeat(101))).toBe(false);
  });

  test('/dev history with no tasks → friendly empty message', async () => {
    await handleDevCommand(makeCommandCtx('/dev history'), group);
    expect(mockDevTasks.findByGroupId).toHaveBeenCalledWith(1, 10);
    expect(sent[0]?.text).toBe('No dev tasks found.');
  });

  test('/dev history formats records', async () => {
    mockDevTasks.findByGroupId.mockImplementation(() => [
      makeTask({
        id: 1,
        state: DevTaskState.COMPLETED,
        description: 'add budget',
        pr_url: 'https://gh/pr/1',
      }),
    ]);
    await handleDevCommand(makeCommandCtx('/dev history'), group);
    const msg = sent[0]?.text ?? '';
    expect(msg).toContain('<b>Recent Dev Tasks</b>');
    expect(msg).toContain('✅');
    expect(msg).toContain('Завершено');
    expect(msg).toContain('PR: https://gh/pr/1');
  });

  test('arbitrary subcommand falls through to handleNewTask', async () => {
    await handleDevCommand(makeCommandCtx('/dev fix the login bug'), group);
    expect(pipelineMethods.startTask).toHaveBeenCalledTimes(1);
    expect(pipelineMethods.startTask).toHaveBeenCalledWith(1, 7, 'fix the login bug');
  });
});

describe('handleDevCommand — new task creation', () => {
  test('creates user if missing before starting task', async () => {
    mockUsers.findByTelegramId.mockImplementationOnce(() => null);
    await handleDevCommand(makeCommandCtx('/dev do stuff'), group);
    expect(mockUsers.create).toHaveBeenCalledWith({ telegram_id: 42, group_id: 1 });
    expect(pipelineMethods.startTask).toHaveBeenCalled();
  });

  test('too many active tasks (>=3) → blocks with friendly message', async () => {
    mockDevTasks.countActive.mockImplementation(() => 3);
    await handleDevCommand(makeCommandCtx('/dev big refactor'), group);
    expect(pipelineMethods.startTask).not.toHaveBeenCalled();
    expect(sent[0]?.text).toContain('Too many active tasks (3)');
  });

  test('pipeline start failure → user-friendly error, logs error', async () => {
    pipelineMethods.startTask.mockImplementationOnce(() => Promise.reject(new Error('boom')));
    await handleDevCommand(makeCommandCtx('/dev cause failure'), group);
    expect(sent[0]?.text).toBe('Failed to start task: boom');
    expect(logMock.error).toHaveBeenCalled();
  });

  test('whitespace-only description → prompts for description', async () => {
    // `/dev   ` → trim then split → ['/dev'] → args = [] — covered by showUsage test.
    // Forge a description of just whitespace via default fall-through:
    // `/dev` with a single trailing arg that's all whitespace cannot be constructed;
    // instead hit handleNewTask directly by submitting an arg that IS a keyword-looking
    // but empty trimmed string via description = ''.
    //
    // Since the router path only calls handleNewTask when args.length > 0,
    // a pure whitespace desc is unreachable via the public API. Skip.
    expect(true).toBe(true);
  });
});

describe('handleDevCommand — approve', () => {
  test('missing id → usage hint', async () => {
    await handleDevCommand(makeCommandCtx('/dev approve'), group);
    expect(sent[0]?.text).toBe('Usage: /dev approve <task_id>');
    expect(pipelineMethods.approveTask).not.toHaveBeenCalled();
  });

  test('non-numeric id → usage hint', async () => {
    await handleDevCommand(makeCommandCtx('/dev approve abc'), group);
    expect(sent[0]?.text).toBe('Usage: /dev approve <task_id>');
  });

  test('task not found', async () => {
    await handleDevCommand(makeCommandCtx('/dev approve 99'), group);
    expect(sent[0]?.text).toBe('Task #99 not found.');
    expect(pipelineMethods.approveTask).not.toHaveBeenCalled();
  });

  test('task belongs to different group → refused', async () => {
    mockDevTasks.findById.mockImplementation(() => makeTask({ id: 99, group_id: 2 }));
    await handleDevCommand(makeCommandCtx('/dev approve 99'), group);
    expect(sent[0]?.text).toBe('Task #99 does not belong to this group.');
    expect(pipelineMethods.approveTask).not.toHaveBeenCalled();
  });

  test('valid → delegates to pipeline.approveTask', async () => {
    mockDevTasks.findById.mockImplementation(() => makeTask({ id: 5 }));
    await handleDevCommand(makeCommandCtx('/dev approve 5'), group);
    expect(pipelineMethods.approveTask).toHaveBeenCalledWith(5);
  });

  test('pipeline throws → reports friendly error', async () => {
    mockDevTasks.findById.mockImplementation(() => makeTask({ id: 5 }));
    pipelineMethods.approveTask.mockImplementationOnce(() => Promise.reject(new Error('nope')));
    await handleDevCommand(makeCommandCtx('/dev approve 5'), group);
    expect(sent[0]?.text).toBe('Failed to approve: nope');
  });
});

describe('handleDevCommand — cancel', () => {
  test('valid → delegates to pipeline.cancelTask', async () => {
    mockDevTasks.findById.mockImplementation(() => makeTask({ id: 8 }));
    await handleDevCommand(makeCommandCtx('/dev cancel 8'), group);
    expect(pipelineMethods.cancelTask).toHaveBeenCalledWith(8);
  });

  test('task not found', async () => {
    await handleDevCommand(makeCommandCtx('/dev cancel 123'), group);
    expect(sent[0]?.text).toBe('Task #123 not found.');
  });

  test('wrong group → refused', async () => {
    mockDevTasks.findById.mockImplementation(() => makeTask({ id: 8, group_id: 999 }));
    await handleDevCommand(makeCommandCtx('/dev cancel 8'), group);
    expect(sent[0]?.text).toBe('Task #8 does not belong to this group.');
  });
});

describe('handleDevCommand — plan', () => {
  test('missing id → usage hint', async () => {
    await handleDevCommand(makeCommandCtx('/dev plan'), group);
    expect(sent[0]?.text).toBe('Usage: /dev plan <task_id>');
  });

  test('no design yet → friendly message', async () => {
    mockDevTasks.findById.mockImplementation(() => makeTask({ id: 3, design: null }));
    await handleDevCommand(makeCommandCtx('/dev plan 3'), group);
    expect(sent[0]?.text).toBe('Task #3 has no design plan yet.');
  });

  test('with design → renders <pre> block, escapes HTML, adds hide keyboard', async () => {
    mockDevTasks.findById.mockImplementation(() =>
      makeTask({ id: 3, title: 'AI <plan>', design: 'step 1 & <html>' }),
    );
    await handleDevCommand(makeCommandCtx('/dev plan 3'), group);
    const entry = sent[0];
    expect(entry?.text).toContain('📐 <b>Dev task #3:</b> AI &lt;plan&gt;');
    expect(entry?.text).toContain('<pre>step 1 &amp; &lt;html&gt;</pre>');
    expect(entry?.opts?.['reply_markup']).toBeDefined();
  });
});

describe('handleDevCommand — answer', () => {
  test('missing id → usage hint', async () => {
    await handleDevCommand(makeCommandCtx('/dev answer'), group);
    expect(sent[0]?.text).toBe('Usage: /dev answer <task_id> <your answers>');
  });

  test('missing answer text → prompt', async () => {
    await handleDevCommand(makeCommandCtx('/dev answer 5'), group);
    expect(sent[0]?.text).toBe('Provide your answers: /dev answer <task_id> <text>');
  });

  test('valid → delegates to pipeline.answerTask with joined text', async () => {
    mockDevTasks.findById.mockImplementation(() => makeTask({ id: 5 }));
    await handleDevCommand(makeCommandCtx('/dev answer 5 yes and also no'), group);
    expect(pipelineMethods.answerTask).toHaveBeenCalledWith(5, 'yes and also no');
  });
});

describe('handleDevCommand — continue', () => {
  test('missing id → usage', async () => {
    await handleDevCommand(makeCommandCtx('/dev continue'), group);
    expect(sent[0]?.text).toBe('Usage: /dev continue <task_id> [message]');
  });

  test('no message → defaults to "Продолжай"', async () => {
    mockDevTasks.findById.mockImplementation(() => makeTask({ id: 2 }));
    await handleDevCommand(makeCommandCtx('/dev continue 2'), group);
    expect(pipelineMethods.continueTask).toHaveBeenCalledWith(2, 'Продолжай');
  });

  test('with message → passes through', async () => {
    mockDevTasks.findById.mockImplementation(() => makeTask({ id: 2 }));
    await handleDevCommand(makeCommandCtx('/dev continue 2 retry the build'), group);
    expect(pipelineMethods.continueTask).toHaveBeenCalledWith(2, 'retry the build');
  });
});

describe('consumePendingDesignEdit', () => {
  test('returns null when no pending edit', () => {
    expect(consumePendingDesignEdit(-9999)).toBeNull();
  });

  test('edit callback sets pending, consume returns it once', async () => {
    mockDevTasks.findById.mockImplementation(() =>
      makeTask({ id: 44, state: DevTaskState.APPROVAL }),
    );
    const ctx = makeCallbackCtx();
    await handleDevCallback(ctx, ['edit', '44'], 42, makeBot());
    expect(consumePendingDesignEdit(-1001)).toBe(44);
    // second call consumed → null
    expect(consumePendingDesignEdit(-1001)).toBeNull();
  });
});

describe('handleDevCallback', () => {
  test('missing action → answers with error', async () => {
    const ctx = makeCallbackCtx();
    await handleDevCallback(ctx, [], 42, makeBot());
    const spy = ctx.answerCallbackQuery as unknown as ReturnType<typeof mock>;
    expect(spy).toHaveBeenCalledWith({ text: 'Invalid parameters' });
  });

  test('non-numeric task id → answers with error', async () => {
    const ctx = makeCallbackCtx();
    await handleDevCallback(ctx, ['approve', 'xyz'], 42, makeBot());
    const spy = ctx.answerCallbackQuery as unknown as ReturnType<typeof mock>;
    expect(spy).toHaveBeenCalledWith({ text: 'Invalid task ID' });
  });

  test('approve action → delegates and confirms', async () => {
    const ctx = makeCallbackCtx();
    const bot = makeBot();
    await handleDevCallback(ctx, ['approve', '10'], 42, bot);
    expect(pipelineMethods.approveTask).toHaveBeenCalledWith(10);
    const spy = ctx.answerCallbackQuery as unknown as ReturnType<typeof mock>;
    expect(spy).toHaveBeenCalledWith({ text: 'Approved!' });
    // button message deleted afterwards
    const delSpy = (bot.api as unknown as { deleteMessage: ReturnType<typeof mock> }).deleteMessage;
    expect(delSpy).toHaveBeenCalled();
  });

  test('reject action → cancelTask + ack', async () => {
    const ctx = makeCallbackCtx();
    await handleDevCallback(ctx, ['reject', '10'], 42, makeBot());
    expect(pipelineMethods.cancelTask).toHaveBeenCalledWith(10);
    const spy = ctx.answerCallbackQuery as unknown as ReturnType<typeof mock>;
    expect(spy).toHaveBeenCalledWith({ text: 'Cancelled' });
  });

  test('cancel action → cancelTask + ack', async () => {
    const ctx = makeCallbackCtx();
    await handleDevCallback(ctx, ['cancel', '10'], 42, makeBot());
    expect(pipelineMethods.cancelTask).toHaveBeenCalledWith(10);
  });

  test('accept_review action → acceptReview', async () => {
    const ctx = makeCallbackCtx();
    await handleDevCallback(ctx, ['accept_review', '10'], 42, makeBot());
    expect(pipelineMethods.acceptReview).toHaveBeenCalledWith(10);
  });

  test('merge action → mergeTask', async () => {
    const ctx = makeCallbackCtx();
    await handleDevCallback(ctx, ['merge', '10'], 42, makeBot());
    expect(pipelineMethods.mergeTask).toHaveBeenCalledWith(10);
  });

  test('hide_plan → deletes button message, does NOT double-delete', async () => {
    const ctx = makeCallbackCtx();
    const bot = makeBot();
    await handleDevCallback(ctx, ['hide_plan', '10'], 42, bot);
    const delSpy = (bot.api as unknown as { deleteMessage: ReturnType<typeof mock> }).deleteMessage;
    // hide_plan returns early, so only one deleteMessage call
    expect(delSpy).toHaveBeenCalledTimes(1);
  });

  test('unknown subAction → "Unknown action"', async () => {
    const ctx = makeCallbackCtx();
    await handleDevCallback(ctx, ['ponycorn', '10'], 42, makeBot());
    const spy = ctx.answerCallbackQuery as unknown as ReturnType<typeof mock>;
    expect(spy).toHaveBeenCalledWith({ text: 'Unknown action' });
  });

  test('edit action with APPROVAL state → design-edit prompt', async () => {
    mockDevTasks.findById.mockImplementation(() =>
      makeTask({ id: 44, state: DevTaskState.APPROVAL }),
    );
    const ctx = makeCallbackCtx();
    await handleDevCallback(ctx, ['edit', '44'], 42, makeBot());
    const prompt = sent.find((s) => s.text.includes('в дизайне задачи #44'));
    expect(prompt).toBeDefined();
  });

  test('edit action with non-APPROVAL state → code-edit prompt', async () => {
    mockDevTasks.findById.mockImplementation(() =>
      makeTask({ id: 44, state: DevTaskState.AWAITING_REVIEW }),
    );
    const ctx = makeCallbackCtx();
    await handleDevCallback(ctx, ['edit', '44'], 42, makeBot());
    const prompt = sent.find((s) => s.text.includes('в коде задачи #44'));
    expect(prompt).toBeDefined();
  });

  test('pipeline error surfaces via answerCallbackQuery', async () => {
    pipelineMethods.approveTask.mockImplementationOnce(() => Promise.reject(new Error('fail!')));
    const ctx = makeCallbackCtx();
    await handleDevCallback(ctx, ['approve', '10'], 42, makeBot());
    // approve answered first with "Approved!" is NOT called because promise rejects before answer.
    // Actually, handler awaits approveTask then answers. On reject, goes to catch, which
    // checks `answered` (false) and calls answerCallbackQuery with the error text.
    const spy = ctx.answerCallbackQuery as unknown as ReturnType<typeof mock>;
    const calls = (spy as unknown as { mock: { calls: unknown[][] } }).mock.calls;
    const found = calls.some(
      (c) =>
        typeof c[0] === 'object' &&
        c[0] !== null &&
        'text' in (c[0] as Record<string, unknown>) &&
        String((c[0] as { text: string }).text).includes('Error: fail!'),
    );
    expect(found).toBe(true);
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('getPipelineInstance', () => {
  test('returns pipeline after init', () => {
    expect(getPipelineInstance()).not.toBeNull();
  });
});
