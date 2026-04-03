# Safe Sync + Batch Budget Setting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix destructive auto-sync that silently deletes budgets/expenses, reverse budget write order to Sheets→DB, add batch set_budget tool for AI.

**Architecture:** Budget writes go Sheets→DB (matching expense-recorder pattern). Both syncBudgetsDiff and syncExpenses collect `pendingDeletions` instead of deleting. Deletions require explicit user confirmation via inline keyboard or AI tool. Batch set_budget accepts array of budgets in one tool call.

**Tech Stack:** Bun, SQLite, googleapis, Anthropic Claude SDK (tool calling), GramIO (Telegram)

---

### Task 1: BudgetManager — Sheets → DB write order

**Files:**
- Modify: `src/services/budget-manager.ts`
- Modify: `src/services/budget-manager.test.ts`

The key change: `set()` writes to Sheets first, then DB. If Sheets write fails and Sheets IS connected → throw (don't write to DB). If no Sheets connected → DB only (local mode, same as before).

For `delete()`: same pattern — zero out in Sheets first, then delete from DB.

- [ ] **Step 1.1: Update test — set() writes Sheets before DB, fails if Sheets fails**

In `src/services/budget-manager.test.ts`, replace the test `'saves to DB even when Sheets sync fails'` (line 201-215) with two new tests:

```ts
test('throws when Sheets is connected but write fails', async () => {
  mockWriteMonthBudgetRow.mockRejectedValue(new Error('Sheets API down'));

  const mgr = new BudgetManager();
  await expect(
    mgr.set({
      groupId: 1,
      category: 'Food',
      month: '2026-04',
      amount: 700,
      currency: 'EUR',
    }),
  ).rejects.toThrow('Sheets API down');

  // DB write must NOT happen when Sheets fails
  expect(mockSetBudget).not.toHaveBeenCalled();
});

test('writes to DB only when no Sheets connected (local mode)', async () => {
  mockFindGroupById.mockReturnValue({
    id: 1,
    telegram_group_id: 456,
    google_refresh_token: null,
    spreadsheet_id: null,
    default_currency: 'EUR' as CurrencyCode,
    enabled_currencies: ['EUR'],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'legacy' as const,
    bank_panel_summary_message_id: null,
    created_at: '',
    updated_at: '',
  });

  const mgr = new BudgetManager();
  const result = await mgr.set({
    groupId: 1,
    category: 'Food',
    month: '2026-04',
    amount: 700,
    currency: 'EUR',
  });

  expect(result.sheetsSynced).toBe(false);
  expect(mockSetBudget).toHaveBeenCalled();
  expect(mockWriteMonthBudgetRow).not.toHaveBeenCalled();
});
```

Also update `'saves to DB and syncs to Sheets'` test (line 106) — verify Sheets is called BEFORE DB by checking mock call order:

```ts
test('writes to Sheets first, then DB', async () => {
  const callOrder: string[] = [];
  mockWriteMonthBudgetRow.mockImplementation(async () => {
    callOrder.push('sheets');
  });
  mockSetBudget.mockImplementation(() => {
    callOrder.push('db');
    return {} as Budget;
  });

  const mgr = new BudgetManager();
  const result = await mgr.set({
    groupId: 1,
    category: 'Food',
    month: '2026-04',
    amount: 700,
    currency: 'EUR',
  });

  expect(result.sheetsSynced).toBe(true);
  expect(callOrder).toEqual(['sheets', 'db']);
});
```

- [ ] **Step 1.2: Run tests — verify they fail**

```bash
bun test src/services/budget-manager.test.ts
```

Expected: new tests fail (set() still writes DB first, doesn't throw on Sheets failure).

- [ ] **Step 1.3: Implement — reverse write order in set()**

In `src/services/budget-manager.ts`, replace `set()` method (lines 41-62):

```ts
async set(params: SetBudgetParams): Promise<BudgetWriteResult> {
  const { groupId, category, month, amount, currency } = params;

  const group = database.groups.findById(groupId);

  // 1. Write to Sheets first (if connected). Fail fast on error.
  const sheetsSynced = await this.syncToSheets(group, month, {
    category,
    limit: amount,
    currency,
  });

  // If Sheets IS connected but write failed → don't write to DB (keep consistent)
  if (!sheetsSynced && this.hasSheetsConnection(group, month)) {
    throw new Error(`Failed to save budget to Google Sheets for ${category}`);
  }

  // 2. Write to DB (atomic, after Sheets success)
  _budgetWriter().setBudget({
    group_id: groupId,
    category,
    month,
    limit_amount: amount,
    currency,
  });

  return { sheetsSynced };
}
```

Add private helper:

```ts
/** Check if group has Sheets connection and spreadsheet for the given month's year */
private hasSheetsConnection(group: Group | null, month: string): boolean {
  if (!group?.google_refresh_token) return false;
  const year = Number.parseInt(month.slice(0, 4), 10);
  const spreadsheetId =
    database.groupSpreadsheets.getByYear(group.id, year) ?? group.spreadsheet_id;
  return !!spreadsheetId;
}
```

Update `syncToSheets` — it now returns false on error but doesn't catch:

```ts
private async syncToSheets(
  group: Group | null,
  month: string,
  row: { category: string; limit: number; currency: CurrencyCode },
): Promise<boolean> {
  if (!group?.google_refresh_token) return false;

  const year = Number.parseInt(month.slice(0, 4), 10);
  const spreadsheetId =
    database.groupSpreadsheets.getByYear(group.id, year) ?? group.spreadsheet_id;
  if (!spreadsheetId) return false;

  const conn = googleConn(group);
  const monthAbbr = monthAbbrFromYYYYMM(month);
  await writeMonthBudgetRow(conn, spreadsheetId, monthAbbr, row);
  return true;
}
```

Note: removed try-catch from syncToSheets — errors now propagate to caller. `set()` uses `hasSheetsConnection()` to distinguish "no connection" (OK, local mode) from "connection exists but write failed" (error).

- [ ] **Step 1.4: Update delete() — same Sheets-first pattern**

Replace `delete()` method (lines 64-82):

```ts
async delete(params: DeleteBudgetParams): Promise<BudgetWriteResult> {
  const { groupId, category, month } = params;

  const group = database.groups.findById(groupId);
  const currency = group?.default_currency ?? ('EUR' as CurrencyCode);

  // 1. Zero out in Sheets first
  let sheetsSynced = false;
  try {
    sheetsSynced = await this.syncToSheets(group, month, {
      category,
      limit: 0,
      currency,
    });
  } catch {
    // For delete: best-effort Sheets zero-out. Budget may already be absent from Sheets
    // (pendingDeletion case). Always proceed with DB deletion.
  }

  // 2. Delete from DB
  _budgetWriter().deleteByGroupCategoryMonth(groupId, category, month);

  return { sheetsSynced };
}
```

Note: `delete()` keeps try-catch on Sheets because the budget may already be absent from Sheets (e.g., pendingDeletion case). Unlike `set()`, a missing Sheets row during delete is not an error — it's expected.

- [ ] **Step 1.5: Update delete test — verify Sheets called first**

Replace `'deletes from DB even when Sheets sync fails'` test:

```ts
test('deletes from DB even when Sheets sync fails (best-effort)', async () => {
  mockWriteMonthBudgetRow.mockRejectedValue(new Error('Network error'));

  const mgr = new BudgetManager();
  const result = await mgr.delete({ groupId: 1, category: 'Food', month: '2026-04' });

  expect(result.sheetsSynced).toBe(false);
  // DB deletion proceeds even if Sheets fails (budget may not be in Sheets)
  expect(mockDeleteByGroupCategoryMonth).toHaveBeenCalled();
});

test('writes Sheets zero before DB delete', async () => {
  const callOrder: string[] = [];
  mockWriteMonthBudgetRow.mockImplementation(async () => {
    callOrder.push('sheets');
  });
  mockDeleteByGroupCategoryMonth.mockImplementation(() => {
    callOrder.push('db');
    return true;
  });

  const mgr = new BudgetManager();
  await mgr.delete({ groupId: 1, category: 'Food', month: '2026-04' });

  expect(callOrder).toEqual(['sheets', 'db']);
});
```

- [ ] **Step 1.6: Run tests — verify all pass**

```bash
bun test src/services/budget-manager.test.ts
```

Expected: all tests pass.

- [ ] **Step 1.7: Commit**

```bash
git add src/services/budget-manager.ts src/services/budget-manager.test.ts
git commit -m "fix(budget): reverse write order to Sheets→DB, fail on Sheets error"
```

---

### Task 2: syncBudgetsDiff — pendingDeletions instead of delete

**Files:**
- Modify: `src/bot/services/budget-sync.ts`
- Modify: `src/bot/services/budget-sync.test.ts`

- [ ] **Step 2.1: Update BudgetSyncResult type — add pendingDeletions**

In `src/bot/services/budget-sync.ts`, update the interface (line 124-136):

```ts
export interface BudgetSyncResult {
  unchanged: number;
  added: Array<{ month: string; category: string; limit: number; currency: CurrencyCode }>;
  updated: Array<{
    month: string;
    category: string;
    limit: number;
    currency: CurrencyCode;
    oldLimit: number;
  }>;
  deleted: Array<{ month: string; category: string; limit: number; currency: CurrencyCode }>;
  pendingDeletions: Array<{
    id: number;
    month: string;
    category: string;
    limit: number;
    currency: CurrencyCode;
  }>;
  createdCategories: string[];
}
```

Update `EMPTY_SYNC_RESULT` (line 18):

```ts
const EMPTY_SYNC_RESULT: BudgetSyncResult = {
  unchanged: 0,
  added: [],
  updated: [],
  deleted: [],
  pendingDeletions: [],
  createdCategories: [],
};
```

- [ ] **Step 2.2: Update test — pendingDeletions instead of delete**

Replace the test `'detects deleted budgets (in DB but not in sheet)'` (line 311-322):

```ts
it('collects pendingDeletions instead of deleting (DB-only budgets)', async () => {
  mockReadMonthBudget.mockResolvedValue([]);
  mockBudgets.getAllBudgetsForMonth.mockReturnValue([
    { id: 5, category: 'Транспорт', limit_amount: 300, currency: 'EUR', month: '2026-03' },
  ]);

  const result = await syncBudgetsDiff(TEST_GROUP_ID);

  expect(result.pendingDeletions).toHaveLength(1);
  expect(result.pendingDeletions.at(0)?.category).toBe('Транспорт');
  expect(result.pendingDeletions.at(0)?.id).toBe(5);
  // Must NOT actually delete
  expect(result.deleted).toHaveLength(0);
  expect(mockBudgets.delete).not.toHaveBeenCalled();
});
```

- [ ] **Step 2.3: Run test — verify it fails**

```bash
bun test src/bot/services/budget-sync.test.ts
```

Expected: test fails (syncBudgetsDiff still deletes).

- [ ] **Step 2.4: Implement — collect pendingDeletions in syncBudgetsDiff**

In `syncBudgetsDiff` (lines 166-234), update the result initialization and Pass 3:

Replace the result initialization (line 166-172):

```ts
const result: BudgetSyncResult = {
  ...EMPTY_SYNC_RESULT,
  added: [],
  updated: [],
  deleted: [],
  pendingDeletions: [],
  createdCategories: [],
};
```

Replace the deletion loop (lines 222-233) — collect instead of delete:

```ts
const dbBudgets = database.budgets.getAllBudgetsForMonth(groupId, currentMonth);
for (const db of dbBudgets) {
  if (!sheetCategories.has(db.category)) {
    // Don't delete — collect as pending. User must confirm.
    result.pendingDeletions.push({
      id: db.id,
      month: db.month,
      category: db.category,
      limit: db.limit_amount,
      currency: db.currency,
    });
  }
}
```

- [ ] **Step 2.5: Update ensureFreshBudgets — show pendingDeletions in notification**

In `ensureFreshBudgets` (lines 246-273), update the `hasChanges` check and notification:

```ts
const hasChanges =
  result.added.length > 0 || result.deleted.length > 0 || result.updated.length > 0;
const hasPendingDeletions = result.pendingDeletions.length > 0;

if ((hasChanges || hasPendingDeletions) && telegramGroupId) {
  cleanBudgetCache();
  const cacheKey = `bs_${Date.now()}_${cacheKeyCounter++}`;
  budgetNotifyCache.set(cacheKey, { result, expires: Date.now() + BUDGET_NOTIFY_CACHE_TTL_MS });
  const msgData = buildAutoSyncBudgetsMessage(result, cacheKey);
  const group = database.groups.findById(groupId);
  const threadId = group?.active_topic_id ?? null;
  await withChatContext(telegramGroupId, threadId, () =>
    sendMessage(
      msgData.text,
      msgData.reply_markup ? { reply_markup: msgData.reply_markup } : {},
    ),
  );
}
```

Update `buildAutoSyncBudgetsMessage` — add pendingDeletions section:

After the `updated` section (around line 115), add:

```ts
if (result.pendingDeletions.length > 0) {
  lines.push(`\n⚠️ Не найдено в таблице: ${result.pendingDeletions.length}`);
  for (const e of result.pendingDeletions.slice(0, BUDGET_PAGE_SIZE)) {
    lines.push(`  ${fmtBudgetItem(e)}`);
  }
  if (result.pendingDeletions.length > BUDGET_PAGE_SIZE) {
    buttons.push({
      text: `⚠️ ещё ${result.pendingDeletions.length - BUDGET_PAGE_SIZE}`,
      callback_data: `bsync_more:${cacheKey}:p`,
    });
  }
  buttons.push({
    text: `🗑 Удалить ${result.pendingDeletions.length} из бота`,
    callback_data: `bsync_del:${cacheKey}`,
  });
}
```

- [ ] **Step 2.6: Export helper for confirming deletions**

Add at the end of `budget-sync.ts`:

```ts
/**
 * Confirm pending budget deletions — actually delete from DB.
 * Called from callback handler after user clicks "Удалить" button.
 */
export function confirmBudgetDeletions(cacheKey: string): number {
  const entry = budgetNotifyCache.get(cacheKey);
  if (!entry || entry.expires < Date.now()) return 0;

  const { pendingDeletions } = entry.result;
  if (pendingDeletions.length === 0) return 0;

  const mgr = getBudgetManager();
  for (const item of pendingDeletions) {
    mgr.deleteLocal(item.id);
  }

  // Clear pendingDeletions so button can't be clicked twice
  entry.result.pendingDeletions = [];
  return pendingDeletions.length;
}
```

- [ ] **Step 2.7: Update log line**

Update the logger.info line at the end of syncBudgetsDiff (line 236-238):

```ts
logger.info(
  `[BUDGET-SYNC] +${result.added.length} -${result.deleted.length} ~${result.updated.length} =${result.unchanged} ?${result.pendingDeletions.length}`,
);
```

- [ ] **Step 2.8: Run tests — verify all pass**

```bash
bun test src/bot/services/budget-sync.test.ts
```

Expected: all pass.

- [ ] **Step 2.9: Commit**

```bash
git add src/bot/services/budget-sync.ts src/bot/services/budget-sync.test.ts
git commit -m "fix(budget-sync): collect pendingDeletions instead of auto-deleting"
```

---

### Task 3: syncExpenses — pendingDeletions instead of delete

**Files:**
- Modify: `src/bot/commands/sync.ts`

- [ ] **Step 3.1: Add pendingDeletions to SyncResult**

Find the `SyncResult` interface in `sync.ts` and add `pendingDeletions`:

```ts
// In the SyncResult type (find the existing interface/type)
pendingDeletions: Array<{
  id: number;
  date: string;
  amount: number;
  currency: string;
  category: string;
  comment: string;
}>;
```

Initialize it in `syncExpenses` result:

```ts
const result: SyncResult = {
  unchanged: 0,
  added: [],
  deleted: [],
  updated: [],
  pendingDeletions: [],
  createdCategories: [],
  errors,
};
```

- [ ] **Step 3.2: Replace Pass 3 — collect instead of delete**

Replace lines 243-256 in `syncExpenses`:

```ts
// Pass 3: remaining unmatched DB expenses — not found in sheet, pending confirmation
for (const candidates of dbPool.values()) {
  for (const expense of candidates) {
    if (exactMatched.has(expense.id)) continue;
    result.pendingDeletions.push({
      id: expense.id,
      date: expense.date,
      amount: expense.amount,
      currency: expense.currency,
      category: expense.category,
      comment: expense.comment,
    });
  }
}
```

- [ ] **Step 3.3: Update formatSyncResult — show pendingDeletions**

In `formatSyncResult`, add a section after the deleted section:

```ts
if (result.pendingDeletions.length > 0) {
  lines.push(`\n⚠️ Не найдено в таблице: ${result.pendingDeletions.length}`);
  for (const e of result.pendingDeletions.slice(0, 10)) {
    lines.push(`  ${fmtExpense(e.date, e.amount, e.currency, e.category, e.comment)}`);
  }
  if (result.pendingDeletions.length > 10) lines.push(`  ...и ещё ${result.pendingDeletions.length - 10}`);
}
```

- [ ] **Step 3.4: Update buildAutoSyncExpensesMessage — same pattern as budgets**

Add pendingDeletions section and confirmation button to `buildAutoSyncExpensesMessage`. Same pattern as Task 2 Step 2.5 but using `esync_del:${cacheKey}` callback data prefix.

- [ ] **Step 3.5: Export confirmExpenseDeletions helper**

```ts
export function confirmExpenseDeletions(cacheKey: string): number {
  const entry = syncNotifyCache.get(cacheKey);
  if (!entry || entry.expires < Date.now()) return 0;

  const { pendingDeletions } = entry.result;
  if (!pendingDeletions || pendingDeletions.length === 0) return 0;

  for (const item of pendingDeletions) {
    database.expenses.delete(item.id);
  }

  entry.result.pendingDeletions = [];
  return pendingDeletions.length;
}
```

- [ ] **Step 3.6: Update log line and ensureFreshExpenses**

Update `ensureFreshExpenses` to include pendingDeletions in hasChanges check (same pattern as Task 2 Step 2.5).

Update log:

```ts
logger.info(
  `[SYNC] Done: +${result.added.length} -${result.deleted.length} ~${result.updated.length} =${result.unchanged} ?${result.pendingDeletions.length}`,
);
```

- [ ] **Step 3.7: Run typecheck**

```bash
bun run type-check
```

Fix any type errors from the new `pendingDeletions` field.

- [ ] **Step 3.8: Commit**

```bash
git add src/bot/commands/sync.ts
git commit -m "fix(sync): collect pendingDeletions instead of auto-deleting expenses"
```

---

### Task 4: Callback handlers for sync deletion confirmation

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts`

- [ ] **Step 4.1: Add callback handler for budget sync deletions**

In `callback.handler.ts`, add a new case in the main switch:

```ts
case 'bsync_del': {
  const cacheKey = params[0];
  if (!cacheKey) {
    await ctx.answerCallbackQuery({ text: 'Ключ не найден' });
    return;
  }

  const { confirmBudgetDeletions } = await import('../services/budget-sync');
  const count = confirmBudgetDeletions(cacheKey);

  if (count > 0) {
    await ctx.answerCallbackQuery({ text: `Удалено: ${count}` });
    await ctx.editText(`✅ Удалено ${count} бюджетов, которых не было в таблице.`);
  } else {
    await ctx.answerCallbackQuery({ text: 'Уже удалено или истекло' });
  }
  break;
}
```

- [ ] **Step 4.2: Add callback handler for expense sync deletions**

Same pattern with `esync_del` prefix:

```ts
case 'esync_del': {
  const cacheKey = params[0];
  if (!cacheKey) {
    await ctx.answerCallbackQuery({ text: 'Ключ не найден' });
    return;
  }

  const { confirmExpenseDeletions } = await import('../commands/sync');
  const count = confirmExpenseDeletions(cacheKey);

  if (count > 0) {
    await ctx.answerCallbackQuery({ text: `Удалено: ${count}` });
    await ctx.editText(`✅ Удалено ${count} расходов, которых не было в таблице.`);
  } else {
    await ctx.answerCallbackQuery({ text: 'Уже удалено или истекло' });
  }
  break;
}
```

- [ ] **Step 4.3: Handle bsync_more:p for pendingDeletions pagination**

In the existing `bsync_more` handler, add a case for type `'p'` (pendingDeletions) alongside existing types `'a'`, `'d'`, `'u'`:

```ts
case 'p':
  items = result.pendingDeletions.map(fmtBudgetItem);
  title = '⚠️ Не найдено в таблице';
  break;
```

- [ ] **Step 4.4: Run typecheck + lint**

```bash
bun run type-check && bun run lint
```

- [ ] **Step 4.5: Commit**

```bash
git add src/bot/handlers/callback.handler.ts
git commit -m "feat(callback): add sync deletion confirmation handlers"
```

---

### Task 5: Batch set_budget tool

**Files:**
- Modify: `src/services/ai/tools.ts`
- Modify: `src/services/ai/tool-executor.ts`
- Modify: `src/services/ai/tool-executor.test.ts`
- Modify: `src/services/ai/agent.ts`
- Modify: `src/services/ai/telegram-stream.ts`

- [ ] **Step 5.1: Update tool schema — accept budgets array**

In `src/services/ai/tools.ts`, replace the `set_budget` definition (lines 118-145):

```ts
{
  name: 'set_budget',
  description:
    'Set or update budget limits. Single mode: pass category + amount. Batch mode: pass budgets array. After setting, the response lists unmentioned existing budgets — ask the user if they should be zeroed out.',
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
      budgets: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            category: { type: 'string' },
            amount: { type: 'number' },
            currency: { type: 'string', description: 'Override currency for this budget' },
          },
          required: ['category', 'amount'],
        },
        description:
          'Array of budgets to set at once (batch mode). Each item: {category, amount, currency?}.',
      },
      currency: {
        type: 'string',
        description:
          'Currency code (e.g., "EUR", "USD", "RSD"). Default: group default currency. In batch mode, serves as shared default.',
      },
      month: {
        type: 'string',
        description: 'Month in "YYYY-MM" format. Default: current month.',
      },
    },
  },
},
```

- [ ] **Step 5.2: Write failing test for batch executeSetBudget**

In `src/services/ai/tool-executor.test.ts`, add a new describe block for batch set_budget. Find the existing `set_budget` tests and add:

```ts
describe('set_budget batch mode', () => {
  it('sets multiple budgets from array', async () => {
    mockBudgetManager.set.mockResolvedValue({ sheetsSynced: true });
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([]);

    const result = await executeTool(
      'set_budget',
      {
        budgets: [
          { category: 'Еда', amount: 700 },
          { category: 'Дом', amount: 100 },
        ],
        currency: 'EUR',
        month: '2026-04',
      },
      TEST_CTX,
    );

    expect(result.success).toBe(true);
    expect(mockBudgetManager.set).toHaveBeenCalledTimes(2);
    expect(mockBudgetManager.set).toHaveBeenCalledWith({
      groupId: TEST_CTX.groupId,
      category: 'Еда',
      month: '2026-04',
      amount: 700,
      currency: 'EUR',
    });
    expect(mockBudgetManager.set).toHaveBeenCalledWith({
      groupId: TEST_CTX.groupId,
      category: 'Дом',
      month: '2026-04',
      amount: 100,
      currency: 'EUR',
    });
    expect(result.output).toContain('Еда');
    expect(result.output).toContain('Дом');
  });

  it('per-item currency overrides shared currency', async () => {
    mockBudgetManager.set.mockResolvedValue({ sheetsSynced: true });
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([]);

    await executeTool(
      'set_budget',
      {
        budgets: [{ category: 'Еда', amount: 700, currency: 'RSD' }],
        currency: 'EUR',
        month: '2026-04',
      },
      TEST_CTX,
    );

    expect(mockBudgetManager.set).toHaveBeenCalledWith(
      expect.objectContaining({ currency: 'RSD' }),
    );
  });

  it('reports unmentioned existing budgets', async () => {
    mockBudgetManager.set.mockResolvedValue({ sheetsSynced: true });
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([
      { category: 'Еда', limit_amount: 700, currency: 'EUR' },
      { category: 'Транспорт', limit_amount: 300, currency: 'EUR' },
      { category: 'Дом', limit_amount: 100, currency: 'EUR' },
    ]);

    const result = await executeTool(
      'set_budget',
      {
        budgets: [{ category: 'Еда', amount: 700 }],
        currency: 'EUR',
        month: '2026-04',
      },
      TEST_CTX,
    );

    expect(result.output).toContain('Транспорт');
    expect(result.output).toContain('Дом');
    expect(result.output).toContain('not mentioned');
  });

  it('reports partial failures in batch', async () => {
    mockBudgetManager.set
      .mockResolvedValueOnce({ sheetsSynced: true })
      .mockRejectedValueOnce(new Error('Sheets fail'));
    mockBudgets.getAllBudgetsForMonth.mockReturnValue([]);

    const result = await executeTool(
      'set_budget',
      {
        budgets: [
          { category: 'Еда', amount: 700 },
          { category: 'Дом', amount: 100 },
        ],
        currency: 'EUR',
      },
      TEST_CTX,
    );

    expect(result.success).toBe(true);
    expect(result.output).toContain('Еда');
    expect(result.output).toContain('FAILED');
    expect(result.output).toContain('Дом');
  });
});
```

- [ ] **Step 5.3: Run test — verify it fails**

```bash
bun test src/services/ai/tool-executor.test.ts
```

Expected: batch tests fail.

- [ ] **Step 5.4: Implement batch executeSetBudget**

In `src/services/ai/tool-executor.ts`, replace `executeSetBudget` (lines 417-469):

```ts
async function executeSetBudget(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const month = (input['month'] as string) || format(new Date(), 'yyyy-MM');
  const group = database.groups.findById(ctx.groupId);
  if (!group) {
    return { success: false, error: 'Group not found' };
  }
  const defaultCurrency = (input['currency'] as CurrencyCode) || group.default_currency;

  // Normalize: single mode → array of one
  const budgetItems: Array<{ category: string; amount: number; currency?: string }> =
    Array.isArray(input['budgets'])
      ? (input['budgets'] as Array<{ category: string; amount: number; currency?: string }>)
      : input['category'] && input['amount'] !== undefined
        ? [
            {
              category: input['category'] as string,
              amount: input['amount'] as number,
              currency: input['currency'] as string | undefined,
            },
          ]
        : [];

  if (budgetItems.length === 0) {
    return { success: false, error: 'Provide category+amount or budgets array' };
  }

  // Validate all items before writing
  for (const item of budgetItems) {
    if (!item.category) {
      return { success: false, error: `Missing category in budget item` };
    }
    if (item.amount === undefined || item.amount === null || item.amount < 0 || Number.isNaN(item.amount)) {
      return {
        success: false,
        error: `Invalid amount "${item.amount}" for ${item.category} — must be a non-negative number`,
      };
    }
  }

  const results: string[] = [];
  const setCategories = new Set<string>();

  for (const item of budgetItems) {
    const currency = (item.currency as CurrencyCode) || defaultCurrency;

    // Ensure category exists
    if (!database.categories.exists(ctx.groupId, item.category)) {
      database.categories.create({ group_id: ctx.groupId, name: item.category });
    }

    try {
      const result = await getBudgetManager().set({
        groupId: ctx.groupId,
        category: item.category,
        month,
        amount: item.amount,
        currency,
      });

      const sheetsNote = result.sheetsSynced ? ' ✓sheets' : '';
      results.push(`${item.category} = ${formatAmount(item.amount, currency, true)}${sheetsNote}`);
      setCategories.add(item.category);
    } catch (err) {
      results.push(`${item.category} = ${formatAmount(item.amount, currency, true)} FAILED: ${getErrorMessage(err)}`);
    }
  }

  // Show unmentioned existing budgets
  const allBudgets = database.budgets.getAllBudgetsForMonth(ctx.groupId, month);
  const unmentioned = allBudgets.filter((b) => !setCategories.has(b.category));

  let output = `Budget set for ${month}:\n${results.join('\n')}`;

  if (unmentioned.length > 0) {
    const unmentionedLines = unmentioned.map(
      (b) => `${b.category}=${formatAmount(b.limit_amount, b.currency, true)}`,
    );
    output += `\n\nExisting budgets not mentioned (ask user if they should be zeroed out): ${unmentionedLines.join(', ')}`;
  }

  return { success: true, output };
}
```

- [ ] **Step 5.5: Update system prompt rule 8a**

In `src/services/ai/agent.ts`, find rule 8a (around line 497) and replace:

```
8a. BULK BUDGET SETTING: when the user asks to set budgets for multiple categories at once, use set_budget with the budgets array parameter (batch mode). The tool response will list existing budget categories that were NOT mentioned in your request. If there are unmentioned categories → ask the user whether they should be zeroed out (set to 0) or left unchanged. List those categories with their current limits. Do NOT silently leave old budgets in place — the user may have intended to replace the entire budget plan.
```

- [ ] **Step 5.6: Update formatToolInput in telegram-stream.ts**

In `src/services/ai/telegram-stream.ts`, update the `set_budget` case in `formatToolInput`:

```ts
case 'set_budget': {
  if (Array.isArray(input['budgets'])) {
    const items = input['budgets'] as Array<{ category: string; amount: number }>;
    return `${items.length} budgets`;
  }
  return [
    input['category'],
    input['amount'] && `${input['amount']} ${input['currency'] || ''}`.trim(),
  ]
    .filter(Boolean)
    .join(', ');
}
```

- [ ] **Step 5.7: Run tests**

```bash
bun test src/services/ai/tool-executor.test.ts
```

Expected: all pass.

- [ ] **Step 5.8: Run full test suite + typecheck + lint**

```bash
bun run type-check && bun run lint && bun run test
```

Fix any failures.

- [ ] **Step 5.9: Commit**

```bash
git add src/services/ai/tools.ts src/services/ai/tool-executor.ts src/services/ai/tool-executor.test.ts src/services/ai/agent.ts src/services/ai/telegram-stream.ts
git commit -m "feat(ai): batch set_budget tool, report unmentioned categories"
```

---

### Task 6: Remove pre-sync for write operations in tool-executor

**Files:**
- Modify: `src/services/ai/tool-executor.ts`

Wait — per discussion, pre-sync STAYS for `set_budget` (user wants fresh data before writes). But it should NOT run for `delete_budget` (user is explicitly deleting, no need to sync first — and sync could interfere with the delete).

- [ ] **Step 6.1: Remove delete_budget from pre-sync list**

In `src/services/ai/tool-executor.ts` line 43:

```ts
// Before:
const needsBudgetSync = ['get_budgets', 'set_budget', 'delete_budget'].includes(name);
// After:
const needsBudgetSync = ['get_budgets', 'set_budget'].includes(name);
```

Same for expenses — remove `delete_expense` from pre-sync:

```ts
// Before:
const needsExpenseSync = ['get_expenses', 'add_expense', 'delete_expense'].includes(name);
// After:
const needsExpenseSync = ['get_expenses', 'add_expense'].includes(name);
```

- [ ] **Step 6.2: Run tests + typecheck**

```bash
bun run type-check && bun run test
```

- [ ] **Step 6.3: Commit**

```bash
git add src/services/ai/tool-executor.ts
git commit -m "fix(ai): remove pre-sync before delete operations"
```

---

### Task 7: Final verification

- [ ] **Step 7.1: Full test suite**

```bash
bun run test
```

All must pass.

- [ ] **Step 7.2: Typecheck + lint**

```bash
bun run type-check && bun run lint
```

Zero errors, zero warnings.

- [ ] **Step 7.3: Review changes**

```bash
git diff main --stat
```

Verify all expected files changed, nothing unexpected.
