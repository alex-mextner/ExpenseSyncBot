# PR Review Flow + Stage Bot + Dev Logs

## Summary

After the dev pipeline creates a PR, instead of auto-completing, it pauses for user decision.
A test bot (stage) runs from the PR worktree for manual verification.
Users can view PM2 logs via `/dev logs prod|stage`.

## State Machine Changes

### New States

- **`AWAITING_REVIEW`** — auto code review done, test bot running, waiting for user decision
- **`AWAITING_MERGE`** — fixes applied, waiting for merge or more edits

### New Transitions

```
REVIEWING → AWAITING_REVIEW (always, replaces direct COMPLETED/UPDATING)

AWAITING_REVIEW → UPDATING     (Accept Review — AI fixes review issues)
AWAITING_REVIEW → UPDATING     (Edit — AI applies user feedback)
AWAITING_REVIEW → REJECTED     (Cancel Task)

UPDATING → TESTING → AWAITING_MERGE (after fixes, always to manual review)

AWAITING_MERGE → COMPLETED     (Merge — gh pr merge + cleanup + kill stage bot)
AWAITING_MERGE → UPDATING      (Edit — AI applies user feedback)
AWAITING_MERGE → REJECTED      (Cancel Task)
```

### Flow Diagram

```
PR created → auto review → AWAITING_REVIEW
                           [Accept Review | Edit (AI) | Cancel Task]
                                ↓              ↓            ↓
                             UPDATING       UPDATING     REJECTED
                                ↓              ↓
                             TESTING        TESTING
                                ↓              ↓
                           AWAITING_MERGE ←────┘
                           [Merge | Edit (AI) | Cancel Task]
                             ↓        ↓          ↓
                          COMPLETED  UPDATING   REJECTED
```

## Keyboards

### `createDevReviewKeyboard(taskId)`

```
[✅ Accept Review]  [✏️ Edit (AI)]  [❌ Cancel Task]
 dev:accept_review   dev:edit         dev:cancel
```

Shown at AWAITING_REVIEW state with auto-review results.

### `createDevMergeKeyboard(taskId)`

```
[🚀 Merge]  [✏️ Edit (AI)]  [❌ Cancel Task]
 dev:merge   dev:edit         dev:cancel
```

Shown at AWAITING_MERGE state after fixes are pushed.

## Callback Handling

- `dev:accept_review:{id}` — transition AWAITING_REVIEW → UPDATING, pass `code_review` as AI feedback
- `dev:merge:{id}` — `gh pr merge --squash --delete-branch` → cleanup worktree → COMPLETED
- `dev:edit:{id}` — force_reply prompt, wait for user text → UPDATING with user feedback
- `dev:cancel:{id}` — cancel task, cleanup worktree

## Bot Messages

### At AWAITING_REVIEW

```
🔍 Dev task #5: code review done

<review summary, up to 1000 chars>

PR: https://github.com/...
🤖 Test bot is running — @TestBotName

[Accept Review] [Edit (AI)] [Cancel Task]
```

### At AWAITING_MERGE

```
✅ Dev task #5: changes pushed

PR: https://github.com/...
🤖 Test bot is running — @TestBotName

[Merge] [Edit (AI)] [Cancel Task]
```

## GitHub Actions: Stage Bot

### New workflow: `.github/workflows/stage-bot.yml`

**Trigger:**

```yaml
on:
  pull_request:
    types: [opened, reopened, synchronize, closed]
```

### On `opened` / `reopened` / `synchronize`

```bash
WORKTREE="/var/www/ExpenseSyncBot/.claude/worktrees/${{ github.head_ref }}"

# Create worktree if not exists (manual PRs), update if exists
if [ ! -d "$WORKTREE" ]; then
  cd /var/www/ExpenseSyncBot
  git fetch origin
  git worktree add "$WORKTREE" "origin/${{ github.head_ref }}"
else
  cd "$WORKTREE"
  git fetch origin
  git reset --hard "origin/${{ github.head_ref }}"
fi

cd "$WORKTREE" && /var/www/.bun/bin/bun install

# Start or restart PM2 process
/var/www/.bun/bin/pm2 describe expensesyncbot-stage > /dev/null 2>&1 \
  && /var/www/.bun/bin/pm2 restart expensesyncbot-stage \
  || /var/www/.bun/bin/pm2 start src/index.ts \
       --name expensesyncbot-stage \
       --interpreter /var/www/.bun/bin/bun \
       -- --env-file /var/www/ExpenseSyncBot/.env.stage
```

### On `closed`

```bash
/var/www/.bun/bin/pm2 delete expensesyncbot-stage 2>/dev/null

WORKTREE="/var/www/ExpenseSyncBot/.claude/worktrees/${{ github.head_ref }}"
if [ -d "$WORKTREE" ]; then
  cd /var/www/ExpenseSyncBot
  git worktree remove "$WORKTREE" --force
fi
```

### Notes

- Only one stage bot at a time — latest PR wins
- `.env.stage` on server (`104.248.84.190`, user `www-data`): `BOT_TOKEN=TEST_BOT_TOKEN`, `DATABASE_PATH=./data/expenses-stage.db`, `OAUTH_SERVER_PORT=3312`
- Pipeline-created worktrees are reused; manual PRs get a fresh worktree
- Pipeline handles its own worktree cleanup on Merge/Cancel; GH Action is a safety net

## `/dev logs` Command

### Usage

```
/dev logs prod    — production bot logs
/dev logs stage   — stage bot logs
```

### Implementation

Read PM2 log files directly (bot runs on the same server):

```typescript
const PM2_LOG_DIR = '/var/www/.pm2/logs';
const LOG_FILES = {
  prod: {
    out: 'expensesyncbot-out.log',
    error: 'expensesyncbot-error.log',
  },
  stage: {
    out: 'expensesyncbot-stage-out.log',
    error: 'expensesyncbot-stage-error.log',
  },
};
```

1. Read last ~100KB of each log file via `Bun.file` + slice
2. Send both as documents via `sendDocument` in Telegram
3. If error log is empty — send only out log with "No errors" note
4. If PM2 process not found / log file missing — report to user

## Files to Modify

- `src/services/dev-pipeline/types.ts` — add AWAITING_REVIEW, AWAITING_MERGE states + transitions
- `src/services/dev-pipeline/pipeline.ts` — add handleAwaitingReview, handleAwaitingMerge, modify handleReviewing, add merge logic
- `src/bot/commands/dev.ts` — new callbacks (accept_review, merge), `/dev logs` subcommand
- `src/bot/keyboards.ts` — createDevReviewKeyboard, createDevMergeKeyboard
- `.github/workflows/stage-bot.yml` — new workflow

## Files NOT Modified

- Existing deploy workflow (`.github/workflows/deploy.yml`)
- Database schema (states are strings, no migration needed)
- `.env` / `.env.stage` (`.env.stage` created manually on server)
