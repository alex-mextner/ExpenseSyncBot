# Part 2: Tasks 4-7: delete_budget, delete_expense, manage_category, manage_recurring_pattern

[← Back to index](../2026-04-09-batch-write-tools.md)

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

