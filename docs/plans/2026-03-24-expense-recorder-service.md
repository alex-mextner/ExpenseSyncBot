# ExpenseRecorder Service Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Consolidate all expense-to-sheet+DB write paths into a single `ExpenseRecorder` service, eliminating duplicated EUR conversion and amounts preparation logic scattered across handlers.

**Architecture:** Create `src/services/expense-recorder.ts` — a singleton service that owns the full "record expense" pipeline: EUR conversion → amounts record building → Google Sheets write → DB write. All callers (message handler, receipt handler, push command) delegate to this service. Dependencies are injected for testability.

**Tech Stack:** Bun, TypeScript, bun:test (mocked dependencies)

---

## Current State (Problem)

Three code paths write expenses to Google Sheets + DB independently:

1. **`message.handler.ts:saveExpenseToSheet()`** — single expense from text message
2. **`callback.handler.ts:saveReceiptExpenses()`** — batch from receipt items
3. **`push.ts:handlePushCommand()`** — push DB expenses to sheet (no DB write)

Each duplicates: EUR conversion, amounts record building, `appendExpenseRow()` call. If any logic changes (e.g. rounding, rate validation), it must be changed in 3 places.

## File Structure

- **Create:** `src/services/expense-recorder.ts` — the service
- **Create:** `src/services/expense-recorder.test.ts` — unit tests
- **Modify:** `src/bot/handlers/message.handler.ts` — delegate to ExpenseRecorder
- **Modify:** `src/bot/handlers/callback.handler.ts` — delegate to ExpenseRecorder
- **Modify:** `src/bot/commands/push.ts` — delegate to ExpenseRecorder

## Tasks

### Task 1: Create ExpenseRecorder with tests for pure logic

**Files:**
- Create: `src/services/expense-recorder.ts`
- Create: `src/services/expense-recorder.test.ts`

- [ ] **Step 1: Write failing tests for `buildAmountsRecord()`**

```typescript
// Test: maps single currency amount to enabled currencies record
// Test: currencies not matching get null
// Test: handles all supported currency codes
```

- [ ] **Step 2: Run tests — verify they fail**

- [ ] **Step 3: Implement `buildAmountsRecord()` and types**

- [ ] **Step 4: Run tests — verify they pass**

- [ ] **Step 5: Write failing tests for `record()` flow**

```typescript
// Test: calls convertToEUR, appendExpenseRow, database.expenses.create in correct order
// Test: passes correct amounts record to appendExpenseRow
// Test: returns created expense with eurAmount
// Test: throws if group not found or not configured
```

- [ ] **Step 6: Implement `record()` with dependency injection**

- [ ] **Step 7: Write failing tests for `recordBatch()` (receipt expenses)**

```typescript
// Test: groups items by category, sums amounts
// Test: creates one sheet row + one DB expense per category
// Test: builds correct comment from item names
```

- [ ] **Step 8: Implement `recordBatch()`**

- [ ] **Step 9: Write failing tests for `pushToSheet()` (sheet-only write)**

- [ ] **Step 10: Implement `pushToSheet()`**

- [ ] **Step 11: Run full test suite + coverage check, commit**

### Task 2: Refactor message.handler to use ExpenseRecorder

**Files:**
- Modify: `src/bot/handlers/message.handler.ts:297-391`

- [ ] **Step 1: Replace `saveExpenseToSheet()` body with `expenseRecorder.record()` call**
- [ ] **Step 2: Run tests — verify nothing broke**
- [ ] **Step 3: Commit**

### Task 3: Refactor callback.handler to use ExpenseRecorder

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts:631-753`

- [ ] **Step 1: Replace `saveReceiptExpenses()` body with `expenseRecorder.recordBatch()` call**
- [ ] **Step 2: Run tests — verify nothing broke**
- [ ] **Step 3: Commit**

### Task 4: Refactor push command to use ExpenseRecorder

**Files:**
- Modify: `src/bot/commands/push.ts:126-163`

- [ ] **Step 1: Replace inline loop with `expenseRecorder.pushToSheet()` call**
- [ ] **Step 2: Run tests — verify nothing broke**
- [ ] **Step 3: Commit**

### Task 5: Cleanup

- [ ] **Step 1: Remove now-unused direct imports of `appendExpenseRow` and `convertToEUR` from handlers**
- [ ] **Step 2: Run `bunx knip` — fix unused exports**
- [ ] **Step 3: Run full test suite + coverage**
- [ ] **Step 4: Final commit**
