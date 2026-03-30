# Massive Review Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix all ~70 findings from the [massive review audit](../specs/2026-03-23-massive-review.md) — security, data integrity, performance, error handling, UX, DevOps, architecture, code quality.

**Architecture:** Five sequential phases ordered by severity. Each phase is independently deployable. Security fixes first, then data safety, quick wins, performance, architecture cleanup.

**Tech Stack:** Bun, SQLite (bun:sqlite), GramIO, googleapis, pino, Biome

**Decisions from review discussion:**
- PERF-4 (`silentSyncBudgets` in per-expense path): **keep as-is** — reliability over speed
- PERF-7 (AI validation): use `glm-4.7-flash` as lightweight model to filter greetings, keep retry logic for real questions
- UX-4 (`/sync`): add pre-sync snapshot in DB + `/sync rollback` command
- OPS-3: UptimeRobot (external pinger on `/health` endpoint) + PM2 webhook on crash
- OPS-1 (backups): **already implemented** — daily cron at 03:00, `scripts/backup-db.sh`, WAL-safe VACUUM INTO + gzip, 30-day retention. Off-server copy is a follow-up (DO Spaces or scp).
- Playwright stays in `dependencies` (used in production for receipt fetching)
- `readExpensesFromSheet` A:Z — MEDIUM, optimize column range
- WAL checkpoint — LOW, default autocheckpoint is sufficient
- AppError typed error hierarchy — already exists in `src/errors/`, needs wiring into all handlers

---

## Phase 1: Security Emergency

### Task 1.1: Fix path traversal in `/temp-images/` (SEC-1)

**Files:**
- Modify: `src/web/oauth-callback.ts:262-290`
- Create: `src/web/oauth-callback.test.ts` (or extend existing)

- [ ] **Step 1: Write failing test for path traversal**

```ts
describe('handleTempImage path traversal', () => {
  it('rejects ../../../.env traversal', async () => {
    const response = await fetch('http://localhost:3000/temp-images/../../.env');
    expect(response.status).toBe(403);
  });

  it('rejects encoded traversal %2e%2e%2f', async () => {
    const response = await fetch('http://localhost:3000/temp-images/%2e%2e%2f.env');
    expect(response.status).toBe(403);
  });

  it('serves valid image file', async () => {
    // Create temp file, request it, verify 200
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL**

- [ ] **Step 3: Add path validation**

In `handleTempImage()`, after resolving `filepath`, validate it stays within `tempDir`:

```ts
const path = await import('node:path');
const tempDir = path.resolve(process.cwd(), 'temp-images');
const filepath = path.resolve(tempDir, filename);

if (!filepath.startsWith(tempDir + path.sep)) {
  return new Response('Forbidden', { status: 403 });
}
```

- [ ] **Step 4: Run test, confirm PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(security): block path traversal in /temp-images/ endpoint (SEC-1)"
```

---

### Task 1.2: Implement token encryption (SEC-2)

**Files:**
- Create: `src/services/google/token-encryption.ts`
- Create: `src/services/google/token-encryption.test.ts`
- Modify: `src/web/oauth-callback.ts:149` (encrypt on save)
- Modify: `src/services/google/oauth.ts` (decrypt on read)
- Modify: `src/database/schema.ts` (migration to encrypt existing tokens)

- [ ] **Step 1: Write failing tests for encrypt/decrypt**

```ts
describe('token encryption', () => {
  const key = 'a'.repeat(64); // 32 bytes hex

  it('encrypts and decrypts a token', () => {
    const token = '1//0abc_refresh_token_here';
    const encrypted = encryptToken(token, key);
    expect(encrypted).not.toBe(token);
    expect(encrypted).toContain(':'); // iv:authTag:ciphertext format
    expect(decryptToken(encrypted, key)).toBe(token);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const a = encryptToken('same', key);
    const b = encryptToken('same', key);
    expect(a).not.toBe(b);
  });

  it('throws on tampered ciphertext', () => {
    const encrypted = encryptToken('token', key);
    expect(() => decryptToken(encrypted.slice(0, -2) + 'xx', key)).toThrow();
  });

  it('throws on wrong key', () => {
    const encrypted = encryptToken('token', key);
    expect(() => decryptToken(encrypted, 'b'.repeat(64))).toThrow();
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL**

- [ ] **Step 3: Implement AES-256-GCM encryption**

Create `src/services/google/token-encryption.ts` with `encryptToken(plaintext, hexKey)` and `decryptToken(encrypted, hexKey)`. Format: `iv:authTag:ciphertext` (all hex).

- [ ] **Step 4: Run test, confirm PASS**

- [ ] **Step 5: Wire encryption into OAuth callback (encrypt on save)**

In `oauth-callback.ts:149`, wrap `tokens.refresh_token` with `encryptToken()` before DB save.

- [ ] **Step 6: Wire decryption into oauth.ts (decrypt on read)**

In `getAuthenticatedClient()`, wrap stored token with `decryptToken()` before use.

- [ ] **Step 7: Add migration for existing plaintext tokens**

Migration detects plaintext tokens (no `:` separator) and encrypts them in place.

- [ ] **Step 8: Run full test suite**

- [ ] **Step 9: Commit**

```bash
git commit -m "feat(security): implement AES-256-GCM token encryption (SEC-2)"
```

---

### Task 1.3: Fix OAuth CSRF — crypto.randomUUID state (SEC-3)

**Files:**
- Modify: `src/services/google/oauth.ts:17-24`
- Modify: `src/web/oauth-callback.ts:141-142`
- Create/extend: `src/services/google/oauth.test.ts`

- [ ] **Step 1: Write failing test**

```ts
describe('OAuth state', () => {
  it('generateAuthUrl returns URL with UUID state, not sequential ID', () => {
    const url = generateAuthUrl(42);
    const state = new URL(url).searchParams.get('state');
    expect(state).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(state).not.toBe('42');
  });

  it('resolveOAuthState returns groupId for valid state', () => {
    // Register, then resolve
  });

  it('resolveOAuthState returns null for unknown state', () => {
    expect(resolveOAuthState('nonexistent')).toBeNull();
  });
});
```

- [ ] **Step 2: Run test, confirm FAIL**

- [ ] **Step 3: Implement secure state management**

Add `pendingStates` Map with TTL (10 min). `generateAuthUrl()` creates UUID state mapped to groupId. `resolveOAuthState()` looks up and deletes (one-time use).

- [ ] **Step 4: Update callback handler**

In `oauth-callback.ts:141-142`, replace `parseInt(state)` with `resolveOAuthState(state)`. Return error page if null.

- [ ] **Step 5: Run tests, confirm PASS**

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(security): use crypto.randomUUID for OAuth state (SEC-3)"
```

---

### Task 1.4: SSRF protection for receipt URLs (SEC-4)

**Files:**
- Create: `src/services/receipt/url-validator.ts`
- Create: `src/services/receipt/url-validator.test.ts`
- Modify: `src/services/receipt/receipt-fetcher.ts:53-68`

- [ ] **Step 1: Write failing tests**

```ts
describe('isUrlSafe', () => {
  it('allows normal HTTPS URLs', () => expect(isUrlSafe('https://receipt.example.com')).resolves.toBe(true));
  it('blocks private IPs', () => expect(isUrlSafe('http://192.168.1.1')).resolves.toBe(false));
  it('blocks localhost', () => expect(isUrlSafe('http://127.0.0.1')).resolves.toBe(false));
  it('blocks cloud metadata', () => expect(isUrlSafe('http://169.254.169.254/')).resolves.toBe(false));
  it('blocks file:// protocol', () => expect(isUrlSafe('file:///etc/passwd')).resolves.toBe(false));
  it('blocks 10.x range', () => expect(isUrlSafe('http://10.0.0.1')).resolves.toBe(false));
});
```

- [ ] **Step 2: Run test, confirm FAIL**

- [ ] **Step 3: Implement URL validator**

Parse URL, check protocol (`http:`/`https:` only), resolve hostname via DNS, check resolved IP against private ranges (10.x, 172.16-31.x, 192.168.x, 127.x, 169.254.x, ::1, fc00::/7).

- [ ] **Step 4: Wire into receipt-fetcher.ts before `page.goto()`**

- [ ] **Step 5: Run tests, confirm PASS**

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(security): add SSRF protection for receipt URL fetching (SEC-4)"
```

---

### Task 1.5: Fix XSS in OAuth error pages (SEC-5, SEC-6)

**Files:**
- Create: `src/web/html-escape.ts`
- Create: `src/web/html-escape.test.ts`
- Modify: `src/web/oauth-callback.ts:76,118,245`

- [ ] **Step 1: Write test for HTML escaping**

```ts
describe('escapeHtml', () => {
  it('escapes <script> tags', () => {
    expect(escapeHtml('<script>alert(1)</script>')).toBe('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
  it('escapes quotes and ampersands', () => {
    expect(escapeHtml('"foo" & \'bar\'')).toBe('&quot;foo&quot; &amp; &#39;bar&#39;');
  });
});
```

- [ ] **Step 2: Implement `escapeHtml()`**

- [ ] **Step 3: Wrap all `${...}` inside HTML templates in oauth-callback.ts with `escapeHtml()`**

- [ ] **Step 4: Run tests, confirm PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(security): escape HTML in OAuth error pages (SEC-5, SEC-6)"
```

---

### Task 1.6: Add SQLite `busy_timeout` PRAGMA (SEC-7)

**Files:**
- Modify: `src/database/schema.ts:14-15`

- [ ] **Step 1: Write test verifying PRAGMA is set**

```ts
it('busy_timeout is configured', () => {
  const result = database.db.query('PRAGMA busy_timeout').get();
  expect(result.busy_timeout).toBe(5000);
});
```

- [ ] **Step 2: Add PRAGMA**

```ts
db.exec('PRAGMA busy_timeout = 5000;');
```

- [ ] **Step 3: Run tests, confirm PASS**

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(db): add busy_timeout PRAGMA (SEC-7)"
```

---

## Phase 2: Data Safety & Error Handling

### Task 2.1: Add transaction helper to DatabaseService (DB-1 prep)

**Files:**
- Modify: `src/database/index.ts`

- [ ] **Step 1: Write test**

```ts
it('transaction rolls back on error', () => {
  expect(() => database.transaction(() => {
    database.expenses.create({...});
    throw new Error('rollback');
  })).toThrow();
  // Verify expense was NOT created
});
```

- [ ] **Step 2: Add `transaction<T>(fn: () => T): T` method**

```ts
transaction<T>(fn: () => T): T {
  return this.db.transaction(fn)();
}
```

- [ ] **Step 3: Run test, confirm PASS**

- [ ] **Step 4: Commit**

```bash
git commit -m "feat(db): add transaction helper to DatabaseService (DB-1)"
```

---

### Task 2.2: Add pre-sync snapshot table + `/sync rollback` (UX-4)

**Files:**
- Modify: `src/database/schema.ts` (migration)
- Create: `src/database/repositories/sync-snapshot.repository.ts`
- Create: `src/bot/commands/sync-rollback.ts`
- Modify: `src/database/index.ts` (register repository)
- Modify: `src/bot/index.ts` (register command)

- [ ] **Step 1: Write test for snapshot repository**

```ts
describe('SyncSnapshotRepository', () => {
  it('creates and retrieves latest snapshot for group', () => { ... });
  it('keeps max 3 snapshots per group, deletes older', () => { ... });
});
```

- [ ] **Step 2: Add migration for `sync_snapshots` table**

```sql
CREATE TABLE IF NOT EXISTS sync_snapshots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  group_id INTEGER NOT NULL,
  snapshot_data TEXT NOT NULL,
  expense_count INTEGER NOT NULL,
  created_at TEXT DEFAULT (datetime('now')),
  FOREIGN KEY (group_id) REFERENCES groups(id)
);
```

- [ ] **Step 3: Implement `SyncSnapshotRepository`** — `create()`, `getLatest(groupId)`, `pruneOld(groupId, keepCount=3)`

- [ ] **Step 4: Run test, confirm PASS**

- [ ] **Step 5: Implement `/sync rollback` command**

Load latest snapshot → confirmation keyboard → on confirm: delete current expenses + re-insert from snapshot (in transaction).

- [ ] **Step 6: Register command in bot**

- [ ] **Step 7: Commit**

```bash
git commit -m "feat(sync): add pre-sync snapshots and /sync rollback command (UX-4)"
```

---

### Task 2.3: Wrap critical flows in transactions (DB-1)

**Files:**
- Modify: `src/bot/commands/sync.ts:54-114`
- Modify: `src/bot/commands/budget.ts:444-502` (silentSyncBudgets)
- Modify: `src/bot/handlers/callback.handler.ts` (receipt confirmation)

- [ ] **Step 1: Write test for sync transactional behavior**

```ts
it('sync rolls back all changes if insertion fails midway', () => {
  // Mock one expense.create to throw after N insertions
  // Verify: original expenses are still intact (not deleted)
});
```

- [ ] **Step 2: Wrap sync.ts delete+insert in `database.transaction()`**

Save snapshot first (Task 2.2), then wrap delete+category creation+insert loop in transaction.

- [ ] **Step 3: Wrap silentSyncBudgets in transaction**

- [ ] **Step 4: Wrap receipt confirmation multi-step in transaction**

- [ ] **Step 5: Run tests, confirm PASS**

- [ ] **Step 6: Commit**

```bash
git commit -m "fix(db): wrap sync, budget sync, receipt confirmation in transactions (DB-1)"
```

---

### Task 2.4: Wire AppError hierarchy into bot (ERR-2, ERR-3)

**Files:**
- Verify: `src/errors/` — read existing AppError subtypes
- Modify: `src/bot/bot-error-formatter.ts` — ensure it handles all error subtypes
- Modify: 9 command handlers (stats, categories, spreadsheet, start, settings, help, ping, prompt, topic) — add try-catch + `formatErrorForUser`

- [ ] **Step 1: Read `src/errors/` to understand existing error hierarchy**

- [ ] **Step 2: Write test for formatErrorForUser with each error subtype**

```ts
describe('formatErrorForUser', () => {
  it('returns Russian message for OAuthError', () => {
    expect(formatErrorForUser(new OAuthError('expired'))).toContain('/reconnect');
  });
  it('returns Russian message for GoogleSheetsError', () => { ... });
  it('returns generic message for unknown Error', () => { ... });
});
```

- [ ] **Step 3: Run test, confirm existing formatErrorForUser handles all subtypes**

If any subtypes are missing — add them.

- [ ] **Step 4: Add try-catch to each of 9 command handlers**

```ts
import { formatErrorForUser } from '../bot-error-formatter';

export async function handleXxxCommand(ctx: Ctx['Command']): Promise<void> {
  try {
    // ... existing handler body
  } catch (error) {
    logger.error({ err: error }, '[CMD] Error in /xxx');
    await ctx.send(formatErrorForUser(error));
  }
}
```

- [ ] **Step 5: Throw typed errors from services** instead of generic `new Error()`. E.g. in sheets.ts throw `GoogleSheetsError`, in oauth.ts throw `OAuthError`.

- [ ] **Step 6: Run tests, confirm PASS**

- [ ] **Step 7: Commit**

```bash
git commit -m "fix(bot): wire AppError hierarchy + formatErrorForUser into all handlers (ERR-2, ERR-3)"
```

---

### Task 2.5: Add global error handlers (ERR-1)

**Files:**
- Modify: `src/bot/index.ts`
- Modify: `index.ts`

- [ ] **Step 1: Add `bot.onError()` in bot/index.ts**

```ts
bot.onError(({ context, kind, error }) => {
  logger.error({ err: error, kind }, '[BOT] Unhandled error');
});
```

- [ ] **Step 2: Add process-level handlers in index.ts**

```ts
process.on('unhandledRejection', (reason) => {
  logger.error({ err: reason }, '[PROCESS] Unhandled rejection');
});
process.on('uncaughtException', (error) => {
  logger.error({ err: error }, '[PROCESS] Uncaught exception');
  process.exit(1);
});
```

- [ ] **Step 3: Run tests**

- [ ] **Step 4: Commit**

```bash
git commit -m "fix(bot): add global error handlers for bot and process (ERR-1)"
```

---

### Task 2.6: OAuth token refresh recovery (ERR-4)

**Files:**
- Modify: `src/services/google/sheets.ts`
- Modify: `src/services/google/oauth.ts`
- Modify: `src/errors/` (add or verify OAuthError exists)

- [ ] **Step 1: Write test for token expiration detection**

```ts
describe('isTokenExpiredError', () => {
  it('detects 401 Unauthorized', () => { ... });
  it('detects invalid_grant', () => { ... });
  it('does not match other errors', () => { ... });
});
```

- [ ] **Step 2: Implement `isTokenExpiredError()` helper in oauth.ts**

Check for HTTP 401, `invalid_grant`, or `Token has been expired or revoked`.

- [ ] **Step 3: Wrap Google API calls in sheets.ts with token error detection**

Catch token errors → throw `OAuthError('Токен доступа истёк. Используй /reconnect')`.

- [ ] **Step 4: Run tests, confirm PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "fix(oauth): detect expired tokens and prompt /reconnect (ERR-4)"
```

---

### Task 2.7: Add CI tests before deploy (OPS-2)

**Files:**
- Modify: `.github/workflows/deploy.yml`

- [ ] **Step 1: Add `test` job before `deploy`**

```yaml
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
      - run: bun install
      - run: bun run type-check
      - run: bun run lint
      - run: bun test

  deploy:
    needs: test
    # ... existing deploy steps
```

- [ ] **Step 2: Commit**

```bash
git commit -m "ci: add typecheck + lint + test before deploy (OPS-2)"
```

---

### Task 2.8: Add `/health` endpoint + monitoring setup (OPS-3)

**Files:**
- Modify: `src/web/oauth-callback.ts`
- Modify: `DEPLOY.md`

- [ ] **Step 1: Write test for /health**

```ts
it('GET /health returns 200 with ok status', async () => {
  const res = await fetch('http://localhost:3000/health');
  expect(res.status).toBe(200);
  const body = await res.json();
  expect(body.status).toBe('ok');
});
```

- [ ] **Step 2: Add `/health` route**

```ts
if (url.pathname === '/health') {
  try {
    database.groups.findById(1); // quick DB check
    return Response.json({ status: 'ok', uptime: process.uptime() });
  } catch {
    return Response.json({ status: 'error' }, { status: 503 });
  }
}
```

Note: uses `database.groups.findById()` instead of raw `database.db.query()` — stays compatible with Task 5.1 (making db private).

- [ ] **Step 3: Document UptimeRobot + PM2 webhook setup in DEPLOY.md**

- [ ] **Step 4: Run tests, confirm PASS**

- [ ] **Step 5: Commit**

```bash
git commit -m "feat(ops): add /health endpoint for uptime monitoring (OPS-3)"
```

---

### Task 2.9: Add PM2 log rotation (OPS-4)

**Files:**
- Modify: `ecosystem.config.cjs`

- [ ] **Step 1: Add rotation config**

Requires `pm2 install pm2-logrotate` on server. Add note to DEPLOY.md. Alternatively, add `max_size` and `retain` to ecosystem.config.cjs.

- [ ] **Step 2: Commit**

```bash
git commit -m "fix(ops): configure PM2 log rotation (OPS-4)"
```

---

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
