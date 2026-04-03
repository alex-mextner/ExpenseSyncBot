# Safe Sync + Batch Budget Setting

**Date:** 2026-04-03
**Status:** Draft

## Problem

### Bug: syncBudgetsDiff deletes locally-set budgets

`BudgetManager.set()` writes DB first, then Sheets (best-effort). When Sheets write fails, the budget exists in DB but not in Sheets. Next `syncBudgetsDiff` run treats this as "user deleted from Sheets" and removes from DB. Result: budgets silently disappear.

**Evidence:** All 10 `set_budget` calls returned OK (DB writes succeeded), none showed "(synced to Sheets)". DB is now empty for April 2026.

### Bug: syncExpenses has the same destructive pattern

Pass 3 in `syncExpenses` deletes DB expenses not found in Sheets. Less likely to trigger (expenses already write Sheets→DB), but same risk exists.

### Missing feature: batch set_budget

AI makes 10 separate `set_budget` tool calls for 10 categories. Should be one call with an array.

## Design

### 1. Budget write order: Sheets → DB

Align `BudgetManager.set()` with `ExpenseRecorder.record()` pattern:

```
Before: DB write (sync) → Sheets write (async, may fail) → DB and Sheets diverge
After:  Sheets write (async) → DB write (sync) → always consistent
```

If Sheets write fails and group has Sheets connected → return error, don't write to DB.
If group has no Sheets (no refresh token / no spreadsheet) → write to DB only (local mode).

### 2. Sync never auto-deletes

Both `syncBudgetsDiff` and `syncExpenses`: when items exist in DB but not in Sheets, collect them in `pendingDeletions` array instead of deleting. Return in result.

```ts
interface BudgetSyncResult {
  unchanged: number;
  added: [...];
  updated: [...];
  deleted: [];  // always empty now from auto-sync
  pendingDeletions: [...];  // NEW: items in DB not found in Sheets
  createdCategories: string[];
}
```

Same pattern for `SyncResult` in expenses.

### 3. Deletion with confirmation only

**Auto-sync (`ensureFreshBudgets` / `ensureFreshExpenses`):**
- If `pendingDeletions` is non-empty → include count in the notification message
- Show inline keyboard "Удалить N записей" / "Оставить"
- Callback handler performs actual deletion

**Manual `/sync` command:**
- Show pendingDeletions in the result message
- Inline keyboard to confirm deletion

**AI tools:**
- `get_budgets` / `get_expenses` tool response includes pendingDeletions if any
- AI informed via system prompt to present them and ask user
- `confirm_sync_deletions` tool (or `force` param) to actually execute deletions

### 4. Batch `set_budget` tool

Tool schema accepts single budget OR array:

```ts
// Single (backward-compatible):
{ category: "Еда", amount: 700, currency: "EUR", month: "2026-04" }

// Batch:
{ budgets: [
    { category: "Еда", amount: 700 },
    { category: "Дом", amount: 100 },
    ...
  ],
  currency: "EUR",   // shared default
  month: "2026-04"   // shared default
}
```

Tool executor: one pre-sync, then batch Sheets writes, then batch DB writes.

**Tool response includes:**
- List of set budgets
- List of OTHER existing budgets for this month not mentioned in the batch (unmentioned categories)
- AI is instructed (system prompt rule 8a, already exists) to ask user if unmentioned categories should be zeroed out

### 5. Pre-sync stays for all budget operations

`ensureFreshBudgets` continues to run before `set_budget`, `delete_budget`, and `get_budgets`. This ensures the AI sees fresh data from Sheets before making changes. The sync just no longer deletes.

## Files to modify

| File | Change |
|------|--------|
| `src/services/budget-manager.ts` | Reverse write order: Sheets → DB |
| `src/bot/services/budget-sync.ts` | `syncBudgetsDiff`: pendingDeletions instead of delete |
| `src/bot/commands/sync.ts` | `syncExpenses`: pendingDeletions instead of delete |
| `src/services/ai/tools.ts` | Batch `set_budget` schema |
| `src/services/ai/tool-executor.ts` | Batch `executeSetBudget`, include unmentioned budgets |
| `src/services/ai/agent.ts` | System prompt: update rule 8a for batch |
| `src/services/ai/telegram-stream.ts` | Tool label for batch set_budget |
| `src/bot/handlers/callback.handler.ts` | Handle sync deletion confirmation buttons |
| Tests for all modified files |

## Out of scope

- Changing expense write order (already correct: Sheets → DB)
- Bidirectional push (DB → Sheets for orphaned items) — just don't delete
- Changes to `/push` command flow
