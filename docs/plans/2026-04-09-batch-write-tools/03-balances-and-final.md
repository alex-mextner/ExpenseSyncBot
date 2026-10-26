# Part 3: Tasks 8-10: get_bank_balances, system prompt, full test run

[← Back to index](../2026-04-09-batch-write-tools.md)

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
