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
import { createDevApprovalKeyboard } from '../../bot/keyboards';

/**
 * Shared development rules injected into all DevAgent prompts.
 * Based on obra's development philosophy — keeps the AI focused.
 */
const DEV_RULES = `
DEVELOPMENT RULES (follow strictly):
- Make the smallest reasonable change to get the job done. No extras.
- Read existing code BEFORE writing. Understand the patterns, then follow them.
- Simple code over clever code. Readable beats concise.
- Match the surrounding code style exactly — formatting, naming, patterns.
- Names describe PURPOSE, not implementation (getUserById, not fetchDataFromDB).
- One change at a time. Never bundle unrelated fixes.
- No speculative generality — don't add features "just in case".
- No dead code, no commented-out code, no TODO placeholders.
- When fixing bugs: find root cause FIRST. Read error messages carefully. Form a hypothesis, verify it, then fix.
- After a fix, verify you haven't broken anything else.
- Keep functions small and focused. If a function does two things, split it.
- Don't refactor code you're not changing. Stay focused on the task.
- Protected paths (NEVER modify): src/services/dev-pipeline/, src/database/schema.ts, .github/
`;

/**
 * Notification callback type.
 * The pipeline calls this to send messages to Telegram.
 */
export type NotifyCallback = (
  groupId: number,
  message: string,
  options?: { reply_markup?: any }
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
    // Short clear descriptions → design directly, ambiguous → clarify
    if (task.description.length < 100) {
      console.log(`[DEV-PIPELINE] Task #${task.id}: short description, going to DESIGNING`);
      const updated = transition(task, DevTaskState.DESIGNING);
      await this.processState(updated);
    } else {
      console.log(`[DEV-PIPELINE] Task #${task.id}: long description, going to CLARIFYING`);
      const updated = transition(task, DevTaskState.CLARIFYING);
      await this.processState(updated);
    }
  }

  /**
   * Handle CLARIFYING state: AI generates questions, waits for user answer.
   */
  private async handleClarifying(task: DevTask): Promise<void> {
    await this.notify(
      task.group_id,
      `💬 Dev task #${task.id}: analyzing requirements...`
    );

    const agent = new DevAgent(await getRepoRoot());

    const systemPrompt = `You are a senior software architect reviewing a task description for a Telegram bot (TypeScript, Bun, GramIO, SQLite).

Analyze the task and generate 2-5 clarifying questions to better understand what needs to be done.
Focus on ambiguities, missing details, and potential edge cases.

Output ONLY the questions, numbered 1-5. No preamble.`;

    const questions = await agent.run(systemPrompt, task.description);

    // Save questions and notify user
    const updated = transition(task, DevTaskState.CLARIFYING, {
      design: `QUESTIONS:\n${questions}`,
    });

    await this.notify(
      task.group_id,
      `💬 Dev task #${task.id} needs clarification:\n\n${questions}\n\n` +
        `Reply with /dev answer ${task.id} <your answers>\n` +
        `Or /dev approve ${task.id} to skip and proceed with designing.`
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
      throw new Error(`Task #${taskId} is not waiting for clarification (current state: ${task.state})`);
    }

    // Append answers to description for context
    const enrichedDescription = `${task.description}\n\nCLARIFICATION:\nQuestions: ${task.design || ''}\nAnswers: ${answer}`;

    const updated = transition(task, DevTaskState.DESIGNING, {
      design: undefined, // will be regenerated
    });

    // Update description with clarification context
    database.devTasks.update(taskId, { description: enrichedDescription } as any);
    updated.description = enrichedDescription;

    await this.notify(
      task.group_id,
      `💬 Dev task #${task.id}: answers received, proceeding to design...`
    );

    this.processStateAsync(updated);
    return updated;
  }

  /**
   * Continue/resume a failed or stuck task with an optional message.
   */
  async continueTask(taskId: number, message: string): Promise<DevTask> {
    const task = database.devTasks.findById(taskId);
    if (!task) {
      throw new Error(`Task #${taskId} not found`);
    }

    if (task.state === DevTaskState.COMPLETED || task.state === DevTaskState.REJECTED) {
      throw new Error(`Task #${taskId} is already ${task.state}, cannot continue`);
    }

    if (task.state === DevTaskState.FAILED) {
      // Restart from PENDING, append message to description
      const enrichedDescription = message !== 'Продолжай'
        ? `${task.description}\n\nADDITIONAL CONTEXT:\n${message}`
        : task.description;

      const updated = transition(task, DevTaskState.PENDING, {
        error_log: undefined,
        retry_count: 0,
      });

      database.devTasks.update(taskId, { description: enrichedDescription } as any);
      updated.description = enrichedDescription;

      await this.notify(
        task.group_id,
        `🔄 Dev task #${task.id}: restarting from scratch...`
      );

      this.processStateAsync(updated);
      return updated;
    }

    if (task.state === DevTaskState.CLARIFYING) {
      return this.answerTask(taskId, message);
    }

    if (task.state === DevTaskState.APPROVAL) {
      return this.approveTask(taskId);
    }

    // For any other active state — re-trigger processing
    await this.notify(
      task.group_id,
      `▶️ Dev task #${task.id}: resuming from ${task.state}...`
    );

    this.processStateAsync(task);
    return task;
  }

  /**
   * Handle DESIGNING state: create a design/plan for the task.
   */
  private async handleDesigning(task: DevTask): Promise<void> {
    await this.notify(
      task.group_id,
      `📐 Dev task #${task.id}: designing solution...`
    );

    const agent = new DevAgent(await getRepoRoot());

    const systemPrompt = `You are a senior software architect analyzing a Telegram bot codebase (TypeScript, Bun, GramIO, SQLite).

Your task: create a concise implementation plan for the requested feature/change.
${DEV_RULES}
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
      `📐 Dev task #${task.id} design ready:\n\n<pre>${escapeHtml(design.slice(0, 2000))}</pre>`,
      { reply_markup: createDevApprovalKeyboard(task.id) }
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
    database.devTasks.update(taskId, { description: enrichedDescription } as any);
    updated.description = enrichedDescription;

    await this.notify(
      task.group_id,
      `✏️ Dev task #${task.id}: redesigning with your feedback...`
    );

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
      await this.notify(task.group_id, `⏩ Dev task #${taskId}: skipping clarification, proceeding to design...`);
      this.processStateAsync(updated);
      return updated;
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
${DEV_RULES}
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
4. After writing all files, use the commit tool to save your work.
${DEV_RULES}
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

    let fullOutput = '';
    let typeCheckPassed = true;
    let testsPassed = true;
    let typeCheckOutput = '';
    let testsOutput = '';

    // Run type check
    try {
      const result = await $`cd ${task.worktree_path} && bunx tsc --noEmit 2>&1`.text();
      typeCheckOutput = result.trim();
    } catch (error: any) {
      typeCheckPassed = false;
      // Bun shell puts stdout+stderr in error.stdout or error.message
      typeCheckOutput = (error.stdout?.toString() || error.message || String(error)).trim();
    }

    // Run tests
    try {
      const result = await $`cd ${task.worktree_path} && bun test 2>&1`.text();
      testsOutput = result.trim();
    } catch (error: any) {
      testsPassed = false;
      testsOutput = (error.stdout?.toString() || error.message || String(error)).trim();
    }

    // Build full output for error_log (raw, for the AI agent)
    fullOutput = `TYPE CHECK ${typeCheckPassed ? 'PASSED' : 'FAILED'}:\n${typeCheckOutput}\n\nTESTS ${testsPassed ? 'PASSED' : 'FAILED'}:\n${testsOutput}`;

    const allPassed = typeCheckPassed && testsPassed;

    if (allPassed) {
      const updated = transition(task, DevTaskState.PULL_REQUEST);
      await this.notify(
        task.group_id,
        `✅ Dev task #${task.id}: all checks passed!\n\n` +
          `✅ Тайпчекер: OK\n` +
          `✅ Тесты: OK`
      );
      await this.processState(updated);
    } else {
      const retryCount = (task.retry_count || 0) + 1;

      // Build pretty notification
      const lines: string[] = [];
      lines.push(`🧪 <b>Dev task #${task.id}</b> — результаты (попытка ${retryCount}/${MAX_RETRY_ATTEMPTS})\n`);

      if (typeCheckPassed) {
        lines.push(`✅ <b>Тайпчекер:</b> OK`);
      } else {
        lines.push(`❌ <b>Тайпчекер:</b> ошибки`);
        lines.push(`<blockquote expandable>${escapeHtml(typeCheckOutput.slice(0, 1500))}</blockquote>`);
      }

      if (testsPassed) {
        lines.push(`✅ <b>Тесты:</b> OK`);
      } else {
        lines.push(`❌ <b>Тесты:</b> ошибки`);
        lines.push(`<blockquote expandable>${escapeHtml(testsOutput.slice(0, 1500))}</blockquote>`);
      }

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
${DEV_RULES}`;

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
