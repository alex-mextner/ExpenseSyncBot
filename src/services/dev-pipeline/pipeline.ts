/**
 * Dev Pipeline Orchestrator.
 *
 * The main brain of the self-modifying bot. Manages the lifecycle
 * of development tasks from creation to merge. Each task goes through
 * a state machine with 12 states.
 *
 * The pipeline is designed to be resumable — tasks in progress are
 * recovered on bot startup by checking worktree existence.
 *
 */

import { $ } from 'bun';
import type { InlineKeyboard } from 'gramio';
import {
  createDevApprovalKeyboard,
  createDevMergeKeyboard,
  createDevReviewKeyboard,
} from '../../bot/keyboards';
import { database } from '../../database';
import { getErrorMessage } from '../../utils/error';
import { escapeHtml } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import { runCodexReview } from './codex-integration';
import { AgentAbortedError, DevAgent } from './dev-agent';
import {
  commitChanges,
  createPR,
  createWorktree,
  deleteLocalBranch,
  generateBranchName,
  getChangedFilesFromMain,
  getDiffFromMain,
  getRepoRoot,
  mergePR,
  pushBranch,
  removeWorktree,
  worktreeExists,
} from './git-ops';
import {
  type AgentPrompt,
  buildFirstRunPrompt,
  buildResumePrompt,
  buildRetryPrompt,
  buildReviewFixPrompt,
  CLARIFYING_SYSTEM_PROMPT,
  DESIGN_SYSTEM_PROMPT,
} from './prompts';
import { isResumableState, isTerminalState, validateTransition } from './state-machine';
import {
  buildFullOutput,
  formatAllPassedMessage,
  formatFailureReportLines,
  parseTestCounts,
  type TestingOutcome,
} from './test-report';
import { type DevTask, DevTaskState, MAX_RETRY_ATTEMPTS, type UpdateDevTaskData } from './types';

const logger = createLogger('pipeline');

/**
 * Notification callback type.
 * The pipeline calls this to send messages to Telegram.
 */
export type NotifyCallback = (
  groupId: number,
  message: string,
  options?: { reply_markup?: InlineKeyboard },
) => Promise<void>;

/**
 * Transition a task to a new state and persist to database.
 */
function transition(
  task: DevTask,
  newState: DevTaskState,
  extra?: Partial<UpdateDevTaskData>,
): DevTask {
  validateTransition(task.id, task.state, newState);

  const updateData: UpdateDevTaskData = {
    ...extra,
    state: newState,
  };

  logger.info(`[DEV-PIPELINE] Task #${task.id}: ${task.state} -> ${newState}`);

  const updated = database.devTasks.update(task.id, updateData);

  if (!updated) {
    throw new Error(`Failed to update task #${task.id}`);
  }

  return updated;
}

/**
 * Shell command result — mirrors the subset of Bun.$ output we actually consume.
 */
export interface ShellResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Dev Pipeline class — manages the full lifecycle of dev tasks.
 */
export class DevPipeline {
  private notify: NotifyCallback;
  private activeAgents = new Map<number, DevAgent>();
  private processingTasks = new Set<number>();

  constructor(notify: NotifyCallback) {
    this.notify = notify;
  }

  /**
   * Run a shell command in a working directory. Overridable in tests so the
   * TESTING stage (tsc + bun test) can be exercised without spawning real
   * subprocesses. `nothrow` is implicit — callers inspect `exitCode`.
   *
   * ⚠️ SECURITY: `command` is interpolated via Bun Shell's `{ raw }` escape
   * hatch, which **bypasses shell escaping**. Callers MUST pass only
   * hard-coded literal strings (e.g. `'bun x tsc --noEmit'`). Never pass
   * task fields, user input, or any value derived from them — that is a
   * shell-injection vector. `cwd` IS escaped by Bun Shell's normal
   * interpolation and is safe.
   */
  protected async runShell(cwd: string, command: string): Promise<ShellResult> {
    const result = await $`cd ${cwd} && ${{ raw: command }}`.nothrow().quiet();
    return {
      exitCode: result.exitCode,
      stdout: result.text().trim(),
      stderr: result.stderr.toString().trim(),
    };
  }

  /**
   * Run an agent for a task, tracking it for cancellation.
   */
  private async runAgent(
    taskId: number,
    agent: DevAgent,
    systemPrompt: string,
    userMessage: string,
  ): Promise<string> {
    this.activeAgents.set(taskId, agent);
    try {
      return await agent.run(systemPrompt, userMessage);
    } finally {
      this.activeAgents.delete(taskId);
    }
  }

  /**
   * Abort a running agent for a task.
   */
  private abortAgent(taskId: number): void {
    const agent = this.activeAgents.get(taskId);
    if (agent) {
      agent.abort();
      this.activeAgents.delete(taskId);
    }
  }

  /**
   * Clean up worktree directory and local branch for a task.
   * Also clears worktree_path in the database.
   */
  private async cleanupWorktree(task: DevTask): Promise<void> {
    if (task.worktree_path) {
      await removeWorktree(task.worktree_path);
    }
    if (task.branch_name) {
      await deleteLocalBranch(task.branch_name);
    }
    if (task.worktree_path || task.branch_name) {
      database.devTasks.update(task.id, { worktree_path: null });
    }
  }

  /**
   * Start a new dev task.
   *
   * Creates a record in the database and begins processing.
   */
  async startTask(groupId: number, userId: number, description: string): Promise<DevTask> {
    // Create task record
    const task = database.devTasks.create({
      group_id: groupId,
      user_id: userId,
      description,
    });

    await this.notify(groupId, `🔵 Dev task #${task.id} created:\n${description}`);

    // Start processing asynchronously (don't block the command)
    this.processStateAsync(task);

    return task;
  }

  /**
   * Process a task's current state asynchronously.
   * Wraps processState in a try/catch and handles errors.
   */
  private async processStateAsync(task: DevTask): Promise<void> {
    if (this.processingTasks.has(task.id)) {
      logger.info(
        `[DEV-PIPELINE] Task #${task.id} already being processed, skipping duplicate run`,
      );
      return;
    }
    this.processingTasks.add(task.id);

    try {
      await this.processState(task);
    } catch (error) {
      // Agent was aborted because user cancelled — task is already REJECTED, nothing to do
      if (error instanceof AgentAbortedError) {
        logger.info(`[DEV-PIPELINE] Task #${task.id} agent aborted (cancelled by user)`);
        return;
      }

      logger.error({ err: error }, `[DEV-PIPELINE] Error processing task #${task.id}`);
      const errorMsg = getErrorMessage(error);

      // Re-read task from DB to get the actual current state (task object may be stale)
      const freshTask = database.devTasks.findById(task.id);
      if (freshTask && !isTerminalState(freshTask.state)) {
        try {
          transition(freshTask, DevTaskState.FAILED, {
            error_log: errorMsg,
            failed_at_state: freshTask.state,
          });
        } catch (transitionErr) {
          logger.error(
            { err: transitionErr, taskId: task.id, fromState: freshTask.state },
            '[DEV-PIPELINE] Cannot transition task to FAILED',
          );
        }
      }

      await this.notify(task.group_id, `💥 Dev task #${task.id} failed:\n${errorMsg}`);
    } finally {
      this.processingTasks.delete(task.id);
    }
  }

  /**
   * Process the current state of a task.
   *
   * This is the state machine dispatcher — it routes to the appropriate
   * handler based on the task's current state.
   */
  async processState(task: DevTask): Promise<void> {
    if (isTerminalState(task.state)) {
      return; // Nothing to do
    }

    switch (task.state) {
      case DevTaskState.PENDING:
        await this.handlePending(task);
        break;
      case DevTaskState.CLARIFYING:
        await this.handleClarifying(task);
        break;
      case DevTaskState.DESIGNING:
        await this.handleDesigning(task);
        break;
      case DevTaskState.APPROVAL:
        // Wait for user — do nothing
        break;
      case DevTaskState.IMPLEMENTING:
        await this.handleImplementing(task);
        break;
      case DevTaskState.TESTING:
        await this.handleTesting(task);
        break;
      case DevTaskState.PULL_REQUEST:
        await this.handlePullRequest(task);
        break;
      case DevTaskState.REVIEWING:
        await this.handleReviewing(task);
        break;
      case DevTaskState.AWAITING_REVIEW:
        // Wait for user — do nothing
        break;
      case DevTaskState.AWAITING_MERGE:
        // Wait for user — do nothing
        break;
      case DevTaskState.UPDATING:
        await this.handleUpdating(task);
        break;
    }
  }

  /**
   * Handle PENDING state: decide if we need clarification or jump to design.
   *
   * For now, we skip clarification and go straight to designing.
   * When AI tool_use is available, this will analyze the description
   * and ask clarifying questions if needed.
   */
  private async handlePending(task: DevTask): Promise<void> {
    // Short clear descriptions → design directly, ambiguous → clarify
    if (task.description.length < 100) {
      logger.info(`[DEV-PIPELINE] Task #${task.id}: short description, going to DESIGNING`);
      const updated = transition(task, DevTaskState.DESIGNING);
      await this.processState(updated);
    } else {
      logger.info(`[DEV-PIPELINE] Task #${task.id}: long description, going to CLARIFYING`);
      const updated = transition(task, DevTaskState.CLARIFYING);
      await this.processState(updated);
    }
  }

  /**
   * Handle CLARIFYING state: AI generates questions, waits for user answer.
   */
  private async handleClarifying(task: DevTask): Promise<void> {
    await this.notify(task.group_id, `💬 Dev task #${task.id}: analyzing requirements...`);

    const agent = new DevAgent(await getRepoRoot());

    const systemPrompt = CLARIFYING_SYSTEM_PROMPT;

    const questions = await this.runAgent(task.id, agent, systemPrompt, task.description);

    if (!questions.trim()) {
      throw new Error('Agent returned empty clarifying questions — no text blocks in response');
    }

    // Save questions (task is already in CLARIFYING, no state transition needed)
    database.devTasks.update(task.id, {
      design: `QUESTIONS:\n${questions}`,
    });

    await this.notify(
      task.group_id,
      `💬 Dev task #${task.id} needs clarification:\n\n${questions}\n\n` +
        `Reply with /dev answer ${task.id} &lt;your answers&gt;\n` +
        `Or /dev approve ${task.id} to skip and proceed with designing.`,
    );
  }

  /**
   * Handle user providing answers to clarifying questions.
   */
  async answerTask(taskId: number, answer: string): Promise<DevTask> {
    const task = database.devTasks.findById(taskId);
    if (!task) {
      throw new Error(`Task #${taskId} not found`);
    }

    if (task.state !== DevTaskState.CLARIFYING) {
      throw new Error(
        `Task #${taskId} is not waiting for clarification (current state: ${task.state})`,
      );
    }

    // Append answers to description for context
    const enrichedDescription = `${task.description}\n\nCLARIFICATION:\nQuestions: ${task.design || ''}\nAnswers: ${answer}`;

    const updated = transition(task, DevTaskState.DESIGNING, {
      design: null, // will be regenerated
    });

    // Update description with clarification context
    database.devTasks.update(taskId, { description: enrichedDescription });
    updated.description = enrichedDescription;

    await this.notify(
      task.group_id,
      `💬 Dev task #${task.id}: answers received, proceeding to design...`,
    );

    this.processStateAsync(updated);
    return updated;
  }

  /**
   * Continue/resume a failed or stuck task with an optional message.
   */
  async continueTask(taskId: number, message: string): Promise<DevTask> {
    if (this.processingTasks.has(taskId)) {
      throw new Error(
        `Task #${taskId} is already being processed, wait for it to finish or cancel first`,
      );
    }

    const task = database.devTasks.findById(taskId);
    if (!task) {
      throw new Error(`Task #${taskId} not found`);
    }

    if (task.state === DevTaskState.COMPLETED || task.state === DevTaskState.REJECTED) {
      throw new Error(`Task #${taskId} is already ${task.state}, cannot continue`);
    }

    switch (task.state) {
      case DevTaskState.FAILED:
        return this.resumeFailedTask(task, message);
      case DevTaskState.CLARIFYING:
        return this.answerTask(taskId, message);
      case DevTaskState.APPROVAL:
        return this.approveTask(taskId);
      case DevTaskState.AWAITING_REVIEW:
        return this.acceptReview(taskId);
      case DevTaskState.AWAITING_MERGE:
        return this.mergeTask(taskId);
      default:
        // For any other active state — re-trigger processing
        await this.notify(task.group_id, `▶️ Dev task #${task.id}: resuming from ${task.state}...`);

        this.processStateAsync(task);
        return task;
    }
  }

  /**
   * Smart resume of a FAILED task: pick the furthest stage whose prerequisites
   * (PR, review, design, worktree) survived the failure.
   */
  private async resumeFailedTask(task: DevTask, message: string): Promise<DevTask> {
    const enrichedDescription =
      message !== 'Продолжай'
        ? `${task.description}\n\nADDITIONAL CONTEXT:\n${message}`
        : task.description;

    database.devTasks.update(task.id, { description: enrichedDescription });

    // Smart resume: check what was already completed before the failure
    const hasWorktree = !!task.worktree_path && worktreeExists(task.worktree_path);

    // PR created + review done → show review buttons immediately
    if (task.pr_number && task.code_review && hasWorktree) {
      const updated = this.reopenAt(task, DevTaskState.AWAITING_REVIEW, enrichedDescription);
      await this.notify(
        task.group_id,
        `🔍 <b>Dev task #${task.id}:</b> resuming — review already done\n\n` +
          `<blockquote expandable>${escapeHtml(task.code_review.slice(0, 1500))}</blockquote>\n\n` +
          `PR: ${task.pr_url}`,
        { reply_markup: createDevReviewKeyboard(task.id) },
      );
      return updated;
    }

    // PR created but no review → run review only
    if (task.pr_number && hasWorktree) {
      return this.resumeAt(
        task,
        DevTaskState.REVIEWING,
        enrichedDescription,
        `▶️ Dev task #${task.id}: resuming — PR exists, running code review...`,
      );
    }

    // Failed at PR/review stage (tests already passed) → create PR
    const failedAt = task.failed_at_state as DevTaskState | null;
    if (
      failedAt &&
      (failedAt === DevTaskState.PULL_REQUEST || failedAt === DevTaskState.REVIEWING) &&
      hasWorktree
    ) {
      return this.resumeAt(
        task,
        DevTaskState.PULL_REQUEST,
        enrichedDescription,
        `▶️ Dev task #${task.id}: resuming — tests passed, creating PR...`,
      );
    }

    // Design + worktree exist → resume implementation
    if (task.design && hasWorktree) {
      // Keep error_log so the agent knows what went wrong last time
      return this.resumeAt(
        task,
        DevTaskState.IMPLEMENTING,
        enrichedDescription,
        `▶️ Dev task #${task.id}: resuming implementation (design and worktree preserved)...`,
      );
    }

    if (task.design) {
      // Design exists but no worktree — re-create worktree and implement
      const branchName = task.branch_name || generateBranchName(task.id, task.description);
      const worktreePath = await createWorktree(branchName);

      return this.resumeAt(
        task,
        DevTaskState.IMPLEMENTING,
        enrichedDescription,
        `▶️ Dev task #${task.id}: resuming implementation (recreated worktree, design preserved)...`,
        { error_log: null, branch_name: branchName, worktree_path: worktreePath },
      );
    }

    // No design — restart from scratch
    return this.resumeAt(
      task,
      DevTaskState.PENDING,
      enrichedDescription,
      `🔄 Dev task #${task.id}: restarting from scratch (no design found)...`,
      { error_log: null },
    );
  }

  /** Transition a FAILED task to `state`, clearing retry bookkeeping, with the enriched description. */
  private reopenAt(
    task: DevTask,
    state: DevTaskState,
    description: string,
    extra?: Partial<UpdateDevTaskData>,
  ): DevTask {
    const updated = transition(task, state, {
      ...extra,
      retry_count: 0,
      failed_at_state: null,
    });
    updated.description = description;
    return updated;
  }

  /** reopenAt + notify + kick off async processing. */
  private async resumeAt(
    task: DevTask,
    state: DevTaskState,
    description: string,
    notice: string,
    extra?: Partial<UpdateDevTaskData>,
  ): Promise<DevTask> {
    const updated = this.reopenAt(task, state, description, extra);
    await this.notify(task.group_id, notice);
    this.processStateAsync(updated);
    return updated;
  }

  /**
   * Handle DESIGNING state: create a design/plan for the task.
   */
  private async handleDesigning(task: DevTask): Promise<void> {
    await this.notify(task.group_id, `📐 Dev task #${task.id}: designing solution...`);

    const agent = new DevAgent(await getRepoRoot());

    const systemPrompt = DESIGN_SYSTEM_PROMPT;

    const design = await this.runAgent(task.id, agent, systemPrompt, task.description);

    if (!design.trim()) {
      throw new Error('Agent returned empty design — no text blocks in response');
    }

    const titleMatch = design.match(/TITLE:\s*(.+)/);
    const title = titleMatch?.[1]?.trim() || task.description.slice(0, 70);

    transition(task, DevTaskState.APPROVAL, { design, title });

    await this.notify(
      task.group_id,
      `📐 Dev task #${task.id} design ready:\n\n<pre>${escapeHtml(design.slice(0, 2000))}</pre>`,
      { reply_markup: createDevApprovalKeyboard(task.id) },
    );
  }

  /**
   * Edit design based on user feedback — re-runs designing with corrections.
   */
  async editDesign(taskId: number, feedback: string): Promise<DevTask> {
    const task = database.devTasks.findById(taskId);
    if (!task) {
      throw new Error(`Task #${taskId} not found`);
    }

    if (task.state !== DevTaskState.APPROVAL) {
      throw new Error(`Task #${taskId} is not in approval state (current: ${task.state})`);
    }

    // Go back to DESIGNING with feedback appended
    const enrichedDescription = `${task.description}\n\nDESIGN FEEDBACK:\nPrevious design:\n${task.design || ''}\n\nUser requested changes:\n${feedback}`;

    const updated = transition(task, DevTaskState.DESIGNING);
    database.devTasks.update(taskId, { description: enrichedDescription });
    updated.description = enrichedDescription;

    await this.notify(task.group_id, `✏️ Dev task #${task.id}: redesigning with your feedback...`);

    this.processStateAsync(updated);
    return updated;
  }

  /**
   * Handle user approval — called from the bot command handler.
   */
  async approveTask(taskId: number): Promise<DevTask> {
    const task = database.devTasks.findById(taskId);
    if (!task) {
      throw new Error(`Task #${taskId} not found`);
    }

    // Allow approve from CLARIFYING (skip questions) or APPROVAL
    if (task.state === DevTaskState.CLARIFYING) {
      const updated = transition(task, DevTaskState.DESIGNING);
      await this.notify(
        task.group_id,
        `⏩ Dev task #${taskId}: skipping clarification, proceeding to design...`,
      );
      this.processStateAsync(updated);
      return updated;
    }

    if (task.state !== DevTaskState.APPROVAL) {
      throw new Error(`Task #${taskId} is not waiting for approval (current state: ${task.state})`);
    }

    // Generate branch name
    const branchName = generateBranchName(task.id, task.description);

    // Create worktree
    const worktreePath = await createWorktree(branchName);

    // Re-read task after async operation to guard against concurrent approvals (TOCTOU)
    const freshTask = database.devTasks.findById(taskId);
    if (!freshTask || freshTask.state !== DevTaskState.APPROVAL) {
      throw new Error(
        `Task #${taskId} state changed during worktree creation (now: ${freshTask?.state})`,
      );
    }

    const updated = transition(freshTask, DevTaskState.IMPLEMENTING, {
      branch_name: branchName,
      worktree_path: worktreePath,
    });

    await this.notify(
      task.group_id,
      `✅ Dev task #${task.id} approved! Starting implementation...`,
    );

    // Continue processing (processStateAsync has its own duplicate-run guard)
    this.processStateAsync(updated);

    return updated;
  }

  /**
   * Cancel a task — works from any non-terminal state, aborts running agents.
   */
  async cancelTask(taskId: number): Promise<DevTask> {
    const task = database.devTasks.findById(taskId);
    if (!task) {
      throw new Error(`Task #${taskId} not found`);
    }

    if (isTerminalState(task.state)) {
      // Already terminal — just clean up worktree/branch if still around
      const hasWorktree = task.worktree_path && worktreeExists(task.worktree_path);
      const hasBranch = !!task.branch_name;
      if (hasWorktree || hasBranch) {
        await this.cleanupWorktree(task);
        await this.notify(task.group_id, `🗑 Dev task #${task.id}: cleaned up.`);
      } else {
        await this.notify(task.group_id, `Task #${taskId} is already ${task.state}.`);
      }
      return task;
    }

    // Abort running agent if task is in an active processing state
    this.abortAgent(taskId);

    const updated = transition(task, DevTaskState.REJECTED);

    // Clean up worktree and local branch
    await this.cleanupWorktree(task);

    await this.notify(task.group_id, `❌ Dev task #${task.id} cancelled.`);

    return updated;
  }

  /**
   * Handle IMPLEMENTING state: write code in the worktree.
   *
   * Placeholder — will use AI tool_use to write actual code.
   */
  private async handleImplementing(task: DevTask): Promise<void> {
    if (!task.worktree_path || !task.branch_name) {
      throw new Error(`Task #${task.id} missing worktree_path or branch_name`);
    }

    const isRetry = (task.retry_count || 0) > 0;

    // Save design plan to docs/plans/ in worktree (first run only)
    if (!isRetry && task.design) {
      await this.savePlanToFile(task);
    }

    await this.notify(
      task.group_id,
      isRetry
        ? `🔧 Dev task #${task.id}: fixing test failures (attempt ${task.retry_count}/${MAX_RETRY_ATTEMPTS})...`
        : `🔨 Dev task #${task.id}: implementing in branch ${task.branch_name}...`,
    );

    const agent = new DevAgent(task.worktree_path);

    // Check if worktree already has commits (code was written in a previous run)
    const hasExistingWork = await this.worktreeHasCommits(task.worktree_path);

    let prompt: AgentPrompt;
    if (isRetry && task.error_log) {
      // RETRY MODE: focused fix after test failure
      prompt = buildRetryPrompt(task, await getChangedFilesFromMain(task.worktree_path));
    } else if (hasExistingWork) {
      // RESUME MODE: code already exists from a previous failed run
      prompt = buildResumePrompt(task);
    } else {
      // FIRST RUN: implement from design using TDD
      prompt = buildFirstRunPrompt(task);
    }

    await this.runAgent(task.id, agent, prompt.systemPrompt, prompt.userMessage);

    const updated = transition(task, DevTaskState.TESTING);
    await this.processState(updated);
  }

  /**
   * Check if the worktree branch has commits beyond main (code was already written).
   */
  private async worktreeHasCommits(worktreePath: string): Promise<boolean> {
    try {
      const result = await $`git -C ${worktreePath} log main..HEAD --oneline`.quiet().nothrow();
      return result.text().trim().length > 0;
    } catch {
      // Expected: git command may fail if worktree is gone
      return false;
    }
  }

  /**
   * Save the design plan to docs/plans/ in the worktree for version control.
   */
  private async savePlanToFile(task: DevTask): Promise<void> {
    if (!task.worktree_path || !task.design) return;

    const plansDir = `${task.worktree_path}/docs/plans`;
    await $`mkdir -p ${plansDir}`.quiet();

    const date = new Date().toISOString().slice(0, 10);
    const slug = (task.title || task.description)
      .toLowerCase()
      .replace(/[^a-z0-9а-яё]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60);
    const filename = `${date}-${slug}.md`;

    const content = `# ${task.title || task.description}\n\nTask #${task.id}\n\n${task.design}`;
    await Bun.write(`${plansDir}/${filename}`, content);
  }

  /**
   * Handle TESTING state: run tests and type checks.
   *
   * Runs `bun test` and `bun x tsc --noEmit` in the worktree.
   * On failure, retries up to MAX_RETRY_ATTEMPTS times.
   */
  private async handleTesting(task: DevTask): Promise<void> {
    if (!task.worktree_path) {
      throw new Error(`Task #${task.id} missing worktree_path`);
    }

    await this.notify(task.group_id, `🧪 Dev task #${task.id}: running tests...`);

    const outcome = await this.runChecks(task.worktree_path);

    // Build full output for error_log (raw, for the AI agent)
    const fullOutput = buildFullOutput(outcome);

    const allPassed = outcome.typeCheckPassed && outcome.testsPassed;

    // Detect retry loops: if error_log is identical to previous attempt, stop early
    if (!allPassed && task.error_log && task.error_log === fullOutput) {
      transition(task, DevTaskState.FAILED, {
        error_log: fullOutput,
        retry_count: (task.retry_count || 0) + 1,
      });
      await this.notify(
        task.group_id,
        `💀 <b>Dev task #${task.id}:</b> одинаковые ошибки 2 раза подряд — агент зациклился. Остановлено.`,
      );
      return;
    }

    if (!allPassed) {
      await this.handleChecksFailed(task, outcome, fullOutput);
    } else if (task.pr_number) {
      await this.handleFixCyclePassed(task, task.worktree_path, outcome);
    } else {
      await this.handleFirstRunPassed(task, outcome);
    }
  }

  /**
   * Run the type check and the test suite in the worktree.
   * Both always run (tests even when tsc fails) so the agent sees every error at once.
   */
  private async runChecks(worktreePath: string): Promise<TestingOutcome> {
    // Run type check — tsc writes errors to stdout
    // NOTE: Bun Shell does not support 2>&1 — always read both streams
    const typeCheckResult = await this.runShell(worktreePath, 'bun x tsc --noEmit');
    const typeCheckExitCode = typeCheckResult.exitCode;
    const tscOOM = typeCheckExitCode === 137;
    const typeCheckPassed = typeCheckExitCode === 0 || tscOOM; // OOM is not a type error
    const typeCheckOutput = tscOOM
      ? 'tsc killed by OOM (exit 137) — not enough server memory, skipped'
      : [typeCheckResult.stdout, typeCheckResult.stderr].filter(Boolean).join('\n');

    // Run tests — bun test writes header to stdout but results/errors to stderr
    const testsResult = await this.runShell(worktreePath, 'bun test');
    const testsOutput = [testsResult.stdout, testsResult.stderr].filter(Boolean).join('\n');

    // Parse test counts from bun test summary (bun 1.3+: "N pass", "N fail", "N error")
    const { pass, fail, error } = parseTestCounts(testsOutput);

    return {
      typeCheckPassed,
      tscOOM,
      typeCheckExitCode,
      typeCheckOutput,
      testsPassed: testsResult.exitCode === 0,
      testExitCode: testsResult.exitCode,
      testsOutput,
      passCount: pass,
      failCount: fail,
      errorCount: error,
    };
  }

  /** Checks passed while a PR already exists: push the fix and show the merge keyboard. */
  private async handleFixCyclePassed(
    task: DevTask,
    worktreePath: string,
    outcome: TestingOutcome,
  ): Promise<void> {
    if (!task.branch_name) throw new Error(`Task #${task.id} has pr_number but no branch_name`);
    await commitChanges(worktreePath, `fix: address review feedback (task #${task.id})`);
    await pushBranch(worktreePath, task.branch_name);

    transition(task, DevTaskState.AWAITING_MERGE);

    await this.notify(task.group_id, formatAllPassedMessage(task.id, outcome, task.pr_url), {
      reply_markup: createDevMergeKeyboard(task.id),
    });
  }

  /** Checks passed on the first run: create the PR (existing flow). */
  private async handleFirstRunPassed(task: DevTask, outcome: TestingOutcome): Promise<void> {
    const updated = transition(task, DevTaskState.PULL_REQUEST);
    await this.notify(task.group_id, formatAllPassedMessage(task.id, outcome));
    await this.processState(updated);
  }

  /** Checks failed: report, then retry via IMPLEMENTING or fail after MAX_RETRY_ATTEMPTS. */
  private async handleChecksFailed(
    task: DevTask,
    outcome: TestingOutcome,
    fullOutput: string,
  ): Promise<void> {
    const retryCount = (task.retry_count || 0) + 1;
    const lines = formatFailureReportLines(task.id, retryCount, outcome);

    if (retryCount >= MAX_RETRY_ATTEMPTS) {
      transition(task, DevTaskState.FAILED, {
        error_log: fullOutput,
        retry_count: retryCount,
      });
      lines.push(`\n💥 Задача провалена после ${retryCount} попыток.`);
      await this.notify(task.group_id, lines.join('\n'));
    } else {
      const updated = transition(task, DevTaskState.IMPLEMENTING, {
        error_log: fullOutput,
        retry_count: retryCount,
      });
      lines.push(`\n🔄 Отправлено на исправление...`);
      await this.notify(task.group_id, lines.join('\n'));
      await this.processState(updated);
    }
  }

  /**
   * Handle PULL_REQUEST state: create a GitHub PR.
   */
  private async handlePullRequest(task: DevTask): Promise<void> {
    if (!task.worktree_path || !task.branch_name) {
      throw new Error(`Task #${task.id} missing worktree_path or branch_name`);
    }

    await this.notify(task.group_id, `📤 Dev task #${task.id}: creating pull request...`);

    // Commit any uncommitted changes
    await commitChanges(task.worktree_path, `feat: ${task.title || task.description}`);

    // Push branch
    await pushBranch(task.worktree_path, task.branch_name);

    // Create PR
    const title = task.title || task.description.slice(0, 70);
    const body =
      `## Summary\n\n${task.description}\n\n` +
      `## Design\n\n${task.design || 'N/A'}\n\n` +
      `---\n` +
      `Automated by ExpenseSyncBot dev pipeline (task #${task.id})`;

    const pr = await createPR(task.worktree_path, title, body);

    const updated = transition(task, DevTaskState.REVIEWING, {
      pr_number: pr.number,
      pr_url: pr.url,
    });

    await this.notify(task.group_id, `📤 Dev task #${task.id}: PR created!\n${pr.url}`);

    await this.processState(updated);
  }

  /**
   * Handle REVIEWING state: run automated code review and show result to user.
   *
   * Always transitions to AWAITING_REVIEW so the user can decide
   * whether to accept, edit, or merge.
   */
  private async handleReviewing(task: DevTask): Promise<void> {
    if (!task.worktree_path) {
      throw new Error(`Task #${task.id} missing worktree_path`);
    }

    await this.notify(task.group_id, `🔍 Dev task #${task.id}: running code review...`);

    const diff = await getDiffFromMain(task.worktree_path);
    const review = await runCodexReview(diff);

    transition(task, DevTaskState.AWAITING_REVIEW, { code_review: review });

    await this.notify(
      task.group_id,
      `🔍 <b>Dev task #${task.id}:</b> code review done\n\n` +
        `<blockquote expandable>${escapeHtml(review.slice(0, 1500))}</blockquote>\n\n` +
        `PR: ${task.pr_url}`,
      { reply_markup: createDevReviewKeyboard(task.id) },
    );
  }

  /**
   * Accept the code review — AI fixes the issues found.
   */
  async acceptReview(taskId: number): Promise<DevTask> {
    const task = database.devTasks.findById(taskId);
    if (!task) throw new Error(`Task #${taskId} not found`);
    if (task.state !== DevTaskState.AWAITING_REVIEW) {
      throw new Error(`Task #${taskId} is not awaiting review (current: ${task.state})`);
    }

    const updated = transition(task, DevTaskState.UPDATING);

    await this.notify(task.group_id, `🔄 Dev task #${task.id}: fixing review issues...`);

    this.processStateAsync(updated);
    return updated;
  }

  /**
   * Merge the PR and complete the task.
   */
  async mergeTask(taskId: number): Promise<DevTask> {
    const task = database.devTasks.findById(taskId);
    if (!task) throw new Error(`Task #${taskId} not found`);
    if (task.state !== DevTaskState.AWAITING_MERGE) {
      throw new Error(`Task #${taskId} is not awaiting merge (current: ${task.state})`);
    }
    if (!task.pr_number) {
      throw new Error(`Task #${taskId} has no PR number`);
    }

    await this.notify(task.group_id, `🚀 Dev task #${task.id}: merging PR #${task.pr_number}...`);

    await mergePR(task.pr_number);

    const updated = transition(task, DevTaskState.COMPLETED);

    await this.cleanupWorktree(task);

    await this.notify(
      task.group_id,
      `✅ Dev task #${task.id} merged and completed!\n\nPR: ${task.pr_url}`,
    );

    return updated;
  }

  /**
   * Edit PR code based on user feedback — transitions to UPDATING.
   */
  async editPR(taskId: number, feedback: string): Promise<DevTask> {
    const task = database.devTasks.findById(taskId);
    if (!task) throw new Error(`Task #${taskId} not found`);

    if (task.state !== DevTaskState.AWAITING_REVIEW && task.state !== DevTaskState.AWAITING_MERGE) {
      throw new Error(`Task #${taskId} is not awaiting review/merge (current: ${task.state})`);
    }

    const updated = transition(task, DevTaskState.UPDATING, {
      code_review: `USER FEEDBACK:\n${feedback}`,
    });

    await this.notify(task.group_id, `✏️ Dev task #${task.id}: applying your changes...`);

    this.processStateAsync(updated);
    return updated;
  }

  /**
   * Handle UPDATING state: address review feedback.
   *
   * Placeholder — will use AI tool_use to fix review issues.
   */
  private async handleUpdating(task: DevTask): Promise<void> {
    if (!task.worktree_path) {
      throw new Error(`Task #${task.id} missing worktree_path`);
    }

    await this.notify(task.group_id, `🔄 Dev task #${task.id}: addressing review feedback...`);

    const { systemPrompt, userMessage } = buildReviewFixPrompt(task);
    const agent = new DevAgent(task.worktree_path);

    await this.runAgent(task.id, agent, systemPrompt, userMessage);

    const updated = transition(task, DevTaskState.TESTING);
    await this.processState(updated);
  }

  /**
   * Resume incomplete tasks on bot startup.
   *
   * Finds all tasks in resumable states and checks if their worktrees
   * still exist. Recovers or fails them accordingly.
   */
  async resumeIncompleteTasksOnStartup(): Promise<void> {
    const activeTasks = database.devTasks.findActive();

    if (activeTasks.length === 0) {
      logger.info('[DEV-PIPELINE] No incomplete tasks to resume');
      return;
    }

    logger.info(`[DEV-PIPELINE] Found ${activeTasks.length} incomplete task(s) to resume`);

    for (const task of activeTasks) {
      if (!isResumableState(task.state)) {
        // Task is waiting for user — skip
        continue;
      }

      // Check worktree existence
      if (task.worktree_path && !worktreeExists(task.worktree_path)) {
        logger.info(`[DEV-PIPELINE] Task #${task.id}: worktree gone, marking as failed`);
        transition(task, DevTaskState.FAILED, {
          error_log: 'Worktree not found after restart',
        });
        continue;
      }

      logger.info(`[DEV-PIPELINE] Resuming task #${task.id} from state: ${task.state}`);
      this.processStateAsync(task);
    }
  }
}
