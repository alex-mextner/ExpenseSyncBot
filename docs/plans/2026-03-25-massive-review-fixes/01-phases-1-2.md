# Part 1: Phase 1 (security) and Phase 2 (data safety)

[← Back to index](../2026-03-25-massive-review-fixes.md)

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

