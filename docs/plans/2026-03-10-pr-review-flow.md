# PR Review Flow + Stage Bot + Dev Logs — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add user-controlled PR review flow with Accept/Edit/Merge buttons, automated stage bot via GitHub Actions, and `/dev logs` command.

**Architecture:** Two new pipeline states (AWAITING_REVIEW, AWAITING_MERGE) pause the auto-flow for user decisions. GitHub Actions workflow manages a stage bot on the server using PR lifecycle events. Log reading uses Bun.file to read PM2 logs and sends them as Telegram documents.

**Tech Stack:** TypeScript, Bun, GramIO, GitHub Actions, PM2, SSH deploy

**Spec:** `docs/specs/2026-03-10-pr-review-flow.md`

---

## Task 1: State Machine — New States and Transitions

**Files:**

- Modify: `src/services/dev-pipeline/types.ts:12-56` (enum, transitions, labels, emoji)
- Modify: `src/services/dev-pipeline/state-machine.ts:65-85` (isWaitingForUser, isResumableState)

- [ ] **Step 1: Add AWAITING_REVIEW and AWAITING_MERGE to DevTaskState enum**

In `types.ts`, add after `REVIEWING`:

```typescript
/** Auto review done, waiting for user to accept/edit/cancel */
AWAITING_REVIEW = 'awaiting_review',
```

And after `UPDATING`:

```typescript
/** Fixes applied, waiting for user to merge/edit/cancel */
AWAITING_MERGE = 'awaiting_merge',
```

- [ ] **Step 2: Update STATE_TRANSITIONS**

Replace the `REVIEWING` line and add new states:

```typescript
[DevTaskState.REVIEWING]: [DevTaskState.AWAITING_REVIEW, DevTaskState.FAILED, DevTaskState.REJECTED],
[DevTaskState.AWAITING_REVIEW]: [DevTaskState.UPDATING, DevTaskState.REJECTED],
[DevTaskState.UPDATING]: [DevTaskState.TESTING, DevTaskState.FAILED, DevTaskState.REJECTED],
[DevTaskState.AWAITING_MERGE]: [DevTaskState.COMPLETED, DevTaskState.UPDATING, DevTaskState.REJECTED],
```

Also update `TESTING` — after fixes it should go to `AWAITING_MERGE` instead of `PULL_REQUEST`:

```typescript
[DevTaskState.TESTING]: [DevTaskState.PULL_REQUEST, DevTaskState.AWAITING_MERGE, DevTaskState.IMPLEMENTING, DevTaskState.FAILED, DevTaskState.REJECTED],
```

- [ ] **Step 3: Add STATE_LABELS and STATE_EMOJI for new states**

```typescript
// In STATE_LABELS:
[DevTaskState.AWAITING_REVIEW]: 'Ожидание ревью',
[DevTaskState.AWAITING_MERGE]: 'Ожидание мержа',

// In STATE_EMOJI:
[DevTaskState.AWAITING_REVIEW]: '👀',
[DevTaskState.AWAITING_MERGE]: '🚀',
```

- [ ] **Step 4: Update state-machine.ts helper functions**

In `isWaitingForUser`, add new states:

```typescript
export function isWaitingForUser(state: DevTaskState): boolean {
  return (
    state === DevTaskState.APPROVAL ||
    state === DevTaskState.CLARIFYING ||
    state === DevTaskState.AWAITING_REVIEW ||
    state === DevTaskState.AWAITING_MERGE
  );
}
```

`isResumableState` — no changes needed (new states are user-waiting, not auto-resumable).

- [ ] **Step 5: Run type check**

Run: `bun x tsc --noEmit`
Expected: Errors in pipeline.ts (references to old transitions) — that's fine, we'll fix in Task 3.

- [ ] **Step 6: Commit**

```bash
git add src/services/dev-pipeline/types.ts src/services/dev-pipeline/state-machine.ts
git commit -m "feat(dev-pipeline): add AWAITING_REVIEW and AWAITING_MERGE states"
```

---

## Task 2: Keyboards — Review and Merge Buttons

**Files:**

- Modify: `src/bot/keyboards.ts:135-144` (replace createDevApprovalKeyboard, add new keyboards)

- [ ] **Step 1: Add createDevReviewKeyboard**

Add after `createDevApprovalKeyboard`:

```typescript
/**
 * Create dev task review keyboard (after auto code review)
 */
export function createDevReviewKeyboard(taskId: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard
    .text('✅ Accept Review', `dev:accept_review:${taskId}`)
    .text('✏️ Edit (AI)', `dev:edit:${taskId}`)
    .text('❌ Cancel Task', `dev:cancel:${taskId}`);

  return keyboard;
}
```

- [ ] **Step 2: Add createDevMergeKeyboard**

```typescript
/**
 * Create dev task merge keyboard (after fixes, ready to merge)
 */
export function createDevMergeKeyboard(taskId: number): InlineKeyboard {
  const keyboard = new InlineKeyboard();

  keyboard
    .text('🚀 Merge', `dev:merge:${taskId}`)
    .text('✏️ Edit (AI)', `dev:edit:${taskId}`)
    .text('❌ Cancel Task', `dev:cancel:${taskId}`);

  return keyboard;
}
```

- [ ] **Step 3: Commit**

```bash
git add src/bot/keyboards.ts
git commit -m "feat(dev-pipeline): add review and merge keyboards"
```

---

## Task 3: Pipeline — Modified Review Flow

**Files:**

- Modify: `src/services/dev-pipeline/pipeline.ts:1-44` (imports)
- Modify: `src/services/dev-pipeline/pipeline.ts:312-346` (processState switch)
- Modify: `src/services/dev-pipeline/pipeline.ts:914-915` (handleTesting — route to AWAITING_MERGE after fixes)
- Modify: `src/services/dev-pipeline/pipeline.ts:1029-1061` (handleReviewing — always go to AWAITING_REVIEW)
- Add new methods: `handleAwaitingReview`, `handleAwaitingMerge`, `acceptReview`, `mergeTask`

- [ ] **Step 1: Update imports in pipeline.ts**

Add `mergePR` to git-ops import:

```typescript
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
```

Add new keyboards to import:

```typescript
import { createDevApprovalKeyboard, createDevReviewKeyboard, createDevMergeKeyboard } from '../../bot/keyboards';
```

- [ ] **Step 2: Update processState switch — add new state cases**

Add to the switch in `processState`:

```typescript
case DevTaskState.AWAITING_REVIEW:
  // Wait for user — do nothing
  break;
case DevTaskState.AWAITING_MERGE:
  // Wait for user — do nothing
  break;
```

- [ ] **Step 3: Modify handleReviewing — always transition to AWAITING_REVIEW**

Replace the entire `handleReviewing` method body:

```typescript
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
```

- [ ] **Step 4: Modify handleTesting — route to AWAITING_MERGE when coming from UPDATING**

In `handleTesting`, the "all passed" branch currently does:

```typescript
const updated = transition(task, DevTaskState.PULL_REQUEST);
```

Change to detect if PR already exists (meaning we're in fix cycle, not first run):

```typescript
if (allPassed) {
  if (task.pr_number) {
    // PR exists — we're in the fix cycle, push and go to AWAITING_MERGE
    await commitChanges(task.worktree_path, `fix: address review feedback (task #${task.id})`);
    await pushBranch(task.worktree_path, task.branch_name!);

    const updated = transition(task, DevTaskState.AWAITING_MERGE);

    await this.notify(
      task.group_id,
      `✅ <b>Dev task #${task.id}:</b> changes pushed\n\n` +
        `PR: ${task.pr_url}`,
      { reply_markup: createDevMergeKeyboard(task.id) }
    );
  } else {
    // First run — create PR
    const updated = transition(task, DevTaskState.PULL_REQUEST);
    // ... existing test summary notification ...
    await this.processState(updated);
  }
}
```

Keep the existing test summary notification for both paths.

- [ ] **Step 5: Add acceptReview method**

Public method called from callback handler when user clicks "Accept Review":

```typescript
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
```

- [ ] **Step 6: Add mergeTask method**

Public method called from callback handler when user clicks "Merge":

```typescript
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
```

- [ ] **Step 7: Update handleUpdating — use code_review or user feedback**

The `handleUpdating` method currently always uses `task.code_review`. It should work for both "Accept Review" (review feedback) and "Edit" (user feedback). Check if `task.error_log` contains user edit feedback (set by the edit callback). Actually, reuse `code_review` field for both — the callback handler will set it appropriately.

No change needed here — `code_review` already contains the right content in both cases.

- [ ] **Step 8: Update continueTask for new states**

In `continueTask`, add handling for new states:

```typescript
if (task.state === DevTaskState.AWAITING_REVIEW) {
  return this.acceptReview(taskId);
}

if (task.state === DevTaskState.AWAITING_MERGE) {
  return this.mergeTask(taskId);
}
```

- [ ] **Step 9: Run type check**

Run: `bun x tsc --noEmit`
Expected: PASS (or only pre-existing errors)

- [ ] **Step 10: Commit**

```bash
git add src/services/dev-pipeline/pipeline.ts
git commit -m "feat(dev-pipeline): pause review flow for user Accept/Edit/Merge decisions"
```

---

## Task 4: Callback Handling — New Button Actions

**Files:**

- Modify: `src/bot/commands/dev.ts:522-599` (handleDevCallback switch)

- [ ] **Step 1: Add accept_review callback**

In the `switch (subAction)` block, add:

```typescript
case 'accept_review':
  await pl.acceptReview(taskId);
  await ctx.answerCallbackQuery({ text: 'Fixing review issues...' });
  break;
```

- [ ] **Step 2: Add merge callback**

```typescript
case 'merge':
  await pl.mergeTask(taskId);
  await ctx.answerCallbackQuery({ text: 'Merging...' });
  break;
```

- [ ] **Step 3: Update edit callback for new states**

The existing `edit` case works for APPROVAL state (design edit). Now it also needs to handle AWAITING_REVIEW and AWAITING_MERGE states. The flow is the same: force_reply → user text → UPDATING.

Update the `edit` case — it needs to store a "pending PR edit" (not design edit). Use a separate map or reuse `pendingDesignEdits` with a flag. Simplest: reuse `pendingDesignEdits` map (chatId → taskId). The `consumePendingDesignEdit` in message handler needs to check task state to decide: if APPROVAL → call `editDesign`, if AWAITING_REVIEW/AWAITING_MERGE → call a new `editPR` method.

Update the edit case prompt text:

```typescript
case 'edit': {
  const editTask = database.devTasks.findById(taskId);
  pendingDesignEdits.set(chatId!, taskId);
  await ctx.answerCallbackQuery({ text: 'Опишите правки' });

  const isDesignEdit = editTask?.state === DevTaskState.APPROVAL;
  const promptText = isDesignEdit
    ? `✏️ Опишите, что изменить в дизайне задачи #${taskId}:`
    : `✏️ Опишите, что изменить в коде задачи #${taskId}:`;

  await bot.api.sendMessage({
    chat_id: chatId,
    text: promptText,
    reply_markup: { force_reply: true, selective: true },
  });
  return; // Don't delete the button message
}
```

- [ ] **Step 4: Add editPR method to pipeline**

In `pipeline.ts`, add public method:

```typescript
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
```

- [ ] **Step 5: Update message handler to route edit by task state**

In `src/bot/handlers/message.handler.ts`, find where `consumePendingDesignEdit` is called. Update to check task state:

```typescript
const editTaskId = consumePendingDesignEdit(chatId);
if (editTaskId !== null) {
  const editTask = database.devTasks.findById(editTaskId);
  const pl = getPipelineInstance();
  if (pl && editTask) {
    if (editTask.state === DevTaskState.APPROVAL) {
      await pl.editDesign(editTaskId, messageText);
    } else {
      await pl.editPR(editTaskId, messageText);
    }
  }
  return;
}
```

Import `DevTaskState` in message.handler.ts if not already imported. Import `database` if not already imported.

- [ ] **Step 6: Run type check**

Run: `bun x tsc --noEmit`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/bot/commands/dev.ts src/services/dev-pipeline/pipeline.ts src/bot/handlers/message.handler.ts
git commit -m "feat(dev-pipeline): handle Accept Review, Merge, and Edit callbacks"
```

---

## Task 5: GitHub Actions — Stage Bot Workflow

**Files:**

- Create: `.github/workflows/stage-bot.yml`

- [ ] **Step 1: Create the workflow file**

```yaml
name: Stage Bot

on:
  pull_request:
    types: [opened, reopened, synchronize, closed]

jobs:
  stage-bot:
    runs-on: ubuntu-latest

    steps:
      - name: Deploy or stop stage bot
        uses: appleboy/ssh-action@v1
        with:
          host: 104.248.84.190
          username: www-data
          key: ${{ secrets.DIGITAL_OCEAN_SSH_KEY }}
          script_stop: true
          script: |
            set -e
            export PATH="/var/www/.nvm/versions/node/v22.17.0/bin:/var/www/.bun/bin:$PATH"

            BRANCH="${{ github.head_ref }}"
            WORKTREE="/var/www/ExpenseSyncBot/.claude/worktrees/$BRANCH"
            ENV_FILE="/var/www/ExpenseSyncBot/.env.stage"
            PM2="/var/www/.bun/bin/pm2"
            BUN="/var/www/.bun/bin/bun"

            if [ "${{ github.event.action }}" = "closed" ]; then
              echo "🛑 Stopping stage bot..."
              $PM2 delete expensesyncbot-stage 2>/dev/null || true

              if [ -d "$WORKTREE" ]; then
                cd /var/www/ExpenseSyncBot
                git worktree remove "$WORKTREE" --force 2>/dev/null || true
              fi

              echo "✅ Stage bot stopped"
              exit 0
            fi

            echo "🚀 Deploying stage bot from branch: $BRANCH"

            cd /var/www/ExpenseSyncBot
            git fetch origin

            if [ ! -d "$WORKTREE" ]; then
              echo "📁 Creating worktree..."
              git worktree add "$WORKTREE" "origin/$BRANCH"
            else
              echo "🔄 Updating worktree..."
              cd "$WORKTREE"
              git fetch origin
              git reset --hard "origin/$BRANCH"
            fi

            cd "$WORKTREE"
            $BUN install

            $PM2 describe expensesyncbot-stage > /dev/null 2>&1 \
              && $PM2 restart expensesyncbot-stage \
              || $PM2 start src/index.ts \
                   --name expensesyncbot-stage \
                   --interpreter $BUN \
                   -- --env-file $ENV_FILE

            echo "✅ Stage bot deployed"
            $PM2 list
```

- [ ] **Step 2: Commit**

```bash
git add .github/workflows/stage-bot.yml
git commit -m "ci: add GitHub Actions workflow for stage bot on PR events"
```

---

## Task 6: `/dev logs` Command

**Files:**

- Modify: `src/bot/commands/dev.ts:1-12` (file comment, add to usage list)
- Modify: `src/bot/commands/dev.ts:134-169` (switch — add 'logs' case)
- Add function: `handleLogs` in `src/bot/commands/dev.ts`

- [ ] **Step 1: Add 'logs' case to the switch**

In the `switch (subcommand)` block, add before `default`:

```typescript
case 'logs':
  await handleLogs(ctx, args, group.id);
  break;
```

- [ ] **Step 2: Implement handleLogs function**

```typescript
/** PM2 log file paths on the server */
const PM2_LOG_DIR = '/var/www/.pm2/logs';
const LOG_NAMES: Record<string, { out: string; error: string }> = {
  prod: {
    out: 'expensesyncbot-out.log',
    error: 'expensesyncbot-error.log',
  },
  stage: {
    out: 'expensesyncbot-stage-out.log',
    error: 'expensesyncbot-stage-error.log',
  },
};

/** Max bytes to read from each log file */
const MAX_LOG_BYTES = 100 * 1024; // 100KB

/**
 * Send PM2 log files as Telegram documents
 */
async function handleLogs(
  ctx: Ctx['Command'],
  args: string[],
  groupId: number
): Promise<void> {
  const target = args[1]?.toLowerCase();

  if (!target || !LOG_NAMES[target]) {
    await ctx.send('Usage: /dev logs prod|stage');
    return;
  }

  const logs = LOG_NAMES[target]!;
  const outPath = `${PM2_LOG_DIR}/${logs.out}`;
  const errorPath = `${PM2_LOG_DIR}/${logs.error}`;

  const outFile = Bun.file(outPath);
  const errorFile = Bun.file(errorPath);

  const outExists = await outFile.exists();
  const errorExists = await errorFile.exists();

  if (!outExists && !errorExists) {
    await ctx.send(`No log files found for ${target}. Is the bot running?`);
    return;
  }

  const chatId = ctx.chat!.id;
  const bot = ctx._bot;

  // Read and send out log
  if (outExists) {
    const outSize = outFile.size;
    const outStart = Math.max(0, outSize - MAX_LOG_BYTES);
    const outContent = await outFile.slice(outStart, outSize).text();

    await bot.api.sendDocument({
      chat_id: chatId,
      document: new File([outContent], logs.out, { type: 'text/plain' }),
      caption: `📋 ${target} stdout (last ${Math.round(outContent.length / 1024)}KB)`,
    });
  }

  // Read and send error log
  if (errorExists) {
    const errorSize = errorFile.size;
    if (errorSize === 0) {
      await ctx.send(`✅ ${target} error log is empty — no errors.`);
    } else {
      const errorStart = Math.max(0, errorSize - MAX_LOG_BYTES);
      const errorContent = await errorFile.slice(errorStart, errorSize).text();

      await bot.api.sendDocument({
        chat_id: chatId,
        document: new File([errorContent], logs.error, { type: 'text/plain' }),
        caption: `⚠️ ${target} stderr (last ${Math.round(errorContent.length / 1024)}KB)`,
      });
    }
  }
}
```

Note: `ctx._bot` may not exist in GramIO — check how other commands access bot API. If `ctx` doesn't expose bot directly, pass `bot` through `initDevPipeline` or use the pipeline's notify callback. Check the existing `handleDevCallback` signature — it receives `bot` as a parameter. For the command handler, `ctx` should have `ctx.api` or similar. Verify by reading GramIO types.

- [ ] **Step 3: Update usage help text**

In `showUsage`, add:

```typescript
'/dev logs prod|stage — download PM2 logs\n' +
```

- [ ] **Step 4: Update file comment**

Add `/dev logs prod|stage` to the comment at the top of the file.

- [ ] **Step 5: Run type check**

Run: `bun x tsc --noEmit`
Expected: PASS (may need to adjust `ctx._bot` to correct GramIO API access)

- [ ] **Step 6: Commit**

```bash
git add src/bot/commands/dev.ts
git commit -m "feat(dev-pipeline): add /dev logs command for PM2 log download"
```

---

## Task 7: Final Verification

- [ ] **Step 1: Run full type check**

Run: `bun x tsc --noEmit`
Expected: PASS

- [ ] **Step 2: Run tests**

Run: `bun test`
Expected: PASS (no new tests broken)

- [ ] **Step 3: Verify state transitions are consistent**

Manually check that `STATE_TRANSITIONS` in `types.ts` covers all paths in the flow diagram from the spec.

- [ ] **Step 4: Final commit if any loose changes**

```bash
git status
# If needed:
git add -A && git commit -m "chore: final cleanup for PR review flow"
```
