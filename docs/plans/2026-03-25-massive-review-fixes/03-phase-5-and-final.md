# Part 3: Phase 5 (architecture), deferred items, final verification

[← Back to index](../2026-03-25-massive-review-fixes.md)

## Phase 5: Architecture & Code Quality

### Task 5.1: Make `DatabaseService.db` private (ARCH-5)

**Files:**
- Modify: `src/database/index.ts:19`

- [ ] **Step 1: Change `public db` to `private db`**

- [ ] **Step 2: Fix compile errors** — route all `database.db.` usages through repositories or the `transaction()` method

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor(db): make DatabaseService.db private (ARCH-5)"
```

---

### Task 5.2: Break circular dependency (ARCH-1)

**Files:**
- Modify: `src/bot/handlers/message.handler.ts`
- Modify: `src/bot/handlers/callback.handler.ts`
- Create: `src/bot/services/expense-saver.ts` (shared code)

- [ ] **Step 1: Extract `saveExpenseToSheet()` from message.handler.ts into a shared service**

The circular dependency exists because:
- callback.handler statically imports `saveExpenseToSheet` from message.handler
- message.handler dynamically imports `saveReceiptExpenses` from callback.handler

Extract the shared function into `expense-saver.ts`. Both handlers import from the new file.

- [ ] **Step 2: Extract `saveReceiptExpenses()` similarly if needed**

- [ ] **Step 3: Remove dynamic imports between handlers**

- [ ] **Step 4: Run tests**

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: break circular dependency between message and callback handlers (ARCH-1)"
```

---

### Task 5.3: Extract ExpenseService from message.handler.ts (ARCH-2, ARCH-3)

**Files:**
- Create: `src/services/expense/expense-service.ts`
- Modify: `src/bot/handlers/message.handler.ts`

- [ ] **Step 1: Extract `saveExpenseToSheet` (95 lines, ARCH-2) and expense processing logic from `handleExpenseMessage` (290 lines, ARCH-3)**

Move business logic into `ExpenseService`:
- Expense parsing + validation
- Category detection + creation
- Google Sheets write
- Budget check
- The handler becomes a thin wrapper that calls the service

- [ ] **Step 2: Run tests**

- [ ] **Step 3: Commit**

```bash
git commit -m "refactor: extract ExpenseService from message handler (ARCH-2, ARCH-3)"
```

---

### Task 5.4: Split callback.handler.ts (ARCH-4)

**Files:**
- Modify: `src/bot/handlers/callback.handler.ts` (1310 lines)
- Create: `src/bot/handlers/callbacks/currency.handler.ts`
- Create: `src/bot/handlers/callbacks/budget.handler.ts`
- Create: `src/bot/handlers/callbacks/receipt.handler.ts`
- Create: `src/bot/handlers/callbacks/category.handler.ts`

- [ ] **Step 1: Split by domain** — extract each case group from the 300-line switch into domain-specific handler files

- [ ] **Step 2: Main callback.handler.ts becomes a router** — maps callback prefix to domain handler

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git commit -m "refactor: split callback.handler.ts into domain-specific handlers (ARCH-4)"
```

---

### Task 5.5: Fix console.log in index.ts + process.env in agent.ts

**Files:**
- Modify: `index.ts` — replace `console.log`/`console.error` with pino logger
- Modify: `src/services/ai/agent.ts:28-29` — use `env.AI_MODEL` and `env.AI_BASE_URL` from config

- [ ] **Step 1: Fix index.ts** — 20 console.log calls → `logger.info`/`logger.error`

- [ ] **Step 2: Fix agent.ts** — import from `env` config instead of `process.env` direct reads. Note: `response-validator.ts` imports `AI_MODEL`/`AI_BASE_URL` from `agent.ts` — if Task 3.6 already moved validator to use `env` directly, verify no stale imports remain.

- [ ] **Step 3: Run lint** — verify `noConsole` warnings gone

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(lint): replace console.log with logger, use env config in agent.ts"
```

---

### Task 5.6: Fix empty catch blocks + structured logging

**Files:**
- Multiple files — ~15 empty `catch {}` blocks
- Multiple files — ~15 `logger.error` with template literals instead of `{ err }`

- [ ] **Step 1: Find and fix empty catch blocks**

Add `logger.error({ err }, 'context')` or re-throw. Minimum: log the error.

- [ ] **Step 2: Fix structured logging**

Replace:
- `logger.error({ err: error.message })` → `logger.error({ err: error })`
- `` logger.error(`Error: ${error}`) `` → `logger.error({ err: error }, 'context')`

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(logging): fill empty catch blocks, use structured { err } in all error logs"
```

---

### Task 5.7: Fix `setBudget()` TOCTOU race — use UPSERT

**Files:**
- Modify: `src/database/repositories/budget.repository.ts`

- [ ] **Step 1: Replace check-then-insert with `INSERT ... ON CONFLICT UPDATE`**

```sql
INSERT INTO budgets (group_id, category, month, limit_amount, currency)
VALUES (?, ?, ?, ?, ?)
ON CONFLICT (group_id, category, month) DO UPDATE SET
  limit_amount = excluded.limit_amount,
  currency = excluded.currency
```

- [ ] **Step 2: Ensure unique constraint exists** on `(group_id, category, month)` — add via migration if missing

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(db): use UPSERT for setBudget to prevent TOCTOU race"
```

---

### Task 5.8: Batch MEDIUM code quality fixes

Each item is independent. Do sequentially:

- [ ] **Remove `Record<string, unknown>` from `topic-middleware.ts`** — define proper interface for middleware params
- [ ] **Add LIMIT to `findByDateRange()` and `findByCategory()`** — add optional `limit?: number` param, default 1000
- [ ] **Remove commented-out debug code in `ocr-extractor.ts`**
- [ ] **Pin `@types/bun`** — change `"latest"` to `"^1.x.x"` (current version with `^`)
- [ ] **Add `^` to `@gramio/types`** — `"9.2.3"` → `"^9.2.3"`
- [ ] **Replace `node:fs/promises` with `Bun.write()`/`Bun.file()` in `ocr-extractor.ts`**
- [ ] **Run `bunx knip`** — fix unused exports and dependencies
- [ ] **Commit after each fix or batch of related fixes**

---

### Task 5.9: Add file-level comments to production files

**Files:** ~76 files in `src/` without opening comment

- [ ] **Step 1: Add 1-2 line comments to each file** explaining what the file does

Format: `/** Description of what this file/module does */`

- [ ] **Step 2: Run lint + typecheck** to ensure comments don't break anything

- [ ] **Step 3: Commit by directory batch**

Do in groups: `database/`, `services/`, `bot/commands/`, `bot/handlers/`, etc.

---

## Deferred / Follow-up Items

These are acknowledged findings that are out of scope for this plan or need separate decisions:

- **OPS-1 off-server backup** — backups are local on the server. Adding DO Spaces/S3 copy is a separate infrastructure task.
- **PERF-1 (batch Google Sheets writes)** — debounce + batchUpdate API is a significant refactor of the sheets.ts write path. Partially addressed by Task 4.4 (append API) and Task 4.3 (header cache). Full batching is a follow-up.
- **Prompt injection via `/prompt`** — needs threat model analysis
- **Callback buttons not authorized per-user** — UX trade-off, needs product decision
- **Headless Chromium `--no-sandbox`** — required for www-data user, mitigated by SSRF fix
- **`REAL` for money (floating-point)** — migration to INTEGER cents requires schema change + data migration + all display code. Large effort, separate plan.
- **`maybeSmartAdvice` 49% unsolicited** — needs product decision on desired frequency
- **Duplicate code patterns** (normalizeCategory, ensureUserInGroup, ensureBudgetSheet×7, etc.) — will surface naturally during ARCH-2/3/4 refactoring. `ensureBudgetSheet` specifically may need explicit extraction if not covered by handler refactor.
- **`setMyCommands` without scope** — minor UX issue, low priority

---

## Final Verification

- [ ] Run full test suite: `bun test`
- [ ] Run type check: `bun run type-check`
- [ ] Run lint: `bun run lint`
- [ ] Run knip: `bunx knip`
- [ ] Manual smoke test: connect bot → send expense → check sheets → test /sync → /sync rollback → /budget
- [ ] Deploy to staging first if available
