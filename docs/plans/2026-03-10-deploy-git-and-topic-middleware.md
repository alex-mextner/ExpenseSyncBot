# Deploy via Git Pull + Topic Middleware Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switch deployment from rsync to git pull (enabling /dev pipeline on server) and add global topic-aware messaging via AsyncLocalStorage middleware.

**Architecture:** Two independent changes: (1) Replace rsync deploy with `git pull` on the server, requiring one-time SSH/deploy key setup. (2) Add a GramIO `preRequest` hook that reads `message_thread_id` from `AsyncLocalStorage` and injects it into all outgoing Telegram API calls, eliminating manual thread_id passing in 162+ `ctx.send()` calls and handler-context `bot.api.*` calls.

**Tech Stack:** GramIO (preRequest hooks), AsyncLocalStorage (node:async_hooks), GitHub Actions, git

---

## File Structure

- **Create:** `src/bot/topic-middleware.ts` — AsyncLocalStorage + middleware + preRequest registration
- **Modify:** `src/bot/index.ts` — register middleware
- **Modify:** `src/bot/commands/ask.ts` — remove manual thread_id passing
- **Modify:** `src/bot/commands/dev.ts` — add active_topic_id to notify callback
- **Modify:** `src/bot/handlers/message.handler.ts` — remove manual thread_id passing
- **Modify:** `src/bot/handlers/callback.handler.ts` — remove manual thread_id passing from receipt handlers
- **Modify:** `src/services/ai/agent.ts` — remove messageThreadId parameter
- **Modify:** `src/services/ai/telegram-stream.ts` — remove messageThreadId constructor param + manual passing
- **Modify:** `.github/workflows/deploy.yml` — switch from rsync to git pull
- **Modify:** `CLAUDE.md` — document topic handling rule

### Files that KEEP explicit message_thread_id (background operations):
- `src/services/receipt/photo-processor.ts` — background worker, no handler context
- `src/services/broadcast.ts` — cron job, no handler context
- `src/bot/handlers/photo.handler.ts` — stores thread_id into photo_queue for background processor

---

## Chunk 1: Topic Middleware

### Task 1: Create topic middleware module

**Files:**
- Create: `src/bot/topic-middleware.ts`

- [ ] **Step 1: Create the middleware file**

```typescript
/**
 * Global topic-aware messaging middleware.
 * Stores incoming message_thread_id in AsyncLocalStorage and injects it
 * into all outgoing Telegram API calls via GramIO preRequest hook.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Bot } from 'gramio';

interface ThreadContext {
  chatId: number;
  threadId: number | undefined;
}

export const threadStorage = new AsyncLocalStorage<ThreadContext>();

/** Telegram API methods that support message_thread_id */
const THREAD_AWARE_METHODS = [
  'sendMessage', 'sendPhoto', 'sendDocument', 'sendVideo',
  'sendAudio', 'sendVoice', 'sendVideoNote', 'sendAnimation',
  'sendSticker', 'sendLocation', 'sendContact', 'sendPoll',
  'sendDice', 'sendMediaGroup', 'copyMessage', 'forwardMessage',
  'sendChatAction',
] as const;

/**
 * Register topic-aware middleware and preRequest hook on the bot.
 * Must be called BEFORE registering any command/message handlers.
 */
export function registerTopicMiddleware(bot: Bot): void {
  // Middleware: extract thread_id from incoming update, store in AsyncLocalStorage
  bot.use((ctx, next) => {
    const payload = (ctx as any).payload;
    // For messages: payload.message_thread_id
    // For callback queries: ctx.message?.message_thread_id
    const threadId =
      payload?.message_thread_id ??
      (ctx as any).message?.message_thread_id;
    const chatId =
      (ctx as any).chat?.id ??
      (ctx as any).message?.chat?.id;

    if (chatId !== undefined) {
      return threadStorage.run({ chatId, threadId }, () => next());
    }
    return next();
  });

  // preRequest: inject message_thread_id into outgoing API calls
  bot.preRequest(THREAD_AWARE_METHODS as any, (context) => {
    const stored = threadStorage.getStore();
    if (
      stored?.threadId &&
      !context.params.message_thread_id &&
      context.params.chat_id === stored.chatId
    ) {
      context.params.message_thread_id = stored.threadId;
    }
    return context;
  });
}
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/topic-middleware.ts
git commit -m "feat: add global topic-aware messaging middleware"
```

---

### Task 2: Register middleware in bot

**Files:**
- Modify: `src/bot/index.ts`

- [ ] **Step 1: Import and register middleware**

Add import at top:
```typescript
import { registerTopicMiddleware } from './topic-middleware';
```

Add call BEFORE all command registrations (after `new Bot()`):
```typescript
registerTopicMiddleware(bot);
```

- [ ] **Step 2: Commit**

```bash
git add src/bot/index.ts
git commit -m "feat: register topic middleware before handlers"
```

---

### Task 3: Clean up manual thread_id in ask.ts

**Files:**
- Modify: `src/bot/commands/ask.ts`

Changes:
- Line 54: KEEP extraction (needed for topic restriction check at line 55-58)
- Line 86: Remove `messageThreadId` from `handleAskWithAnthropic()` call
- Line 103: Remove `messageThreadId` parameter from function signature
- Line 127: Remove `...(messageThreadId && { message_thread_id: messageThreadId })` from sendChatAction
- Line 136: Remove `messageThreadId` from `agent.run()` call

- [ ] **Step 1: Edit ask.ts** — remove messageThreadId from function calls and parameters
- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/ask.ts
git commit -m "refactor: remove manual thread_id passing from ask.ts"
```

---

### Task 4: Clean up agent.ts and telegram-stream.ts

**Files:**
- Modify: `src/services/ai/agent.ts`
- Modify: `src/services/ai/telegram-stream.ts`

**agent.ts changes:**
- Line 46: Remove `messageThreadId?: number` parameter from `run()`
- Line 48: Remove `messageThreadId` from `new TelegramStreamWriter()` constructor
- Lines 172, 193: Remove `...(messageThreadId && { message_thread_id: messageThreadId })` from error sendMessage calls

**telegram-stream.ts changes:**
- Line 59: Remove `private messageThreadId?: number` from constructor
- Lines 65, 75, 215, 290: Remove all `...(this.messageThreadId && { message_thread_id: this.messageThreadId })` spreads

- [ ] **Step 1: Edit agent.ts** — remove messageThreadId parameter and usage
- [ ] **Step 2: Edit telegram-stream.ts** — remove messageThreadId constructor param and all usage
- [ ] **Step 3: Commit**

```bash
git add src/services/ai/agent.ts src/services/ai/telegram-stream.ts
git commit -m "refactor: remove manual thread_id from AI agent and stream writer"
```

---

### Task 5: Clean up message.handler.ts

**Files:**
- Modify: `src/bot/handlers/message.handler.ts`

Changes:
- Line 106: KEEP extraction (needed for topic restriction check at line 107-109)
- Line 265: Remove `...(messageThreadId && { message_thread_id: messageThreadId })` from category confirmation
- Lines 444-445: Remove `const groupForTopic = database.groups.findById(groupId);`
- Line 449: Remove `...(groupForTopic?.active_topic_id && { message_thread_id: groupForTopic.active_topic_id })` from budget warning

- [ ] **Step 1: Edit message.handler.ts** — remove manual thread_id passing
- [ ] **Step 2: Commit**

```bash
git add src/bot/handlers/message.handler.ts
git commit -m "refactor: remove manual thread_id from message handler"
```

---

### Task 6: Clean up callback.handler.ts

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`

Changes:
- Line 788: Remove `...(queueItem?.message_thread_id && { message_thread_id: queueItem.message_thread_id })`
- Line 1347: Remove `...(queueItem.message_thread_id && { message_thread_id: queueItem.message_thread_id })`

- [ ] **Step 1: Edit callback.handler.ts** — remove manual thread_id from receipt handlers
- [ ] **Step 2: Commit**

```bash
git add src/bot/handlers/callback.handler.ts
git commit -m "refactor: remove manual thread_id from callback handler"
```

---

### Task 7: Add topic to dev pipeline notify callback

**Files:**
- Modify: `src/bot/commands/dev.ts`

Change the `notify` callback in `initDevPipeline` (lines 50-63) to include `group.active_topic_id`:

```typescript
const notify: NotifyCallback = async (groupId, message, options) => {
  const group = database.groups.findById(groupId);
  if (!group) return;

  try {
    await bot.api.sendMessage({
      chat_id: group.telegram_group_id,
      text: message,
      parse_mode: 'HTML',
      ...(group.active_topic_id && { message_thread_id: group.active_topic_id }),
      ...options,
    });
  } catch (error) {
    console.error('[DEV-CMD] Failed to send notification:', error);
  }
};
```

- [ ] **Step 1: Edit dev.ts** — add active_topic_id to notify callback
- [ ] **Step 2: Commit**

```bash
git add src/bot/commands/dev.ts
git commit -m "fix: send dev pipeline notifications to active topic"
```

---

### Task 8: Type check

- [ ] **Step 1: Run type check**

```bash
bunx tsc --noEmit
```

Expected: no type errors.

- [ ] **Step 2: Fix any type errors if found**

---

## Chunk 2: Deploy Infrastructure

### Task 9: Change deploy.yml to git pull

**Files:**
- Modify: `.github/workflows/deploy.yml`

Replace the rsync-based deploy with SSH + git pull:

```yaml
name: Deploy to Digital Ocean

on:
  push:
    branches: [main]
  workflow_dispatch:

jobs:
  deploy:
    runs-on: ubuntu-latest

    steps:
      - name: Deploy via git pull
        uses: appleboy/ssh-action@v1
        with:
          host: 104.248.84.190
          username: www-data
          key: ${{ secrets.DIGITAL_OCEAN_SSH_KEY }}
          script: |
            set -e
            cd /var/www/ExpenseSyncBot

            echo "📥 Pulling latest changes..."
            git pull origin main

            echo "📦 Installing dependencies..."
            /var/www/.bun/bin/bun install

            echo "🔧 Making start script executable..."
            chmod +x start.sh

            echo "🔄 Reloading PM2 process..."
            export PATH="/var/www/.nvm/versions/node/v22.17.0/bin:/var/www/.bun/bin:$PATH"
            pm2 reload ecosystem.config.cjs --update-env

            echo "✅ Deployment completed successfully!"
            pm2 list
```

- [ ] **Step 1: Edit deploy.yml**
- [ ] **Step 2: Commit**

```bash
git add .github/workflows/deploy.yml
git commit -m "feat: switch deploy from rsync to git pull"
```

---

### Task 10: One-time server setup (manual)

These steps must be done manually on the server BEFORE the first git-based deploy.

#### 10a: Set up SSH key for GitHub access

```bash
ssh www-data@104.248.84.190

# Generate SSH key
ssh-keygen -t ed25519 -C "expensesyncbot-server" -f ~/.ssh/id_ed25519 -N ""

# Add GitHub to known_hosts
ssh-keyscan github.com >> ~/.ssh/known_hosts

# Show public key (add as deploy key in GitHub repo settings)
cat ~/.ssh/id_ed25519.pub
```

Add the public key as a deploy key in GitHub repo → Settings → Deploy keys (read-only is enough for pull).

#### 10b: Initialize git repo on server

```bash
cd /var/www/ExpenseSyncBot

# Initialize git in existing directory
git init
git remote add origin git@github.com:alex-mextner/ExpenseSyncBot.git
git fetch origin

# Align with main branch (preserves .env and data/ since they're in .gitignore)
git reset origin/main
git checkout -- .

# Verify
git status
git log --oneline -5
```

#### 10c: Install and authenticate gh CLI (for /dev pipeline PRs)

```bash
# Install gh
curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg | sudo dd of=/usr/share/keyrings/githubcli-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" | sudo tee /etc/apt/sources.list.d/github-cli.list > /dev/null
sudo apt update && sudo apt install gh

# Authenticate (use a PAT with repo scope)
gh auth login
```

---

## Chunk 3: Documentation

### Task 11: Update CLAUDE.md with topic handling rule

**Files:**
- Modify: `CLAUDE.md`

Add to "Important Patterns & Conventions" section:

```markdown
### Topic-Aware Messaging

Bot uses `AsyncLocalStorage` middleware (`src/bot/topic-middleware.ts`) to automatically inject `message_thread_id` into all outgoing Telegram API calls within request handler context.

**Rules:**
- **Do NOT manually pass `message_thread_id`** in command handlers, message handlers, or callback handlers — the middleware handles it
- **DO pass `message_thread_id` explicitly** in background operations (photo-processor, broadcast, dev pipeline notify) since they run outside handler context
- The middleware is registered in `src/bot/index.ts` before all handlers
- Topic restriction checks still require extracting `message_thread_id` from context manually
```

Add to "Common Gotchas":
```markdown
10. **Topic middleware** — never pass message_thread_id manually in handler context, middleware does it. Background workers must pass it explicitly.
```

- [ ] **Step 1: Edit CLAUDE.md**
- [ ] **Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: add topic-aware messaging rule to CLAUDE.md"
```

### Task 12: Update dev pipeline agent rules

**Files:**
- Modify: `src/services/dev-pipeline/pipeline.ts` (AGENTS_MD constant, if it has coding rules for the AI agent)

Add to the agent's rules section:
```
- When sending Telegram messages from command/callback handlers: do NOT pass message_thread_id — AsyncLocalStorage middleware handles it automatically.
- When sending from background workers (photo-processor, broadcast, pipeline notifications): DO pass message_thread_id explicitly.
```

- [ ] **Step 1: Edit pipeline.ts** — add topic rule to AGENTS_MD
- [ ] **Step 2: Commit**

```bash
git add src/services/dev-pipeline/pipeline.ts
git commit -m "docs: add topic middleware rule to dev agent instructions"
```
