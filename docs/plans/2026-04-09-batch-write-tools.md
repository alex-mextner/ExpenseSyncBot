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

## Parts

1. [File Structure; Tasks 1-3: batch helper, set_budget, add_expense](2026-04-09-batch-write-tools/01-helper-budget-expense.md)
2. [Tasks 4-7: delete_budget, delete_expense, manage_category, manage_recurring_pattern](2026-04-09-batch-write-tools/02-deletes-category-recurring.md)
3. [Tasks 8-10: get_bank_balances, system prompt, full test run](2026-04-09-batch-write-tools/03-balances-and-final.md)
