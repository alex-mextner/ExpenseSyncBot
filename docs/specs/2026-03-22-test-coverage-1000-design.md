# Design: Test Coverage 1000 / TDD Error Handling

**Date:** 2026-03-22
**Status:** Approved

## Goal

Bring test count to ~1040 (from current **302**) and coverage to ~80%.
Add typed error handling for external services via TDD (test-first, then implementation).

## Error Handling Architecture

### Typed Errors (new: `src/errors/`)

```
src/errors/
  service-errors.ts   — GoogleSheetsError, HuggingFaceError, NetworkError, OAuthError
  index.ts            — re-exports
```

**Base class:**
```ts
export class AppError extends Error {
  constructor(message: string, public code: string, public cause?: unknown) {
    super(message);
    this.name = this.constructor.name;
  }
}
export class GoogleSheetsError extends AppError {}
export class HuggingFaceError extends AppError {}
export class NetworkError extends AppError {}
export class OAuthError extends AppError {}
```

**Rule:** services throw typed errors, know nothing about Telegram.
**Rule:** command handlers catch typed errors → `src/bot/bot-error-formatter.ts` → user-friendly Telegram message.

### TDD Flow for Error Handling

1. Write failing test: `it('should throw GoogleSheetsError on 401')`
2. Implement typed error + throw in service
3. Write failing test: `it('should return user-friendly message for GoogleSheetsError')`
4. Implement `bot-error-formatter.ts`
5. Tests green

## Shared Test Utilities

**Agent 2 creates** `src/test-utils/db.ts` — shared in-memory SQLite helper used by Agents 2 and 3.

```ts
// src/test-utils/db.ts
export function createTestDb(): Database {
  // initializes in-memory SQLite with all migrations applied
}
export function clearTestDb(db: Database): void {}
```

## Agent Distribution

**Start order:** Agent 1 creates `src/errors/` as part of its run (alongside converter/oauth tests).
Agent 4 imports from `src/errors/` directly — both can run in parallel since Agent 1 creates the error files early.

### Agent 1 — Pure Services (~110 tests)
**Files (test files to create):**
- `src/services/currency/converter.test.ts`
- `src/utils/fuzzy-search.test.ts`
- `src/services/google/oauth.test.ts` (crypto/token logic only, no real Google calls)

**Also creates:** `src/errors/service-errors.ts` and `src/errors/index.ts` with `AppError` base class
(moved here from Agent 5 to unblock Agent 4 and free up Agent 5)

**Focus:** exchange rate conversions, multi-currency math, rounding edge cases,
fuzzy matching (exact match, partial, case-insensitive, empty string, unicode),
AES-256-GCM encrypt/decrypt, token refresh logic.

### Agent 2 — Core Repositories (~180 tests)
**Files (test files to create):**
- `src/test-utils/db.ts` (create shared helper first)
- `src/database/repositories/expense.repository.test.ts`
- `src/database/repositories/category.repository.test.ts`
- `src/database/repositories/expense-items.repository.test.ts`
- `src/database/repositories/budget.repository.test.ts`
- `src/database/repositories/group.repository.test.ts`
- `src/database/repositories/user.repository.test.ts`

**Focus:** full CRUD, filters (date range, category, group, currency), constraints,
foreign key integrity, pagination/limits, NULL handling. Use in-memory SQLite via `test-utils/db.ts`.

### Agent 3 — Small Repositories (~110 tests)
**Files (test files to create):**
- `src/database/repositories/pending-expense.repository.test.ts`
- `src/database/repositories/advice-log.repository.test.ts`
- `src/database/repositories/chat-message.repository.test.ts`
- `src/database/repositories/receipt-items.repository.test.ts`
- `src/database/repositories/photo-queue.repository.test.ts`

**Depends on:** `src/test-utils/db.ts` (created by Agent 2).
**Focus:** CRUD, expiry/TTL logic, queue ordering, message history limits, upsert patterns.

### Agent 4 — Receipt Pipeline (~110 tests)
**Files (test files to create):**
- `src/services/receipt/receipt-fetcher.test.ts`
- `src/services/receipt/ocr-extractor.test.ts`
- `src/services/receipt/qr-scanner.test.ts`
- `src/services/receipt/link-analyzer.test.ts`
- `src/services/receipt/receipt-summarizer.test.ts`
- `src/services/receipt/ai-extractor.test.ts`

**Mock strategy:** mock `fetch` globally via `global.fetch = mock(...)`, mock HF client via module mock.
**TDD error cases:** network timeout → `NetworkError`, HTTP 4xx/5xx → typed error,
malformed OCR response → graceful null return, invalid QR data → typed error.
**Imports `src/errors/` (created by Agent 1).**

### Agent 5 — AI Layer + Bot Error Formatter (~130 tests)
**Files (create + expand):**
- `src/services/ai/agent.test.ts`
- `src/services/ai/telegram-stream.test.ts` (expand: +20 edge cases)
- `src/bot/bot-error-formatter.ts` (implement via TDD)
- `src/bot/bot-error-formatter.test.ts`

**Mock strategy for agent.ts:** mock `fetch` for HF API calls, or mock the HF client module.
**TDD error cases:** HuggingFace 429 rate limit → `HuggingFaceError` with retry hint,
HF timeout → `HuggingFaceError`, malformed JSON response → typed error,
OAuth token expiry mid-request → `OAuthError`.
**Telegram stream edge cases:** text exactly 4096 chars, deeply nested unclosed HTML tags,
split at unicode boundary, empty message, back-to-back sends.

### Agent 6 — Fixes + Bot Layer (~110 tests)
**Files (fix + create):**
- `src/services/analytics/advice-triggers.test.ts` (fix + expand: +15 tests)
- `src/services/dev-pipeline/file-ops.test.ts` (expand: +20 security tests)
- `src/bot/keyboards.test.ts`
- `src/bot/topic-middleware.test.ts`
- `src/services/broadcast.test.ts`

**Date mocking in bun:test:** use `jest.useFakeTimers()` (bun:test is jest-compatible),
or monkey-patch `Date` if needed. Fix day-of-week fragility in advice-triggers.
**file-ops security tests:** absolute paths (`/etc/passwd`), null bytes, unicode normalization,
double-encoded traversal (`%2e%2e/`), Windows-style paths.
**broadcast mock:** mock bot instance with `{ api: { sendMessage: mock(() => Promise.resolve()) } }`.
**keyboards:** test output structure (inline_keyboard arrays, callback_data format).

## Non-Goals

- No tests for command handlers in `src/bot/commands/` (too coupled to GramIO framework)
- No tests for `src/bot/handlers/` (callback.handler, message.handler)
- No tests for Google Sheets API live calls (require credentials)
- No tests for `src/bot/index.ts` registration boilerplate
- **Bot utilities are in scope:** `keyboards.ts`, `topic-middleware.ts`, `bot-error-formatter.ts`

## Coverage Targets

| Module | Current | Target |
|--------|---------|--------|
| services/currency | ~90% | 95% |
| services/google | 0% | 70% |
| services/receipt | 0% | 75% |
| services/ai | ~50% | 85% |
| services/analytics | ~70% | 85% |
| services/dev-pipeline | ~60% | 80% |
| database/repositories | ~15% | 85% |
| utils | 0% | 80% |
| bot/keyboards + middleware | 0% | 70% |
| **Overall** | **~30%** | **~80%** |

## Test Count Summary

| Agent | New tests | Running total |
|-------|-----------|---------------|
| Baseline | 302 | 302 |
| Agent 1 | +110 | 412 |
| Agent 2 | +180 | 592 |
| Agent 3 | +110 | 702 |
| Agent 4 | +110 | 812 |
| Agent 5 | +130 | 942 |
| Agent 6 | +110 | **1052** |

## Monitoring

- All 6 agents run in background simultaneously
- Loop every 10 minutes: check agent outputs, report status, redirect if blocked
- Final verification: `bun test --coverage` to confirm 80% target
