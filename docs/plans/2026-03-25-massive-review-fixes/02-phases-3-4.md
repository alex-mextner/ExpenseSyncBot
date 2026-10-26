# Part 2: Phase 3 (quick wins) and Phase 4 (performance)

[← Back to index](../2026-03-25-massive-review-fixes.md)

## Phase 3: Quick Wins (UX + Code Quality)

### Task 3.1: Fix parse_mode in stats/sum/budget (UX-1)

**Files:**
- Modify: `src/bot/commands/stats.ts:38-56`
- Modify: `src/bot/commands/sum.ts`
- Modify: `src/bot/commands/budget.ts`

- [ ] **Step 1: Write test that output contains HTML tags**

```ts
it('stats output uses HTML bold, not markdown', async () => {
  // Verify message contains <b>По валютам:</b> not **По валютам:**
});
```

- [ ] **Step 2: Replace `**text**` with `<b>text</b>`, add `{ parse_mode: 'HTML' }`**

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(ux): use HTML parse_mode in stats/sum/budget (UX-1)"
```

---

### Task 3.2: Replace English error messages with Russian (UX-2)

**Files:**
- Modify: `src/bot/commands/stats.ts`, `categories.ts`, `spreadsheet.ts`, `start.ts`, `settings.ts`, `prompt.ts`, `topic.ts`, `ask.ts`
- Modify: `src/bot/handlers/callback.handler.ts`

- [ ] **Step 1: Find all English user-facing strings**

Run: `grep -rn "Error:" src/bot/ --include="*.ts" | grep -v ".test." | grep -v "logger"`

Key replacements:
- `'Error: Unable to identify chat'` → `'❌ Не удалось определить чат'`
- `'Invalid parameters'` → `'❌ Неверные параметры'`
- All other English strings in callback answers

- [ ] **Step 2: Replace all**

- [ ] **Step 3: Verify no English error strings remain**

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(ux): replace English error messages with Russian (UX-2)"
```

---

### Task 3.3: Fix OAuth 5-minute blocking (UX-3)

**Files:**
- Modify: `src/bot/commands/connect.ts:84-94`

- [ ] **Step 1: Analyze current blocking flow**

Currently `handleConnectCommand` awaits a Promise that blocks for up to 5 minutes until OAuth callback fires. The handler can't return — the bot appears frozen.

- [ ] **Step 2: Refactor to non-blocking**

Instead of awaiting the OAuth result in the command handler:
1. Command sends auth URL to user and returns immediately
2. OAuth callback handler (in oauth-callback.ts) sends the success/failure message to the chat directly via `bot.api.sendMessage()`

Remove the blocking Promise. The state store from Task 1.3 already maps state → groupId.

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(ux): make /connect non-blocking — no 5-minute wait (UX-3)"
```

---

### Task 3.4: Add typing indicators to long operations (UX-5)

**Files:**
- Modify: `src/bot/commands/sum.ts`, `budget.ts`, `sync.ts`, `push.ts`

- [ ] **Step 1: Add `ctx.sendChatAction('typing')` before first async operation**

Only in commands with Google Sheets calls or heavy DB queries. Skip fast commands (ping, help, categories, settings).

- [ ] **Step 2: Commit**

```bash
git commit -m "fix(ux): add typing indicators to long-running commands (UX-5)"
```

---

### Task 3.5: Extract `getErrorMessage()` utility (20+ copies)

**Files:**
- Create: `src/utils/error.ts`
- Create: `src/utils/error.test.ts`
- Modify: ~20 files with `error instanceof Error ? error.message : String(error)`

- [ ] **Step 1: Write test**

```ts
it('extracts message from Error', () => expect(getErrorMessage(new Error('boom'))).toBe('boom'));
it('converts non-Error to string', () => expect(getErrorMessage(42)).toBe('42'));
```

- [ ] **Step 2: Implement utility**

- [ ] **Step 3: Replace all 20+ occurrences across codebase**

- [ ] **Step 4: Run tests, confirm PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "refactor: extract getErrorMessage utility, replace 20+ copies"
```

---

### Task 3.6: Simplify AI validation with lightweight model (PERF-7)

**Files:**
- Modify: `src/config/env.ts` (add `AI_VALIDATION_MODEL`)
- Modify: `src/services/ai/response-validator.ts`

- [ ] **Step 1: Add `AI_VALIDATION_MODEL` to env config**

```ts
AI_VALIDATION_MODEL: getEnvVariable('AI_VALIDATION_MODEL', false) || 'glm-4.7-flash',
```

- [ ] **Step 2: Verify `glm-4.7-flash` is available at the configured API**

Test: `curl -X POST "$AI_BASE_URL/v1/messages" ...` with `model: "glm-4.7-flash"`. If unavailable, fall back to the main `AI_MODEL`.

- [ ] **Step 3: Use lightweight model in validator**

Change `model: AI_MODEL` → `model: env.AI_VALIDATION_MODEL` in `validateResponse()`. Also update the import — currently `response-validator.ts` imports `AI_MODEL` from `agent.ts`; switch to importing from `env` directly.

- [ ] **Step 4: Simplify validation prompt** — focus on binary: "is this a greeting/thanks (APPROVE) or a data question without tools (REJECT)?"

- [ ] **Step 5: Run tests**

- [ ] **Step 6: Add `AI_VALIDATION_MODEL=glm-4.7-flash` to server .env**

- [ ] **Step 6: Commit**

```bash
git commit -m "perf(ai): use lightweight model for response validation (PERF-7)"
```

---

## Phase 4: Performance

### Task 4.1: Fix N+1 in `getAllBudgetsForMonth()` (PERF-3)

**Files:**
- Modify: `src/database/repositories/budget.repository.ts:110-130`

- [ ] **Step 1: Write test**

```ts
it('getAllBudgetsForMonth returns all budgets in single query execution', () => {
  // Create 5 budgets for different categories in same month
  // Call getAllBudgetsForMonth
  // Verify all 5 returned
});
```

- [ ] **Step 2: Rewrite with single query using UNION**

Replace the N+1 loop (1 categories query + N×2 budget queries) with a single SQL:
- Get month-specific budgets UNION get latest-prior-month budgets for categories without a current-month budget.

- [ ] **Step 3: Run tests, confirm PASS**

- [ ] **Step 4: Commit**

```bash
git commit -m "perf(db): fix N+1 in getAllBudgetsForMonth — single SQL query (PERF-3)"
```

---

### Task 4.2: Fix `checkBudgetLimit()` — SQL SUM (PERF-5)

**Files:**
- Modify: `src/database/repositories/expense.repository.ts`
- Modify: `src/bot/handlers/message.handler.ts:419-423`

- [ ] **Step 1: Write test for `sumByCategory`**

```ts
it('sumByCategory returns sum of eur_amount for given category and date range', () => {
  // Create expenses in different categories
  // Verify sum returns only matching category
});
```

- [ ] **Step 2: Add `sumByCategory()` to expense repository**

```ts
sumByCategory(groupId: number, category: string, dateFrom: string, dateTo: string): number {
  const result = this.db.query<{ total: number }, [number, string, string, string]>(
    `SELECT COALESCE(SUM(eur_amount), 0) as total
     FROM expenses WHERE group_id = ? AND category = ? AND date >= ? AND date <= ?`
  ).get(groupId, category, dateFrom, dateTo);
  return result?.total ?? 0;
}
```

- [ ] **Step 3: Replace in checkBudgetLimit**

```ts
// OLD: load all expenses, filter in JS, reduce
// NEW:
const categorySpending = database.expenses.sumByCategory(groupId, category, monthStart, monthEnd);
```

- [ ] **Step 4: Run tests, confirm PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "perf(db): SQL SUM for budget limit check instead of loading all expenses (PERF-5)"
```

---

### Task 4.3: Cache Google Sheets headers (PERF-6)

**Files:**
- Modify: `src/services/google/sheets.ts:129-132`

- [ ] **Step 1: Write test for cache behavior**

```ts
it('getHeaders returns cached result on second call', () => { ... });
it('cache invalidates after column insert', () => { ... });
```

- [ ] **Step 2: Add per-spreadsheet header cache with 10min TTL**

```ts
const headerCache = new Map<string, { headers: string[]; expiry: number }>();

async function getHeaders(sheets, spreadsheetId): Promise<string[]> {
  const cached = headerCache.get(spreadsheetId);
  if (cached && Date.now() < cached.expiry) return cached.headers;
  // ... fetch from API, cache, return
}
```

- [ ] **Step 3: Invalidate cache after `insertCurrencyColumn` / `ensureRateColumn`**

- [ ] **Step 4: Replace direct header fetches with `getHeaders()`**

- [ ] **Step 5: Run tests**

- [ ] **Step 6: Commit**

```bash
git commit -m "perf(sheets): cache headers per spreadsheet with 10min TTL (PERF-6)"
```

---

### Task 4.4: Fix race condition in `appendExpenseRow` (PERF-2)

**Files:**
- Modify: `src/services/google/sheets.ts:170-243`

- [ ] **Step 1: Replace "get last row + update" with `sheets.spreadsheets.values.append()`**

Google Sheets API has a dedicated `append` method that atomically finds the next empty row and writes. This eliminates the TOCTOU race between reading last row and writing.

```ts
await sheets.spreadsheets.values.append({
  spreadsheetId,
  range: `${SPREADSHEET_CONFIG.sheetName}!A:A`,
  valueInputOption: 'USER_ENTERED',
  insertDataOption: 'INSERT_ROWS',
  requestBody: { values: [row] },
});
```

- [ ] **Step 2: Remove the separate "get last row" API call** — saves 1 API call per expense (partial PERF-1 fix)

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(sheets): use append API to prevent race condition (PERF-2)"
```

---

### Task 4.5: Add composite indexes + performance PRAGMAs

**Files:**
- Modify: `src/database/schema.ts`

- [ ] **Step 1: Add PRAGMAs**

```ts
db.exec('PRAGMA synchronous = NORMAL;');
db.exec('PRAGMA cache_size = -8000;');    // 8MB
db.exec('PRAGMA temp_store = MEMORY;');
```

- [ ] **Step 2: Add indexes via migration**

```sql
CREATE INDEX IF NOT EXISTS idx_expenses_group_category ON expenses(group_id, category);
CREATE INDEX IF NOT EXISTS idx_expenses_group_date ON expenses(group_id, date);
```

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git commit -m "perf(db): add performance PRAGMAs and composite indexes"
```

---

### Task 4.6: Use `RETURNING *` in repositories

**Files:**
- Modify: repositories that do INSERT + SELECT

- [ ] **Step 1: Audit `create()` methods** that do INSERT then immediate SELECT. Replace with `INSERT ... RETURNING *`. Existing repository tests cover return values — no new tests needed, this is a pure internal refactor.

- [ ] **Step 2: Run existing tests to verify nothing breaks**

- [ ] **Step 3: Commit**

```bash
git commit -m "perf(db): use RETURNING clause instead of INSERT+SELECT"
```

---

### Task 4.7: Optimize `readExpensesFromSheet` range

**Files:**
- Modify: `src/services/google/sheets.ts:583-586`

- [ ] **Step 1: Read headers first (row 1), determine last column, then fetch `A2:{lastCol}`**

Instead of `A:Z` (26 columns), fetch only columns that exist. Reduces payload for sheets with 5-7 columns.

- [ ] **Step 2: Run tests**

- [ ] **Step 3: Commit**

```bash
git commit -m "perf(sheets): optimize readExpensesFromSheet range (A:Z → actual columns)"
```

---

