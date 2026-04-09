# Batch Write Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add batch (array) support to 6 write tools so the AI agent can execute multiple operations in a single tool call.

**Scope:** Read tool batch (period/category arrays for `get_expenses`, `get_budgets`, `get_bank_transactions`, `find_missing_expenses`) and stats/diff/trend are already implemented. This plan covers only **write tool batch** + `get_bank_balances` array filter.

**Architecture:** Two batch patterns — Option A (array in target field) for tools with a single "target" parameter, and Option B (`items` array) for tools with multiple independent fields per item. A shared `executeBatchItems` helper handles the loop + result formatting. Each existing executor function is reused for individual items. Max 20 items per batch, independent execution (no rollback on partial failure).

**Pre-sync design:** `ensureFreshExpenses` / `ensureFreshBudgets` in `executeTool` runs **once** before the switch statement — it covers the entire batch, not per-item. This is correct: syncing once before the batch is both sufficient and efficient.

**Sync→async:** Several executor functions (`executeDeleteExpense`, `executeManageCategory`, `executeManageRecurringPattern`) are currently sync. In batch mode they return `executeBatchItems(...)` which is async. The switch cases in `executeTool` must add `await` (they already have `return await` for async cases, so this is consistent). Code samples in the plan show this explicitly.

**Schema validation:** For Option B tools (`set_budget`, `add_expense`), top-level `required` is removed because the schema must accept either single mode (top-level fields) or batch mode (`items` array). Each `items` element has its own `required`. In single mode, the existing executor validation (`!category`, `!amount`) catches missing fields — this is not a regression, just moves validation from schema to executor. Option A tools keep their `required` intact since the field type changes to `oneOf [string, array]`.

**Empty items array:** `isBatchInput([])` returns `false`, so `items: []` falls through to single mode. Each batch-enabled executor explicitly checks for `Array.isArray(items) && items.length === 0` and returns an error, preventing silent fallthrough.

**Sequential execution:** `executeBatchItems` executes items sequentially via `for...of`, NOT `Promise.all`. This is intentional — write operations may hit Google Sheets rate limits, and sequential execution is safer for DB consistency. Do not "optimize" to parallel.

**Tech Stack:** TypeScript, Bun test runner, existing `tool-executor.ts` / `tools.ts` infrastructure.

**Spec:** [`docs/specs/2026-04-02-batch-tools-stats.md`](../specs/2026-04-02-batch-tools-stats.md)

---

## File Structure

| File | Action | Responsibility |
|------|--------|---------------|
| `src/services/ai/batch.ts` | Create | `executeBatchItems` helper — loop, format results, enforce 20-item limit |
| `src/services/ai/batch.test.ts` | Create | Tests for `executeBatchItems` |
| `src/services/ai/tools.ts` | Modify | Update 6 tool schemas for array/items support |
| `src/services/ai/tool-executor.ts` | Modify | Wire batch detection into 6 write tool handlers |
| `src/services/ai/tool-executor.test.ts` | Modify | Add batch tests for each write tool |
| `src/services/ai/agent.ts` | Modify | Add batch instructions to system prompt |

---

### Task 1: Batch helper — `executeBatchItems`

**Files:**
- Create: `src/services/ai/batch.ts`
- Test: `src/services/ai/batch.test.ts`

The helper runs an async executor function for each item, collects per-item results (success/error), formats output.

- [ ] **Step 1: Write the failing test for `executeBatchItems`**

In `src/services/ai/batch.test.ts`:

```ts
import { describe, expect, test } from 'bun:test';
import { executeBatchItems, isBatchInput, MAX_BATCH_SIZE } from './batch';
import type { ToolResult } from './types';

describe('isBatchInput', () => {
  test('returns false for undefined', () => {
    expect(isBatchInput(undefined)).toBe(false);
  });

  test('returns false for a string', () => {
    expect(isBatchInput('hello')).toBe(false);
  });

  test('returns false for a number', () => {
    expect(isBatchInput(42)).toBe(false);
  });

  test('returns true for an array with items', () => {
    expect(isBatchInput([1, 2, 3])).toBe(true);
  });

  test('returns false for an empty array', () => {
    expect(isBatchInput([])).toBe(false);
  });
});

describe('executeBatchItems', () => {
  test('executes each item and collects results', async () => {
    const executor = async (item: { name: string }): Promise<ToolResult> => ({
      success: true,
      output: `Done: ${item.name}`,
    });

    const result = await executeBatchItems(
      [{ name: 'Еда' }, { name: 'Транспорт' }],
      'set_budget',
      executor,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('2/2 succeeded');
    expect(result.output).toContain('Done: Еда');
    expect(result.output).toContain('Done: Транспорт');
  });

  test('reports partial failures without aborting', async () => {
    const executor = async (item: { n: number }): Promise<ToolResult> => {
      if (item.n === 2) return { success: false, error: 'not found' };
      return { success: true, output: `ok #${item.n}` };
    };

    const result = await executeBatchItems(
      [{ n: 1 }, { n: 2 }, { n: 3 }],
      'delete_budget',
      executor,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('2/3 succeeded');
    expect(result.output).toContain('✗');
    expect(result.output).toContain('not found');
  });

  test('rejects batch over MAX_BATCH_SIZE', async () => {
    const items = Array.from({ length: MAX_BATCH_SIZE + 1 }, (_, i) => ({ id: i }));
    const executor = async () => ({ success: true, output: 'ok' }) as ToolResult;

    const result = await executeBatchItems(items, 'test_tool', executor);

    expect(result.success).toBe(false);
    expect(result.error).toContain(`${MAX_BATCH_SIZE}`);
  });

  test('returns all-failed summary when everything fails', async () => {
    const executor = async (): Promise<ToolResult> => ({
      success: false,
      error: 'boom',
    });

    const result = await executeBatchItems([{ a: 1 }, { a: 2 }], 'tool', executor);

    expect(result.success).toBe(false);
    expect(result.output).toContain('0/2 succeeded');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/ai/batch.test.ts`
Expected: FAIL — module `./batch` not found.

- [ ] **Step 3: Implement `executeBatchItems`**

In `src/services/ai/batch.ts`:

```ts
/** Batch execution helper for write tools — runs executor per item, collects results */
import type { ToolResult } from './types';

export const MAX_BATCH_SIZE = 20;

/** Check whether a value is a non-empty array (used to detect batch mode) */
export function isBatchInput(value: unknown): value is unknown[] {
  return Array.isArray(value) && value.length > 0;
}

interface BatchItemResult {
  success: boolean;
  message: string;
}

/**
 * Execute a function for each item in a batch, collect per-item results.
 * Returns a combined ToolResult with a formatted summary.
 *
 * Note: only `output` and `error` from individual results are aggregated.
 * `data` and `summary` fields are intentionally dropped — write tools
 * don't return structured data, and batch output is already a summary.
 *
 * Items execute sequentially (not Promise.all) to avoid rate limits
 * on Google Sheets and maintain DB consistency.
 */
export async function executeBatchItems<T>(
  items: T[],
  toolName: string,
  executor: (item: T) => Promise<ToolResult>,
): Promise<ToolResult> {
  if (items.length > MAX_BATCH_SIZE) {
    return {
      success: false,
      error: `Batch too large: ${items.length} items, max ${MAX_BATCH_SIZE}. Split into smaller batches.`,
    };
  }

  const results: BatchItemResult[] = [];

  for (const item of items) {
    const result = await executor(item);
    results.push({
      success: result.success,
      message: result.success
        ? `✓ ${toolName}: ${result.output ?? 'OK'}`
        : `✗ ${toolName}: ${result.error ?? 'Unknown error'}`,
    });
  }

  const succeeded = results.filter((r) => r.success).length;
  const total = results.length;
  const lines = [
    `=== Batch result (${succeeded}/${total} succeeded) ===`,
    ...results.map((r) => r.message),
  ];

  return {
    success: succeeded > 0,
    output: lines.join('\n'),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/ai/batch.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/batch.ts src/services/ai/batch.test.ts
git commit -m "feat: add batch execution helper for write tools"
```

---

### Task 2: Batch `set_budget` (Option B — `items` array)

**Files:**
- Modify: `src/services/ai/tools.ts` — update `set_budget` schema
- Modify: `src/services/ai/tool-executor.ts` — detect `items`, loop via `executeBatchItems`
- Modify: `src/services/ai/tool-executor.test.ts` — add batch tests

- [ ] **Step 1: Write the failing test**

Add to `src/services/ai/tool-executor.test.ts`, inside a new `describe('set_budget batch')` block:

```ts
describe('set_budget batch', () => {
  beforeEach(resetAllMocks);

  test('batch set_budget with items array calls set for each item', async () => {
    const result = await executeTool(
      'set_budget',
      {
        items: [
          { category: 'Food', amount: 50000 },
          { category: 'Transport', amount: 10000 },
          { category: 'Fun', amount: 20000 },
        ],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('3/3 succeeded');
    expect(mockBudgetManagerSet).toHaveBeenCalledTimes(3);
  });

  test('batch set_budget reports partial failure', async () => {
    mockBudgetManagerSet
      .mockResolvedValueOnce({ sheetsSynced: false })
      .mockRejectedValueOnce(new Error('Sheet error'))
      .mockResolvedValueOnce({ sheetsSynced: false });

    const result = await executeTool(
      'set_budget',
      {
        items: [
          { category: 'Food', amount: 100 },
          { category: 'Bad', amount: 200 },
          { category: 'OK', amount: 300 },
        ],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('2/3 succeeded');
    expect(result.output).toContain('✗');
  });

  test('batch over 20 items is rejected', async () => {
    const items = Array.from({ length: 21 }, (_, i) => ({
      category: `Cat${i}`,
      amount: 100,
    }));

    const result = await executeTool('set_budget', { items }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('20');
  });

  test('single set_budget still works (backward compat)', async () => {
    const result = await executeTool(
      'set_budget',
      { category: 'Food', amount: 500 },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(mockBudgetManagerSet).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('Budget set: Food');
  });

  test('items array takes priority over top-level fields', async () => {
    const result = await executeTool(
      'set_budget',
      {
        category: 'IGNORED',
        amount: 999,
        items: [{ category: 'Real', amount: 100 }],
      },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('1/1 succeeded');
    expect(mockBudgetManagerSet).toHaveBeenCalledTimes(1);
    // Verify the actual call used 'Real', not 'IGNORED'
    const callArg = mockBudgetManagerSet.mock.calls[0][0];
    expect(callArg.category).toBe('Real');
    expect(callArg.amount).toBe(100);
  });

  test('empty items array returns error', async () => {
    const result = await executeTool('set_budget', { items: [] }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/ai/tool-executor.test.ts`
Expected: FAIL — batch tests fail because `items` is ignored.

- [ ] **Step 3: Update tool schema in `tools.ts`**

Replace the `set_budget` definition's `input_schema`:

```ts
  {
    name: 'set_budget',
    description:
      'Set or update budget limit for a category. Saves to DB and syncs to Google Sheets. Pass an `items` array to set multiple budgets in one call (max 20).',
    input_schema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'Category name (single mode)',
        },
        amount: {
          type: 'number',
          description: 'Budget limit amount (single mode)',
        },
        currency: {
          type: 'string',
          description:
            'Currency code (e.g., "EUR", "USD", "RSD"). Default: group default currency.',
        },
        month: {
          type: 'string',
          description: 'Month in "YYYY-MM" format. Default: current month.',
        },
        items: {
          type: 'array',
          description:
            'Batch mode: array of {category, amount, currency?, month?}. When present, top-level category/amount are ignored.',
          items: {
            type: 'object',
            properties: {
              category: { type: 'string' },
              amount: { type: 'number' },
              currency: { type: 'string' },
              month: { type: 'string' },
            },
            required: ['category', 'amount'],
          },
        },
      },
    },
  },
```

- [ ] **Step 4: Wire batch logic in `tool-executor.ts`**

Update `executeSetBudget` to detect `items` array:

```ts
async function executeSetBudget(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  // Batch mode: items array
  if (isBatchInput(input['items'])) {
    const items = input['items'] as Array<Record<string, unknown>>;
    return executeBatchItems(items, 'set_budget', (item) =>
      executeSetBudgetSingle(item, ctx),
    );
  }

  // Explicit empty array → error (isBatchInput returns false for [])
  if (Array.isArray(input['items'])) {
    return { success: false, error: 'items array is empty' };
  }

  return executeSetBudgetSingle(input, ctx);
}

async function executeSetBudgetSingle(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  // ... existing executeSetBudget body (unchanged) ...
}
```

Add import at top of `tool-executor.ts`:

```ts
import { executeBatchItems, isBatchInput } from './batch';
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/services/ai/tool-executor.test.ts`
Expected: All tests PASS, including new batch tests and existing single-mode tests.

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts src/services/ai/tool-executor.test.ts
git commit -m "feat: batch support for set_budget tool (items array)"
```

---

### Task 3: Batch `add_expense` (Option B — `items` array)

**Files:**
- Modify: `src/services/ai/tools.ts` — update `add_expense` schema
- Modify: `src/services/ai/tool-executor.ts` — detect `items`, batch via helper
- Modify: `src/services/ai/tool-executor.test.ts` — add batch tests

- [ ] **Step 1: Write the failing test**

Add to `src/services/ai/tool-executor.test.ts`:

```ts
describe('add_expense batch', () => {
  beforeEach(resetAllMocks);

  test('batch add_expense with items array records each expense', async () => {
    const result = await executeTool(
      'add_expense',
      {
        items: [
          { amount: 300, category: 'Еда', comment: 'кофе' },
          { amount: 800, category: 'Еда', comment: 'обед' },
          { amount: 500, category: 'Транспорт', comment: 'такси' },
        ],
      },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('3/3 succeeded');
    expect(mockRecord).toHaveBeenCalledTimes(3);
  });

  test('single add_expense still works (backward compat)', async () => {
    const result = await executeTool(
      'add_expense',
      { amount: 300, category: 'Еда', comment: 'кофе' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(mockRecord).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('Expense added');
  });

  test('batch over 20 items is rejected', async () => {
    const items = Array.from({ length: 21 }, (_, i) => ({
      amount: 100,
      category: `Cat${i}`,
    }));

    const result = await executeTool('add_expense', { items }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('20');
  });

  test('items array takes priority over top-level fields', async () => {
    const result = await executeTool(
      'add_expense',
      {
        amount: 999,
        category: 'IGNORED',
        items: [{ amount: 42, category: 'Real', comment: 'test' }],
      },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('1/1 succeeded');
    expect(mockRecord).toHaveBeenCalledTimes(1);
    const callArg = mockRecord.mock.calls[0][1];
    expect(callArg.category).toBe('Real');
    expect(callArg.amount).toBe(42);
  });

  test('empty items array returns error', async () => {
    const result = await executeTool('add_expense', { items: [] }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/ai/tool-executor.test.ts`
Expected: FAIL — `items` ignored, only 1 call.

- [ ] **Step 3: Update tool schema in `tools.ts`**

Add `items` property to `add_expense` input_schema:

```ts
        items: {
          type: 'array',
          description:
            'Batch mode: array of {amount, currency?, category, comment?, date?}. When present, top-level fields are ignored.',
          items: {
            type: 'object',
            properties: {
              amount: { type: 'number' },
              currency: { type: 'string' },
              category: { type: 'string' },
              comment: { type: 'string' },
              date: { type: 'string' },
            },
            required: ['amount', 'category'],
          },
        },
```

Update the description to mention batch support.

- [ ] **Step 4: Wire batch logic in `tool-executor.ts`**

Same pattern as set_budget — extract `executeAddExpenseSingle`, add batch detection:

```ts
async function executeAddExpense(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  if (isBatchInput(input['items'])) {
    const items = input['items'] as Array<Record<string, unknown>>;
    return executeBatchItems(items, 'add_expense', (item) =>
      executeAddExpenseSingle(item, ctx),
    );
  }

  if (Array.isArray(input['items'])) {
    return { success: false, error: 'items array is empty' };
  }

  return executeAddExpenseSingle(input, ctx);
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `bun test src/services/ai/tool-executor.test.ts`
Expected: All tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts src/services/ai/tool-executor.test.ts
git commit -m "feat: batch support for add_expense tool (items array)"
```

---

### Task 4: Batch `delete_budget` (Option A — `category` array)

**Files:**
- Modify: `src/services/ai/tools.ts` — update `delete_budget` schema
- Modify: `src/services/ai/tool-executor.ts` — detect array `category`
- Modify: `src/services/ai/tool-executor.test.ts` — add batch tests

- [ ] **Step 1: Write the failing test**

```ts
describe('delete_budget batch', () => {
  beforeEach(resetAllMocks);

  test('batch delete with category array', async () => {
    const result = await executeTool(
      'delete_budget',
      { category: ['Food', 'Transport', 'Fun'] },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('3/3 succeeded');
    expect(mockBudgetManagerDelete).toHaveBeenCalledTimes(3);
  });

  test('single delete still works (backward compat)', async () => {
    const result = await executeTool(
      'delete_budget',
      { category: 'Food' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(mockBudgetManagerDelete).toHaveBeenCalledTimes(1);
    expect(result.output).toContain('Budget deleted for Food');
  });

  test('empty category array returns error', async () => {
    const result = await executeTool('delete_budget', { category: [] }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/ai/tool-executor.test.ts`
Expected: FAIL — array category treated as string.

- [ ] **Step 3: Update schema and executor**

In `tools.ts`, update `delete_budget.category` to use `oneOf: [string, string[]]`:

```ts
        category: {
          oneOf: [
            { type: 'string', description: 'Single category' },
            { type: 'array', items: { type: 'string' }, description: 'Array of categories' },
          ],
          description: 'Category name(s). Pass an array to delete multiple budgets at once.',
        },
```

In `tool-executor.ts`, update `executeDeleteBudget`:

```ts
async function executeDeleteBudget(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const rawCategory = input['category'];
  const month = (input['month'] as string) || format(new Date(), 'yyyy-MM');

  if (isBatchInput(rawCategory)) {
    const categories = rawCategory as string[];
    return executeBatchItems(categories, 'delete_budget', (category) =>
      executeDeleteBudgetSingle(category, month, ctx),
    );
  }

  if (Array.isArray(rawCategory)) {
    return { success: false, error: 'category array is empty' };
  }

  const category = rawCategory as string;
  return executeDeleteBudgetSingle(category, month, ctx);
}

async function executeDeleteBudgetSingle(
  category: string,
  month: string,
  ctx: AgentContext,
): Promise<ToolResult> {
  if (!category) {
    return { success: false, error: 'category is required' };
  }
  await getBudgetManager().delete({ groupId: ctx.groupId, category, month });
  return {
    success: true,
    output: `Budget deleted for ${category} in ${month}`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/ai/tool-executor.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts src/services/ai/tool-executor.test.ts
git commit -m "feat: batch support for delete_budget tool (category array)"
```

---

### Task 5: Batch `delete_expense` (Option A — `expense_id` array)

**Files:**
- Modify: `src/services/ai/tools.ts` — update `delete_expense` schema
- Modify: `src/services/ai/tool-executor.ts` — detect array `expense_id`
- Modify: `src/services/ai/tool-executor.test.ts` — add batch tests

- [ ] **Step 1: Write the failing test**

```ts
describe('delete_expense batch', () => {
  beforeEach(resetAllMocks);

  test('batch delete with expense_id array', async () => {
    // Set up findById to return an expense for each ID
    mockExpenses.findById.mockImplementation((id: number) => ({
      id,
      group_id: 1,
      user_id: 123,
      date: '2026-03-01',
      category: 'Food',
      comment: 'test',
      amount: 10,
      currency: 'EUR',
      eur_amount: 10,
      created_at: '',
    }));

    const result = await executeTool(
      'delete_expense',
      { expense_id: [10, 11, 12] },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('3/3 succeeded');
    expect(mockExpenses.delete).toHaveBeenCalledTimes(3);
  });

  test('batch delete rejects expense from another group', async () => {
    mockExpenses.findById
      .mockReturnValueOnce({
        id: 10, group_id: 1, user_id: 123, date: '2026-03-01',
        category: 'Food', comment: '', amount: 10, currency: 'EUR', eur_amount: 10, created_at: '',
      })
      .mockReturnValueOnce({
        id: 11, group_id: 999, user_id: 123, date: '2026-03-01',
        category: 'Food', comment: '', amount: 10, currency: 'EUR', eur_amount: 10, created_at: '',
      });

    const result = await executeTool(
      'delete_expense',
      { expense_id: [10, 11] },
      ctx,
    );

    expect(result.output).toContain('1/2 succeeded');
    expect(result.output).toContain('Access denied');
  });

  test('single delete still works', async () => {
    mockExpenses.findById.mockReturnValue({
      id: 10, group_id: 1, user_id: 123, date: '2026-03-01',
      category: 'Food', comment: 'lunch', amount: 15, currency: 'EUR', eur_amount: 15, created_at: '',
    });

    const result = await executeTool('delete_expense', { expense_id: 10 }, ctx);
    expect(result.success).toBe(true);
    expect(mockExpenses.delete).toHaveBeenCalledWith(10);
    expect(result.output).toContain('Expense 10 deleted');
  });

  test('empty expense_id array returns error', async () => {
    const result = await executeTool('delete_expense', { expense_id: [] }, ctx);
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/ai/tool-executor.test.ts`
Expected: FAIL — array treated as single value.

- [ ] **Step 3: Update schema and executor**

In `tools.ts`, update `delete_expense.expense_id`:

```ts
        expense_id: {
          oneOf: [
            { type: 'number', description: 'Single expense ID' },
            { type: 'array', items: { type: 'number' }, description: 'Array of expense IDs' },
          ],
          description:
            'ID(s) of the expense(s) to delete. Pass an array to delete multiple at once.',
        },
```

In `tool-executor.ts`, update `executeDeleteExpense`. **Important:** this function was sync, now returns `Promise<ToolResult>` in batch path. Update the switch case to `return await executeDeleteExpense(...)`:

```ts
async function executeDeleteExpense(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const rawId = input['expense_id'];

  if (isBatchInput(rawId)) {
    const ids = rawId as number[];
    return executeBatchItems(ids, 'delete_expense', async (id) =>
      executeDeleteExpenseSingle(id, ctx),
    );
  }

  if (Array.isArray(rawId)) {
    return { success: false, error: 'expense_id array is empty' };
  }

  return executeDeleteExpenseSingle(rawId as number, ctx);
}
```

In `executeTool` switch, change:
```ts
// Before:
case 'delete_expense':
  return executeDeleteExpense(input, ctx);
// After:
case 'delete_expense':
  return await executeDeleteExpense(input, ctx);
```

Note: `executeDeleteExpense` becomes async because `executeBatchItems` is async. Update the return type and the switch case in `executeTool`.

Extract existing body into `executeDeleteExpenseSingle(expenseId: number, ctx)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/ai/tool-executor.test.ts`
Expected: All tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts src/services/ai/tool-executor.test.ts
git commit -m "feat: batch support for delete_expense tool (expense_id array)"
```

---

### Task 6: Batch `manage_category` (Option A — `name` array)

**Files:**
- Modify: `src/services/ai/tools.ts` — update `manage_category` schema
- Modify: `src/services/ai/tool-executor.ts` — detect array `name`
- Modify: `src/services/ai/tool-executor.test.ts` — add batch tests

- [ ] **Step 1: Write the failing test**

```ts
describe('manage_category batch', () => {
  beforeEach(resetAllMocks);

  test('batch create with name array', async () => {
    const result = await executeTool(
      'manage_category',
      { action: 'create', name: ['Еда', 'Транспорт', 'Развлечения'] },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('3/3 succeeded');
    expect(mockCategories.create).toHaveBeenCalledTimes(3);
  });

  test('batch delete with name array', async () => {
    mockCategories.findByName.mockImplementation((_gid: number, name: string) => ({
      id: name.length,
      group_id: 1,
      name,
      created_at: '',
    }));

    const result = await executeTool(
      'manage_category',
      { action: 'delete', name: ['Еда', 'Транспорт'] },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('2/2 succeeded');
  });

  test('single manage_category still works', async () => {
    const result = await executeTool(
      'manage_category',
      { action: 'create', name: 'Еда' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('created');
  });

  test('empty name array returns error', async () => {
    const result = await executeTool(
      'manage_category',
      { action: 'create', name: [] },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/ai/tool-executor.test.ts`

- [ ] **Step 3: Update schema and executor**

In `tools.ts`, update `manage_category.name`:

```ts
        name: {
          oneOf: [
            { type: 'string', description: 'Single category name' },
            { type: 'array', items: { type: 'string' }, description: 'Array of category names' },
          ],
          description: 'Category name(s). Pass an array to create/delete multiple at once.',
        },
```

In `tool-executor.ts`, update `executeManageCategory`:

**Important:** this function was sync, now returns `Promise<ToolResult>` in batch path. Make it `async` and update the switch case to `return await executeManageCategory(...)`.

```ts
async function executeManageCategory(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const action = input['action'] as string;
  const rawName = input['name'];

  if (!action) {
    return { success: false, error: 'action is required' };
  }

  if (isBatchInput(rawName)) {
    const names = rawName as string[];
    return executeBatchItems(names, 'manage_category', async (name) =>
      executeManageCategorySingle(action, name, ctx),
    );
  }

  if (Array.isArray(rawName)) {
    return { success: false, error: 'name array is empty' };
  }

  return executeManageCategorySingle(action, rawName as string, ctx);
}
```

Extract existing body into `executeManageCategorySingle(action, name, ctx)`.

In `executeTool` switch, change:
```ts
// Before:
case 'manage_category':
  return executeManageCategory(input, ctx);
// After:
case 'manage_category':
  return await executeManageCategory(input, ctx);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/ai/tool-executor.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts src/services/ai/tool-executor.test.ts
git commit -m "feat: batch support for manage_category tool (name array)"
```

---

### Task 7: Batch `manage_recurring_pattern` (Option A — `pattern_id` array)

**Files:**
- Modify: `src/services/ai/tools.ts` — update schema
- Modify: `src/services/ai/tool-executor.ts` — detect array `pattern_id`
- Modify: `src/services/ai/tool-executor.test.ts` — add batch tests

- [ ] **Step 1: Write the failing test**

**Pre-requisite:** Add `mockRecurringPatterns` to the test file setup. Three changes needed:

**1. Add mock object** (after `mockBankTransactions` definition, before `mock.module`):

```ts
const mockRecurringPatterns = {
  findById: mock((id: number) => ({
    id,
    group_id: 1,
    category: `Cat${id}`,
    expected_amount: 100,
    currency: 'EUR',
    expected_day: 1,
    next_expected_date: null,
    last_seen_date: null,
    status: 'active',
  })),
  updateStatus: mock(() => {}),
  delete: mock(() => {}),
  findAllByGroupId: mock(() => []),
};
```

**2. Wire into mockDatabase** (update the existing `mock.module('../../database', ...)` call):

```ts
mock.module('../../database', () => ({
  database: mockDatabase({
    expenses: mockExpenses,
    budgets: mockBudgets,
    categories: mockCategories,
    groups: mockGroups,
    users: mockUsers,
    bankTransactions: mockBankTransactions,
    recurringPatterns: mockRecurringPatterns, // ← add this line
  }),
}));
```

**3. Add resets to `resetAllMocks()`** (at the end, before closing brace):

```ts
  mockRecurringPatterns.findById.mockReset();
  mockRecurringPatterns.findById.mockImplementation((id: number) => ({
    id,
    group_id: 1,
    category: `Cat${id}`,
    expected_amount: 100,
    currency: 'EUR',
    expected_day: 1,
    next_expected_date: null,
    last_seen_date: null,
    status: 'active',
  }));
  mockRecurringPatterns.updateStatus.mockReset();
  mockRecurringPatterns.delete.mockReset();
  mockRecurringPatterns.findAllByGroupId.mockReset();
  mockRecurringPatterns.findAllByGroupId.mockReturnValue([]);
```

Then the test:

```ts
describe('manage_recurring_pattern batch', () => {
  beforeEach(resetAllMocks);

  test('batch pause with pattern_id array', async () => {
    const result = await executeTool(
      'manage_recurring_pattern',
      { pattern_id: [1, 2, 3], action: 'pause' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('3/3 succeeded');
    expect(mockRecurringPatterns.updateStatus).toHaveBeenCalledTimes(3);
  });

  test('single pattern still works', async () => {
    const result = await executeTool(
      'manage_recurring_pattern',
      { pattern_id: 1, action: 'pause' },
      ctx,
    );
    expect(result.success).toBe(true);
    expect(result.output).toContain('paused');
  });

  test('empty pattern_id array returns error', async () => {
    const result = await executeTool(
      'manage_recurring_pattern',
      { pattern_id: [], action: 'pause' },
      ctx,
    );
    expect(result.success).toBe(false);
    expect(result.error).toContain('empty');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/ai/tool-executor.test.ts`

- [ ] **Step 3: Update schema and executor**

In `tools.ts`, update `manage_recurring_pattern.pattern_id`:

```ts
        pattern_id: {
          oneOf: [
            { type: 'number', description: 'Single pattern ID' },
            { type: 'array', items: { type: 'number' }, description: 'Array of pattern IDs' },
          ],
          description: 'ID(s) of the recurring pattern(s) to manage.',
        },
```

In `tool-executor.ts`, update `executeManageRecurringPattern`. **Important:** was sync, now returns `Promise<ToolResult>` in batch path. Make `async` and update switch to `return await`.

```ts
async function executeManageRecurringPattern(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const rawPatternId = input['pattern_id'];
  const action = input['action'] as string;

  if (!action) {
    return { success: false, error: 'action is required' };
  }

  if (isBatchInput(rawPatternId)) {
    const ids = rawPatternId as number[];
    return executeBatchItems(ids, 'manage_recurring_pattern', async (id) =>
      executeManageRecurringPatternSingle(id, action, ctx),
    );
  }

  if (Array.isArray(rawPatternId)) {
    return { success: false, error: 'pattern_id array is empty' };
  }

  return executeManageRecurringPatternSingle(rawPatternId as number, action, ctx);
}
```

Extract existing body into `executeManageRecurringPatternSingle(patternId, action, ctx)`.

In `executeTool` switch, change:
```ts
// Before:
case 'manage_recurring_pattern':
  return executeManageRecurringPattern(input, ctx);
// After:
case 'manage_recurring_pattern':
  return await executeManageRecurringPattern(input, ctx);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/ai/tool-executor.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts src/services/ai/tool-executor.test.ts
git commit -m "feat: batch support for manage_recurring_pattern tool (pattern_id array)"
```

---

### Task 8: Batch `get_bank_balances` (Option A — `bank_name` array)

**Files:**
- Modify: `src/services/ai/tools.ts` — update schema
- Modify: `src/services/ai/tool-executor.ts` — handle array `bank_name`
- Modify: `src/services/ai/tool-executor.test.ts` — add test

This is a read tool, not a write tool — no `executeBatchItems` needed. The existing `executeGetBankBalances` just needs to accept `bank_name` as `string | string[]` and filter for any match (OR).

**Pre-requisite:** Add `mockBankAccounts` and `mockBankConnections` to the test file setup.

**1. Add mock objects** (after `mockBankTransactions`, before `mock.module`):

```ts
const mockBankAccounts = {
  findByGroupId: mock(() => [
    { id: 1, connection_id: 10, title: 'TBC Card', balance: 5000, currency: 'GEL', type: 'card', is_excluded: 0 },
    { id: 2, connection_id: 10, title: 'TBC Savings', balance: 20000, currency: 'GEL', type: 'savings', is_excluded: 0 },
    { id: 3, connection_id: 20, title: 'Kaspi Card', balance: 100000, currency: 'KZT', type: 'card', is_excluded: 0 },
    { id: 4, connection_id: 30, title: 'Monobank UAH', balance: 3000, currency: 'UAH', type: 'card', is_excluded: 0 },
  ]),
};

const mockBankConnections = {
  findById: mock((id: number) => {
    const map: Record<number, { id: number; bank_name: string; display_name: string }> = {
      10: { id: 10, bank_name: 'tbc-ge', display_name: 'TBC Bank' },
      20: { id: 20, bank_name: 'kaspi', display_name: 'Kaspi Bank' },
      30: { id: 30, bank_name: 'monobank', display_name: 'Monobank' },
    };
    return map[id] ?? null;
  }),
  findActiveByGroupId: mock(() => []),
};
```

**2. Wire into mockDatabase** (add to existing call):

```ts
    bankAccounts: mockBankAccounts,
    bankConnections: mockBankConnections,
```

**3. Add resets to `resetAllMocks()`:**

```ts
  mockBankAccounts.findByGroupId.mockReset();
  mockBankAccounts.findByGroupId.mockReturnValue([
    { id: 1, connection_id: 10, title: 'TBC Card', balance: 5000, currency: 'GEL', type: 'card', is_excluded: 0 },
    { id: 2, connection_id: 10, title: 'TBC Savings', balance: 20000, currency: 'GEL', type: 'savings', is_excluded: 0 },
    { id: 3, connection_id: 20, title: 'Kaspi Card', balance: 100000, currency: 'KZT', type: 'card', is_excluded: 0 },
    { id: 4, connection_id: 30, title: 'Monobank UAH', balance: 3000, currency: 'UAH', type: 'card', is_excluded: 0 },
  ]);
  mockBankConnections.findById.mockReset();
  mockBankConnections.findById.mockImplementation((id: number) => {
    const map: Record<number, { id: number; bank_name: string; display_name: string }> = {
      10: { id: 10, bank_name: 'tbc-ge', display_name: 'TBC Bank' },
      20: { id: 20, bank_name: 'kaspi', display_name: 'Kaspi Bank' },
      30: { id: 30, bank_name: 'monobank', display_name: 'Monobank' },
    };
    return map[id] ?? null;
  });
  mockBankConnections.findActiveByGroupId.mockReset();
  mockBankConnections.findActiveByGroupId.mockReturnValue([]);
```

- [ ] **Step 1: Write the failing test**

```ts
describe('get_bank_balances array bank_name', () => {
  beforeEach(resetAllMocks);

  test('accepts array of bank names and filters OR-match', async () => {
    const result = await executeTool(
      'get_bank_balances',
      { bank_name: ['tbc-ge', 'kaspi'] },
      ctx,
    );

    expect(result.success).toBe(true);
    // Should include TBC (2 accounts) + Kaspi (1 account), exclude Monobank
    expect(result.data).toHaveLength(3);
    const bankNames = (result.data as Array<{ bank_name: string }>).map((a) => a.bank_name);
    expect(bankNames).toContain('tbc-ge');
    expect(bankNames).toContain('kaspi');
    expect(bankNames).not.toContain('monobank');
  });

  test('single string bank_name still works (backward compat)', async () => {
    const result = await executeTool(
      'get_bank_balances',
      { bank_name: 'kaspi' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(1);
  });

  test('bank_name "all" returns all accounts', async () => {
    const result = await executeTool(
      'get_bank_balances',
      { bank_name: 'all' },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(4);
  });

  test('array with "all" returns all accounts', async () => {
    const result = await executeTool(
      'get_bank_balances',
      { bank_name: ['tbc-ge', 'all'] },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toHaveLength(4);
  });

  test('no matching bank returns helpful error with available banks', async () => {
    const result = await executeTool(
      'get_bank_balances',
      { bank_name: ['nonexistent'] },
      ctx,
    );

    expect(result.success).toBe(true);
    expect(result.data).toEqual([]);
    expect(result.summary).toContain('tbc-ge');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test src/services/ai/tool-executor.test.ts`

- [ ] **Step 3: Update schema and executor**

In `tools.ts`, update `get_bank_balances.bank_name` to `oneOf: [string, string[]]` (same pattern as `get_bank_transactions`):

```ts
        bank_name: {
          oneOf: [
            { type: 'string', description: 'Single bank name' },
            { type: 'array', items: { type: 'string' }, description: 'Array of bank names' },
          ],
          description:
            'Which bank(s) to show: "all" for all banks, or bank registry key(s) (case-insensitive substring match). Pass an array for multiple banks.',
        },
```

In `tool-executor.ts`, update `executeGetBankBalances` to normalize `bank_name` via `normalizeArrayParam` and filter accounts matching ANY of the names:

```ts
function executeGetBankBalances(input: Record<string, unknown>, ctx: AgentContext): ToolResult {
  const bankNames = normalizeArrayParam(input['bank_name']);
  const isAll = bankNames.length === 0 || bankNames.some((b) => b.toLowerCase() === 'all');
  const filters = isAll
    ? undefined
    : bankNames.map((b) => b.toLowerCase()).filter((b) => b !== 'all');

  const accounts = database.bankAccounts.findByGroupId(ctx.groupId, true);
  const filtered = filters
    ? accounts.filter((a) => {
        const conn = database.bankConnections.findById(a.connection_id);
        const bankName = conn?.bank_name?.toLowerCase() ?? '';
        return filters.some((f) => bankName.includes(f));
      })
    : accounts;

  // ... rest unchanged (from line `if (filtered.length === 0)` onward) ...
  // Note: update the "not found" branch to show filter as array:
  // `No accounts found matching bank_name filter "${filters?.join(', ')}"`
}
```

**Note:** The "not found" branch needs adjustment — `bankNameFilter` was a single string, now `filters` is an array. Update the summary to `filters?.join(', ')` and adjust the condition to `if (filters)` instead of `if (bankNameFilter)`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test src/services/ai/tool-executor.test.ts`

- [ ] **Step 5: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts src/services/ai/tool-executor.test.ts
git commit -m "feat: array bank_name support for get_bank_balances"
```

---

### Task 9: System prompt updates

**Files:**
- Modify: `src/services/ai/agent.ts`

- [ ] **Step 1: Add batch instructions to system prompt**

In `agent.ts`, inside `buildSystemPrompt()`, add to the `## TOOL USAGE` section (after rule 8a):

```
8b. BATCH OPERATIONS: set_budget and add_expense accept an \`items\` array for multiple operations in one call (max 20). delete_budget, delete_expense, manage_category, manage_recurring_pattern accept arrays in their primary field (category, expense_id, name, pattern_id). Prefer batch over sequential calls. Each item executes independently — partial failures don't abort the batch.
```

- [ ] **Step 2: Update `TOOL_LABELS` in `tools.ts` for batch-aware labels**

No change needed — labels are per-tool, not per-item. The batch output already identifies each sub-result.

- [ ] **Step 3: Commit**

```bash
git add src/services/ai/agent.ts
git commit -m "feat: add batch tool usage instructions to system prompt"
```

---

### Task 10: Full test suite run + lint

- [ ] **Step 1: Run linter**

Run: `node_modules/.bin/biome check src/services/ai/batch.ts src/services/ai/tool-executor.ts src/services/ai/tools.ts src/services/ai/agent.ts`

Fix any issues.

- [ ] **Step 2: Run typecheck**

Run: `bun run type-check`

Fix any type errors.

- [ ] **Step 3: Run full test suite**

Run: `bun run test`

All tests must pass.

- [ ] **Step 4: Run knip for unused exports**

Run: `bunx knip`

Fix any reported issues.

- [ ] **Step 5: Commit fixes if any**

```bash
git add -A && git commit -m "fix: lint and type errors from batch tools"
```
