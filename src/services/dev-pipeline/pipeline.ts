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
import { database } from '../../database';
import {
  DevTaskState,
  MAX_RETRY_ATTEMPTS,
  type DevTask,
  type CreateDevTaskData,
} from './types';
import {
  transition,
  isTerminalState,
  isResumableState,
} from './state-machine';
import {
  createWorktree,
  removeWorktree,
  worktreeExists,
  getRepoRoot,
  commitChanges,
  pushBranch,
  createPR,
  getCurrentDiff,
  getDiffFromMain,
  generateBranchName,
} from './git-ops';
import { runCodexReview } from './codex-integration';
import { DevAgent } from './dev-agent';
import { escapeHtml } from '../../bot/commands/ask';

/**
 * Notification callback type.
 * The pipeline calls this to send messages to Telegram.
 */
export type NotifyCallback = (
  groupId: number,
  message: string
) => Promise<void>;

/**
 * Dev Pipeline class — manages the full lifecycle of dev tasks.
 */
export class DevPipeline {
  private notify: NotifyCallback;

  constructor(notify: NotifyCallback) {
    this.notify = notify;
  }

  /**
   * Start a new dev task.
   *
   * Creates a record in the database and begins processing.
   */
  async startTask(
    groupId: number,
    userId: number,
    description: string
  ): Promise<DevTask> {
    // Create task record
    const task = database.devTasks.create({
      group_id: groupId,
      user_id: userId,
      description,
    });

    await this.notify(
      groupId,
      `🔵 Dev task #${task.id} created:\n${description}`
    );

    // Start processing asynchronously (don't block the command)
    this.processStateAsync(task);

    return task;
  }

  /**
   * Process a task's current state asynchronously.
   * Wraps processState in a try/catch and handles errors.
   */
  private async processStateAsync(task: DevTask): Promise<void> {
    try {
      await this.processState(task);
    } catch (error) {
      console.error(
        `[DEV-PIPELINE] Error processing task #${task.id}:`,
        error
      );
      const errorMsg =
        error instanceof Error ? error.message : String(error);

      try {
        transition(task, DevTaskState.FAILED, {
          error_log: errorMsg,
        });
      } catch {
        // If we can't even transition to FAILED, just log it
        console.error(
          `[DEV-PIPELINE] Cannot transition task #${task.id} to FAILED`
        );
      }

      await this.notify(
        task.group_id,
        `💥 Dev task #${task.id} failed:\n${errorMsg}`
      );
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
    console.log(`[DEV-PIPELINE] Task #${task.id}: description length=${task.description.length}, going to DESIGNING`);
    const updated = transition(task, DevTaskState.DESIGNING);
    await this.processState(updated);
  }

  /**
   * Handle CLARIFYING state: ask user questions.
   *
   * Placeholder — will use AI tool_use to generate questions.
   */
  private async handleClarifying(task: DevTask): Promise<void> {
    // TODO: Use AI to generate clarifying questions
    // For now, this is a manual step — transition happens when user
    // provides answers via callback
    await this.notify(
      task.group_id,
      `💬 Dev task #${task.id}: analyzing requirements...\n` +
        `(Clarification step will be implemented with AI tool_use)`
    );
  }

  /**
   * Handle DESIGNING state: create a design/plan for the task.
   *
   * Placeholder — will use AI tool_use to analyze codebase and
   * create a detailed implementation plan.
   */
  private async handleDesigning(task: DevTask): Promise<void> {
    await this.notify(
      task.group_id,
      `📐 Dev task #${task.id}: designing solution...`
    );

    const agent = new DevAgent(await getRepoRoot());

    const systemPrompt = `You are a senior software architect analyzing a Telegram bot codebase (TypeScript, Bun, GramIO, SQLite).

Your task: create a concise implementation plan for the requested feature/change.

PROCESS:
1. Use tools to explore relevant files and understand the current architecture
2. Identify which files need to be created or modified
3. Write a clear plan with specific file paths and changes

OUTPUT FORMAT (plain text, not markdown):
TITLE: <short title for the task>

FILES TO MODIFY:
- <path>: <what changes>

FILES TO CREATE:
- <path>: <purpose>

IMPLEMENTATION STEPS:
1. <step>
2. <step>
...

RISKS/NOTES:
- <any concerns>

Be specific about file paths. Reference existing patterns in the codebase.
Keep the plan concise — 20-40 lines max.`;

    const design = await agent.run(systemPrompt, task.description);

    const titleMatch = design.match(/TITLE:\s*(.+)/);
    const title = titleMatch?.[1]?.trim() || task.description.slice(0, 70);

    const updated = transition(task, DevTaskState.APPROVAL, { design, title });

    await this.notify(
      task.group_id,
      `📐 Dev task #${task.id} design ready:\n\n<pre>${escapeHtml(design.slice(0, 2000))}</pre>\n\n` +
        `Use /dev approve ${task.id} to proceed or /dev reject ${task.id} to cancel.`
    );
  }

  /**
   * Handle user approval — called from the bot command handler.
   */
  async approveTask(taskId: number): Promise<DevTask> {
    const task = database.devTasks.findById(taskId);
    if (!task) {
      throw new Error(`Task #${taskId} not found`);
    }

    if (task.state !== DevTaskState.APPROVAL) {
      throw new Error(
        `Task #${taskId} is not waiting for approval (current state: ${task.state})`
      );
    }

    // Generate branch name
    const branchName = generateBranchName(task.id, task.description);

    // Create worktree
    const worktreePath = await createWorktree(branchName);

    const updated = transition(task, DevTaskState.IMPLEMENTING, {
      branch_name: branchName,
      worktree_path: worktreePath,
    });

    await this.notify(
      task.group_id,
      `✅ Dev task #${task.id} approved! Starting implementation...`
    );

    // Continue processing
    this.processStateAsync(updated);

    return updated;
  }

  /**
   * Handle user rejection — called from the bot command handler.
   */
  async rejectTask(taskId: number): Promise<DevTask> {
    const task = database.devTasks.findById(taskId);
    if (!task) {
      throw new Error(`Task #${taskId} not found`);
    }

    const updated = transition(task, DevTaskState.REJECTED);

    // Clean up worktree if it exists
    if (task.worktree_path) {
      await removeWorktree(task.worktree_path);
    }

    await this.notify(task.group_id, `❌ Dev task #${task.id} rejected.`);

    return updated;
  }

  /**
   * Cancel a task — called from the bot command handler.
   */
  async cancelTask(taskId: number): Promise<DevTask> {
    const task = database.devTasks.findById(taskId);
    if (!task) {
      throw new Error(`Task #${taskId} not found`);
    }

    if (isTerminalState(task.state)) {
      throw new Error(
        `Task #${taskId} is already in terminal state: ${task.state}`
      );
    }

    const updated = transition(task, DevTaskState.REJECTED);

    // Clean up worktree if it exists
    if (task.worktree_path) {
      await removeWorktree(task.worktree_path);
    }

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

    await this.notify(
      task.group_id,
      isRetry
        ? `🔧 Dev task #${task.id}: fixing test failures (attempt ${task.retry_count}/${MAX_RETRY_ATTEMPTS})...`
        : `🔨 Dev task #${task.id}: implementing in branch ${task.branch_name}...`
    );

    const agent = new DevAgent(task.worktree_path);

    const techNotes = `TECH NOTES:
- Bun runtime, not Node.js
- bun:sqlite for database
- GramIO for Telegram bot
- date-fns for dates
- currency.js for money formatting
- Bun auto-loads .env`;

    let systemPrompt: string;
    let userMessage: string;

    if (isRetry && task.error_log) {
      // RETRY MODE: focused fix, not rewrite
      systemPrompt = `You are a senior TypeScript developer FIXING test/type-check failures in a Telegram bot.

CRITICAL RULES:
1. You are NOT reimplementing from scratch. Code already exists in the worktree.
2. First, READ the files that failed — understand what's already there.
3. Make MINIMAL targeted fixes to pass the failing tests/type-checks.
4. Do NOT rewrite files that aren't broken.
5. Do NOT delete or recreate files that already exist unless they're fundamentally wrong.
6. After fixing, use the commit tool.
7. Do NOT modify protected paths: src/services/dev-pipeline/, src/database/schema.ts, .github/

${techNotes}`;

      userMessage = `Tests/type-check FAILED. Fix the errors below.

ERRORS:
${task.error_log}

Original task for context: ${task.description}

Read the failing files first, then make minimal fixes.`;
    } else {
      // FIRST RUN: implement from design
      systemPrompt = `You are a senior TypeScript developer implementing a feature in a Telegram bot.

IMPORTANT RULES:
1. Use tools to read existing code BEFORE writing. Understand patterns first.
2. Write complete files — no partial snippets or TODOs.
3. Follow existing code style and patterns in the project.
4. Do NOT modify protected paths: src/services/dev-pipeline/, src/database/schema.ts, .github/
5. After writing all files, use the commit tool to save your work.
6. Keep changes minimal and focused on the task.

${techNotes}`;

      userMessage = `Implement this task:

${task.description}

DESIGN PLAN:
${task.design || 'No design provided. Analyze the codebase and implement directly.'}`;
    }

    await agent.run(systemPrompt, userMessage);

    const updated = transition(task, DevTaskState.TESTING);
    await this.processState(updated);
  }

  /**
   * Handle TESTING state: run tests and type checks.
   *
   * Runs `bun test` and `bunx tsc --noEmit` in the worktree.
   * On failure, retries up to MAX_RETRY_ATTEMPTS times.
   */
  private async handleTesting(task: DevTask): Promise<void> {
    if (!task.worktree_path) {
      throw new Error(`Task #${task.id} missing worktree_path`);
    }

    await this.notify(
      task.group_id,
      `🧪 Dev task #${task.id}: running tests...`
    );

    let testOutput = '';
    let testsPassed = true;

    // Run type check
    try {
      const typeCheck =
        await $`cd ${task.worktree_path} && bunx tsc --noEmit 2>&1`.text();
      testOutput += 'TYPE CHECK:\n' + typeCheck + '\n';
    } catch (error) {
      testsPassed = false;
      testOutput +=
        'TYPE CHECK FAILED:\n' +
        (error instanceof Error ? error.message : String(error)) +
        '\n';
    }

    // Run tests
    try {
      const tests =
        await $`cd ${task.worktree_path} && bun test 2>&1`.text();
      testOutput += 'TESTS:\n' + tests + '\n';
    } catch (error) {
      testsPassed = false;
      testOutput +=
        'TESTS FAILED:\n' +
        (error instanceof Error ? error.message : String(error)) +
        '\n';
    }

    if (testsPassed) {
      const updated = transition(task, DevTaskState.PULL_REQUEST);
      await this.notify(
        task.group_id,
        `✅ Dev task #${task.id}: tests passed!`
      );
      await this.processState(updated);
    } else {
      const retryCount = (task.retry_count || 0) + 1;

      if (retryCount >= MAX_RETRY_ATTEMPTS) {
        transition(task, DevTaskState.FAILED, {
          error_log: testOutput,
          retry_count: retryCount,
        });
        await this.notify(
          task.group_id,
          `💥 Dev task #${task.id} failed after ${retryCount} attempts.\n\n` +
            `Error:\n${testOutput.slice(0, 500)}`
        );
      } else {
        // Go back to implementing to fix issues
        const updated = transition(task, DevTaskState.IMPLEMENTING, {
          error_log: testOutput,
          retry_count: retryCount,
        });
        await this.notify(
          task.group_id,
          `⚠️ Dev task #${task.id}: tests failed (attempt ${retryCount}/${MAX_RETRY_ATTEMPTS}). Retrying...`
        );
        await this.processState(updated);
      }
    }
  }

  /**
   * Handle PULL_REQUEST state: create a GitHub PR.
   */
  private async handlePullRequest(task: DevTask): Promise<void> {
    if (!task.worktree_path || !task.branch_name) {
      throw new Error(
        `Task #${task.id} missing worktree_path or branch_name`
      );
    }

    await this.notify(
      task.group_id,
      `📤 Dev task #${task.id}: creating pull request...`
    );

    // Commit any uncommitted changes
    await commitChanges(
      task.worktree_path,
      `feat: ${task.title || task.description}`
    );

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

    await this.notify(
      task.group_id,
      `📤 Dev task #${task.id}: PR created!\n${pr.url}`
    );

    await this.processState(updated);
  }

  /**
   * Handle REVIEWING state: run automated code review.
   *
   * Uses Claude Code CLI for review.
   */
  private async handleReviewing(task: DevTask): Promise<void> {
    if (!task.worktree_path) {
      throw new Error(`Task #${task.id} missing worktree_path`);
    }

    await this.notify(task.group_id, `🔍 Dev task #${task.id}: running code review...`);

    const diff = await getDiffFromMain(task.worktree_path);
    const review = await runCodexReview(diff);

    // Check if review found serious issues
    const hasIssues = /\b(bug|security|error|fix|wrong|incorrect|vulnerability|injection)\b/i.test(review)
      && !/looks good|no issues|approve|clean/i.test(review);

    if (hasIssues) {
      const updated = transition(task, DevTaskState.UPDATING, { code_review: review });
      await this.notify(
        task.group_id,
        `⚠️ Dev task #${task.id}: review found issues, fixing...\n\n${review.slice(0, 500)}`
      );
      await this.processState(updated);
    } else {
      const updated = transition(task, DevTaskState.COMPLETED, { code_review: review });

      if (task.worktree_path) {
        await removeWorktree(task.worktree_path);
      }

      await this.notify(
        task.group_id,
        `✅ Dev task #${task.id} completed!\n\nPR: ${task.pr_url}\n\nReview:\n${review.slice(0, 1000)}`
      );
    }
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

    await this.notify(
      task.group_id,
      `🔄 Dev task #${task.id}: addressing review feedback...`
    );

    const agent = new DevAgent(task.worktree_path);

    const systemPrompt = `You are a senior TypeScript developer fixing code review issues in a Telegram bot (Bun, GramIO, SQLite).

RULES:
1. Read the files mentioned in the review before making changes.
2. Fix ONLY the issues mentioned — don't refactor unrelated code.
3. After fixing, commit your changes.
4. Do NOT modify protected paths: src/services/dev-pipeline/, src/database/schema.ts, .github/`;

    const userMessage = `Fix these code review issues:

${task.code_review || 'No specific review comments.'}

Original task: ${task.description}`;

    await agent.run(systemPrompt, userMessage);

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
      console.log('[DEV-PIPELINE] No incomplete tasks to resume');
      return;
    }

    console.log(
      `[DEV-PIPELINE] Found ${activeTasks.length} incomplete task(s) to resume`
    );

    for (const task of activeTasks) {
      if (!isResumableState(task.state)) {
        // Task is waiting for user — skip
        continue;
      }

      // Check worktree existence
      if (task.worktree_path && !worktreeExists(task.worktree_path)) {
        console.log(
          `[DEV-PIPELINE] Task #${task.id}: worktree gone, marking as failed`
        );
        transition(task, DevTaskState.FAILED, {
          error_log: 'Worktree not found after restart',
        });
        continue;
      }

      console.log(
        `[DEV-PIPELINE] Resuming task #${task.id} from state: ${task.state}`
      );
      this.processStateAsync(task);
    }
  }
}
