# Dev Pipeline AI Brain — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Fill in the 4 placeholder handlers in pipeline.ts (handleDesigning, handleImplementing, handleUpdating, handleClarifying) with Anthropic/GLM tool_use, and replace codex-integration with Anthropic-based review.

**Architecture:** Create a `DevAgent` class (similar to `ExpenseBotAgent`) that uses Anthropic Messages API with tool_use. It gets file/search/write tools scoped to a worktree. The pipeline calls DevAgent for design, implementation, code fixing, and review. No new dependencies — reuses existing `@anthropic-ai/sdk`.

**Tech Stack:** Anthropic SDK (already installed), Bun shell ($), existing file-ops.ts and git-ops.ts

---

### Task 1: Create DevAgent with file tools

**Files:**
- Create: `src/services/dev-pipeline/dev-agent.ts`

**Step 1: Create the DevAgent class**

The agent wraps Anthropic Messages API with streaming and tool_use. Tools are scoped to a worktree path.

```typescript
// src/services/dev-pipeline/dev-agent.ts
import Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL, AI_BASE_URL } from '../ai/agent';
import { env } from '../../config/env';
import {
  readFile,
  writeFile,
  listDirectory,
  searchCode,
  fileExists,
  deleteFile,
} from './file-ops';
import { commitChanges } from './git-ops';

const DEV_TOOLS: Anthropic.Tool[] = [
  {
    name: 'read_file',
    description: 'Read a file from the project. Use relative paths from project root (e.g., "src/bot/commands/ask.ts")',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write content to a file. Creates parent directories if needed. Use for creating new files or fully replacing existing ones.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative file path' },
        content: { type: 'string', description: 'Full file content' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_directory',
    description: 'List files and directories. Use to explore the project structure.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative directory path (default: ".")' },
      },
    },
  },
  {
    name: 'search_code',
    description: 'Search for a regex pattern across source files. Returns matching lines with file paths.',
    input_schema: {
      type: 'object' as const,
      properties: {
        pattern: { type: 'string', description: 'Regex pattern to search for' },
        glob: { type: 'string', description: 'Optional file glob filter (e.g., "*.ts")' },
      },
      required: ['pattern'],
    },
  },
  {
    name: 'file_exists',
    description: 'Check if a file exists.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'delete_file',
    description: 'Delete a file from the project.',
    input_schema: {
      type: 'object' as const,
      properties: {
        path: { type: 'string', description: 'Relative file path' },
      },
      required: ['path'],
    },
  },
  {
    name: 'commit',
    description: 'Stage and commit all current changes.',
    input_schema: {
      type: 'object' as const,
      properties: {
        message: { type: 'string', description: 'Commit message' },
      },
      required: ['message'],
    },
  },
];

const MAX_ROUNDS = 30;
const AGENT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class DevAgent {
  private anthropic: Anthropic;
  private worktreePath: string;

  constructor(worktreePath: string) {
    this.anthropic = new Anthropic({
      apiKey: env.ANTHROPIC_API_KEY,
      baseURL: AI_BASE_URL,
    });
    this.worktreePath = worktreePath;
  }

  /**
   * Run agent with a system prompt and user message.
   * Returns the final text response.
   */
  async run(systemPrompt: string, userMessage: string): Promise<string> {
    const messages: Anthropic.MessageParam[] = [
      { role: 'user', content: userMessage },
    ];

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), AGENT_TIMEOUT_MS);

    try {
      let round = 0;
      let finalText = '';

      while (round < MAX_ROUNDS) {
        round++;

        const response = await this.anthropic.messages.create(
          {
            model: AI_MODEL,
            max_tokens: 8192,
            system: systemPrompt,
            messages,
            tools: DEV_TOOLS,
          },
          { signal: controller.signal }
        );

        // Collect text and tool_use blocks
        const toolCalls: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];

        for (const block of response.content) {
          if (block.type === 'text') {
            finalText += block.text;
          } else if (block.type === 'tool_use') {
            toolCalls.push({ id: block.id, name: block.name, input: block.input as Record<string, unknown> });
          }
        }

        if (toolCalls.length === 0 || response.stop_reason === 'end_turn') {
          break;
        }

        // Execute tools and build results
        messages.push({ role: 'assistant', content: response.content });

        const toolResults: Anthropic.ToolResultBlockParam[] = [];
        for (const call of toolCalls) {
          console.log(`[DEV-AGENT] Tool: ${call.name}`, JSON.stringify(call.input).slice(0, 200));
          const result = await this.executeTool(call.name, call.input);
          console.log(`[DEV-AGENT] Result: ${result.slice(0, 200)}`);
          toolResults.push({
            type: 'tool_result',
            tool_use_id: call.id,
            content: result,
          });
        }

        messages.push({ role: 'user', content: toolResults });
      }

      return finalText;
    } finally {
      clearTimeout(timeout);
    }
  }

  private async executeTool(name: string, input: Record<string, unknown>): Promise<string> {
    try {
      switch (name) {
        case 'read_file':
          return await readFile(this.worktreePath, input.path as string);

        case 'write_file':
          await writeFile(this.worktreePath, input.path as string, input.content as string);
          return `Written: ${input.path}`;

        case 'list_directory':
          const files = await listDirectory(this.worktreePath, (input.path as string) || '.');
          return files.join('\n');

        case 'search_code':
          const results = await searchCode(this.worktreePath, input.pattern as string, input.glob as string | undefined);
          return results || 'No matches found.';

        case 'file_exists':
          return fileExists(this.worktreePath, input.path as string) ? 'true' : 'false';

        case 'delete_file':
          await deleteFile(this.worktreePath, input.path as string);
          return `Deleted: ${input.path}`;

        case 'commit':
          await commitChanges(this.worktreePath, input.message as string);
          return `Committed: ${input.message}`;

        default:
          return `Unknown tool: ${name}`;
      }
    } catch (error) {
      return `Error: ${error instanceof Error ? error.message : String(error)}`;
    }
  }
}
```

**Step 2: Verify it compiles**

Run: `bun x tsc --noEmit 2>&1 | grep dev-agent`
Expected: No errors

**Step 3: Commit**

```bash
git add src/services/dev-pipeline/dev-agent.ts
git commit -m "feat(dev-pipeline): add DevAgent with file/git tool_use"
```

---

### Task 2: Implement handleDesigning()

**Files:**
- Modify: `src/services/dev-pipeline/pipeline.ts` (handleDesigning method ~line 200)

**Step 1: Replace the placeholder handleDesigning**

The agent analyzes the codebase and creates a design document.

```typescript
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

  // Extract title from design if present
  const titleMatch = design.match(/TITLE:\s*(.+)/);
  const title = titleMatch?.[1]?.trim() || task.description.slice(0, 70);

  const updated = transition(task, DevTaskState.APPROVAL, {
    design,
    title,
  });

  await this.notify(
    task.group_id,
    `📐 Dev task #${task.id} design ready:\n\n<pre>${escapeHtml(design.slice(0, 2000))}</pre>\n\n` +
      `Use /dev approve ${task.id} to proceed or /dev reject ${task.id} to cancel.`
  );
}
```

Add import at the top of pipeline.ts:
```typescript
import { DevAgent } from './dev-agent';
import { escapeHtml } from '../../bot/commands/ask';
```

Also import `getRepoRoot` (already imported via git-ops).

**Step 2: Verify it compiles**

Run: `bun x tsc --noEmit 2>&1 | grep pipeline`
Expected: No errors

**Step 3: Commit**

```bash
git add src/services/dev-pipeline/pipeline.ts
git commit -m "feat(dev-pipeline): implement AI-powered handleDesigning"
```

---

### Task 3: Implement handleImplementing()

**Files:**
- Modify: `src/services/dev-pipeline/pipeline.ts` (handleImplementing method ~line 311)

**Step 1: Replace the placeholder handleImplementing**

The agent writes code in the worktree based on the design.

```typescript
private async handleImplementing(task: DevTask): Promise<void> {
  if (!task.worktree_path || !task.branch_name) {
    throw new Error(`Task #${task.id} missing worktree_path or branch_name`);
  }

  await this.notify(
    task.group_id,
    `🔨 Dev task #${task.id}: implementing in branch ${task.branch_name}...`
  );

  const agent = new DevAgent(task.worktree_path);

  const isRetry = (task.retry_count || 0) > 0;
  const errorContext = isRetry && task.error_log
    ? `\n\nPREVIOUS ATTEMPT FAILED with these errors:\n${task.error_log}\n\nFix these issues.`
    : '';

  const systemPrompt = `You are a senior TypeScript developer implementing a feature in a Telegram bot (Bun runtime, GramIO, SQLite via bun:sqlite).

IMPORTANT RULES:
1. Use tools to read existing code BEFORE writing. Understand patterns first.
2. Write complete files — no partial snippets or TODOs.
3. Follow existing code style and patterns in the project.
4. Do NOT modify protected paths: src/services/dev-pipeline/, src/database/schema.ts, .github/
5. After writing all files, use the commit tool to save your work.
6. Keep changes minimal and focused on the task.

TECH NOTES:
- Bun runtime, not Node.js
- bun:sqlite for database
- GramIO for Telegram bot
- date-fns for dates
- currency.js for money formatting
- Bun auto-loads .env`;

  const userMessage = `Implement this task:

${task.description}

DESIGN PLAN:
${task.design || 'No design provided. Analyze the codebase and implement directly.'}${errorContext}`;

  await agent.run(systemPrompt, userMessage);

  const updated = transition(task, DevTaskState.TESTING);
  await this.processState(updated);
}
```

**Step 2: Verify it compiles**

Run: `bun x tsc --noEmit 2>&1 | grep pipeline`
Expected: No errors

**Step 3: Commit**

```bash
git add src/services/dev-pipeline/pipeline.ts
git commit -m "feat(dev-pipeline): implement AI-powered handleImplementing with retry support"
```

---

### Task 4: Implement handleUpdating()

**Files:**
- Modify: `src/services/dev-pipeline/pipeline.ts` (handleUpdating method ~line 504)

**Step 1: Replace the placeholder handleUpdating**

The agent fixes issues based on review feedback.

```typescript
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
```

**Step 2: Commit**

```bash
git add src/services/dev-pipeline/pipeline.ts
git commit -m "feat(dev-pipeline): implement AI-powered handleUpdating for review fixes"
```

---

### Task 5: Replace codex-integration with Anthropic review

**Files:**
- Modify: `src/services/dev-pipeline/codex-integration.ts`

**Step 1: Replace runCodexReview with Anthropic-based review**

```typescript
// src/services/dev-pipeline/codex-integration.ts
import Anthropic from '@anthropic-ai/sdk';
import { AI_MODEL, AI_BASE_URL } from '../ai/agent';
import { env } from '../../config/env';

/**
 * Run code review using Anthropic/GLM API.
 */
export async function runCodexReview(diff: string): Promise<string> {
  if (!diff.trim()) {
    return 'No changes to review.';
  }

  if (!env.ANTHROPIC_API_KEY) {
    return 'Code review skipped: no AI API key configured.';
  }

  const maxDiffLength = 50000;
  const truncatedDiff =
    diff.length > maxDiffLength
      ? diff.slice(0, maxDiffLength) + '\n\n[... diff truncated ...]'
      : diff;

  const anthropic = new Anthropic({
    apiKey: env.ANTHROPIC_API_KEY,
    baseURL: AI_BASE_URL,
  });

  try {
    const response = await anthropic.messages.create({
      model: AI_MODEL,
      max_tokens: 4096,
      messages: [
        {
          role: 'user',
          content: `Review this code diff. Focus on:
1. Bugs or logic errors
2. Security issues (path traversal, injection)
3. Missing error handling
4. TypeScript type safety
5. Performance concerns

Be concise. List issues as bullet points. If the code looks good, say so.

\`\`\`diff
${truncatedDiff}
\`\`\``,
        },
      ],
    });

    let review = '';
    for (const block of response.content) {
      if (block.type === 'text') review += block.text;
    }
    return review.trim() || 'No review comments.';
  } catch (error) {
    console.error('[REVIEW] Failed:', error);
    return `Review failed: ${error instanceof Error ? error.message : String(error)}`;
  }
}
```

Remove the old `runCodexImplement` function — it's replaced by DevAgent.

**Step 2: Commit**

```bash
git add src/services/dev-pipeline/codex-integration.ts
git commit -m "refactor(dev-pipeline): replace Claude CLI review with Anthropic API"
```

---

### Task 6: Wire up handlePending to skip or clarify

**Files:**
- Modify: `src/services/dev-pipeline/pipeline.ts` (handlePending ~line 171)

**Step 1: Make handlePending smarter**

Short descriptions (< 50 chars) go straight to DESIGNING. Longer ones with ambiguity go through CLARIFYING (future). For now, always go to DESIGNING — but log the decision.

```typescript
private async handlePending(task: DevTask): Promise<void> {
  // Short clear descriptions → design directly
  // Complex ambiguous ones → clarify (TODO: implement AI analysis)
  console.log(`[DEV-PIPELINE] Task #${task.id}: description length=${task.description.length}, going to DESIGNING`);
  const updated = transition(task, DevTaskState.DESIGNING);
  await this.processState(updated);
}
```

This is intentionally simple — CLARIFYING can be added later when we see real usage patterns.

**Step 2: Commit**

```bash
git add src/services/dev-pipeline/pipeline.ts
git commit -m "chore(dev-pipeline): document handlePending decision logic"
```

---

### Task 7: Update handleReviewing to gate on review quality

**Files:**
- Modify: `src/services/dev-pipeline/pipeline.ts` (handleReviewing ~line 467)

**Step 1: Check review verdict before auto-completing**

If review mentions "NEEDS_CHANGES" or "bug" or "security" → go to UPDATING instead of COMPLETED.

```typescript
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
```

**Step 2: Commit**

```bash
git add src/services/dev-pipeline/pipeline.ts
git commit -m "feat(dev-pipeline): gate on review quality before auto-completing"
```

---

### Task 8: Integration test — full pipeline dry run

**Files:**
- Modify: `src/services/dev-pipeline/pipeline.ts` (add progress notifications)

**Step 1: Manual test via Telegram**

In a group with the bot:
```
/dev add a /ping command that replies with "pong" and current timestamp
```

Expected flow:
1. `🔵 Dev task #N created` — PENDING
2. `📐 Dev task #N: designing solution...` — DESIGNING (AI explores code, writes plan)
3. `📐 Dev task #N design ready: ...` — APPROVAL (shows plan, waits)
4. `/dev approve N`
5. `✅ Dev task #N approved!` — IMPLEMENTING (AI writes code in worktree)
6. `🧪 Dev task #N: running tests...` — TESTING
7. `📤 Dev task #N: creating pull request...` — PULL_REQUEST
8. `🔍 Dev task #N: running code review...` — REVIEWING
9. `✅ Dev task #N completed!` with PR link

Verify:
- PR exists on GitHub with correct diff
- Code actually implements the ping command
- Tests pass in the worktree

**Step 2: Commit any fixes from testing**

```bash
git add -A
git commit -m "fix(dev-pipeline): fixes from integration testing"
```

---

## Summary

| Task | What | Effort |
|------|------|--------|
| 1 | DevAgent class with file/git tools | Core piece |
| 2 | handleDesigning — AI creates plan | Quick |
| 3 | handleImplementing — AI writes code | Quick (uses DevAgent) |
| 4 | handleUpdating — AI fixes review issues | Quick |
| 5 | Replace Codex CLI with Anthropic API review | Quick |
| 6 | handlePending — clean up decision logic | Trivial |
| 7 | handleReviewing — gate on review quality | Quick |
| 8 | Integration test | Manual verification |

All tasks are independent once Task 1 (DevAgent) is done. Tasks 2-7 can be done in any order.
