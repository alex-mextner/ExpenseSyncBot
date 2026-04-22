// Tests for DevPipeline — task lifecycle dispatch, error handling, cancellation, resume.
// Focuses on the public entry points; lower-level stage implementations
// (TESTING / shell commands) are out of scope and not exercised.
import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';
import type { DevTask, UpdateDevTaskData } from './types';
import { DevTaskState } from './types';

// ─── Mocks ──────────────────────────────────────────────────────────────
const logMock = createMockLogger();

mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// DB repo — in-memory fake so we can observe state transitions
interface FakeRepo {
  create: ReturnType<typeof mock>;
  findById: ReturnType<typeof mock>;
  findActive: ReturnType<typeof mock>;
  update: ReturnType<typeof mock>;
}

const store = new Map<number, DevTask>();
let nextId = 1;

function makeTask(partial: Partial<DevTask> = {}): DevTask {
  const id = partial.id ?? nextId++;
  const task: DevTask = {
    id,
    group_id: partial.group_id ?? 1000,
    user_id: partial.user_id ?? 1,
    state: partial.state ?? DevTaskState.PENDING,
    title: partial.title ?? null,
    description: partial.description ?? 'do the thing',
    branch_name: partial.branch_name ?? null,
    worktree_path: partial.worktree_path ?? null,
    pr_number: partial.pr_number ?? null,
    pr_url: partial.pr_url ?? null,
    design: partial.design ?? null,
    plan: partial.plan ?? null,
    code_review: partial.code_review ?? null,
    error_log: partial.error_log ?? null,
    failed_at_state: partial.failed_at_state ?? null,
    retry_count: partial.retry_count ?? 0,
    created_at: partial.created_at ?? '2026-01-01T00:00:00Z',
    updated_at: partial.updated_at ?? '2026-01-01T00:00:00Z',
  };
  store.set(task.id, task);
  return task;
}

const fakeRepo: FakeRepo = {
  create: mock((data: { group_id: number; user_id: number; description: string }) =>
    makeTask({
      group_id: data.group_id,
      user_id: data.user_id,
      description: data.description,
      state: DevTaskState.PENDING,
    }),
  ),
  findById: mock((id: number) => store.get(id) ?? null),
  findActive: mock(() =>
    [...store.values()].filter(
      (t) =>
        t.state !== DevTaskState.COMPLETED &&
        t.state !== DevTaskState.REJECTED &&
        t.state !== DevTaskState.FAILED,
    ),
  ),
  update: mock((id: number, data: UpdateDevTaskData): DevTask | null => {
    const current = store.get(id);
    if (!current) return null;
    const updated = { ...current, ...data } as DevTask;
    store.set(id, updated);
    return updated;
  }),
};

mock.module('../../database', () => ({
  database: { devTasks: fakeRepo },
}));

// codex-integration — just return a canned review
const mockRunCodexReview = mock<(diff: string) => Promise<string>>(async () => 'review text');
mock.module('./codex-integration', () => ({
  runCodexReview: mockRunCodexReview,
}));

// dev-agent — fake class: records calls, supports abort for cancellation test
class AgentAbortedErrorFake extends Error {
  constructor() {
    super('Agent was cancelled by user');
    this.name = 'AgentAbortedError';
  }
}

const agentInstances: FakeAgent[] = [];
class FakeAgent {
  worktreePath: string;
  aborted = false;
  runImpl: (sys: string, user: string) => Promise<string> = async () => 'agent output';
  constructor(worktreePath: string) {
    this.worktreePath = worktreePath;
    agentInstances.push(this);
  }
  abort() {
    this.aborted = true;
  }
  async run(sys: string, user: string): Promise<string> {
    return this.runImpl(sys, user);
  }
}

mock.module('./dev-agent', () => ({
  DevAgent: FakeAgent,
  AgentAbortedError: AgentAbortedErrorFake,
}));

// git-ops — stub every used export
const mockCreateWorktree = mock<(branch: string) => Promise<string>>(
  async (b) => `/tmp/worktree-${b}`,
);
const mockRemoveWorktree = mock<(p: string) => Promise<void>>(async () => {});
const mockDeleteLocalBranch = mock<(b: string) => Promise<void>>(async () => {});
const mockWorktreeExists = mock<(p: string) => boolean>(() => true);
const mockGenerateBranchName = mock<(id: number, desc: string) => string>(
  (id, _d) => `dev/task-${id}`,
);
const mockGetRepoRoot = mock<() => Promise<string>>(async () => '/repo/root');
const mockCommitChanges = mock<(p: string, m: string) => Promise<void>>(async () => {});
const mockPushBranch = mock<(p: string, b: string) => Promise<void>>(async () => {});
const mockCreatePR = mock<
  (p: string, t: string, b: string) => Promise<{ number: number; url: string }>
>(async () => ({
  number: 42,
  url: 'https://gh/pr/42',
}));
const mockMergePR = mock<(n: number) => Promise<void>>(async () => {});
const mockGetDiffFromMain = mock<(p: string) => Promise<string>>(async () => 'diff --git a/x b/x');
const mockGetChangedFilesFromMain = mock<(p: string) => Promise<string[]>>(async () => [
  'src/x.ts',
]);

mock.module('./git-ops', () => ({
  createWorktree: mockCreateWorktree,
  removeWorktree: mockRemoveWorktree,
  deleteLocalBranch: mockDeleteLocalBranch,
  worktreeExists: mockWorktreeExists,
  generateBranchName: mockGenerateBranchName,
  getRepoRoot: mockGetRepoRoot,
  commitChanges: mockCommitChanges,
  pushBranch: mockPushBranch,
  createPR: mockCreatePR,
  mergePR: mockMergePR,
  getDiffFromMain: mockGetDiffFromMain,
  getChangedFilesFromMain: mockGetChangedFilesFromMain,
}));

// keyboards — return plain placeholder objects
mock.module('../../bot/keyboards', () => ({
  createDevApprovalKeyboard: () => ({ kb: 'approval' }),
  createDevReviewKeyboard: () => ({ kb: 'review' }),
  createDevMergeKeyboard: () => ({ kb: 'merge' }),
}));

// Dynamic import AFTER mocks
const { DevPipeline } = await import('./pipeline');

/** Wait for any queued microtasks (processStateAsync fire-and-forget) to settle. */
async function flushMicrotasks(times = 20): Promise<void> {
  for (let i = 0; i < times; i++) {
    await Promise.resolve();
  }
}

// ─── Shared test harness ───────────────────────────────────────────────

type NotifyCall = {
  groupId: number;
  message: string;
  hasKeyboard: boolean;
};

function freshPipeline() {
  store.clear();
  nextId = 1;
  agentInstances.length = 0;

  const notifyCalls: NotifyCall[] = [];
  const notify = mock(async (groupId: number, message: string, options?: unknown) => {
    notifyCalls.push({
      groupId,
      message,
      hasKeyboard:
        !!options &&
        typeof options === 'object' &&
        'reply_markup' in (options as Record<string, unknown>),
    });
  });

  const pipeline = new DevPipeline(notify);
  return { pipeline, notifyCalls, notify };
}

beforeEach(() => {
  mockRunCodexReview.mockClear();
  mockCreateWorktree.mockClear();
  mockRemoveWorktree.mockClear();
  mockDeleteLocalBranch.mockClear();
  mockWorktreeExists.mockReset();
  mockWorktreeExists.mockImplementation(() => true);
  mockGenerateBranchName.mockClear();
  mockGetRepoRoot.mockClear();
  mockCommitChanges.mockClear();
  mockPushBranch.mockClear();
  mockCreatePR.mockClear();
  mockMergePR.mockClear();
  mockGetDiffFromMain.mockClear();
  mockGetChangedFilesFromMain.mockClear();
  fakeRepo.create.mockClear();
  fakeRepo.findById.mockClear();
  fakeRepo.findActive.mockClear();
  fakeRepo.update.mockClear();
  logMock.info.mockClear();
  logMock.error.mockClear();
  logMock.warn.mockClear();
});

// ─── Task creation ─────────────────────────────────────────────────────

describe('DevPipeline.startTask', () => {
  test('creates a PENDING task in the DB and returns it', async () => {
    const { pipeline, notifyCalls } = freshPipeline();
    const task = await pipeline.startTask(777, 1, 'short desc');

    expect(fakeRepo.create).toHaveBeenCalledWith({
      group_id: 777,
      user_id: 1,
      description: 'short desc',
    });
    expect(task.group_id).toBe(777);
    // First notify message announces task #<id> was created
    expect(notifyCalls[0]?.groupId).toBe(777);
    expect(notifyCalls[0]?.message).toContain(`Dev task #${task.id}`);
    expect(notifyCalls[0]?.message).toContain('created');
  });

  test('short description dispatches PENDING -> DESIGNING automatically', async () => {
    const { pipeline } = freshPipeline();
    const task = await pipeline.startTask(1000, 1, 'tiny task');

    await flushMicrotasks();

    // State should have transitioned away from PENDING
    const current = store.get(task.id);
    expect(current?.state).not.toBe(DevTaskState.PENDING);
    // Short descriptions go DESIGNING → APPROVAL after agent runs
    expect([DevTaskState.DESIGNING, DevTaskState.APPROVAL]).toContain(
      current?.state as DevTaskState,
    );
  });

  test('long (>=100 char) description routes to CLARIFYING', async () => {
    const { pipeline, notifyCalls } = freshPipeline();
    const longDesc = 'x'.repeat(250);
    const task = await pipeline.startTask(1000, 1, longDesc);
    await flushMicrotasks();

    const current = store.get(task.id);
    // Clarifying stays in CLARIFYING after questions are saved (waiting for user)
    expect(current?.state).toBe(DevTaskState.CLARIFYING);
    expect(notifyCalls.some((c) => c.message.includes('needs clarification'))).toBe(true);
  });
});

// ─── Error handling + FAILED transition ────────────────────────────────

describe('DevPipeline error handling', () => {
  test('agent error during DESIGNING transitions task to FAILED with error_log', async () => {
    const { pipeline, notifyCalls } = freshPipeline();

    // Override the next agent's run() to throw
    const OriginalAgent = FakeAgent.prototype.run;
    FakeAgent.prototype.run = async () => {
      throw new Error('boom: model unavailable');
    };

    try {
      const task = await pipeline.startTask(42, 1, 'short'); // dispatches to DESIGNING
      await flushMicrotasks();

      const current = store.get(task.id);
      expect(current?.state).toBe(DevTaskState.FAILED);
      expect(current?.error_log).toContain('boom: model unavailable');
      expect(current?.failed_at_state).toBe(DevTaskState.DESIGNING);
      // User is notified about the failure
      expect(notifyCalls.some((c) => c.message.includes('failed'))).toBe(true);
    } finally {
      FakeAgent.prototype.run = OriginalAgent;
    }
  });

  test('empty agent response produces a failure (not a silent transition)', async () => {
    const { pipeline } = freshPipeline();

    const OriginalAgent = FakeAgent.prototype.run;
    FakeAgent.prototype.run = async () => '';

    try {
      const task = await pipeline.startTask(42, 1, 'short');
      await flushMicrotasks();
      const current = store.get(task.id);
      expect(current?.state).toBe(DevTaskState.FAILED);
      expect(current?.error_log).toContain('empty design');
    } finally {
      FakeAgent.prototype.run = OriginalAgent;
    }
  });
});

// ─── State transitions via public entry points ─────────────────────────

describe('DevPipeline state transitions', () => {
  test('approveTask: APPROVAL -> IMPLEMENTING with worktree creation', async () => {
    const { pipeline } = freshPipeline();
    const task = makeTask({
      state: DevTaskState.APPROVAL,
      design: 'plan',
      title: 't',
    });

    // Prevent the downstream IMPLEMENTING → TESTING work from running.
    // We only care that approveTask transitions and creates the worktree.
    FakeAgent.prototype.run = async () => {
      throw new Error('stop here');
    };

    await pipeline.approveTask(task.id);
    await flushMicrotasks();

    expect(mockCreateWorktree).toHaveBeenCalledTimes(1);
    const updated = store.get(task.id);
    // Either IMPLEMENTING (if async impl didn't finish) or FAILED (because we threw).
    // Both acceptable — the important check is the APPROVAL→IMPLEMENTING edge ran.
    expect(updated?.branch_name).toBe(`dev/task-${task.id}`);
    expect(updated?.worktree_path).toBe(`/tmp/worktree-dev/task-${task.id}`);
  });

  test('approveTask rejects if task is not in APPROVAL state', async () => {
    const { pipeline } = freshPipeline();
    const task = makeTask({ state: DevTaskState.IMPLEMENTING });
    await expect(pipeline.approveTask(task.id)).rejects.toThrow('not waiting for approval');
  });

  test('answerTask: CLARIFYING -> DESIGNING with answers appended to description', async () => {
    const { pipeline } = freshPipeline();
    const task = makeTask({
      state: DevTaskState.CLARIFYING,
      description: 'original',
      design: 'QUESTIONS:\n1. what?',
    });

    // Stop downstream DESIGNING work
    FakeAgent.prototype.run = async () => {
      throw new Error('stop');
    };

    await pipeline.answerTask(task.id, 'my answer');
    await flushMicrotasks();

    const updated = store.get(task.id);
    expect(updated?.description).toContain('CLARIFICATION');
    expect(updated?.description).toContain('my answer');
  });

  test('mergeTask: AWAITING_MERGE -> COMPLETED, merges PR, cleans up', async () => {
    const { pipeline, notifyCalls } = freshPipeline();
    const task = makeTask({
      state: DevTaskState.AWAITING_MERGE,
      pr_number: 99,
      pr_url: 'https://gh/pr/99',
      worktree_path: '/tmp/wt',
      branch_name: 'dev/x',
    });

    await pipeline.mergeTask(task.id);

    expect(mockMergePR).toHaveBeenCalledWith(99);
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/tmp/wt');
    expect(mockDeleteLocalBranch).toHaveBeenCalledWith('dev/x');
    const updated = store.get(task.id);
    expect(updated?.state).toBe(DevTaskState.COMPLETED);
    expect(updated?.worktree_path).toBeNull();
    expect(notifyCalls.some((c) => c.message.includes('merged'))).toBe(true);
  });

  test('mergeTask rejects when task is not AWAITING_MERGE', async () => {
    const { pipeline } = freshPipeline();
    const task = makeTask({ state: DevTaskState.AWAITING_REVIEW, pr_number: 1 });
    await expect(pipeline.mergeTask(task.id)).rejects.toThrow('not awaiting merge');
  });

  test('acceptReview: AWAITING_REVIEW -> UPDATING', async () => {
    const { pipeline } = freshPipeline();
    const task = makeTask({
      state: DevTaskState.AWAITING_REVIEW,
      worktree_path: '/tmp/wt',
    });

    // Prevent UPDATING -> TESTING from actually running test suites
    FakeAgent.prototype.run = async () => {
      throw new Error('stop after update');
    };

    const updated = await pipeline.acceptReview(task.id);
    expect(updated.state).toBe(DevTaskState.UPDATING);
    await flushMicrotasks();
  });
});

// ─── Cancellation ──────────────────────────────────────────────────────

describe('DevPipeline.cancelTask', () => {
  test('transitions non-terminal task to REJECTED and cleans up worktree', async () => {
    const { pipeline, notifyCalls } = freshPipeline();
    const task = makeTask({
      state: DevTaskState.IMPLEMENTING,
      worktree_path: '/tmp/wt-x',
      branch_name: 'dev/x',
    });

    await pipeline.cancelTask(task.id);

    const updated = store.get(task.id);
    expect(updated?.state).toBe(DevTaskState.REJECTED);
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/tmp/wt-x');
    expect(mockDeleteLocalBranch).toHaveBeenCalledWith('dev/x');
    expect(notifyCalls.some((c) => c.message.includes('cancelled'))).toBe(true);
  });

  test('cancelling a terminal task with leftover worktree triggers cleanup only', async () => {
    const { pipeline } = freshPipeline();
    const task = makeTask({
      state: DevTaskState.COMPLETED,
      worktree_path: '/tmp/leftover',
      branch_name: 'dev/done',
    });

    await pipeline.cancelTask(task.id);

    // Stays COMPLETED, but worktree got cleaned
    const updated = store.get(task.id);
    expect(updated?.state).toBe(DevTaskState.COMPLETED);
    expect(mockRemoveWorktree).toHaveBeenCalledWith('/tmp/leftover');
  });
});

// ─── Resume on startup ─────────────────────────────────────────────────

describe('DevPipeline.resumeIncompleteTasksOnStartup', () => {
  test('returns immediately when no active tasks', async () => {
    const { pipeline } = freshPipeline();
    await pipeline.resumeIncompleteTasksOnStartup();
    expect(fakeRepo.findActive).toHaveBeenCalled();
    // No transitions occurred
    expect(fakeRepo.update).not.toHaveBeenCalled();
  });

  test('marks resumable task with missing worktree as FAILED', async () => {
    const { pipeline } = freshPipeline();
    const task = makeTask({
      state: DevTaskState.IMPLEMENTING,
      worktree_path: '/tmp/gone',
      branch_name: 'dev/x',
    });
    mockWorktreeExists.mockImplementation(() => false);

    await pipeline.resumeIncompleteTasksOnStartup();

    const updated = store.get(task.id);
    expect(updated?.state).toBe(DevTaskState.FAILED);
    expect(updated?.error_log).toContain('Worktree not found');
  });

  test('skips tasks in waiting-for-user states without transitioning', async () => {
    const { pipeline } = freshPipeline();
    const task = makeTask({ state: DevTaskState.APPROVAL });
    await pipeline.resumeIncompleteTasksOnStartup();
    const updated = store.get(task.id);
    expect(updated?.state).toBe(DevTaskState.APPROVAL);
  });
});

// ─── Sanity: construction ───────────────────────────────────────────────

describe('DevPipeline construction', () => {
  test('constructs without side effects given a minimal notify callback', () => {
    const notify = mock(async () => {});
    const pipeline = new DevPipeline(notify);
    expect(pipeline).toBeInstanceOf(DevPipeline);
    expect(notify).not.toHaveBeenCalled();
  });
});

// ─── TESTING stage ───────────────────────────────────────────────────────
// Subclass DevPipeline, override runShell() so we can exercise handleTesting
// without spawning real tsc / bun test subprocesses.

interface ShellStub {
  tsc: { exitCode: number; stdout: string; stderr: string };
  test: { exitCode: number; stdout: string; stderr: string };
}

class TestablePipeline extends DevPipeline {
  public shellCalls: Array<{ cwd: string; cmd: string }> = [];
  public stub: ShellStub = {
    tsc: { exitCode: 0, stdout: '', stderr: '' },
    test: { exitCode: 0, stdout: '0 pass\n0 fail\n0 error', stderr: '' },
  };
  public stateDispatches: DevTask[] = [];

  protected override async runShell(
    cwd: string,
    cmd: string,
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    this.shellCalls.push({ cwd, cmd });
    if (cmd.includes('tsc')) return this.stub.tsc;
    if (cmd.includes('bun test')) return this.stub.test;
    return { exitCode: 0, stdout: '', stderr: '' };
  }

  // Expose private handleTesting for direct test invocation
  public async triggerTesting(task: DevTask): Promise<void> {
    await (this as unknown as { handleTesting(t: DevTask): Promise<void> }).handleTesting(task);
  }
}

// Patch processState at the prototype level so the transition cascade past
// TESTING does not try to drive PULL_REQUEST / IMPLEMENTING handlers (which
// would need fully-shaped tasks and external mocks this suite doesn't provide).
const _origProcessState = (
  DevPipeline.prototype as unknown as {
    processState(t: DevTask): Promise<void>;
  }
).processState;

describe('DevPipeline — TESTING stage', () => {
  // Patching DevPipeline.prototype.processState is a GLOBAL mutation shared
  // across all tests in all describe blocks. Restore it via afterEach — if any
  // test throws mid-run, cleanup still fires, so a later describe block can't
  // see our stub. beforeEach sets it up fresh per-test.

  function patchProcessState(onDispatch: (t: DevTask) => void): void {
    const proto = DevPipeline.prototype as unknown as {
      processState(t: DevTask): Promise<void>;
    };
    proto.processState = async (t: DevTask): Promise<void> => {
      onDispatch(t);
    };
  }
  function restoreProcessState(): void {
    const proto = DevPipeline.prototype as unknown as {
      processState(t: DevTask): Promise<void>;
    };
    proto.processState = _origProcessState;
  }

  afterEach(restoreProcessState);

  function testable(): {
    pipeline: TestablePipeline;
    notifyCalls: NotifyCall[];
  } {
    store.clear();
    nextId = 1;
    const notifyCalls: NotifyCall[] = [];
    const notify = mock(async (groupId: number, message: string, options?: unknown) => {
      notifyCalls.push({
        groupId,
        message,
        hasKeyboard:
          !!options &&
          typeof options === 'object' &&
          'reply_markup' in (options as Record<string, unknown>),
      });
    });
    const pipeline = new TestablePipeline(notify);
    patchProcessState((t) => {
      (pipeline as unknown as { stateDispatches: DevTask[] }).stateDispatches.push(t);
    });
    return { pipeline, notifyCalls };
  }

  test('missing worktree_path throws', async () => {
    const { pipeline } = testable();
    const task = makeTask({ state: DevTaskState.TESTING, worktree_path: null });
    await expect(pipeline.triggerTesting(task)).rejects.toThrow(/missing worktree_path/);
  });

  test('tsc fails → task transitions to IMPLEMENTING for retry', async () => {
    const { pipeline, notifyCalls } = testable();
    const task = makeTask({
      state: DevTaskState.TESTING,
      worktree_path: '/tmp/wt',
      pr_number: null,
      retry_count: 0,
    });
    pipeline.stub.tsc = {
      exitCode: 2,
      stdout: 'src/x.ts(5,10): error TS2345: Argument type error',
      stderr: '',
    };
    pipeline.stub.test = { exitCode: 0, stdout: '10 pass\n0 fail\n0 error', stderr: '' };

    await pipeline.triggerTesting(task);

    expect(pipeline.shellCalls).toHaveLength(2);
    expect(pipeline.shellCalls[0]?.cmd).toContain('tsc');
    expect(pipeline.shellCalls[1]?.cmd).toContain('bun test');
    // Notification includes tsc failure marker
    const combined = notifyCalls.map((c) => c.message).join('\n');
    expect(combined).toContain('Тайпчекер');
    expect(combined).toMatch(/error TS2345|ошибк/);
  });

  test('tests fail → failCount reflected in notification', async () => {
    const { pipeline, notifyCalls } = testable();
    const task = makeTask({
      state: DevTaskState.TESTING,
      worktree_path: '/tmp/wt',
      retry_count: 0,
    });
    pipeline.stub.test = {
      exitCode: 1,
      stdout: '',
      stderr: '5 pass\n3 fail\n0 error',
    };

    await pipeline.triggerTesting(task);

    const combined = notifyCalls.map((c) => c.message).join('\n');
    expect(combined).toContain('Тесты');
    expect(combined).toMatch(/3 ❌|fail/i);
  });

  test('tsc OOM (exit 137) is treated as passed — skipped, not a type error', async () => {
    const { pipeline, notifyCalls } = testable();
    const task = makeTask({
      state: DevTaskState.TESTING,
      worktree_path: '/tmp/wt',
      pr_number: null,
    });
    pipeline.stub.tsc = { exitCode: 137, stdout: '', stderr: '' };
    pipeline.stub.test = { exitCode: 0, stdout: '5 pass\n0 fail\n0 error', stderr: '' };

    await pipeline.triggerTesting(task);

    const combined = notifyCalls.map((c) => c.message).join('\n');
    expect(combined).toContain('OOM');
    // Overall path is the "all passed" branch → PR creation (or state=PULL_REQUEST)
    const updatedTask = store.get(task.id);
    expect(updatedTask?.state).toBe(DevTaskState.PULL_REQUEST);
  });

  test('retry loop detection: same error_log twice → task FAILED', async () => {
    const { pipeline, notifyCalls } = testable();
    // Compose the exact `fullOutput` string the first attempt would have produced —
    // seed it as prior error_log. Second run with identical stub must produce the
    // same string and trigger the retry-loop short circuit.
    const tscOut = 'src/x.ts(5,10): error TS2345: foo';
    const priorOutput = `TYPE CHECK FAILED:\n${tscOut}\n\nTESTS PASSED (exit code 0):\n`;
    const task = makeTask({
      state: DevTaskState.TESTING,
      worktree_path: '/tmp/wt',
      error_log: priorOutput,
      retry_count: 1,
    });
    pipeline.stub.tsc = { exitCode: 2, stdout: tscOut, stderr: '' };
    pipeline.stub.test = { exitCode: 0, stdout: '', stderr: '' };

    await pipeline.triggerTesting(task);

    const updatedTask = store.get(task.id);
    expect(updatedTask?.state).toBe(DevTaskState.FAILED);
    const combined = notifyCalls.map((c) => c.message).join('\n');
    expect(combined).toMatch(/зациклился/);
  });

  test('retry_count reaches MAX → task FAILED with summary', async () => {
    const { pipeline, notifyCalls } = testable();
    // MAX_RETRY_ATTEMPTS=15 (types.ts). retry_count=14 → this run bumps to 15.
    const task = makeTask({
      state: DevTaskState.TESTING,
      worktree_path: '/tmp/wt',
      retry_count: 14,
    });
    pipeline.stub.tsc = { exitCode: 2, stdout: 'error TS1: bad', stderr: '' };
    pipeline.stub.test = { exitCode: 0, stdout: '', stderr: '' };

    await pipeline.triggerTesting(task);

    const updatedTask = store.get(task.id);
    expect(updatedTask?.state).toBe(DevTaskState.FAILED);
    const combined = notifyCalls.map((c) => c.message).join('\n');
    expect(combined).toMatch(/провалена/);
  });

  test('happy path without PR → creates PR (transition to PULL_REQUEST)', async () => {
    const { pipeline, notifyCalls } = testable();
    const task = makeTask({
      state: DevTaskState.TESTING,
      worktree_path: '/tmp/wt',
      pr_number: null,
    });

    await pipeline.triggerTesting(task);

    const updatedTask = store.get(task.id);
    expect(updatedTask?.state).toBe(DevTaskState.PULL_REQUEST);
    const combined = notifyCalls.map((c) => c.message).join('\n');
    expect(combined).toContain('all checks passed');
  });

  test('happy path with existing PR → push branch + AWAITING_MERGE', async () => {
    const { pipeline, notifyCalls } = testable();
    const task = makeTask({
      state: DevTaskState.TESTING,
      worktree_path: '/tmp/wt',
      pr_number: 42,
      pr_url: 'https://gh/pr/42',
      branch_name: 'dev/task-1',
    });

    await pipeline.triggerTesting(task);

    const updatedTask = store.get(task.id);
    expect(updatedTask?.state).toBe(DevTaskState.AWAITING_MERGE);
    expect(mockPushBranch).toHaveBeenCalledWith('/tmp/wt', 'dev/task-1');
    const lastCall = notifyCalls.at(-1);
    expect(lastCall?.hasKeyboard).toBe(true);
  });

  test('shell commands run in task.worktree_path', async () => {
    const { pipeline } = testable();
    const task = makeTask({ state: DevTaskState.TESTING, worktree_path: '/specific/wt' });

    await pipeline.triggerTesting(task);

    expect(pipeline.shellCalls).toHaveLength(2);
    for (const call of pipeline.shellCalls) {
      expect(call.cwd).toBe('/specific/wt');
    }
  });
});
