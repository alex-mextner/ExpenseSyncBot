# Test Coverage 1000 / TDD Error Handling — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring test count from 302 to ~1052 and overall coverage to ~80% by writing TDD tests for all untested modules and adding typed error handling for external services (Anthropic API, network, OAuth).

**Architecture:** 6 parallel independent agents each own isolated file sets. Agent 1 creates `src/errors/` first (unblocks Agent 4). Agent 2 creates `src/test-utils/db.ts` (unblocks Agent 3). All other work is fully independent. TDD flow for new code: failing test → minimal implementation → green. For existing code without tests: write spec-style tests describing expected behaviour.

**Tech Stack:** Bun test (jest-compatible), TypeScript, `bun:sqlite` in-memory SQLite, Anthropic SDK (`@anthropic-ai/sdk`), Playwright (mocked in tests), `bun:test` mock() API.

**Spec:** `docs/specs/2026-03-22-test-coverage-1000-design.md`

---

## File Map

### New production files
- `src/errors/service-errors.ts` — AppError base + typed error classes (Agent 1)
- `src/errors/index.ts` — re-exports (Agent 1)
- `src/bot/bot-error-formatter.ts` — typed error → Telegram message (Agent 5, via TDD)

### New test files
- `src/test-utils/db.ts` — shared in-memory SQLite setup (Agent 2)
- `src/services/currency/converter.test.ts` (Agent 1)
- `src/utils/fuzzy-search.test.ts` (Agent 1)
- `src/services/google/oauth.test.ts` (Agent 1)
- `src/database/repositories/expense.repository.test.ts` (Agent 2)
- `src/database/repositories/category.repository.test.ts` (Agent 2)
- `src/database/repositories/expense-items.repository.test.ts` (Agent 2)
- `src/database/repositories/budget.repository.test.ts` (Agent 2)
- `src/database/repositories/group.repository.test.ts` (Agent 2)
- `src/database/repositories/user.repository.test.ts` (Agent 2)
- `src/database/repositories/pending-expense.repository.test.ts` (Agent 3)
- `src/database/repositories/advice-log.repository.test.ts` (Agent 3)
- `src/database/repositories/chat-message.repository.test.ts` (Agent 3)
- `src/database/repositories/receipt-items.repository.test.ts` (Agent 3)
- `src/database/repositories/photo-queue.repository.test.ts` (Agent 3)
- `src/services/receipt/receipt-fetcher.test.ts` (Agent 4)
- `src/services/receipt/ocr-extractor.test.ts` (Agent 4)
- `src/services/receipt/qr-scanner.test.ts` (Agent 4)
- `src/services/receipt/link-analyzer.test.ts` (Agent 4)
- `src/services/receipt/receipt-summarizer.test.ts` (Agent 4)
- `src/services/receipt/ai-extractor.test.ts` (Agent 4)
- `src/services/ai/agent.test.ts` (Agent 5)
- `src/bot/bot-error-formatter.test.ts` (Agent 5)
- `src/bot/keyboards.test.ts` (Agent 6)
- `src/bot/topic-middleware.test.ts` (Agent 6)
- `src/services/broadcast.test.ts` (Agent 6)

### Modified test files
- `src/services/ai/telegram-stream.test.ts` — expand with edge cases (Agent 5)
- `src/services/analytics/advice-triggers.test.ts` — fix + expand (Agent 6)
- `src/services/dev-pipeline/file-ops.test.ts` — expand security cases (Agent 6)

---

## AGENT 1 — Pure Services + Error Architecture (~110 tests)

**Files owned:** `src/errors/`, `src/services/currency/converter.test.ts`, `src/utils/fuzzy-search.test.ts`, `src/services/google/oauth.test.ts`

**Run tests with:** `bun test src/errors/ src/services/currency/converter.test.ts src/utils/fuzzy-search.test.ts src/services/google/oauth.test.ts`

---

### Task A1-1: Create typed error architecture

**Files:**
- Create: `src/errors/service-errors.ts`
- Create: `src/errors/index.ts`

- [ ] **Step 1: Write service-errors.ts**

```typescript
// src/errors/service-errors.ts
// Typed error classes for external service failures

export class AppError extends Error {
  constructor(
    message: string,
    public readonly code: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class GoogleSheetsError extends AppError {}
// Used for HuggingFace Inference API (OCR, receipt AI services)
export class HuggingFaceError extends AppError {}
// Used for Anthropic SDK (main AI agent in src/services/ai/agent.ts)
export class AnthropicError extends AppError {}
export class NetworkError extends AppError {}
export class OAuthError extends AppError {}
```

- [ ] **Step 2: Write index.ts**

```typescript
// src/errors/index.ts
// Error type exports

export {
  AppError,
  GoogleSheetsError,
  HuggingFaceError,
  AnthropicError,
  NetworkError,
  OAuthError,
} from './service-errors';
```

- [ ] **Step 3: Verify compilation**

```bash
bunx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/errors/
git commit -m "feat(errors): add typed error architecture for external services"
```

---

### Task A1-2: Currency converter tests

**Files:**
- Read first: `src/services/currency/converter.ts`
- Create: `src/services/currency/converter.test.ts`

**Key insight:** `converter.ts` has module-level mutable `cachedRates`. Tests run on fresh module import where `cachedRates = null`, so all sync functions use `FALLBACK_RATES`. Test only the exported sync functions; the async `updateExchangeRates()` / `fetchExchangeRates()` need fetch mocks.

- [ ] **Step 1: Write test file skeleton**

```typescript
// src/services/currency/converter.test.ts
// Tests for currency conversion logic

import { describe, it, expect, beforeEach, mock, afterEach } from 'bun:test';
import {
  convertToEUR,
  convertCurrency,
  getExchangeRate,
  formatAmount,
  getAllExchangeRates,
  formatExchangeRatesForAI,
} from './converter';
```

- [ ] **Step 2: Write convertToEUR tests (~25 tests)**

```typescript
describe('convertToEUR', () => {
  it('returns same amount for EUR', () => {
    expect(convertToEUR(100, 'EUR')).toBe(100);
  });

  it('converts USD to EUR using fallback rate', () => {
    // 1 USD = 0.93 EUR
    expect(convertToEUR(100, 'USD')).toBe(93);
  });

  it('converts GBP to EUR', () => {
    // 1 GBP = 1.18 EUR
    expect(convertToEUR(10, 'GBP')).toBe(11.8);
  });

  it('converts RSD to EUR (small rate)', () => {
    // 1 RSD = 0.0086 EUR → 1000 RSD = 8.6 EUR
    expect(convertToEUR(1000, 'RSD')).toBe(8.6);
  });

  it('converts JPY to EUR (very small rate)', () => {
    // 1 JPY = 0.0062 EUR → 10000 JPY = 62 EUR
    expect(convertToEUR(10000, 'JPY')).toBe(62);
  });

  it('rounds to 2 decimal places', () => {
    // 1 RUB = 0.0093 EUR → 7 RUB = 0.07 EUR (rounding test)
    const result = convertToEUR(7, 'RUB');
    expect(Number(result.toFixed(2))).toBe(result);
  });

  it('handles zero amount', () => {
    expect(convertToEUR(0, 'USD')).toBe(0);
  });

  it('handles large amounts', () => {
    expect(convertToEUR(1_000_000, 'EUR')).toBe(1_000_000);
  });

  it('handles negative amounts', () => {
    expect(convertToEUR(-100, 'USD')).toBe(-93);
  });

  // All 11 currencies
  const currencies = ['USD', 'RUB', 'RSD', 'GBP', 'BYN', 'CHF', 'JPY', 'CNY', 'INR', 'LKR', 'AED'] as const;
  for (const currency of currencies) {
    it(`converts ${currency} to EUR (result is positive for positive input)`, () => {
      expect(convertToEUR(100, currency)).toBeGreaterThan(0);
    });
  }
});
```

- [ ] **Step 3: Run and verify**

```bash
bun test src/services/currency/converter.test.ts
```
Expected: all pass.

- [ ] **Step 4: Write convertCurrency tests (~20 tests)**

```typescript
describe('convertCurrency', () => {
  it('returns same amount when currencies are equal', () => {
    expect(convertCurrency(100, 'USD', 'USD')).toBe(100);
  });

  it('converts USD to GBP via EUR', () => {
    // USD→EUR: 100 * 0.93 = 93 EUR
    // EUR→GBP: 93 / 1.18 ≈ 78.81 GBP
    const result = convertCurrency(100, 'USD', 'GBP');
    expect(result).toBeCloseTo(78.81, 1);
  });

  it('converts EUR to USD', () => {
    // EUR→USD: rate[USD]=0.93, so 1 EUR = 1/0.93 USD
    const result = convertCurrency(100, 'EUR', 'USD');
    expect(result).toBeGreaterThan(100); // USD is weaker than EUR
  });

  it('handles zero', () => {
    expect(convertCurrency(0, 'USD', 'GBP')).toBe(0);
  });

  it('round-trip EUR→USD→EUR is approximately equal', () => {
    const eur = 100;
    const usd = convertCurrency(eur, 'EUR', 'USD');
    const backToEur = convertCurrency(usd, 'USD', 'EUR');
    expect(backToEur).toBeCloseTo(eur, 0); // allow small rounding
  });

  it('is symmetric: A→B then B→A ≈ original', () => {
    const original = 500;
    const toGBP = convertCurrency(original, 'RSD', 'GBP');
    const back = convertCurrency(toGBP, 'GBP', 'RSD');
    expect(back).toBeCloseTo(original, -1); // within 10 RSD
  });

  it('converts RUB to RSD (both small currencies)', () => {
    const result = convertCurrency(1000, 'RUB', 'RSD');
    expect(result).toBeGreaterThan(0);
  });

  it('rounds result to 2 decimal places', () => {
    const result = convertCurrency(1, 'JPY', 'INR');
    expect(Number(result.toFixed(2))).toBe(result);
  });
});
```

- [ ] **Step 5: Write getExchangeRate, formatAmount, getAllExchangeRates, formatExchangeRatesForAI tests (~20 tests)**

```typescript
describe('getExchangeRate', () => {
  it('returns 1.0 for EUR', () => {
    expect(getExchangeRate('EUR')).toBe(1.0);
  });

  it('returns 0.93 for USD (fallback rate)', () => {
    expect(getExchangeRate('USD')).toBe(0.93);
  });

  it('returns rate for all supported currencies', () => {
    const currencies = ['USD', 'RUB', 'RSD', 'GBP', 'BYN', 'CHF', 'JPY', 'CNY', 'INR', 'LKR', 'AED', 'EUR'] as const;
    for (const c of currencies) {
      expect(getExchangeRate(c)).toBeGreaterThan(0);
    }
  });
});

describe('formatAmount', () => {
  // Read the actual formatAmount implementation first — verify expected output format
  // The function uses toFixed(2), so output is "100.00 USD" — but confirm by reading converter.ts

  it('returns a non-empty string', () => {
    expect(formatAmount(100, 'USD').length).toBeGreaterThan(0);
  });

  it('includes the currency code', () => {
    expect(formatAmount(100, 'USD')).toContain('USD');
    expect(formatAmount(50, 'EUR')).toContain('EUR');
  });

  it('includes the numeric value', () => {
    expect(formatAmount(100, 'USD')).toContain('100');
    expect(formatAmount(0.05, 'EUR')).toContain('0.05');
  });

  it('handles zero', () => {
    expect(formatAmount(0, 'USD')).toContain('0');
  });

  it('handles negative amounts', () => {
    const result = formatAmount(-50.5, 'GBP');
    expect(result).toContain('50');
    expect(result).toContain('GBP');
  });

  // After reading converter.ts formatAmount implementation, add exact format tests:
  // it('format is "amount.xx CURRENCY"', () => {
  //   expect(formatAmount(100, 'USD')).toBe('100.00 USD'); // confirm by reading code
  // });
});

describe('getAllExchangeRates', () => {
  it('returns object with all 12 currencies', () => {
    const rates = getAllExchangeRates();
    expect(Object.keys(rates)).toHaveLength(12);
  });

  it('EUR rate is 1.0', () => {
    expect(getAllExchangeRates()['EUR']).toBe(1.0);
  });

  it('returns a copy (mutation does not affect module state)', () => {
    const rates = getAllExchangeRates();
    rates['EUR'] = 999;
    expect(getAllExchangeRates()['EUR']).toBe(1.0);
  });
});

describe('formatExchangeRatesForAI', () => {
  it('returns a non-empty string', () => {
    expect(formatExchangeRatesForAI().length).toBeGreaterThan(50);
  });

  it('contains EUR header', () => {
    expect(formatExchangeRatesForAI()).toContain('EUR');
  });

  it('does not include EUR as a line item (only as base)', () => {
    const lines = formatExchangeRatesForAI().split('\n').filter(l => l.startsWith('- '));
    expect(lines.every(l => !l.includes('1 EUR ='))).toBe(true);
  });

  it('includes all non-EUR currencies', () => {
    const text = formatExchangeRatesForAI();
    const currencies = ['USD', 'RUB', 'RSD', 'GBP', 'BYN', 'CHF', 'JPY', 'CNY', 'INR', 'LKR', 'AED'];
    for (const c of currencies) {
      expect(text).toContain(c);
    }
  });
});
```

- [ ] **Step 6: Run all converter tests**

```bash
bun test src/services/currency/converter.test.ts
```
Expected: ~65 tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/services/currency/converter.test.ts
git commit -m "test(currency): add 65+ tests for converter — all sync functions covered"
```

---

### Task A1-3: Fuzzy search tests (~25 tests)

**Files:**
- Read first: `src/utils/fuzzy-search.ts`
- Create: `src/utils/fuzzy-search.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// src/utils/fuzzy-search.test.ts
// Tests for category fuzzy matching and normalization

import { describe, it, expect } from 'bun:test';
import {
  normalizeCategoryName,
  findBestCategoryMatch,
  findSimilarCategories,
} from './fuzzy-search';

describe('normalizeCategoryName', () => {
  it('capitalizes first letter', () => expect(normalizeCategoryName('food')).toBe('Food'));
  it('preserves already-capitalized', () => expect(normalizeCategoryName('Food')).toBe('Food'));
  it('trims whitespace', () => expect(normalizeCategoryName('  food  ')).toBe('Food'));
  it('handles empty string', () => expect(normalizeCategoryName('')).toBe(''));
  it('handles whitespace only', () => expect(normalizeCategoryName('   ')).toBe(''));
  it('handles single character', () => expect(normalizeCategoryName('f')).toBe('F'));
  it('handles unicode first char', () => expect(normalizeCategoryName('еда')).toBe('Еда'));
  it('does not alter rest of string casing', () => expect(normalizeCategoryName('fOOD')).toBe('FOOD'));
});

describe('findBestCategoryMatch', () => {
  const cats = ['Food', 'Transport', 'Entertainment', 'Health'];

  it('returns null for empty input', () => expect(findBestCategoryMatch('', cats)).toBeNull());
  it('returns null for empty categories', () => expect(findBestCategoryMatch('food', [])).toBeNull());
  it('finds exact match case-insensitive', () => expect(findBestCategoryMatch('food', cats)).toBe('Food'));
  it('finds exact match uppercase input', () => expect(findBestCategoryMatch('FOOD', cats)).toBe('Food'));
  it('finds match when category contains input', () => expect(findBestCategoryMatch('tain', cats)).toBe('Entertainment'));
  it('finds match when input contains category', () => expect(findBestCategoryMatch('My Food purchase', cats)).toBe('Food'));
  it('returns null when no match', () => expect(findBestCategoryMatch('xyz', cats)).toBeNull());
  it('prefers exact over contains', () => {
    const c = ['food & drink', 'Food'];
    expect(findBestCategoryMatch('food', c)).toBe('Food');
  });
  it('handles single character input with match', () => {
    expect(findBestCategoryMatch('h', ['Health', 'Home'])).toBe('Health');
  });
});

describe('findSimilarCategories', () => {
  const cats = ['Food', 'Transport', 'Entertainment', 'Health', 'Healthcare'];

  it('returns empty array for empty input', () => expect(findSimilarCategories('', cats)).toEqual([]));
  it('returns empty array for empty categories', () => expect(findSimilarCategories('food', [])).toEqual([]));
  it('returns at most limit results', () => expect(findSimilarCategories('health', cats, 1)).toHaveLength(1));
  it('default limit is 3', () => expect(findSimilarCategories('health', cats).length).toBeLessThanOrEqual(3));
  it('exact match scores highest (appears first)', () => {
    const results = findSimilarCategories('health', cats);
    expect(results[0]).toBe('Health');
  });
  it('returns multiple partial matches', () => {
    const results = findSimilarCategories('health', cats, 5);
    expect(results).toContain('Health');
    expect(results).toContain('Healthcare');
  });
  it('word-based matching works', () => {
    const results = findSimilarCategories('food delivery', cats);
    expect(results).toContain('Food');
  });
  it('returns sorted by score descending', () => {
    const results = findSimilarCategories('health', cats, 5);
    expect(results[0]).toBe('Health'); // exact > partial
  });
});
```

- [ ] **Step 2: Run tests**

```bash
bun test src/utils/fuzzy-search.test.ts
```
Expected: ~25 tests pass.

- [ ] **Step 3: Commit**

```bash
git add src/utils/fuzzy-search.test.ts
git commit -m "test(utils): add 25 tests for fuzzy-search — normalization and matching"
```

---

### Task A1-4: OAuth tests (~20 tests, crypto + URL generation only)

**Files:**
- Read first: `src/services/google/oauth.ts`
- Create: `src/services/google/oauth.test.ts`

**Constraint:** Do NOT test `getTokensFromCode`, `refreshAccessToken`, `revokeToken` against real Google API. Test only: `generateAuthUrl`, `getAuthenticatedClient`.

**Env vars:** `oauth.ts` reads `env.GOOGLE_CLIENT_ID/SECRET/REDIRECT_URI` at **module load time** via the singleton `oauth2Client`. Ensure these are set before running tests. Bun auto-loads `.env` — if it exists with real values, tests will pass. If running in CI without `.env`, set them explicitly:

```bash
GOOGLE_CLIENT_ID=test-client-id \
GOOGLE_CLIENT_SECRET=test-secret \
GOOGLE_REDIRECT_URI=http://localhost/callback \
bun test src/services/google/oauth.test.ts
```

- [ ] **Step 1: Write tests**

```typescript
// src/services/google/oauth.test.ts
// Tests for OAuth URL generation and client setup (no live API calls)

import { describe, it, expect } from 'bun:test';
import { generateAuthUrl, getAuthenticatedClient } from './oauth';

describe('generateAuthUrl', () => {
  it('returns a string URL', () => {
    const url = generateAuthUrl(123);
    expect(typeof url).toBe('string');
    expect(url.length).toBeGreaterThan(10);
  });

  it('contains accounts.google.com', () => {
    expect(generateAuthUrl(123)).toContain('accounts.google.com');
  });

  it('contains access_type=offline', () => {
    expect(generateAuthUrl(123)).toContain('access_type=offline');
  });

  it('contains the user ID in state param', () => {
    expect(generateAuthUrl(456)).toContain('456');
  });

  it('different user IDs produce different URLs', () => {
    const url1 = generateAuthUrl(1);
    const url2 = generateAuthUrl(2);
    expect(url1).not.toBe(url2);
  });

  it('contains prompt=consent', () => {
    expect(generateAuthUrl(1)).toContain('consent');
  });
});

describe('getAuthenticatedClient', () => {
  it('returns an OAuth2 client object', () => {
    const client = getAuthenticatedClient('dummy-refresh-token');
    expect(client).toBeTruthy();
    expect(typeof client.refreshAccessToken).toBe('function');
  });

  it('creates a new client per call (not a singleton)', () => {
    const c1 = getAuthenticatedClient('token-1');
    const c2 = getAuthenticatedClient('token-2');
    expect(c1).not.toBe(c2);
  });
});
```

- [ ] **Step 2: Run tests**

```bash
bun test src/services/google/oauth.test.ts
```
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add src/services/google/oauth.test.ts
git commit -m "test(oauth): add tests for URL generation and client setup"
```

- [ ] **Step 4: Final run — all Agent 1 tests**

```bash
bun test src/errors/ src/services/currency/converter.test.ts src/utils/fuzzy-search.test.ts src/services/google/oauth.test.ts
```
Expected: ~110 tests, all green.

---

## AGENT 2 — Core Repositories (~180 tests)

**Files owned:** `src/test-utils/db.ts`, six repository test files.

**Depends on:** Nothing. Creates `src/test-utils/db.ts` first (used by Agent 3).

**Run tests with:** `bun test src/test-utils/ src/database/repositories/expense.repository.test.ts src/database/repositories/category.repository.test.ts src/database/repositories/expense-items.repository.test.ts src/database/repositories/budget.repository.test.ts src/database/repositories/group.repository.test.ts src/database/repositories/user.repository.test.ts`

---

### Task A2-1: Create shared test DB helper

**Files:**
- Read first: `src/database/schema.ts` (for runMigrations function)
- Create: `src/test-utils/db.ts`

- [ ] **Step 1: Write helper**

```typescript
// src/test-utils/db.ts
// Shared in-memory SQLite setup for repository tests

import { Database } from 'bun:sqlite';
import { runMigrations } from '../database/schema'; // runMigrations IS exported at schema.ts:23

/**
 * Create a fresh in-memory database with all migrations applied.
 * Call in beforeAll(). Close in afterAll(). Clear tables in beforeEach().
 */
export function createTestDb(): Database {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}

/**
 * Remove all rows from all tables (call in beforeEach to isolate tests).
 * Order matters due to foreign keys.
 */
export function clearTestDb(db: Database): void {
  db.exec(`
    DELETE FROM advice_log;
    DELETE FROM chat_messages;
    DELETE FROM receipt_items;
    DELETE FROM photo_processing_queue;
    DELETE FROM expense_items;
    DELETE FROM expenses;
    DELETE FROM pending_expenses;
    DELETE FROM budgets;
    DELETE FROM categories;
    DELETE FROM dev_tasks;
    DELETE FROM users;
    DELETE FROM groups;
  `);
}

/**
 * Insert a test group and return its id.
 */
export function insertTestGroup(db: Database, overrides: Partial<{
  telegram_group_id: number;
  default_currency: string;
}> = {}): number {
  const stmt = db.prepare(
    `INSERT INTO groups (telegram_group_id, default_currency, enabled_currencies)
     VALUES (?, ?, '["EUR"]')`
  );
  const result = stmt.run(
    overrides.telegram_group_id ?? Math.floor(Math.random() * 1_000_000),
    overrides.default_currency ?? 'EUR'
  );
  return result.lastInsertRowid as number;
}

/**
 * Insert a test user in a group and return its id.
 */
export function insertTestUser(db: Database, groupId: number): number {
  const stmt = db.prepare(
    `INSERT INTO users (telegram_id, group_id) VALUES (?, ?)`
  );
  const result = stmt.run(Math.floor(Math.random() * 1_000_000), groupId);
  return result.lastInsertRowid as number;
}
```

- [ ] **Step 2: Verify helper compiles**

```bash
bunx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add src/test-utils/db.ts
git commit -m "test(utils): add shared in-memory SQLite test helper"
```

---

### Task A2-2: Group repository tests (~25 tests)

**Files:**
- Read first: `src/database/repositories/group.repository.ts`
- Create: `src/database/repositories/group.repository.test.ts`

- [ ] **Step 1: Read the repository to understand its methods**

Read `src/database/repositories/group.repository.ts` fully before writing tests.

- [ ] **Step 2: Write tests covering all public methods**

Pattern to follow for every repository:
```typescript
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'bun:test';
import { Database } from 'bun:sqlite';
import { createTestDb } from '../../test-utils/db';
import { GroupRepository } from './group.repository';

let db: Database;
let repo: GroupRepository;

beforeAll(() => {
  db = createTestDb();
  repo = new GroupRepository(db);
});

afterAll(() => db.close());

beforeEach(() => {
  db.exec('DELETE FROM groups');
});

describe('GroupRepository', () => {
  describe('create', () => {
    it('creates and returns group with id', () => {
      const group = repo.create({ telegram_group_id: 100500, default_currency: 'EUR' });
      expect(group.id).toBeGreaterThan(0);
      expect(group.telegram_group_id).toBe(100500);
    });

    it('throws on duplicate telegram_group_id', () => {
      repo.create({ telegram_group_id: 1, default_currency: 'EUR' });
      expect(() => repo.create({ telegram_group_id: 1, default_currency: 'USD' })).toThrow();
    });
  });

  describe('findByTelegramId', () => {
    it('returns group by telegram id', () => {
      repo.create({ telegram_group_id: 200, default_currency: 'USD' });
      const found = repo.findByTelegramId(200);
      expect(found?.telegram_group_id).toBe(200);
    });

    it('returns null for unknown id', () => {
      expect(repo.findByTelegramId(999999)).toBeNull();
    });
  });

  // ... (findById, update, delete, etc. — cover all methods you find in the file)
});
```

Write tests for **every method** in the repository. Aim for 25+ tests covering: create, find variants, update, delete, edge cases (NULL values, constraints).

- [ ] **Step 3: Run tests**

```bash
bun test src/database/repositories/group.repository.test.ts
```
Expected: all pass.

- [ ] **Step 4: Commit**

```bash
git add src/database/repositories/group.repository.test.ts
git commit -m "test(repo): add group repository tests"
```

---

### Task A2-3: User repository tests (~25 tests)

Same pattern as A2-2. Read `user.repository.ts` first.

Key cases to cover:
- `findByTelegramId` — found / not found
- `findById` — found / not found
- `create` — with and without group_id
- `update` — partial updates
- Foreign key: user with group_id when group deleted (ON DELETE SET NULL)

```bash
bun test src/database/repositories/user.repository.test.ts
git commit -m "test(repo): add user repository tests"
```

---

### Task A2-4: Category repository tests (~25 tests)

Read `category.repository.ts` first.

Key cases:
- `findByGroupId` — returns only group's categories
- `findByName` — case-sensitive vs case-insensitive
- UNIQUE(group_id, name) constraint
- Cascade delete when group deleted
- Create/update/delete

```bash
bun test src/database/repositories/category.repository.test.ts
git commit -m "test(repo): add category repository tests"
```

---

### Task A2-5: Expense repository tests (~40 tests)

Read `expense.repository.ts` first. This is the most complex repository.

Key cases:
- Create expense with all fields
- `findByGroupId` — basic fetch
- Date range filter (`from`, `to`)
- Category filter (case-insensitive)
- Currency filter
- Pagination / limit
- Sum aggregation by category
- Sum aggregation by currency
- Order by date descending
- Delete expense (own group vs wrong group — access control)
- `findByDateRange` with empty result
- NULL comment handling

```bash
bun test src/database/repositories/expense.repository.test.ts
git commit -m "test(repo): add expense repository tests — 40 cases"
```

---

### Task A2-6: Budget repository tests (~25 tests)

Read `budget.repository.ts` first.

Key cases:
- UNIQUE(group_id, category, month)
- `findByGroupAndMonth` — returns correct month only
- `upsert` or `createOrUpdate` pattern
- `findExceededBudgets` — comparing sum to limit
- Currency handling

```bash
bun test src/database/repositories/budget.repository.test.ts
git commit -m "test(repo): add budget repository tests"
```

---

### Task A2-7: Expense-items repository tests (~20 tests)

Read `expense-items.repository.ts` first.

Key cases:
- Create item linked to expense
- `findByExpenseId`
- Cascade delete when expense deleted

```bash
bun test src/database/repositories/expense-items.repository.test.ts
git commit -m "test(repo): add expense-items repository tests"
```

---

### Task A2-8: Final run — all Agent 2 tests

```bash
bun test src/test-utils/ src/database/repositories/expense.repository.test.ts src/database/repositories/category.repository.test.ts src/database/repositories/expense-items.repository.test.ts src/database/repositories/budget.repository.test.ts src/database/repositories/group.repository.test.ts src/database/repositories/user.repository.test.ts
```
Expected: ~180 tests, all green.

---

## AGENT 3 — Small Repositories (~110 tests)

**Files owned:** five repository test files.

**Depends on:** `src/test-utils/db.ts` (created by Agent 2). If Agent 2 hasn't committed it yet, create a local inline version:

```typescript
// Inline fallback if test-utils/db.ts not yet available
import { Database } from 'bun:sqlite';
import { runMigrations } from '../../database/schema';
function createTestDb() {
  const db = new Database(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  runMigrations(db);
  return db;
}
```

**Run tests with:** `bun test src/database/repositories/pending-expense.repository.test.ts src/database/repositories/advice-log.repository.test.ts src/database/repositories/chat-message.repository.test.ts src/database/repositories/receipt-items.repository.test.ts src/database/repositories/photo-queue.repository.test.ts`

---

### Task A3-1: Pending expense repository tests (~20 tests)

Read `pending-expense.repository.ts` first.

Key cases:
- Create pending expense with `status = 'pending_category'`
- `findByUserId`
- `findByMessageId`
- Update status to 'confirmed'
- Delete after confirmation
- Multiple pending expenses for same user

```bash
bun test src/database/repositories/pending-expense.repository.test.ts
git commit -m "test(repo): add pending-expense repository tests"
```

---

### Task A3-2: Chat message repository tests (~20 tests)

Read `chat-message.repository.ts` first.

Key cases:
- Create message with role 'user' / 'assistant'
- `findByGroupId` — returns messages for group only
- Order by created_at
- Limit (get last N messages)
- Invalid role → throws constraint error
- Clear history for group

```bash
bun test src/database/repositories/chat-message.repository.test.ts
git commit -m "test(repo): add chat-message repository tests"
```

---

### Task A3-3: Advice log repository tests (~20 tests)

Read `advice-log.repository.ts` first.

Key cases:
- Create log entry
- `findByGroupId` with date range
- `findRecent` — last N entries
- tier constraint ('quick', 'alert', 'deep')
- trigger_data JSON storage (stored as text, parsed as needed)

```bash
bun test src/database/repositories/advice-log.repository.test.ts
git commit -m "test(repo): add advice-log repository tests"
```

---

### Task A3-4: Photo queue repository tests (~25 tests)

Read `photo-queue.repository.ts` first.

Key cases:
- Create with status 'pending'
- `findByStatus` — returns only matching status
- `updateStatus` — pending → processing → done / error
- Invalid status → throws constraint error
- `findByGroupId`
- summary_mode flag (0/1)
- message_thread_id nullable

```bash
bun test src/database/repositories/photo-queue.repository.test.ts
git commit -m "test(repo): add photo-queue repository tests"
```

---

### Task A3-5: Receipt items repository tests (~25 tests)

Read `receipt-items.repository.ts` first.

Key cases:
- Create item linked to photo_queue entry
- `findByQueueId`
- Status: 'pending', 'confirmed', 'skipped'
- `updateStatus` including 'skipped'
- confirmed_category nullable
- possible_categories stored as JSON text
- waiting_for_category_input flag
- Cascade delete when photo_queue entry deleted

```bash
bun test src/database/repositories/receipt-items.repository.test.ts
git commit -m "test(repo): add receipt-items repository tests"
```

---

### Task A3-6: Final run — all Agent 3 tests

```bash
bun test src/database/repositories/pending-expense.repository.test.ts src/database/repositories/advice-log.repository.test.ts src/database/repositories/chat-message.repository.test.ts src/database/repositories/receipt-items.repository.test.ts src/database/repositories/photo-queue.repository.test.ts
```
Expected: ~110 tests, all green.

---

## AGENT 4 — Receipt Pipeline (~110 tests)

**Files owned:** six receipt service test files.

**Depends on:** `src/errors/` (created by Agent 1). If not yet committed, define local stubs:
```typescript
class NetworkError extends Error { constructor(msg: string, public code = 'NETWORK_ERROR') { super(msg); } }
```
Replace with real import once Agent 1 commits.

**Mock strategy:** Use dependency injection (DI) for receipt-fetcher (see A4-3 — no `mock.module()`). Mock `fetch` globally via `global.fetch = mock(...)` for HTTP calls in other services.

**Run tests with:** `bun test src/services/receipt/`

---

### Task A4-1: QR scanner tests (~15 tests)

Read `src/services/receipt/qr-scanner.ts` first.

Focus on `isURL` and any parsing/extraction functions — pure logic, no mocks needed.

```typescript
// src/services/receipt/qr-scanner.test.ts
import { describe, it, expect } from 'bun:test';
import { isURL } from './qr-scanner';

describe('isURL', () => {
  it('returns true for http URL', () => expect(isURL('http://example.com')).toBe(true));
  it('returns true for https URL', () => expect(isURL('https://example.com/receipt?id=123')).toBe(true));
  it('returns false for plain text', () => expect(isURL('just text')).toBe(false));
  it('returns false for JSON string', () => expect(isURL('{"amount":100}')).toBe(false));
  it('returns false for empty string', () => expect(isURL('')).toBe(false));
  it('returns false for ftp URL (not supported)', () => expect(isURL('ftp://example.com')).toBe(false));
  it('handles URL with path and query', () => expect(isURL('https://api.store.com/r?t=abc&id=123')).toBe(true));
  // Add more based on what you find in qr-scanner.ts
});
```

```bash
bun test src/services/receipt/qr-scanner.test.ts
git commit -m "test(receipt): add qr-scanner tests"
```

---

### Task A4-2: Link analyzer tests (~20 tests)

Read `src/services/receipt/link-analyzer.ts` first.

This likely has URL classification/detection logic. Test each classification function.

```bash
bun test src/services/receipt/link-analyzer.test.ts
git commit -m "test(receipt): add link-analyzer tests"
```

---

### Task A4-3: Receipt fetcher tests with DI (~20 tests)

Read `src/services/receipt/receipt-fetcher.ts` first.

**`mock.module()` is banned in this project** (pipeline.ts:148). Use **dependency injection** instead.

- [ ] **Step 1: Add optional `getBrowserFn` parameter to `fetchReceiptData` in receipt-fetcher.ts**

This is a backward-compatible change — existing callers pass no second arg and get real Playwright.

```typescript
// In receipt-fetcher.ts — add optional second parameter:
export async function fetchReceiptData(
  qrData: string,
  getBrowserFn: () => Promise<{ newContext: Function }> = getBrowser,
): Promise<string>
// Pass getBrowserFn instead of calling getBrowser() directly inside the function body.
```

- [ ] **Step 2: Write TDD tests (write the NetworkError tests FIRST, they will fail)**

```typescript
// src/services/receipt/receipt-fetcher.test.ts
import { describe, it, expect, mock } from 'bun:test';
import { fetchReceiptData } from './receipt-fetcher';
import { NetworkError } from '../../errors';

// Fake browser factory — dependency-injected, no mock.module needed
function makeFakeBrowser(opts: { content?: string; gotoError?: Error } = {}) {
  return async () => ({
    newContext: async () => ({
      newPage: async () => ({
        goto: opts.gotoError
          ? mock(() => Promise.reject(opts.gotoError))
          : mock(() => Promise.resolve()),
        waitForTimeout: mock(() => Promise.resolve()),
        content: mock(() => Promise.resolve(
          opts.content ?? '<html><body>Receipt content with enough data to pass length check</body></html>'
        )),
        close: mock(() => Promise.resolve()),
      }),
      close: mock(() => Promise.resolve()),
    }),
  });
}

describe('fetchReceiptData', () => {
  it('returns page content for valid URL', async () => {
    const result = await fetchReceiptData('https://example.com/receipt', makeFakeBrowser());
    expect(typeof result).toBe('string');
    expect(result).toContain('Receipt content');
  });

  it('returns plain QR data as-is when not a URL', async () => {
    const json = '{"amount":1500,"store":"Supermarket"}';
    const result = await fetchReceiptData(json, makeFakeBrowser());
    expect(result).toBe(json);
  });

  it('does not call browser for non-URL QR data', async () => {
    let browserCalled = false;
    const trackingBrowser = async () => { browserCalled = true; return makeFakeBrowser()(); };
    await fetchReceiptData('plain text', trackingBrowser as Parameters<typeof fetchReceiptData>[1]);
    expect(browserCalled).toBe(false);
  });

  // TDD: write FIRST → test FAILS → fix receipt-fetcher.ts to throw NetworkError → test PASSES

  it('[TDD] throws NetworkError when page content is too short', async () => {
    await expect(
      fetchReceiptData('https://example.com/empty', makeFakeBrowser({ content: '<html></html>' }))
    ).rejects.toBeInstanceOf(NetworkError);
  });

  it('[TDD] throws NetworkError when browser navigation fails', async () => {
    await expect(
      fetchReceiptData(
        'https://unreachable.example.com',
        makeFakeBrowser({ gotoError: new Error('net::ERR_CONNECTION_REFUSED') })
      )
    ).rejects.toBeInstanceOf(NetworkError);
  });
});
```

- [ ] **Step 3: Run — NetworkError tests FAIL (receipt-fetcher throws plain Error)**

```bash
bun test src/services/receipt/receipt-fetcher.test.ts
```
Expected: 3 pass, 2 fail (`NetworkError` not thrown yet).

- [ ] **Step 4: Fix receipt-fetcher.ts to throw NetworkError**

```typescript
// In receipt-fetcher.ts:
import { NetworkError } from '../../errors';
// Replace: throw new Error('Page content too short...')
// With:    throw new NetworkError('Page content too short', 'EMPTY_CONTENT')
// Replace: catch (error) { throw error; }
// With:    catch (error) { throw new NetworkError('Browser navigation failed', 'NAVIGATION_FAILED', error); }
```

- [ ] **Step 5: Run — all tests PASS**

```bash
bun test src/services/receipt/receipt-fetcher.test.ts
git commit -m "feat(receipt): throw NetworkError on fetch failures (TDD) + tests"
```

---

### Task A4-4: OCR extractor tests (~20 tests)

Read `src/services/receipt/ocr-extractor.ts` first.

Mock any external APIs (HuggingFace inference, etc.).

TDD error cases:
- API returns 429 → should propagate as `HuggingFaceError`
- API returns malformed JSON → handle gracefully, return null

```bash
bun test src/services/receipt/ocr-extractor.test.ts
git commit -m "feat(receipt): throw typed errors from ocr-extractor (TDD) + tests"
```

---

### Task A4-5: Receipt summarizer + AI extractor tests (~20 + 15 tests)

Read both files first. Mock external dependencies.

```bash
bun test src/services/receipt/receipt-summarizer.test.ts src/services/receipt/ai-extractor.test.ts
git commit -m "test(receipt): add summarizer and ai-extractor tests"
```

---

### Task A4-6: Final run — all Agent 4 tests

```bash
bun test src/services/receipt/
```
Expected: ~110 tests, all green.

---

## AGENT 5 — AI Layer + Bot Error Formatter (~130 tests)

**Files owned:** `ai/agent.test.ts`, expand `telegram-stream.test.ts`, `bot-error-formatter.ts` (production + test).

**Run tests with:** `bun test src/services/ai/agent.test.ts src/services/ai/telegram-stream.test.ts src/bot/bot-error-formatter.test.ts`

---

### Task A5-1: Bot error formatter via TDD (~30 tests)

This is pure TDD: write tests FIRST, then implement `bot-error-formatter.ts`.

- [ ] **Step 1: Write failing tests first**

```typescript
// src/bot/bot-error-formatter.test.ts
// TDD: write before implementing bot-error-formatter.ts

import { describe, it, expect } from 'bun:test';
import { formatErrorForUser } from './bot-error-formatter';
import { GoogleSheetsError, HuggingFaceError, AnthropicError, NetworkError, OAuthError, AppError } from '../errors';

describe('formatErrorForUser', () => {
  describe('GoogleSheetsError', () => {
    it('returns spreadsheet-related message', () => {
      const err = new GoogleSheetsError('API error', 'SHEETS_API_ERROR');
      const msg = formatErrorForUser(err);
      expect(msg.toLowerCase()).toMatch(/таблиц|sheets|google/);
    });

    it('includes suggestion to retry', () => {
      const err = new GoogleSheetsError('quota exceeded', 'QUOTA_EXCEEDED');
      const msg = formatErrorForUser(err);
      expect(msg.length).toBeGreaterThan(10);
    });
  });

  describe('OAuthError', () => {
    it('returns reconnect suggestion', () => {
      const err = new OAuthError('token expired', 'TOKEN_EXPIRED');
      const msg = formatErrorForUser(err);
      expect(msg).toContain('/reconnect');
    });
  });

  describe('NetworkError', () => {
    it('returns network problem message', () => {
      const err = new NetworkError('connection refused', 'CONNECTION_REFUSED');
      const msg = formatErrorForUser(err);
      expect(msg.toLowerCase()).toMatch(/сеть|соединени|интернет|недоступ/);
    });
  });

  describe('HuggingFaceError', () => {
    it('returns AI service message', () => {
      const err = new HuggingFaceError('rate limit', 'RATE_LIMIT');
      const msg = formatErrorForUser(err);
      expect(msg.toLowerCase()).toMatch(/ai|ии|сервис|попробуй/);
    });
  });

  describe('AnthropicError', () => {
    it('returns AI service unavailable message', () => {
      const err = new AnthropicError('rate limit', 'RATE_LIMIT_429');
      const msg = formatErrorForUser(err);
      expect(msg.toLowerCase()).toMatch(/ai|ии|сервис|попробуй/);
    });
  });

  describe('generic AppError', () => {
    it('returns generic error message', () => {
      const err = new AppError('something', 'UNKNOWN');
      const msg = formatErrorForUser(err);
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(5);
    });
  });

  describe('unknown error', () => {
    it('handles plain Error', () => {
      const msg = formatErrorForUser(new Error('oops'));
      expect(typeof msg).toBe('string');
    });

    it('handles non-Error value', () => {
      const msg = formatErrorForUser('string error' as unknown as Error);
      expect(typeof msg).toBe('string');
    });
  });

  it('never returns empty string', () => {
    const errors = [
      new GoogleSheetsError('x', 'y'),
      new OAuthError('x', 'y'),
      new NetworkError('x', 'y'),
      new HuggingFaceError('x', 'y'),
      new Error('x'),
    ];
    for (const err of errors) {
      expect(formatErrorForUser(err).length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run — expect ALL FAIL (function not defined)**

```bash
bun test src/bot/bot-error-formatter.test.ts
```
Expected: fail with "Cannot find module" or "formatErrorForUser is not a function".

- [ ] **Step 3: Implement bot-error-formatter.ts**

```typescript
// src/bot/bot-error-formatter.ts
// Translates typed service errors into user-friendly Telegram messages

import { AppError, GoogleSheetsError, HuggingFaceError, AnthropicError, NetworkError, OAuthError } from '../errors';

export function formatErrorForUser(error: unknown): string {
  if (error instanceof OAuthError) {
    return 'Авторизация истекла. Запусти /reconnect чтобы переподключить Google.';
  }
  if (error instanceof GoogleSheetsError) {
    return 'Не удалось обратиться к Google Таблицам. Попробуй ещё раз через минуту.';
  }
  if (error instanceof NetworkError) {
    return 'Нет соединения с сервисом. Проверь интернет и попробуй снова.';
  }
  if (error instanceof AnthropicError || error instanceof HuggingFaceError) {
    return 'AI-сервис временно недоступен. Попробуй позже.';
  }
  if (error instanceof AppError) {
    return 'Произошла ошибка. Попробуй ещё раз.';
  }
  if (error instanceof Error) {
    return 'Произошла непредвиденная ошибка.';
  }
  return 'Неизвестная ошибка.';
}
```

- [ ] **Step 4: Run — expect ALL PASS**

```bash
bun test src/bot/bot-error-formatter.test.ts
```
Expected: ~30 tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/bot/bot-error-formatter.ts src/bot/bot-error-formatter.test.ts
git commit -m "feat(bot): add bot-error-formatter via TDD — translates typed errors to Telegram messages"
```

---

### Task A5-2: Expand telegram-stream tests (+20 edge cases)

Read `src/services/ai/telegram-stream.test.ts` first (see what exists), then read `src/services/ai/telegram-stream.ts`.

**REQUIRED: Read `src/services/ai/telegram-stream.ts` fully before writing any test.** Find the class name, method names, and return types. Every test MUST have a real assertion — no empty bodies.

Add these missing edge cases (adapt method calls to actual API):

```typescript
// Add to existing telegram-stream.test.ts
// Read telegram-stream.ts first, then adapt these stubs to use real method names

describe('edge cases', () => {
  // Find the method that splits/truncates text (e.g. splitMessage, truncate, write)
  // Read telegram-stream.ts to find actual method name

  it('handles text at exactly the Telegram limit (4096 chars)', () => {
    const text = 'a'.repeat(4096);
    // After reading the source, call the appropriate method:
    // const chunks = splitForTelegram(text);
    // expect(chunks.every(c => c.length <= 4096)).toBe(true);
    // PLACEHOLDER — replace with real call after reading telegram-stream.ts
    expect(() => { /* real call here */ }).not.toThrow();
  });

  it('closes unclosed <b> tag when text is truncated mid-tag', () => {
    const text = '<b>' + 'x'.repeat(4100);
    // const result = truncateHtml(text, 4096); // adapt to real function name
    // expect(result).toContain('</b>');
    // expect(result).not.toMatch(/<b>[^<]*$/); // no unclosed bold at end
    expect(true).toBe(true); // REPLACE with real assertion after reading source
  });

  it('closes unclosed <i> tag at truncation boundary', () => {
    const text = '<i>' + 'x'.repeat(4100);
    // expect(truncated).toContain('</i>');
    expect(true).toBe(true); // REPLACE
  });

  it('handles deeply nested tags without throwing', () => {
    const text = '<b><i><code>' + 'x'.repeat(100) + '</code></i></b>';
    expect(() => { /* real call */ }).not.toThrow();
  });

  it('produces chunks all within 4096 char limit for very long text', () => {
    const text = 'x'.repeat(10000);
    // const chunks = splitForTelegram(text);
    // chunks.forEach(c => expect(c.length).toBeLessThanOrEqual(4096));
    expect(true).toBe(true); // REPLACE
  });

  it('handles unicode text without splitting multibyte characters', () => {
    const text = 'привет '.repeat(700); // ~4900 chars
    // const chunks = splitForTelegram(text);
    // chunks.forEach(c => expect(Buffer.byteLength(c, 'utf8')).toBeGreaterThan(0));
    expect(true).toBe(true); // REPLACE
  });
});
```

**⚠️ Every `expect(true).toBe(true)` placeholder MUST be replaced with real assertions after reading telegram-stream.ts. Empty/trivial tests that always pass are not acceptable.**

```bash
bun test src/services/ai/telegram-stream.test.ts
git commit -m "test(ai): expand telegram-stream edge cases — HTML closing, boundary splitting"
```

---

### Task A5-3: AI agent tests with spyOn (~50 tests)

**`mock.module()` is banned** (pipeline.ts:148). Use **`spyOn`** to intercept the Anthropic client.

- [ ] **Step 1: Read `src/services/ai/agent.ts` fully before writing any tests**

Find: (a) exact shape of `this.anthropic.messages.stream()` call — does it use `for await`, `.on()`, or `.text()`; (b) whether `db` is accessed in constructor or `run()`; (c) all error paths.

- [ ] **Step 2: Write agent.test.ts using spyOn**

```typescript
// src/services/ai/agent.test.ts
import { describe, it, expect, mock, beforeEach, afterEach, spyOn } from 'bun:test';
import Anthropic from '@anthropic-ai/sdk';
import { ExpenseBotAgent } from './agent';
import { createTestDb } from '../../test-utils/db';
import type { Database } from 'bun:sqlite';

// Fake streaming response — shape MUST match what agent.ts actually iterates
// (read agent.ts first to verify the exact API used)
function makeFakeStream(chunks: string[] = ['Hello', ' world']) {
  return {
    [Symbol.asyncIterator]: async function* () {
      for (const text of chunks) {
        yield { type: 'content_block_delta', delta: { type: 'text_delta', text } };
      }
      yield { type: 'message_stop' };
    },
    // Add other methods agent.ts may call (e.g. .finalMessage(), .text())
    // Read agent.ts to know which ones are used
  };
}

const mockBot = {
  api: {
    sendMessage: mock(() => Promise.resolve({ message_id: 1, chat: { id: 1 }, date: 0, text: '' })),
    editMessageText: mock(() => Promise.resolve({ message_id: 1, chat: { id: 1 }, date: 0, text: '' })),
  },
};

let db: Database;
let agent: ExpenseBotAgent;

beforeEach(() => {
  db = createTestDb(); // real in-memory SQLite
  agent = new ExpenseBotAgent('test-api-key', {
    chatId: 123,
    groupId: 1,
    userId: 10,
    db,
  });
});

afterEach(() => {
  mock.restore();
  db.close();
});

describe('ExpenseBotAgent', () => {
  describe('construction', () => {
    it('creates instance', () => {
      expect(agent).toBeTruthy();
    });
  });

  describe('run', () => {
    it('returns a string response', async () => {
      // Use spyOn on the private anthropic field (cast to access)
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      spyOn(anthropic.messages, 'stream').mockReturnValue(makeFakeStream() as unknown as ReturnType<typeof anthropic.messages.stream>);

      const result = await agent.run('What are my expenses?', [], mockBot as unknown as import('gramio').Bot);
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('calls Anthropic messages.stream with user message', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(makeFakeStream() as unknown as ReturnType<typeof anthropic.messages.stream>);

      await agent.run('How much did I spend?', [], mockBot as unknown as import('gramio').Bot);
      expect(streamSpy).toHaveBeenCalled();
    });

    it('handles empty conversation history', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      spyOn(anthropic.messages, 'stream').mockReturnValue(makeFakeStream() as unknown as ReturnType<typeof anthropic.messages.stream>);

      const result = await agent.run('Hello', [], mockBot as unknown as import('gramio').Bot);
      expect(result).toBeTruthy();
    });

    it('includes conversation history in Anthropic call', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const streamSpy = spyOn(anthropic.messages, 'stream').mockReturnValue(makeFakeStream() as unknown as ReturnType<typeof anthropic.messages.stream>);

      const history = [
        { id: 1, group_id: 1, user_id: 10, role: 'user' as const, content: 'Hi', created_at: '2026-01-01' },
        { id: 2, group_id: 1, user_id: 10, role: 'assistant' as const, content: 'Hello!', created_at: '2026-01-01' },
      ];
      await agent.run('Thanks', history, mockBot as unknown as import('gramio').Bot);

      const callArgs = streamSpy.mock.calls[0][0] as Anthropic.MessageStreamParams;
      expect(callArgs.messages.length).toBeGreaterThan(1); // history + new message
    });

    // TDD error handling: write FIRST (fail) → fix agent.ts → pass

    it('[TDD] wraps Anthropic 429 as AnthropicError', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const apiError = Object.assign(new Error('Rate limit exceeded'), { status: 429 });
      spyOn(anthropic.messages, 'stream').mockImplementation(() => { throw apiError; });

      // First: test FAILS because agent throws plain Error
      // Then: add try/catch in agent.ts that maps status:429 → AnthropicError
      const { AnthropicError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot)
      ).rejects.toBeInstanceOf(AnthropicError);
    });

    it('[TDD] wraps Anthropic 5xx as AnthropicError', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const serverErr = Object.assign(new Error('Internal server error'), { status: 500 });
      spyOn(anthropic.messages, 'stream').mockImplementation(() => { throw serverErr; });

      const { AnthropicError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot)
      ).rejects.toBeInstanceOf(AnthropicError);
    });

    it('[TDD] wraps timeout as NetworkError', async () => {
      const anthropic = (agent as unknown as { anthropic: Anthropic }).anthropic;
      const timeoutErr = Object.assign(new Error('Request timed out'), { code: 'ETIMEDOUT' });
      spyOn(anthropic.messages, 'stream').mockImplementation(() => { throw timeoutErr; });

      const { NetworkError } = await import('../../errors');
      await expect(
        agent.run('question', [], mockBot as unknown as import('gramio').Bot)
      ).rejects.toBeInstanceOf(NetworkError);
    });
  });
});
```

**Aim for ~50 tests.** After the skeleton above compiles and runs, add more cases:
- Tool call loop: mock stream that yields a `tool_use` block, verify `executeTool` is called
- MAX_TOOL_ROUNDS: mock 11 consecutive tool calls, verify loop exits cleanly
- Timeout (AGENT_TIMEOUT_MS): use `setSystemTime` from `bun:test` to advance clock
- `buildHistoryMessages`: verify role mapping user/assistant, trimming long history

```bash
bun test src/services/ai/agent.test.ts
git commit -m "test(ai): add agent tests — streaming, tool calls, error handling"
```

---

### Task A5-4: Final run — all Agent 5 tests

```bash
bun test src/services/ai/agent.test.ts src/services/ai/telegram-stream.test.ts src/bot/bot-error-formatter.test.ts
```
Expected: ~130 tests, all green.

---

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
