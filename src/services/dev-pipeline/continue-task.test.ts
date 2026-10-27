// Tests for DevPipeline.continueTask — which stage a FAILED task resumes at,
// what is written to the DB and in what order, and how other states dispatch.
// Worktree paths point below /dev/null so any fire-and-forget processing that the
// resume kicks off fails fast on its first filesystem write instead of touching disk.
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { DevTask, UpdateDevTaskData } from './types';
import { DevTaskState } from './types';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

const DEAD_WORKTREE = '/dev/null/worktree';
const store = new Map<number, DevTask>();

function seedTask(partial: Partial<DevTask>): DevTask {
  const task: DevTask = {
    id: 1,
    group_id: 500,
    user_id: 1,
    state: DevTaskState.FAILED,
    title: null,
    description: 'original description',
    branch_name: null,
    worktree_path: null,
    pr_number: null,
    pr_url: null,
    design: null,
    plan: null,
    code_review: null,
    error_log: 'old error',
    failed_at_state: null,
    retry_count: 3,
    created_at: '2026-01-01T00:00:00Z',
    updated_at: '2026-01-01T00:00:00Z',
    ...partial,
  };
  store.set(task.id, task);
  return task;
}

const updateMock = mock((id: number, data: UpdateDevTaskData): DevTask | null => {
  const current = store.get(id);
  if (!current) return null;
  const updated = { ...current, ...data } as DevTask;
  store.set(id, updated);
  return updated;
});

mock.module('../../database', () => ({
  database: {
    devTasks: {
      findById: (id: number) => store.get(id) ?? null,
      update: updateMock,
      findActive: () => [],
    },
  },
}));

class FakeAgent {
  abort() {}
  async run(): Promise<string> {
    return 'agent output';
  }
}
mock.module('./dev-agent', () => ({
  DevAgent: FakeAgent,
  AgentAbortedError: class extends Error {},
}));
mock.module('./codex-integration', () => ({ runCodexReview: async () => 'review' }));

const worktreeExistsMock = mock<(p: string) => boolean>(() => true);
const createWorktreeMock = mock<(b: string) => Promise<string>>(async () => DEAD_WORKTREE);
const mergePRMock = mock<(n: number) => Promise<void>>(async () => {});
mock.module('./git-ops', () => ({
  createWorktree: createWorktreeMock,
  removeWorktree: async () => {},
  deleteLocalBranch: async () => {},
  worktreeExists: worktreeExistsMock,
  generateBranchName: (id: number) => `dev/generated-${id}`,
  getRepoRoot: async () => '/repo/root',
  commitChanges: async () => {},
  pushBranch: async () => {},
  createPR: async () => ({ number: 1, url: 'u' }),
  mergePR: mergePRMock,
  getDiffFromMain: async () => 'diff',
  getChangedFilesFromMain: async () => [],
}));

mock.module('../../bot/keyboards', () => ({
  createDevApprovalKeyboard: () => ({ kb: 'approval' }),
  createDevReviewKeyboard: () => ({ kb: 'review' }),
  createDevMergeKeyboard: () => ({ kb: 'merge' }),
}));

const { DevPipeline } = await import('./pipeline');

interface NotifyCall {
  message: string;
  options: unknown;
}

function freshPipeline() {
  const notifyCalls: NotifyCall[] = [];
  const pipeline = new DevPipeline(async (_groupId, message, options) => {
    notifyCalls.push({ message, options });
  });
  return { pipeline, notifyCalls };
}

beforeEach(() => {
  store.clear();
  updateMock.mockClear();
  worktreeExistsMock.mockReset();
  worktreeExistsMock.mockImplementation(() => true);
  createWorktreeMock.mockClear();
  mergePRMock.mockClear();
});

/** The first two repo writes of a resume: the description update, then the state transition. */
function firstWrites() {
  return updateMock.mock.calls.slice(0, 2).map((c) => c[1]);
}

interface ResumeCase {
  name: string;
  task: Partial<DevTask>;
  worktreeExists: boolean;
  expectedState: DevTaskState;
  expectedNotice: string;
  expectedExtra: UpdateDevTaskData;
}

const RESET = { retry_count: 0, failed_at_state: null };

const RESUME_CASES: ResumeCase[] = [
  {
    name: 'PR + review done: shows review buttons without reprocessing',
    task: {
      pr_number: 9,
      pr_url: 'https://gh/pr/9',
      code_review: 'looks ok',
      worktree_path: DEAD_WORKTREE,
    },
    worktreeExists: true,
    expectedState: DevTaskState.AWAITING_REVIEW,
    expectedNotice: 'resuming — review already done',
    expectedExtra: { ...RESET, state: DevTaskState.AWAITING_REVIEW },
  },
  {
    name: 'PR but no review: reruns the review',
    task: { pr_number: 9, worktree_path: DEAD_WORKTREE },
    worktreeExists: true,
    expectedState: DevTaskState.REVIEWING,
    expectedNotice: 'PR exists, running code review',
    expectedExtra: { ...RESET, state: DevTaskState.REVIEWING },
  },
  {
    name: 'failed at REVIEWING without PR: creates the PR',
    task: { failed_at_state: DevTaskState.REVIEWING, worktree_path: DEAD_WORKTREE, design: 'd' },
    worktreeExists: true,
    expectedState: DevTaskState.PULL_REQUEST,
    expectedNotice: 'tests passed, creating PR',
    expectedExtra: { ...RESET, state: DevTaskState.PULL_REQUEST },
  },
  {
    name: 'design + worktree: resumes implementation and keeps error_log',
    task: { design: 'plan', worktree_path: DEAD_WORKTREE, failed_at_state: DevTaskState.TESTING },
    worktreeExists: true,
    expectedState: DevTaskState.IMPLEMENTING,
    expectedNotice: 'design and worktree preserved',
    expectedExtra: { ...RESET, state: DevTaskState.IMPLEMENTING },
  },
  {
    name: 'design but worktree gone: recreates worktree under the generated branch',
    task: { design: 'plan', worktree_path: DEAD_WORKTREE },
    worktreeExists: false,
    expectedState: DevTaskState.IMPLEMENTING,
    expectedNotice: 'recreated worktree, design preserved',
    expectedExtra: {
      error_log: null,
      ...RESET,
      branch_name: 'dev/generated-1',
      worktree_path: DEAD_WORKTREE,
      state: DevTaskState.IMPLEMENTING,
    },
  },
  {
    name: 'no design: restarts from PENDING and clears error_log',
    task: {},
    worktreeExists: false,
    expectedState: DevTaskState.PENDING,
    expectedNotice: 'restarting from scratch',
    expectedExtra: { error_log: null, ...RESET, state: DevTaskState.PENDING },
  },
];

describe('DevPipeline.continueTask — FAILED task resume', () => {
  for (const c of RESUME_CASES) {
    test(c.name, async () => {
      const task = seedTask(c.task);
      worktreeExistsMock.mockImplementation(() => c.worktreeExists);
      const { pipeline, notifyCalls } = freshPipeline();

      const result = await pipeline.continueTask(task.id, 'try the other way');

      const enriched = 'original description\n\nADDITIONAL CONTEXT:\ntry the other way';
      expect(result.state).toBe(c.expectedState);
      expect(result.description).toBe(enriched);
      expect(firstWrites()).toEqual([{ description: enriched }, c.expectedExtra]);
      expect(notifyCalls[0]?.message).toContain(c.expectedNotice);
    });
  }

  test('review-done resume attaches the review keyboard and truncates the review to 1500 chars', async () => {
    const task = seedTask({
      pr_number: 9,
      pr_url: 'https://gh/pr/9',
      code_review: 'x'.repeat(2000),
      worktree_path: DEAD_WORKTREE,
    });
    const { pipeline, notifyCalls } = freshPipeline();

    await pipeline.continueTask(task.id, 'go');

    expect(notifyCalls[0]?.options).toEqual({ reply_markup: { kb: 'review' } });
    expect(notifyCalls[0]?.message).toContain('x'.repeat(1500));
    expect(notifyCalls[0]?.message).not.toContain('x'.repeat(1501));
    expect(notifyCalls[0]?.message).toContain('PR: https://gh/pr/9');
  });

  test('the default "Продолжай" message leaves the description untouched', async () => {
    const task = seedTask({});
    const { pipeline } = freshPipeline();

    const result = await pipeline.continueTask(task.id, 'Продолжай');

    expect(result.description).toBe('original description');
    expect(firstWrites()[0]).toEqual({ description: 'original description' });
  });

  test('recreating the worktree reuses an existing branch name', async () => {
    const task = seedTask({ design: 'plan', branch_name: 'dev/existing' });
    worktreeExistsMock.mockImplementation(() => false);
    const { pipeline } = freshPipeline();

    await pipeline.continueTask(task.id, 'go');

    expect(createWorktreeMock).toHaveBeenCalledWith('dev/existing');
  });
});

describe('DevPipeline.continueTask — other states', () => {
  test('unknown task, terminal states and concurrent processing are rejected', async () => {
    const { pipeline } = freshPipeline();
    await expect(pipeline.continueTask(99, 'x')).rejects.toThrow('Task #99 not found');

    seedTask({ id: 2, state: DevTaskState.COMPLETED });
    await expect(pipeline.continueTask(2, 'x')).rejects.toThrow(
      'Task #2 is already completed, cannot continue',
    );
  });

  test('AWAITING_MERGE continues by merging the PR', async () => {
    const task = seedTask({ state: DevTaskState.AWAITING_MERGE, pr_number: 12 });
    const { pipeline } = freshPipeline();

    const result = await pipeline.continueTask(task.id, 'x');

    expect(mergePRMock).toHaveBeenCalledWith(12);
    expect(result.state).toBe(DevTaskState.COMPLETED);
  });

  test('AWAITING_REVIEW continues by accepting the review (UPDATING)', async () => {
    const task = seedTask({ state: DevTaskState.AWAITING_REVIEW, worktree_path: DEAD_WORKTREE });
    const { pipeline } = freshPipeline();

    const result = await pipeline.continueTask(task.id, 'x');

    expect(result.state).toBe(DevTaskState.UPDATING);
  });

  test('another active state is re-triggered in place with a "resuming from" notice', async () => {
    const task = seedTask({ state: DevTaskState.TESTING, worktree_path: DEAD_WORKTREE });
    const { pipeline, notifyCalls } = freshPipeline();

    const result = await pipeline.continueTask(task.id, 'x');

    expect(result.state).toBe(DevTaskState.TESTING);
    expect(notifyCalls[0]?.message).toBe('▶️ Dev task #1: resuming from testing...');
  });
});
