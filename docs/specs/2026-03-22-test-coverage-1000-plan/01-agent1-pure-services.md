# Test Coverage 1000 / TDD Error Handling — Implementation Plan — Part 1/4: File map, Agent 1: pure services + error architecture

[← Back to index](../2026-03-22-test-coverage-1000-plan.md)

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

