# Streaming Receipt Scanner — Implementation Plan — Part 4/4: Task 8 and summary

[← Back to index](../2026-04-02-streaming-receipt-scanner.md)

## Task 8: Integration Verification

- [ ] **Step 8.1: Typecheck**

Run: `bun run type-check`

- [ ] **Step 8.2: Lint**

Run: `bun run lint:fix && bun run format`

- [ ] **Step 8.3: Full test suite**

Run: `bun run test`

- [ ] **Step 8.4: Knip**

Run: `bunx knip`

- [ ] **Step 8.5: Build miniapp**

Run: `cd miniapp && npx vite build`

- [ ] **Step 8.6: Final commit if needed**

```bash
git add -A && git commit -m "chore: lint and cleanup from streaming scanner implementation"
```

---

## Summary

| Task | Files | Key Changes |
|------|-------|-------------|
| 1. Stream JSON Parser | 2 new | Incremental item parser + `getCurrency()` |
| 2. URL Shortener | 2 new | Truncate URLs for display |
| 3. Scan Store | 2 new | State + SSE pub/sub + `telegramGroupId` in state |
| 4. Streaming AI Extractor | 1 modified, 1 new test | `streamExtractExpenses` + `Promise.race` timeout + extracted helpers |
| 5. Server API | 2 modified | Async 202 endpoints + SSE + poll + categories + distinct error codes |
| 6. Client API | 1 new, 1 modified | `startScan`, `streamScan`, `fetchCategories` |
| 7. Scanner.tsx + UI | 2 modified | Streaming UI, font fix, category `<datalist>` combobox, reconnect dedup |
| 8. Verification | 0 | Typecheck, lint, test, build |
