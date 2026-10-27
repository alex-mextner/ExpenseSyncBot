# Part 1: File Structure; Tasks 1-3: batch helper, set_budget, add_expense

[← Back to index](../2026-04-09-batch-write-tools.md)

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

