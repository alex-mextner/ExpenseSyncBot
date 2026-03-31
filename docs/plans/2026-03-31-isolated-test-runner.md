# Isolated Test Runner & Test Cleanup

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a parallel test runner that spawns each test file in its own bun process (full mock isolation), then clean up the worst test files.

**Architecture:** A `scripts/test-runner.ts` script finds `*.test.ts` files, spawns `bun test <file>` per file via `Bun.spawn` in a concurrency pool, parses stdout for pass/fail, prints aggregated results. With process isolation, `mock.module()` is safe — no cross-file leakage.

**Tech Stack:** Bun (Bun.spawn, Bun.Glob), existing bun:test API

---

## File Map

| Action | Path | Purpose |
|--------|------|---------|
| Create | `scripts/test-runner.ts` | Parallel isolated test runner |
| Modify | `package.json` | Add `test:isolated` script |
| Modify | `CLAUDE.md` | Update mock rules (mock.module is safe with isolation) |
| Create | `src/test-utils/mocks/database.ts` | Shared database singleton mock |
| Create | `src/test-utils/mocks/fetch.ts` | Fetch mock helpers |
| Create | `src/test-utils/fixtures.ts` | Shared make* factories |

---

### Task 1: Test Runner Script

**Files:**
- Create: `scripts/test-runner.ts`

- [ ] **Step 1: Create runner with file discovery and pool**

```ts
// scripts/test-runner.ts
// Parallel test runner — each file in its own bun process for mock isolation

const CONCURRENCY = Number(process.env.TEST_CONCURRENCY) || 16;
const FILTER = process.argv[2] ?? '';

interface FileResult {
  file: string;
  pass: number;
  fail: number;
  duration: number;
  ok: boolean;
  output: string;
}

async function findTestFiles(): Promise<string[]> {
  const glob = new Bun.Glob('src/**/*.test.ts');
  const files: string[] = [];
  for await (const path of glob.scan({ cwd: '.', onlyFiles: true })) {
    if (path.includes('ZenPlugins')) continue;
    if (FILTER && !path.includes(FILTER)) continue;
    files.push(path);
  }
  return files.sort();
}

async function runFile(file: string): Promise<FileResult> {
  const start = performance.now();
  const proc = Bun.spawn(['bun', 'test', file], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, FORCE_COLOR: '1' },
  });

  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const exitCode = await proc.exited;
  const duration = performance.now() - start;
  const output = stdout + stderr;

  // Parse bun test output: " N pass" and " N fail"
  const passMatch = output.match(/(\d+)\s+pass/);
  const failMatch = output.match(/(\d+)\s+fail/);

  return {
    file,
    pass: passMatch ? Number(passMatch[1]) : 0,
    fail: failMatch ? Number(failMatch[1]) : 0,
    duration,
    ok: exitCode === 0,
    output,
  };
}

async function run(): Promise<void> {
  const files = await findTestFiles();
  if (files.length === 0) {
    console.log('No test files found.');
    process.exit(0);
  }

  console.log(`Running ${files.length} test files (concurrency: ${CONCURRENCY})\n`);
  const start = performance.now();

  const results = await runPool(files, CONCURRENCY);

  const totalDuration = performance.now() - start;
  const totalPass = results.reduce((s, r) => s + r.pass, 0);
  const totalFail = results.reduce((s, r) => s + r.fail, 0);
  const failedFiles = results.filter((r) => !r.ok);

  console.log('\n' + '─'.repeat(60));
  console.log(`Files:  ${results.length} total, ${results.length - failedFiles.length} passed, ${failedFiles.length} failed`);
  console.log(`Tests:  ${totalPass + totalFail} total, ${totalPass} passed, ${totalFail} failed`);
  console.log(`Time:   ${(totalDuration / 1000).toFixed(2)}s`);

  if (failedFiles.length > 0) {
    console.log('\nFailed files:');
    for (const f of failedFiles) {
      console.log(`  \x1b[31m✗\x1b[0m ${f.file}`);
    }
    process.exit(1);
  }
}

async function runPool(files: string[], concurrency: number): Promise<FileResult[]> {
  const results: FileResult[] = [];
  let idx = 0;

  async function worker(): Promise<void> {
    while (idx < files.length) {
      const file = files[idx++]!;
      const result = await runFile(file);
      results.push(result);
      const icon = result.ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m';
      const ms = `${Math.round(result.duration)}ms`;
      console.log(`  ${icon} ${result.file} (${result.pass} pass, ${result.fail} fail) [${ms}]`);
      if (!result.ok) {
        console.log(result.output.split('\n').map((l) => `    ${l}`).join('\n'));
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

run();

- [ ] **Step 2: Run the runner and verify it works**

Run: `bun scripts/test-runner.ts`
Expected: all 82 files pass, wall time ~2s (vs 5.7s with `bun test`).

- [ ] **Step 3: Test filtering**

Run: `bun scripts/test-runner.ts parser`
Expected: only `parser.test.ts` runs.

- [ ] **Step 4: Commit**

```bash
git add scripts/test-runner.ts
git commit -m "feat: add isolated parallel test runner

Each test file runs in its own bun process — mock.module()
no longer leaks between files. Uses worker pool with
configurable concurrency (default 16)."
```

---

### Task 2: Package Scripts & CLAUDE.md Update

**Files:**
- Modify: `package.json`
- Modify: `CLAUDE.md`

- [ ] **Step 1: Add test scripts to package.json**

Add to `"scripts"`:

```json
"test": "bun scripts/test-runner.ts",
"test:single": "bun test"
```

`test` = isolated runner (default). `test:single` = original single-process bun test for quick single-file runs.

- [ ] **Step 2: Update CLAUDE.md mock rules**

In the "Testing" section, replace the `mock.module()` ban:

Old:
```
- **Never use `mock.module()` for project modules.** It replaces modules in Bun's global cache and poisons unrelated test files...
```

New:
```
- **`mock.module()` is safe** — each test file runs in its own process via `scripts/test-runner.ts`. Use `mock.module()` freely for mocking dependencies. Use `spyOn` when you need to assert call counts or arguments on a real implementation.
- **Always run tests via `bun run test`** (isolated runner), not `bun test` directly — the latter runs all files in one process and mock.module leaks between files. Use `bun test <file>` only for running a single file.
```

- [ ] **Step 3: Update lefthook.yml if it uses `bun test`**

Check if pre-push hook uses `bun test` and update to `bun run test`.

- [ ] **Step 4: Commit**

```bash
git add package.json CLAUDE.md lefthook.yml
git commit -m "chore: wire isolated test runner as default test command"
```

---

### Task 3: Shared Mock — Database Singleton

**Files:**
- Create: `src/test-utils/mocks/database.ts`

Many test files mock the `database` singleton from `../../database` with identical empty stubs. Extract to a shared module.

- [ ] **Step 1: Create database mock helper**

```ts
// src/test-utils/mocks/database.ts
// Shared mock for the database singleton — use with mock.module()
import { mock } from 'bun:test';

type MockFn = ReturnType<typeof mock>;

interface MockRepo {
  [method: string]: MockFn;
}

/**
 * Create a mock database object with configurable repository stubs.
 * Default: every method is a no-op mock.
 * Override specific repos/methods via the `overrides` parameter.
 *
 * Usage:
 *   mock.module('../../database', () => ({ database: mockDatabase() }));
 *   mock.module('../../database', () => ({ database: mockDatabase({ expenses: { findByGroupId: mock(() => [...]) } }) }));
 */
export function mockDatabase(overrides: Record<string, Partial<MockRepo>> = {}): Record<string, MockRepo> {
  const repoNames = [
    'groups', 'users', 'expenses', 'categories', 'pendingExpenses',
    'budgets', 'chatMessages', 'adviceLog', 'bankConnections',
    'bankCredentials', 'bankAccounts', 'bankTransactions',
    'expenseItems', 'receiptItems', 'merchantRules', 'photoQueue',
    'devTasks', 'groupSpreadsheets', 'syncSnapshots',
  ] as const;

  const db: Record<string, MockRepo> = {};
  for (const name of repoNames) {
    db[name] = new Proxy(overrides[name] ?? {}, {
      get(target, prop: string) {
        if (prop in target) return target[prop];
        // Auto-create mock for any accessed method
        const fn = mock(() => undefined);
        target[prop] = fn;
        return fn;
      },
    });
  }
  return db;
}
```

- [ ] **Step 2: Verify it works with a quick import test**

Run: `bun -e "import { mockDatabase } from './src/test-utils/mocks/database'; const db = mockDatabase(); console.log(typeof db.expenses.findByGroupId)"`
Expected: `function`

- [ ] **Step 3: Commit**

```bash
git add src/test-utils/mocks/database.ts
git commit -m "feat: add shared database mock for test files"
```

---

### Task 4: Shared Mock — Fetch Helper

**Files:**
- Create: `src/test-utils/mocks/fetch.ts`

- [ ] **Step 1: Create fetch mock helper**

```ts
// src/test-utils/mocks/fetch.ts
// Helpers for mocking globalThis.fetch in tests
import { mock } from 'bun:test';

type FetchMock = ReturnType<typeof mock>;

/**
 * Mock fetch to return a JSON response.
 * Returns the mock function for assertions.
 */
export function mockFetchJson(body: unknown, status = 200): FetchMock {
  const fn = mock(async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  globalThis.fetch = fn as typeof fetch;
  return fn;
}

/**
 * Mock fetch to return a text/binary response.
 */
export function mockFetchText(body: string, status = 200): FetchMock {
  const fn = mock(async () => new Response(body, { status }));
  globalThis.fetch = fn as typeof fetch;
  return fn;
}

/**
 * Mock fetch to throw a network error.
 */
export function mockFetchError(message = 'Network error'): FetchMock {
  const fn = mock(async () => { throw new Error(message); });
  globalThis.fetch = fn as typeof fetch;
  return fn;
}

/**
 * Restore original fetch. Call in afterEach.
 */
const originalFetch = globalThis.fetch;
export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}
```

- [ ] **Step 2: Commit**

```bash
git add src/test-utils/mocks/fetch.ts
git commit -m "feat: add shared fetch mock helpers for tests"
```

---

### Task 5: Shared Fixtures

**Files:**
- Create: `src/test-utils/fixtures.ts`

Common factory functions used across multiple test files.

- [ ] **Step 1: Create shared fixtures**

```ts
// src/test-utils/fixtures.ts
// Shared test fixture factories

import type { Database } from 'bun:sqlite';

/**
 * Insert a group + user combo and return their IDs.
 * Most tests need this boilerplate — extract it once.
 */
export function seedGroupAndUser(
  db: Database,
  overrides: { groupId?: number; userId?: number } = {},
): { groupId: number; userId: number } {
  const telegramGroupId = overrides.groupId ?? -Date.now();
  const telegramUserId = overrides.userId ?? Date.now();

  db.run(
    `INSERT OR IGNORE INTO groups (telegram_group_id, default_currency) VALUES (?, 'EUR')`,
    [telegramGroupId],
  );
  const group = db.query<{ id: number }, [number]>(
    'SELECT id FROM groups WHERE telegram_group_id = ?',
  ).get(telegramGroupId)!;

  db.run(
    `INSERT OR IGNORE INTO users (telegram_user_id, group_id, display_name) VALUES (?, ?, 'Test User')`,
    [telegramUserId, group.id],
  );
  const user = db.query<{ id: number }, [number]>(
    'SELECT id FROM users WHERE telegram_user_id = ?',
  ).get(telegramUserId)!;

  return { groupId: group.id, userId: user.id };
}

/** Standard expense fields with sensible defaults */
export interface ExpenseFixture {
  group_id: number;
  user_id: number;
  date: string;
  category: string;
  comment: string;
  amount: number;
  currency: string;
  eur_amount: number;
}

export function makeExpense(groupId: number, userId: number, overrides: Partial<ExpenseFixture> = {}): ExpenseFixture {
  return {
    group_id: groupId,
    user_id: userId,
    date: '2024-01-15',
    category: 'Food',
    comment: 'Lunch',
    amount: 25.0,
    currency: 'EUR',
    eur_amount: 25.0,
    ...overrides,
  };
}
```

- [ ] **Step 2: Commit**

```bash
git add src/test-utils/fixtures.ts
git commit -m "feat: add shared test fixtures (seedGroupAndUser, makeExpense)"
```

---

### Task 6: Rewrite agent.test.ts (worst offender — massive spyOn repetition)

**Files:**
- Modify: `src/services/ai/agent.test.ts`

This file has 30+ `spyOn(anthropic.messages, 'stream')` calls with identical mock stream construction. Extract a helper.

- [ ] **Step 1: Read the full file and understand the mock stream pattern**

Read `src/services/ai/agent.test.ts` in full. Identify the repeated `mockStreamResponse` pattern and count unique variations.

- [ ] **Step 2: Create a mock stream factory at the top of the file**

Add a helper function near the top that creates mock stream responses:

```ts
import { mock } from 'bun:test';

/** Create a mock Anthropic stream that yields the given events */
function mockStream(events: Array<{ type: string; [key: string]: unknown }>) {
  return {
    [Symbol.asyncIterator]: async function* () {
      yield* events;
    },
    finalMessage: async () => events.find((e) => e.type === 'message')
      ?? { content: [], usage: { input_tokens: 0, output_tokens: 0 }, stop_reason: 'end_turn' },
    abort: mock(),
  };
}

/** Mock anthropic.messages.stream to return a stream with given text */
function mockTextStream(anthropic: { messages: { stream: unknown } }, text: string, extras?: { toolUse?: unknown[] }) {
  const events = [
    { type: 'content_block_delta', delta: { type: 'text_delta', text } },
    ...(extras?.toolUse ?? []),
    {
      type: 'message',
      content: [{ type: 'text', text }, ...(extras?.toolUse ?? [])],
      usage: { input_tokens: 100, output_tokens: 50 },
      stop_reason: 'end_turn',
    },
  ];
  return spyOn(anthropic.messages, 'stream').mockReturnValue(mockStream(events));
}
```

- [ ] **Step 3: Replace all 30+ individual spyOn calls with the helper**

Go through each test and replace the verbose inline mock with `mockTextStream(anthropic, 'response text')`.

- [ ] **Step 4: Run the test file**

Run: `bun test src/services/ai/agent.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/agent.test.ts
git commit -m "refactor: extract mock stream helpers in agent tests"
```

---

### Task 7: Rewrite ocr-extractor.test.ts (43% boilerplate — fetch mocking)

**Files:**
- Modify: `src/services/receipt/ocr-extractor.test.ts`

- [ ] **Step 1: Read the full file**

Read `src/services/receipt/ocr-extractor.test.ts`.

- [ ] **Step 2: Replace repeated fetch mocking with shared helpers**

Replace all `globalThis.fetch = mock(async () => new Response(...))` calls with `mockFetchJson()` / `mockFetchText()` from `src/test-utils/mocks/fetch.ts`. Replace `afterEach` cleanup with `restoreFetch()`.

- [ ] **Step 3: Run tests**

Run: `bun test src/services/receipt/ocr-extractor.test.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/receipt/ocr-extractor.test.ts
git commit -m "refactor: use shared fetch mocks in ocr-extractor tests"
```

---

### Task 8: Rewrite spending-analytics.test.ts (25% boilerplate — inline DDL)

**Files:**
- Modify: `src/services/analytics/spending-analytics.test.ts`

This file has ~80 lines of inline CREATE TABLE statements duplicating schema.ts.

- [ ] **Step 1: Read the full file**

Read `src/services/analytics/spending-analytics.test.ts`.

- [ ] **Step 2: Replace inline DDL with createTestDb()**

The file creates tables manually instead of using `createTestDb()` from `src/test-utils/db.ts`. Replace the manual DDL with:

```ts
import { createTestDb, clearTestDb } from '../../test-utils/db';
```

Replace the mock.module for database with a real in-memory DB where possible, or keep mock.module but remove the DDL duplication.

- [ ] **Step 3: Use seedGroupAndUser from shared fixtures**

Replace manual group/user insertion with `seedGroupAndUser(db)`.

- [ ] **Step 4: Run tests**

Run: `bun test src/services/analytics/spending-analytics.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/services/analytics/spending-analytics.test.ts
git commit -m "refactor: use shared test DB and fixtures in spending-analytics tests"
```

---

### Task 9: Rewrite expense-saver.test.ts (mixed mock.module + spyOn)

**Files:**
- Modify: `src/bot/services/expense-saver.test.ts`

- [ ] **Step 1: Read the full file**

Read `src/bot/services/expense-saver.test.ts`.

- [ ] **Step 2: Convert spyOn calls to mock.module where appropriate**

With process isolation, `mock.module` is safe. Replace `spyOn(sheetsModule, 'appendExpenseRow')` and similar with `mock.module` at the top, using configurable mock functions that tests can override.

Pattern:
```ts
const appendExpenseRow = mock();
const convertToEUR = mock(() => 1.72);
const convertCurrency = mock(() => 0);
const formatAmount = mock((amount: number, currency: string) => `${amount} ${currency}`);

mock.module('../../services/google/sheets', () => ({ appendExpenseRow }));
mock.module('../../services/currency/converter', () => ({
  convertToEUR,
  convertCurrency,
  formatAmount,
}));
```

- [ ] **Step 3: Replace database mock with shared mockDatabase()**

```ts
import { mockDatabase } from '../../test-utils/mocks/database';
mock.module('../../database', () => ({ database: mockDatabase() }));
```

- [ ] **Step 4: Run tests**

Run: `bun test src/bot/services/expense-saver.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot/services/expense-saver.test.ts
git commit -m "refactor: use mock.module and shared mocks in expense-saver tests"
```

---

### Task 10: Rewrite receipt-fetcher.test.ts (repeated spyOn on urlValidator)

**Files:**
- Modify: `src/services/receipt/receipt-fetcher.test.ts`

- [ ] **Step 1: Read the full file**

Read `src/services/receipt/receipt-fetcher.test.ts`.

- [ ] **Step 2: Replace repeated spyOn with mock.module**

10+ calls to `spyOn(urlValidatorModule, 'isUrlSafe').mockResolvedValue(true)` — mock it once at module level:

```ts
const isUrlSafe = mock(() => Promise.resolve(true));
mock.module('./url-validator', () => ({ isUrlSafe }));
```

Tests that need `isUrlSafe` to return `false` can override: `isUrlSafe.mockResolvedValueOnce(false)`.

- [ ] **Step 3: Run tests**

Run: `bun test src/services/receipt/receipt-fetcher.test.ts`
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/services/receipt/receipt-fetcher.test.ts
git commit -m "refactor: use mock.module for url-validator in receipt-fetcher tests"
```

---

### Task 11: Rewrite cron.test.ts and feedback.test.ts (spyOn → mock.module)

**Files:**
- Modify: `src/bot/cron.test.ts`
- Modify: `src/services/feedback.test.ts`

Both files use spyOn for module-level mocks that would be cleaner as mock.module.

- [ ] **Step 1: Read both files**

Read `src/bot/cron.test.ts` and `src/services/feedback.test.ts`.

- [ ] **Step 2: Convert cron.test.ts**

Replace `spyOn(cron, 'schedule')`, `spyOn(converterModule, 'updateExchangeRates')`, `spyOn(senderModule, 'sendDirect')` with mock.module calls at the top.

- [ ] **Step 3: Convert feedback.test.ts**

Replace `spyOn(mod, 'sendDirect')` and `spyOn(database.groups, 'findById')` with mock.module.

- [ ] **Step 4: Run both tests**

Run: `bun test src/bot/cron.test.ts src/services/feedback.test.ts`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot/cron.test.ts src/services/feedback.test.ts
git commit -m "refactor: use mock.module in cron and feedback tests"
```

---

### Task 12: Batch cleanup — remaining test files

**Files:** All remaining `*.test.ts` files not covered by Tasks 6-11.

This task applies the following mechanical transformations across all remaining test files:

1. **If the file uses `mock.module('../../database', ...)`** with an inline object — replace with `import { mockDatabase } from '../../test-utils/mocks/database'` and `mockDatabase()` or `mockDatabase({ expenses: { findByGroupId: mock(() => [...]) } })`.

2. **If the file uses `globalThis.fetch = mock(...)`** — replace with `mockFetchJson()` / `mockFetchText()` from shared helpers + `restoreFetch()` in afterEach.

3. **If the file uses `spyOn` on imported module namespaces for top-level mocking** — evaluate whether `mock.module` would be cleaner. Convert if yes.

4. **If the file has a local `makeExpense()` factory** that duplicates the shared one — import from `src/test-utils/fixtures.ts`.

5. **If repository test files have manual group/user insertion** — use `seedGroupAndUser()`.

- [ ] **Step 1: List all remaining files not yet touched**

Compare full file list against Tasks 6-11 to find remaining files.

- [ ] **Step 2: Apply transformations file by file**

For each file, read → apply applicable transformations → run test → move to next.

- [ ] **Step 3: Run full test suite**

Run: `bun run test`
Expected: all 82 files pass, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor: apply shared mocks and fixtures across test suite"
```

---

### Task 13: Final Verification

- [ ] **Step 1: Run full test suite with isolated runner**

Run: `bun run test`
Expected: all files pass, output shows aggregated stats.

- [ ] **Step 2: Run type check**

Run: `bun run type-check`
Expected: no errors.

- [ ] **Step 3: Run linter**

Run: `bun run lint`
Expected: no warnings.

- [ ] **Step 4: Compare timing**

Run old vs new:
```bash
time bun test 2>&1 | tail -3
time bun run test 2>&1 | tail -3
```

Report the timing difference.

- [ ] **Step 5: Final commit if any remaining changes**
