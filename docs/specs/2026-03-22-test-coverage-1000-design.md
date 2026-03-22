# Design: Test Coverage 1000 / TDD Error Handling

**Date:** 2026-03-22
**Status:** Approved

## Goal

Bring test count to ~1040 (from current 370) and coverage to ~80%.
Add typed error handling for external services via TDD (test-first, then implementation).

## Error Handling Architecture

### Typed Errors (new: `src/errors/`)

```
src/errors/
  service-errors.ts   — GoogleSheetsError, HuggingFaceError, NetworkError, OAuthError
  index.ts            — re-exports
```

**Rule:** services throw typed errors, know nothing about Telegram.
**Rule:** command handlers catch typed errors → `bot-error-formatter.ts` → user-friendly Telegram message.

### TDD Flow for Error Handling

1. Write failing test: `it('should throw GoogleSheetsError on 401')`
2. Implement typed error + throw in service
3. Write failing test: `it('should send user-friendly message on GoogleSheetsError')`
4. Implement handler in command/formatter
5. Tests green

## Agent Distribution

### Agent 1 — Pure Services (~100 tests)
**Files (test files to create):**
- `src/services/currency/converter.test.ts`
- `src/utils/fuzzy-search.test.ts`
- `src/services/google/oauth.test.ts` (crypto/token logic only, no real Google calls)

**Focus:** exchange rate conversions, multi-currency math, fuzzy matching edge cases,
AES-256-GCM encrypt/decrypt, token refresh logic.

### Agent 2 — Core Repositories (~150 tests)
**Files (test files to create):**
- `src/database/repositories/expense.repository.test.ts`
- `src/database/repositories/category.repository.test.ts`
- `src/database/repositories/expense-items.repository.test.ts`
- `src/database/repositories/budget.repository.test.ts`
- `src/database/repositories/group.repository.test.ts`
- `src/database/repositories/user.repository.test.ts`

**Focus:** full CRUD, filters, constraints, foreign key integrity. Use in-memory SQLite.

### Agent 3 — Small Repositories (~100 tests)
**Files (test files to create):**
- `src/database/repositories/pending-expense.repository.test.ts`
- `src/database/repositories/advice-log.repository.test.ts`
- `src/database/repositories/chat-message.repository.test.ts`
- `src/database/repositories/receipt-items.repository.test.ts`
- `src/database/repositories/photo-queue.repository.test.ts`

**Focus:** CRUD, expiry/TTL logic, queue ordering, message history limits. Use in-memory SQLite.

### Agent 4 — Receipt Pipeline (~100 tests)
**Files (test files to create):**
- `src/services/receipt/receipt-fetcher.test.ts`
- `src/services/receipt/ocr-extractor.test.ts`
- `src/services/receipt/qr-scanner.test.ts`
- `src/services/receipt/link-analyzer.test.ts`
- `src/services/receipt/receipt-summarizer.test.ts`
- `src/services/receipt/ai-extractor.test.ts`

**Focus:** mock fetch/HTTP, mock HF API. TDD for error cases: network timeout → `NetworkError`,
bad OCR response → graceful fallback, invalid QR data → typed error.

### Agent 5 — AI Layer + Error Architecture (~120 tests)
**Files (create + expand):**
- `src/errors/service-errors.ts` (implement)
- `src/errors/index.ts` (implement)
- `src/services/ai/agent.test.ts`
- `src/services/ai/telegram-stream.test.ts` (expand: +20 edge cases)
- `src/bot/bot-error-formatter.test.ts` (TDD: formatter translates typed errors)
- `src/bot/bot-error-formatter.ts` (implement via TDD)

**Focus:** TDD for HuggingFace errors (rate limit 429, timeout, malformed response),
OAuth token expiry handling, stream truncation edge cases, HTML tag closing.

### Agent 6 — Fixes + Bot Layer (~100 tests)
**Files (fix + create):**
- `src/services/analytics/advice-triggers.test.ts` (fix: mock Date, +15 tests)
- `src/services/dev-pipeline/file-ops.test.ts` (expand: +20 security tests)
- `src/bot/keyboards.test.ts`
- `src/bot/topic-middleware.test.ts`
- `src/services/broadcast.test.ts`

**Focus:** fix day-of-week fragility with `vi.useFakeTimers` / Date mock,
absolute path injection, symlink traversal, keyboard builder output structure,
topic context injection, broadcast error handling.

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
| bot/keyboards | 0% | 70% |
| **Overall** | **~35%** | **~80%** |

## Monitoring

- All 6 agents run in background
- Loop every 10 minutes: read agent outputs, report overall status
- Redirect agents via SendMessage if blocked or off-track
- Final: `bun test --coverage` to verify 80% target

## Non-Goals

- No tests for Telegram bot command handlers (too coupled to framework)
- No tests for Google Sheets API calls (require live credentials)
- No tests for `src/bot/index.ts` registration boilerplate
