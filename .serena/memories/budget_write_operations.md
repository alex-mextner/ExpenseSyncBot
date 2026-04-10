# Budget Write/Update/Delete Operations - Complete Call Sites

## 1. database.budgets.setBudget() - UPSERT calls

### File: src/bot/commands/budget.ts
- **Line 296**: In `setBudget()` function - when user manually sets budget via /budget command
  - Syncs to sheets: YES (calls writeMonthBudgetRow on line 320)
  - Context: Manual budget set by user
  
- **Line 378**: In `syncBudgets()` function (part of syncFromSheet) 
  - Syncs to sheets: NO
  - Context: Silent import from sheet during full sync

### File: src/bot/commands/reconnect.ts
- **Line 325**: In `importBudgetsFromSheet()` function
  - Syncs to sheets: YES (sheets→DB, then DB budgets are written back via syncBudgetsToSheet line 390)
  - Context: Full reconnect bidirectional sync, importing from all month tabs

### File: src/bot/commands/sync.ts
- **Line 570**: In `handleSyncRollback()` function
  - Syncs to sheets: NO
  - Context: Snapshot rollback restoration (DB-only restore)

### File: src/bot/handlers/callback.handler.ts
- **Line 725**: In `handleBudgetAction()` callback - when confirming quick budget entry
  - Syncs to sheets: NO (DB-only, no sheet sync visible in handler)
  - Context: Quick budget confirmation from inline button callback
  
- **Line 767**: In `handleBudgetAction()` callback - when creating new category with budget
  - Syncs to sheets: NO (DB-only, no sheet sync visible in handler)
  - Context: Create category + set initial budget from inline button

### File: src/bot/services/budget-sync.ts
- **Line 186**: In `syncBudgetsDiff()` - sheet→DB sync for added budgets
  - Syncs to sheets: NO (already from sheets, reading diff)
  - Context: Auto-sync from sheets, new budgets detected
  - Transaction: YES (wrapped in database.transaction())

- **Line 200**: In `syncBudgetsDiff()` - sheet→DB sync for updated budgets
  - Syncs to sheets: NO (already from sheets, reading diff)
  - Context: Auto-sync from sheets, budget changes detected
  - Transaction: YES (wrapped in database.transaction())

- **Line 310**: In `silentSyncBudgets()` - sheet→DB sync for any changed budgets
  - Syncs to sheets: NO (already from sheets, reading diff)
  - Context: Silent sync during reconnect, importing from sheet
  - Transaction: YES (wrapped in database.transaction())

### File: src/services/ai/tool-executor.ts
- **Line 447**: In `executeSetBudget()` - Claude AI tool execution
  - Syncs to sheets: NO (AI tools don't write to sheets)
  - Context: AI agent setting budgets via Claude API

---

## 2. database.budgets.deleteByGroupCategoryMonth() - DELETE calls

### File: src/services/ai/tool-executor.ts
- **Line 469**: In `executeDeleteBudget()` function
  - Syncs to sheets: NO (AI tools don't sync to sheets)
  - Context: Claude AI agent deleting budgets via delete_budget tool
  - Note: No automatic removal from sheets

---

## 3. database.budgets.delete() - ID-based deletion

### File: src/bot/services/budget-sync.ts
- **Line 222**: In `syncBudgetsDiff()` - sheet→DB deletion
  - Syncs to sheets: NO (deletion triggered by absence in sheet)
  - Context: Auto-sync detects budget removed from sheet, deletes from DB
  - Transaction: YES (wrapped in database.transaction())

---

## 4. writeMonthBudgetRow() - Google Sheets writes

### File: src/bot/commands/budget.ts
- **Line 20**: Import statement
- **Line 320**: In `setBudget()` function
  - When: After database.budgets.setBudget() on line 296
  - Condition: Only if group has google_refresh_token and spreadsheet_id
  - Creates tab if missing: YES (via createEmptyMonthTab)
  - Updates/Appends: YES (existing category updates, new appends)

### File: src/bot/commands/reconnect.ts
- **Line 20**: Import statement
- **Line 390**: In `syncBudgetsToSheet()` function
  - When: Part of fullSyncAfterReconnect (DB→Sheet push)
  - Iterates all DB budgets for current month and writes to sheets
  - Creates tab if missing: YES

### File: src/services/google/budget-migration.ts
- **Line 20**: Import statement
- **Line 225**: In budget migration during year-split
  - When: Moving budgets to new year spreadsheet
  - Context: Year-split migration logic

---

## 5. OTHER Budget Write Operations

### database.budgets.update()
- Method exists in budget.repository.ts (line 116)
- NO direct callers found - update logic goes through setBudget() UPSERT instead

### Snapshot-based budget operations
- database.syncSnapshots.saveBudgetSnapshot() - used in sync.ts line 501 (read-only storage for rollback)
- database.syncSnapshots.getBudgetSnapshots() - used in sync.ts line 551 (restore from snapshot)
- These are for snapshot/rollback, not direct budget writes

---

## Key Patterns

### 1. Database writes are ALWAYS via setBudget (UPSERT), not separate INSERT/UPDATE
- Ensures atomicity and conflict handling

### 2. Sheet writes happen CONDITIONALLY
- Only if group has google_refresh_token and spreadsheet_id
- After database.budgets.setBudget() call

### 3. Transactional integrity
- budget-sync.ts wraps all diff operations in database.transaction()
- Ensures atomicity of reads+writes

### 4. Sync direction patterns
- Manual /budget: DB→Sheet (setBudget then writeMonthBudgetRow)
- /reconnect: Sheet→DB (import via setBudget in transaction)
- /sync rollback: DB only (restore from snapshot via setBudget)
- AI tools: DB only (no sheet sync)
- Auto-sync: Sheet→DB (via syncBudgetsDiff transaction)

### 5. Deletion is asymmetric
- DB deletion triggered by sheet absence (syncBudgetsDiff)
- AI delete_budget only removes from DB, not sheets
