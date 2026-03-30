# Massive Review: ExpenseSyncBot

**Date:** 2026-03-23
**Methodology:** 10 parallel audit agents (Opus) analyzing security, performance, architecture, UX, DevOps, GramIO, Bun runtime, database, error handling, code quality. Web research for best practices included.

---

## Executive Summary

ExpenseSyncBot is a well-structured personal project with strong foundations: type safety (9/10), clean lint (9.5/10), solid repository pattern, and 1192 tests. However, the audit uncovered **critical security vulnerabilities** (path traversal exposing `.env`, plaintext Google tokens, SSRF, OAuth IDOR), **zero database transactions** in the entire codebase, **performance bottlenecks** in Google Sheets API usage (3-4 calls per expense), and significant UX gaps.

### Priority Matrix

| Priority | Count | Categories |
|----------|-------|-----------|
| CRITICAL | 6 | Security (4), Data integrity (1), DevOps (1) |
| HIGH | 22 | Security, Performance, Architecture, UX, Error handling |
| MEDIUM | 30+ | All areas |
| LOW | 15+ | Style, docs, minor improvements |

---

## CRITICAL Findings (Fix Immediately)

### SEC-1. Path Traversal in `/temp-images/` — RCE-level exposure

- **File:** `src/web/oauth-callback.ts:262-290`
- **Impact:** `GET /temp-images/../../.env` returns all server secrets (BOT_TOKEN, GOOGLE_CLIENT_SECRET, ENCRYPTION_KEY, etc.)
- **Fix:** Validate resolved path starts with `tempDir + path.sep`

### SEC-2. Google Refresh Tokens Stored in Plaintext

- **Files:** `src/web/oauth-callback.ts:149`, `src/services/google/oauth.ts`
- **Impact:** `encryptToken()`/`decryptToken()` documented in CLAUDE.md but never implemented. `ENCRYPTION_KEY` required but unused. Anyone with DB file access gets Google Sheets for all groups.
- **Fix:** Implement AES-256-GCM encryption as documented

### SEC-3. OAuth State = Sequential Integer (IDOR)

- **File:** `src/services/google/oauth.ts:21`, `src/web/oauth-callback.ts:141-149`
- **Impact:** Attacker substitutes `state=N` with another group's ID. Token saved BEFORE pendingOAuthStates check.
- **Fix:** Use `crypto.randomUUID()` mapped server-side to group ID

### SEC-4. SSRF via Receipt Link Processing

- **Files:** `src/services/receipt/link-analyzer.ts:14-18`, `src/services/receipt/receipt-fetcher.ts:56-85`
- **Impact:** User sends `http://169.254.169.254/latest/meta-data/` → Playwright navigates. Cloud metadata, internal services accessible.
- **Fix:** URL validation against private IP ranges, DNS resolution check

### DB-1. Zero Transactions in Entire Codebase

- **All repositories, handlers, services**
- **Impact:** `sync` deletes all expenses then re-inserts without transaction — crash = total data loss. `createMany()` is partial on failure. Multi-step DB+Sheets operations not atomic.
- **Fix:** Use `db.transaction()` for all multi-step operations

### OPS-1. No Automated Backups

- **Impact:** Single SQLite file on single server. Disk failure = total loss. Current manual `cp` is unsafe on live DB.
- **Fix:** Automated daily `sqlite3 .backup`, off-server storage (DO Spaces/S3)

---

## HIGH Findings

### Security

| ID | Finding | File(s) |
|----|---------|---------|
| SEC-5 | Reflected XSS in OAuth error page | `oauth-callback.ts:76,118,245` |
| SEC-6 | HTML injection in OAuth error page | `oauth-callback.ts:119,245` |
| SEC-7 | No `busy_timeout` PRAGMA — concurrent writes get SQLITE_BUSY | `schema.ts:10-18` |

### Performance

| ID | Finding | File(s) |
|----|---------|---------|
| PERF-1 | 3-4 Google Sheets API calls per expense (headers + last row + update + budget sync) | `sheets.ts:114-207`, `message.handler.ts:330` |
| PERF-2 | Race condition: concurrent `appendExpenseRow` writes to same row | `sheets.ts:170-191` |
| PERF-3 | N+1 in `getAllBudgetsForMonth()` — up to 93 queries per `getFinancialSnapshot()` | `budget.repository.ts:110-130` |
| PERF-4 | `silentSyncBudgets()` reads Google Sheets on every expense save | `message.handler.ts:330` |
| PERF-5 | `checkBudgetLimit()` loads ALL month expenses for one category sum | `message.handler.ts:420-423` |
| PERF-6 | Google Sheets headers not cached (fetched per expense) | `sheets.ts:129-132` |
| PERF-7 | AI validation pass doubles latency for simple questions (3 API calls) | `agent.ts:94-137` |

### Architecture

| ID | Finding | File(s) |
|----|---------|---------|
| ARCH-1 | Circular dependency: `message.handler` ↔ `callback.handler` (hidden via dynamic import) | Both handlers |
| ARCH-2 | `saveExpenseToSheet()` — 95-line god function in handler layer | `message.handler.ts:297-391` |
| ARCH-3 | `handleExpenseMessage()` — 290 lines, 10+ responsibilities | `message.handler.ts:21-292` |
| ARCH-4 | `callback.handler.ts` — 1250-line monolith with 300+ line switch | `callback.handler.ts` |
| ARCH-5 | `DatabaseService.db` public — bypasses repository pattern | `database/index.ts:20` |

### Error Handling

| ID | Finding | File(s) |
|----|---------|---------|
| ERR-1 | No global `bot.onError()` or `process.on('unhandledRejection')` | `bot/index.ts` |
| ERR-2 | 9 command handlers without any try-catch | `stats.ts`, `categories.ts`, `spreadsheet.ts`, `start.ts`, `settings.ts`, `help.ts`, `ping.ts`, `prompt.ts`, `topic.ts` |
| ERR-3 | `formatErrorForUser()` is dead code — entire typed error system unused | `bot-error-formatter.ts` |
| ERR-4 | No Google OAuth token refresh recovery — expired tokens fail forever | `oauth.ts`, `sheets.ts` |

### UX

| ID | Finding | File(s) |
|----|---------|---------|
| UX-1 | `/stats` uses Markdown `**` without parse_mode — literal asterisks shown | `stats.ts:41-49` |
| UX-2 | English tech errors in 14 files ("Error: Unable to identify user or chat") | All command handlers |
| UX-3 | OAuth handler blocks for 5 minutes (Promise with timeout) | `connect.ts:84-94` |
| UX-4 | `/sync` deletes ALL local data without confirmation | `sync.ts:54-56` |
| UX-5 | No typing indicator for long operations (sync, push, budget) | Only in `ask.ts:128` |

### DevOps

| ID | Finding | File(s) |
|----|---------|---------|
| OPS-2 | No CI tests before deploy — push to main goes straight to production | `.github/workflows/deploy.yml` |
| OPS-3 | No uptime monitoring or error alerting | N/A |
| OPS-4 | PM2 without log rotation | `ecosystem.config.cjs` |

---

## MEDIUM Findings

### Security

- No authentication on temp-images HTTP endpoint
- User financial data logged in plaintext (`message.handler.ts:27`)
- Prompt injection via `/prompt` custom system prompts
- Callback buttons not authorized per-user (any group member can confirm others' receipts)
- Headless Chromium with `--no-sandbox`
- Temp image cleanup disabled (debug code in production)

### Performance

- Missing SQLite PRAGMAs: `synchronous=NORMAL`, `cache_size`, `temp_store=memory`, `mmap_size`
- INSERT+SELECT in all 12 repositories instead of `RETURNING *`
- `readExpensesFromSheet()` loads entire sheet `A:Z` into memory
- Dynamic imports in hot expense path (`message.handler.ts:326-327`)
- `hasCompletedSetup()` re-queries same group just fetched
- Missing composite indexes: `(group_id, category)`, `(group_id, created_at)`
- `findByDateRange()` and `findByCategory()` have no LIMIT
- WAL checkpoint not managed
- Playwright in `dependencies` (~120MB+) instead of `devDependencies`

### Architecture

- Duplicate `normalizeCategory()` in parser.ts and category.repository.ts
- Duplicate `ensureUserInGroup()` in callback.handler.ts and message.handler.ts
- 7 copy-pasted dynamic UPDATE builders across repositories
- JSON parse duplicated 7x in receipt-items.repository.ts, 4x in group.repository.ts
- Exchange rate cache: module-level mutable state, silent fallback to stale rates
- `Record<string, unknown>` in topic-middleware.ts (banned by CLAUDE.md)

### Database

- `REAL` for money (floating-point rounding errors accumulate)
- TOCTOU race in `setBudget()` — check-then-insert instead of UPSERT
- `pending_expenses` has no `group_id` (orphan table from migration)
- `message_id` lookup ignores chat (unique per-chat, not global)
- Migrations run without transactions
- `delete()` always returns `true` regardless of affected rows
- No input validation before INSERT (negative amounts, empty strings pass)

### Error Handling

- 15 empty `catch {}` blocks
- 15+ `logger.error` calls use template literals instead of `{ err }` structured format
- 3 `.catch(() => {})` in telegram-stream.ts
- Raw `error.message` leaked to users in 8+ places
- Stack traces destroyed via `{ err: errorMessage }` in 2 places

### UX

- `setMyCommands` without scope (group commands shown in private chats)
- `maybeSmartAdvice` called from 6 places — 49% chance of unsolicited advice per session
- No "Back" button in multi-step flows
- No message length checks (4096 char Telegram limit)
- "Invalid parameters" in English in 13 callback answers
- `/reconnect` loops back to `/connect`
- `/settings` minimal and read-only
- `/categories` read-only, no emoji

### Code Quality

- 20+ copies of `error instanceof Error ? error.message : String(error)`
- 7 copies of "ensure budget sheet" pattern across 4 files
- 9 copies of Google Sheets client initialization
- ~35 production files without file-level comments
- Commented-out debug code in `ocr-extractor.ts`
- `createMany()` comment says "transaction" but there is none

### DevOps

- Graceful shutdown doesn't stop HTTP server/bot/intervals
- `process.env` read directly in `agent.ts` with conflicting defaults (`glm-5` vs `glm-4.7`)
- `console.log` in index.ts instead of pino logger
- No env var validation at startup (fail-late)
- Hardcoded server IP in GitHub Actions workflows
- No post-deploy health check

### Bun-specific

- `@types/bun: "latest"` not pinned
- `@gramio/types: "9.2.3"` without `^`
- `node:fs/promises` instead of `Bun.write()`/`Bun.file()` in ocr-extractor
- Dynamic `import('node:path')` in hot paths

---

## Positive Findings (What Works Well)

1. **Type safety is excellent** — zero `any`/`as any` in production code
2. **1192 tests, 40 test files** — repositories and services well-covered
3. **SQL injection properly mitigated** — all queries parameterized
4. **Math expression evaluator** — safe, no `eval()`, proper bounds checking
5. **Rate limiter** — well-implemented global + per-chat throttling
6. **Topic-aware middleware** — elegant AsyncLocalStorage + preRequest pattern
7. **Sanitize outgoing hook** — idempotent HTML cleanup on all messages
8. **Repository pattern** — clean separation, typed DTOs
9. **Typed error hierarchy** — `AppError` with subtypes (just needs to be wired in)
10. **Bot reactions** — thumbs-up instead of message for expense confirmation
11. **Multi-currency toggle keyboard** — proper inline keyboard UX
12. **Dev pipeline path traversal protection** — `validateFilePath` is secure
13. **CLAUDE.md** — comprehensive, well-maintained project documentation
14. **Biome clean** — zero warnings in production code

---

## Recommended Fix Order

### Phase 1: Security Emergency (1-2 days)

1. Fix path traversal in `/temp-images/`
2. Implement token encryption
3. Fix OAuth state to use crypto.randomUUID()
4. Add URL validation for SSRF
5. HTML-escape OAuth error pages
6. Add `PRAGMA busy_timeout = 5000`

### Phase 2: Data Safety (1-2 days)

7. Add `db.transaction()` to sync flow, createMany, receipt confirmation
2. Set up automated SQLite backups with off-server storage
3. Add CI tests (typecheck + lint + test) before deploy
4. Add `bot.onError()` and `process.on('unhandledRejection')`

### Phase 3: Quick Wins (1 day)

11. Fix `/stats` parse_mode (and `/sum`, `/budget`)
2. Wire in `formatErrorForUser()` and add try-catch to 9 naked handlers
3. Replace English error messages with Russian
4. Add typing indicators to long operations
5. Extract `getErrorMessage()` utility (replace 20+ copies)
6. Extract `ensureBudgetSheet()` helper (replace 7 copies)

### Phase 4: Performance (2-3 days)

17. Cache Google Sheets headers per spreadsheet
2. Batch Google Sheets writes (debounce + batchUpdate)
3. Remove `silentSyncBudgets` from per-expense path
4. Fix N+1 in `getAllBudgetsForMonth()` — single SQL query
5. Add missing composite indexes
6. Add SQLite performance PRAGMAs (synchronous, cache_size, temp_store, mmap_size)

### Phase 5: Architecture Cleanup (ongoing)

23. Extract `ExpenseService` from message.handler.ts
2. Split callback.handler.ts into domain modules
3. Wire `derive` for group/user resolution (eliminate boilerplate)
4. Consider `CallbackData` for typed callback routing
5. Add tests for command handlers and callback handler
6. Add uptime monitoring and error alerting

---

## Metrics

| Metric | Value |
|--------|-------|
| Files analyzed | 100+ |
| Security vulnerabilities (CRITICAL+HIGH) | 7 |
| Performance bottlenecks (CRITICAL+HIGH) | 7 |
| Architecture issues (HIGH) | 5 |
| Error handling gaps (HIGH) | 4 |
| UX issues (CRITICAL+HIGH) | 5 |
| DevOps gaps (CRITICAL+HIGH) | 4 |
| Database issues (HIGH) | 4 |
| Total unique findings | ~70 |
| Test count | 1192 |
| Test files | 40 |
| Production `any` count | 0 |
| Lint warnings | 0 |
