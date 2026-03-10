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
  type UpdateDevTaskData,
} from './types';
import {
  validateTransition,
  isTerminalState,
  isResumableState,
} from './state-machine';
import {
  createWorktree,
  removeWorktree,
  deleteLocalBranch,
  worktreeExists,
  getRepoRoot,
  commitChanges,
  pushBranch,
  createPR,
  mergePR,
  getCurrentDiff,
  getDiffFromMain,
  getChangedFilesFromMain,
  generateBranchName,
} from './git-ops';
import { runCodexReview } from './codex-integration';
import { DevAgent, AgentAbortedError } from './dev-agent';
import { escapeHtml } from '../../bot/commands/ask';
import { createDevApprovalKeyboard, createDevReviewKeyboard, createDevMergeKeyboard } from '../../bot/keyboards';

/** Reorder test output: failures and errors first, then passing tests fill remaining space */
function prioritizeFailures(raw: string, maxChars: number): string {
  const lines = raw.split('\n');
  const failLines: string[] = [];
  const otherLines: string[] = [];

  for (const line of lines) {
    if (line.includes('error:') || line.includes('Error:') ||
        line.includes('✗') || line.includes('FAIL') || line.includes('# Unhandled')) {
      failLines.push(line);
    } else {
      otherLines.push(line);
    }
  }

  // Failures + context first
  const result = [...failLines, ...otherLines].join('\n');
  return result.slice(0, maxChars);
}

/** Parse bun test summary counts from output (bun 1.3+: "N pass", "N fail", "N error") */
function parseTestCounts(output: string): { pass: number; fail: number; error: number } {
  const passMatch = output.match(/(\d+)\s+pass(?!\w)/);
  const failMatch = output.match(/(\d+)\s+fail(?!\w)/);
  const errorMatch = output.match(/(\d+)\s+error/);
  return {
    pass: passMatch ? parseInt(passMatch[1]!, 10) : 0,
    fail: failMatch ? parseInt(failMatch[1]!, 10) : 0,
    error: errorMatch ? parseInt(errorMatch[1]!, 10) : 0,
  };
}

/** Take the last N characters of a string (errors are usually at the end of output) */
function tailSlice(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  return '…' + text.slice(-maxChars);
}

/** Extract tsc error lines (file:line:col + message) for concise display */
function extractTscErrors(output: string): string {
  const lines = output.split('\n');
  const errors: string[] = [];
  for (const line of lines) {
    if (line.includes('error TS')) {
      errors.push(line.trim());
    }
  }
  return errors.join('\n') || output;
}

/** Filter tsc errors to only include errors in the given file list (relative paths) */
function filterTscErrorsByFiles(output: string, changedFiles: string[]): string {
  if (changedFiles.length === 0) return output;
  const lines = output.split('\n');
  const filtered: string[] = [];
  for (const line of lines) {
    if (!line.includes('error TS')) continue;
    // tsc errors start with relative path: src/foo/bar.ts(10,5): error TS...
    if (changedFiles.some(f => line.includes(f))) {
      filtered.push(line.trim());
    }
  }
  return filtered.join('\n');
}

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

TDD (Test-Driven Development) — MANDATORY:
- Write tests FIRST, before writing implementation code.
- For each piece of new functionality: write a failing test → implement minimal code to pass → refactor.
- Every new function, method, or behavior MUST have a corresponding test.
- Run tests after writing them to confirm they fail (red), then implement, then confirm they pass (green).
- Test files go next to the source file: foo.ts → foo.test.ts

TESTING RULES (Bun test):
- NEVER use mock.module() — it is broken in Bun: leaks between test files, cannot be restored with mock.restore(), does not work transitively.
- To mock singleton methods (like database repositories): use spyOn(object, 'method'). spyOn works correctly and is restored by mock.restore().
- For new code: prefer dependency injection — pass dependencies as parameters so tests can inject mocks directly without module mocking.
- Use mock() to create standalone mock functions when needed.
- Always clean up in afterEach: call mock.restore() to restore spyOn mocks, clear intervals/timeouts, close connections.
- When creating fake objects (e.g. fake bot for testing): stub ALL methods that the constructor or tested code calls, not just the ones your test uses.
- If a test file needs database: either use spyOn on the singleton, or create an in-memory SQLite database — do NOT mock the database module.
- Do NOT modify or "fix" tests that are unrelated to your task. If pre-existing tests fail, report it but do not change them.

TOPIC-AWARE MESSAGING:
- When sending Telegram messages from command/callback handlers: do NOT pass message_thread_id — AsyncLocalStorage middleware (src/bot/topic-middleware.ts) handles it automatically.
- When sending from background workers (photo-processor, broadcast, pipeline notifications): DO pass message_thread_id explicitly.
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
 * Transition a task to a new state and persist to database.
 */
function transition(
  task: DevTask,
  newState: DevTaskState,
  extra?: Partial<UpdateDevTaskData>
): DevTask {
  validateTransition(task.id, task.state, newState);

  const updateData: UpdateDevTaskData = {
    ...extra,
    state: newState,
  };

  console.log(
    `[DEV-PIPELINE] Task #${task.id}: ${task.state} -> ${newState}`
  );

  const updated = database.devTasks.update(task.id, updateData);

  if (!updated) {
    throw new Error(`Failed to update task #${task.id}`);
  }

  return updated;
}

/**
 * Dev Pipeline class — manages the full lifecycle of dev tasks.
 */
export class DevPipeline {
  private notify: NotifyCallback;
  private activeAgents = new Map<number, DevAgent>();

  constructor(notify: NotifyCallback) {
    this.notify = notify;
  }

  /**
   * Run an agent for a task, tracking it for cancellation.
   */
  private async runAgent(taskId: number, agent: DevAgent, systemPrompt: string, userMessage: string): Promise<string> {
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
      database.devTasks.update(task.id, { worktree_path: undefined } as any);
    }
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
      // Agent was aborted because user cancelled — task is already REJECTED, nothing to do
      if (error instanceof AgentAbortedError) {
        console.log(`[DEV-PIPELINE] Task #${task.id} agent aborted (cancelled by user)`);
        return;
      }

      console.error(
        `[DEV-PIPELINE] Error processing task #${task.id}:`,
        error
      );
      const errorMsg =
        error instanceof Error ? error.message : String(error);

      // Task may already be in a terminal state (e.g. REJECTED by concurrent cancel)
      if (!isTerminalState(task.state)) {
        try {
          transition(task, DevTaskState.FAILED, {
            error_log: errorMsg,
          });
        } catch {
          console.error(
            `[DEV-PIPELINE] Cannot transition task #${task.id} to FAILED`
          );
        }
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

    const questions = await this.runAgent(task.id, agent, systemPrompt, task.description);

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
      const enrichedDescription = message !== 'Продолжай'
        ? `${task.description}\n\nADDITIONAL CONTEXT:\n${message}`
        : task.description;

      database.devTasks.update(taskId, { description: enrichedDescription } as any);

      // Smart resume: use existing design and worktree if available
      if (task.design && task.worktree_path && worktreeExists(task.worktree_path)) {
        // Worktree + design exist — resume from where we left off
        // Keep error_log so the agent knows what went wrong last time
        const updated = transition(task, DevTaskState.IMPLEMENTING, {
          retry_count: 0,
        });
        updated.description = enrichedDescription;

        await this.notify(
          task.group_id,
          `▶️ Dev task #${task.id}: resuming implementation (design and worktree preserved)...`
        );

        this.processStateAsync(updated);
        return updated;
      }

      if (task.design) {
        // Design exists but no worktree — re-create worktree and implement
        const branchName = task.branch_name || generateBranchName(task.id, task.description);
        const worktreePath = await createWorktree(branchName);

        const updated = transition(task, DevTaskState.IMPLEMENTING, {
          error_log: undefined,
          retry_count: 0,
          branch_name: branchName,
          worktree_path: worktreePath,
        });
        updated.description = enrichedDescription;

        await this.notify(
          task.group_id,
          `▶️ Dev task #${task.id}: resuming implementation (recreated worktree, design preserved)...`
        );

        this.processStateAsync(updated);
        return updated;
      }

      // No design — restart from scratch
      const updated = transition(task, DevTaskState.PENDING, {
        error_log: undefined,
        retry_count: 0,
      });
      updated.description = enrichedDescription;

      await this.notify(
        task.group_id,
        `🔄 Dev task #${task.id}: restarting from scratch (no design found)...`
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

    if (task.state === DevTaskState.AWAITING_REVIEW) {
      return this.acceptReview(taskId);
    }

    if (task.state === DevTaskState.AWAITING_MERGE) {
      return this.mergeTask(taskId);
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

    const design = await this.runAgent(task.id, agent, systemPrompt, task.description);

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

    // Check if worktree already has commits (code was written in a previous run)
    const hasExistingWork = await this.worktreeHasCommits(task.worktree_path);

    if (isRetry && task.error_log) {
      // RETRY MODE: focused fix after test failure
      const changedFiles = await getChangedFilesFromMain(task.worktree_path);
      const changedFilesList = changedFiles.length > 0
        ? changedFiles.join('\n')
        : '(no files changed yet)';

      systemPrompt = `You are a senior TypeScript developer FIXING test/type-check failures in a Telegram bot.

CRITICAL RULES:
1. You are NOT reimplementing from scratch. Code already exists in the worktree.
2. First, READ the files that failed — understand what's already there.
3. Make MINIMAL targeted fixes to pass the failing tests/type-checks.
4. Do NOT rewrite files that aren't broken.
5. Do NOT delete or recreate files that already exist unless they're fundamentally wrong.
6. After fixing, use the commit tool.

SCOPE AWARENESS:
- Tests run on the ENTIRE project, not just your changes.
- If a test fails in a file you did NOT modify, your changes probably broke it indirectly (e.g., changed imports, moved exports).
- In that case, FIX YOUR CODE, don't fix the other test. Or use revert_file to undo your unnecessary changes.
- Do NOT "fix" pre-existing code, refactor unrelated files, or extract utilities. Stay focused on your task.
${DEV_RULES}
${techNotes}`;

      userMessage = `Tests/type-check FAILED. Fix the errors below.

YOUR CHANGED FILES (your scope — these are the files you modified vs main):
${changedFilesList}

ERRORS:
${task.error_log}

Original task for context: ${task.description}

IMPORTANT: If errors are in files NOT in your changed files list, your changes likely broke them indirectly. Revert unnecessary changes with revert_file rather than trying to fix unrelated tests.`;
    } else if (hasExistingWork) {
      // RESUME MODE: code already exists from a previous failed run
      systemPrompt = `You are a senior TypeScript developer RESUMING work on a Telegram bot feature.

CRITICAL CONTEXT: This task was attempted before and FAILED. Code already exists in the worktree from a previous run.

CRITICAL RULES:
1. First, explore the worktree to understand what's already been implemented.
2. Do NOT rewrite existing code unless it's broken or wrong.
3. Read the error log below to understand what went wrong last time.
4. Fix the issues, complete any unfinished work, and make it pass tests.
5. After fixing, use the commit tool.
${DEV_RULES}
${techNotes}`;

      userMessage = `RESUME this task (code already exists in worktree from a previous attempt):

${task.description}

DESIGN PLAN:
${task.design || 'No design provided.'}
${task.error_log ? `\nPREVIOUS FAILURE:\n${task.error_log}` : ''}

Start by listing files and reading what's already there. Then fix/complete the implementation.`;
    } else {
      // FIRST RUN: implement from design using TDD
      systemPrompt = `You are a senior TypeScript developer implementing a feature in a Telegram bot.

IMPORTANT RULES:
1. Use tools to read existing code BEFORE writing. Understand patterns first.
2. Follow TDD: write tests FIRST (*.test.ts next to source), confirm they fail, then implement.
3. Write complete files — no partial snippets or TODOs.
4. Follow existing code style and patterns in the project.
5. After writing all files, use the commit tool to save your work.
${DEV_RULES}
${techNotes}`;

      userMessage = `Implement this task using TDD:

${task.description}

DESIGN PLAN:
${task.design || 'No design provided. Analyze the codebase and implement directly.'}

WORKFLOW:
1. Read existing code to understand patterns
2. Write test file(s) for the new functionality FIRST
3. Implement the code to make tests pass
4. Commit everything`;
    }

    await this.runAgent(task.id, agent, systemPrompt, userMessage);

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

    await this.notify(
      task.group_id,
      `🧪 Dev task #${task.id}: running tests...`
    );

    let fullOutput = '';
    let typeCheckOutput = '';
    let testsOutput = '';

    // Run type check — tsc writes errors to stdout
    // NOTE: Bun Shell does not support 2>&1 — always read both streams
    const typeCheckResult = await $`cd ${task.worktree_path} && bun x tsc --noEmit`.nothrow().quiet();
    const typeCheckPassed = typeCheckResult.exitCode === 0;
    const tscStdout = typeCheckResult.text().trim();
    const tscStderr = typeCheckResult.stderr.toString().trim();
    typeCheckOutput = [tscStdout, tscStderr].filter(Boolean).join('\n');

    // Run tests — bun test writes header to stdout but results/errors to stderr
    const testsResult = await $`cd ${task.worktree_path} && bun test`.nothrow().quiet();
    const testsStdout = testsResult.text().trim();
    const testsStderr = testsResult.stderr.toString().trim();
    testsOutput = [testsStdout, testsStderr].filter(Boolean).join('\n');
    const testExitCode = testsResult.exitCode;
    const testsPassed = testExitCode === 0;

    // Parse test counts from bun test summary (bun 1.3+: "N pass", "N fail", "N error")
    const { pass: passCount, fail: failCount, error: errorCount } = parseTestCounts(testsOutput);

    // Build full output for error_log (raw, for the AI agent)
    fullOutput = `TYPE CHECK ${typeCheckPassed ? 'PASSED' : 'FAILED'}:\n${typeCheckOutput}\n\nTESTS ${testsPassed ? 'PASSED' : 'FAILED'} (exit code ${testExitCode}):\n${testsOutput}`;

    const allPassed = typeCheckPassed && testsPassed;

    // Detect retry loops: if error_log is identical to previous attempt, stop early
    if (!allPassed && task.error_log && task.error_log === fullOutput) {
      transition(task, DevTaskState.FAILED, {
        error_log: fullOutput,
        retry_count: (task.retry_count || 0) + 1,
      });
      await this.notify(
        task.group_id,
        `💀 <b>Dev task #${task.id}:</b> одинаковые ошибки 2 раза подряд — агент зациклился. Остановлено.`
      );
      return;
    }

    if (allPassed) {
      if (task.pr_number) {
        // PR already exists — we're in the fix cycle, push and show merge keyboard
        await commitChanges(task.worktree_path, `fix: address review feedback (task #${task.id})`);
        await pushBranch(task.worktree_path, task.branch_name!);

        const updated = transition(task, DevTaskState.AWAITING_MERGE);

        const testSummary = `${passCount} ✅`;
        await this.notify(
          task.group_id,
          `✅ <b>Dev task #${task.id}:</b> all checks passed!\n\n` +
            `✅ <b>Тайпчекер:</b> OK\n` +
            `✅ <b>Тесты:</b> ${testSummary}\n\n` +
            `PR: ${task.pr_url}`,
          { reply_markup: createDevMergeKeyboard(task.id) }
        );
      } else {
        // First run — create PR (existing flow)
        const updated = transition(task, DevTaskState.PULL_REQUEST);

        const testSummary = `${passCount} ✅`;
        await this.notify(
          task.group_id,
          `✅ <b>Dev task #${task.id}:</b> all checks passed!\n\n` +
            `✅ <b>Тайпчекер:</b> OK\n` +
            `✅ <b>Тесты:</b> ${testSummary}`
        );
        await this.processState(updated);
      }
    } else {
      const retryCount = (task.retry_count || 0) + 1;

      // Build pretty notification
      const lines: string[] = [];
      lines.push(`🧪 <b>Dev task #${task.id}</b> — результаты (попытка ${retryCount}/${MAX_RETRY_ATTEMPTS})\n`);

      if (typeCheckPassed) {
        lines.push(`✅ <b>Тайпчекер:</b> OK`);
      } else {
        const tscErrors = extractTscErrors(typeCheckOutput);
        const tscErrorCount = (typeCheckOutput.match(/error TS\d+/g) || []).length;
        if (tscErrorCount > 0) {
          lines.push(`❌ <b>Тайпчекер:</b> ${tscErrorCount} ${tscErrorCount === 1 ? 'ошибка' : 'ошибок'}`);
        } else {
          lines.push(`⚠️ <b>Тайпчекер:</b> failed (exit code ${typeCheckResult.exitCode})`);
        }
        const tscDisplay = tscErrors.trim() || typeCheckOutput.trim() || '(no output)';
        lines.push(`<blockquote expandable>${escapeHtml(tailSlice(tscDisplay, 3000))}</blockquote>`);
      }

      if (testsPassed) {
        lines.push(`✅ <b>Тесты:</b> ${passCount} ✅`);
      } else {
        const parts: string[] = [];
        if (passCount > 0) parts.push(`${passCount} ✅`);
        if (failCount > 0) parts.push(`${failCount} ❌`);
        if (errorCount > 0) parts.push(`${errorCount} 💥`);
        if (failCount === 0 && errorCount === 0) parts.push(`exit code ${testExitCode}`);
        lines.push(`${failCount > 0 || errorCount > 0 ? '❌' : '⚠️'} <b>Тесты:</b> ${parts.join(' / ')}`);
        lines.push(`<blockquote expandable>${escapeHtml(prioritizeFailures(testsOutput, 3000))}</blockquote>`);
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

    const updated = transition(task, DevTaskState.AWAITING_REVIEW, { code_review: review });

    await this.notify(
      task.group_id,
      `🔍 <b>Dev task #${task.id}:</b> code review done\n\n` +
        `<blockquote expandable>${escapeHtml(review.slice(0, 1500))}</blockquote>\n\n` +
        `PR: ${task.pr_url}`,
      { reply_markup: createDevReviewKeyboard(task.id) }
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

    await this.notify(
      task.group_id,
      `🔄 Dev task #${task.id}: fixing review issues...`
    );

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
      `✅ Dev task #${task.id} merged and completed!\n\nPR: ${task.pr_url}`
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

    await this.notify(
      task.group_id,
      `✏️ Dev task #${task.id}: applying your changes...`
    );

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
