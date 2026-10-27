# Test Coverage 1000 / TDD Error Handling — Implementation Plan — Part 4/4: Agent 6, final verification, test count summary

[← Back to index](../2026-03-22-test-coverage-1000-plan.md)

## AGENT 6 — Fixes + Bot Layer (~110 tests)

**Files owned:** fix advice-triggers, expand file-ops, keyboards, topic-middleware, broadcast.

**Run tests with:** `bun test src/services/analytics/advice-triggers.test.ts src/services/dev-pipeline/file-ops.test.ts src/bot/keyboards.test.ts src/bot/topic-middleware.test.ts src/services/broadcast.test.ts`

---

### Task A6-1: Fix advice-triggers tests (fragile day-of-week + expand)

Read `src/services/analytics/advice-triggers.test.ts` and `src/services/analytics/advice-triggers.ts` first.

- [ ] **Step 1: Fix day-of-week fragility**

Find all places in advice-triggers.test.ts that check for "Monday" or specific days. Replace with:

```typescript
import { beforeEach, afterEach, setSystemTime } from 'bun:test';
// Note: bun:test exports setSystemTime directly — no jest.useFakeTimers() needed

beforeEach(() => {
  // 2026-03-23 is a Monday — fixes day-of-week dependent tests
  setSystemTime(new Date('2026-03-23T10:00:00Z'));
});

afterEach(() => {
  setSystemTime(); // reset to real time
});
```

- [ ] **Step 2: Add 15 new test cases** covering:
- Budget exceeded by exactly 0.01% (boundary)
- Budget exceeded by 200% (extreme overspend)
- Multiple budgets, only one exceeded
- Anomaly detection with single data point (not enough data)
- Cooldown: second call within cooldown window returns false
- Cooldown reset after window expires
- Group with no expenses → no triggers
- All trigger types return correct tier ('quick', 'alert', 'deep')

```bash
bun test src/services/analytics/advice-triggers.test.ts
git commit -m "fix(tests): fix date-dependent advice-triggers tests, add 15 edge cases"
```

---

### Task A6-2: Expand file-ops security tests (+20 tests)

Read `src/services/dev-pipeline/file-ops.test.ts` and `src/services/dev-pipeline/file-ops.ts` first.

Add these security cases:

```typescript
describe('path security — additional cases', () => {
  it('blocks absolute path /etc/passwd', () => {
    expect(isAllowedPath('/etc/passwd')).toBe(false);
  });

  it('blocks absolute path starting with /', () => {
    expect(isAllowedPath('/Users/admin/secret')).toBe(false);
  });

  it('blocks null byte injection', () => {
    expect(isAllowedPath('src/file.ts\x00.jpg')).toBe(false);
  });

  it('blocks double-encoded traversal %2e%2e/', () => {
    // If the function URL-decodes input, this would traverse
    // If it doesn't, it should still be blocked as invalid chars
    const result = isAllowedPath('%2e%2e/etc/passwd');
    expect(result).toBe(false);
  });

  it('blocks Windows-style path separator', () => {
    expect(isAllowedPath('src\\..\\..\\etc\\passwd')).toBe(false);
  });

  it('blocks path with multiple consecutive traversals', () => {
    expect(isAllowedPath('../../../../etc/passwd')).toBe(false);
  });

  it('blocks hidden directories starting with dot', () => {
    expect(isAllowedPath('.hidden/file.ts')).toBe(false);
  });

  it('allows normal src/ path', () => {
    expect(isAllowedPath('src/services/currency/converter.ts')).toBe(true);
  });

  it('allows nested src/ path', () => {
    expect(isAllowedPath('src/database/repositories/expense.repository.ts')).toBe(true);
  });

  it('blocks empty string', () => {
    expect(isAllowedPath('')).toBe(false);
  });

  it('blocks path with newline', () => {
    expect(isAllowedPath('src/file.ts\n/etc/passwd')).toBe(false);
  });

  it('blocks path with semicolon (shell injection)', () => {
    expect(isAllowedPath('src/file.ts;rm -rf /')).toBe(false);
  });
});
```

**Note:** Adapt test to actual function signature in file-ops.ts.

```bash
bun test src/services/dev-pipeline/file-ops.test.ts
git commit -m "test(dev-pipeline): add 20 security path validation tests"
```

---

### Task A6-3: Keyboards tests (~30 tests)

Read `src/bot/keyboards.ts` first.

**REQUIRED: Read `src/bot/keyboards.ts` fully first** to find all exported functions and their signatures.

```typescript
// src/bot/keyboards.test.ts
import { describe, it, expect } from 'bun:test';
// Import all exported keyboard builder functions — find them by reading keyboards.ts
// Example: import { buildCurrencyKeyboard, buildBudgetKeyboard, ... } from './keyboards';

// Helper: flatten all buttons from inline_keyboard matrix
function allButtons(kb: { inline_keyboard: Array<Array<{ text: string; callback_data?: string }>> }) {
  return kb.inline_keyboard.flat();
}

describe('keyboard builders', () => {
  // For each exported function found in keyboards.ts, add a describe block like this:

  // describe('buildCurrencyKeyboard', () => {
  //   const kb = buildCurrencyKeyboard(['EUR', 'USD', 'RSD']);
  //
  //   it('returns object with inline_keyboard array', () => {
  //     expect(Array.isArray(kb.inline_keyboard)).toBe(true);
  //     expect(kb.inline_keyboard.length).toBeGreaterThan(0);
  //   });
  //
  //   it('all buttons have non-empty text', () => {
  //     allButtons(kb).forEach(btn => expect(btn.text.length).toBeGreaterThan(0));
  //   });
  //
  //   it('all buttons have non-empty callback_data', () => {
  //     allButtons(kb).forEach(btn => expect((btn.callback_data ?? '').length).toBeGreaterThan(0));
  //   });
  //
  //   it('includes EUR button', () => {
  //     expect(allButtons(kb).some(btn => btn.text.includes('EUR'))).toBe(true);
  //   });
  //
  //   it('callback_data matches expected pattern', () => {
  //     // Find the pattern from callbacks in callback.handler.ts
  //     allButtons(kb).forEach(btn => expect(btn.callback_data).toMatch(/^[a-z_]+:/));
  //   });
  // });

  // Write a describe block for EVERY exported builder function in keyboards.ts
  // Minimum tests per function: (1) structure valid, (2) buttons have text, (3) buttons have callback_data
  // Aim for ~30 total tests
});
```

Aim for ~30 tests. All assertions must be real — no empty `it()` bodies.

```bash
bun test src/bot/keyboards.test.ts
git commit -m "test(bot): add keyboard builder tests"
```

---

### Task A6-4: Topic middleware tests (~20 tests)

Read `src/bot/topic-middleware.ts` first.

```typescript
// src/bot/topic-middleware.test.ts
import { describe, it, expect, mock } from 'bun:test';
// Test that middleware injects message_thread_id into outgoing calls
// Mock the AsyncLocalStorage context
```

Test:
- Context with message_thread_id injects it into API calls
- Context without message_thread_id does NOT inject undefined
- Multiple concurrent contexts don't bleed into each other

```bash
bun test src/bot/topic-middleware.test.ts
git commit -m "test(bot): add topic-middleware context injection tests"
```

---

### Task A6-5: Broadcast tests (~20 tests)

Read `src/services/broadcast.ts` first.

Mock the bot instance:

```typescript
const mockBot = {
  api: {
    sendMessage: mock(() => Promise.resolve({ ok: true })),
  },
};
```

Test:
- Sends to all groups
- Skips groups without spreadsheet
- Handles individual group send failure without stopping broadcast
- Logs errors silently (no throw)

```bash
bun test src/services/broadcast.test.ts
git commit -m "test(broadcast): add broadcast service tests with mock bot"
```

---

### Task A6-6: Final run — all Agent 6 tests

```bash
bun test src/services/analytics/advice-triggers.test.ts src/services/dev-pipeline/file-ops.test.ts src/bot/keyboards.test.ts src/bot/topic-middleware.test.ts src/services/broadcast.test.ts
```
Expected: ~110 tests, all green.

---

## Final Verification (run after all 6 agents complete)

```bash
# Run all tests
bun test

# Check total count (target: ~1052)
bun test 2>&1 | tail -5

# Type check
bunx tsc --noEmit

# Commit if clean — check status first
git status
git add src/ docs/
git commit -m "test: complete 1000-test coverage milestone — 6 parallel agents"
```

---

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
