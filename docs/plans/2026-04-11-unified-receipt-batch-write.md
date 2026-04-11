# Unified receipt batch write

**Date:** 2026-04-11
**Author:** Alex + Claude
**Status:** In progress
**Branch:** `worktree-unified-receipt-batch-write`

## Why

Production bug (2026-04-11 07:39 UTC, user Alex, group -1003207640556): Mini App confirm of 70-item grocery receipt fails with `CONFIRM_FAILED`. Root cause: `src/web/miniapp-api.ts:511` loops `recorder.record()` per item → 70 × ~3 Google Sheets API calls = **~140 write requests** within 25s → Google Sheets API returns **429 RATE_LIMIT_EXCEEDED** (quota: 60 write/min/user).

30 expenses (rows 292–321) made it to the sheet before the quota hit; the remaining 40 are lost. User sees "Не удалось сохранить расходы" with no indication that half already wrote.

Deeper problem: **three parallel receipt-write code paths that diverged over time**:

1. `src/bot/services/expense-saver.ts::saveReceiptExpenses` — bot flow, groups by category, uses `appendExpenseRows()` batch. **Correct**, but ignores receipt date.
2. `src/web/miniapp-api.ts::/api/receipt/confirm` — Mini App flow, loops `recorder.record()`. **Broken** (causes the bug).
3. `src/services/expense-recorder.ts::recordBatch` — written for receipts, groups by category, but calls `appendExpenseRow()` (single-row, not batch), **dead code** (only referenced in tests).

Alex's words: *"тут сразу много проблема — дата чека не учтена, батча нет хотя мы его делали, группировки нет хотя она была, какой-то видимо отдельный путь записи появился для мини аппа хотя все должно быть унифицированно. надо чтобы и mini app и запись чека через бота одинаково писались в г таблицу."*

## Goals

1. **One write path** for receipts. Bot and Mini App must go through identical logic.
2. **Never hit the 60/min quota for a single receipt.** One receipt → one `appendExpenseRows()` call → one API write (plus optional formulas write).
3. **Receipt date from the receipt itself**, not `new Date()`. Fall back to today if receipt has no date.
4. **Full comment in DB and sheet** (`Чек: item1 (qty×price), item2, ...`). In Telegram messages — N+2 truncation: `item1, item2, item3 и ещё N` where N ≥ 3.
5. **Graceful 429 handling** with exponential backoff + jitter (Google's recommended pattern). If all retries fail, *no partial state* — atomic or nothing.
6. **No HTTP timeout cliff**: the confirm endpoint should not drop the connection mid-write. Remove/raise server-side timeouts so the only enforcement is the client.
7. **Comprehensive tests**: regression for the 70-item bug, unit for grouping, date handling, comment truncation, retry, dead-code removal.
8. **Clean up** the 30 orphan rows in Alex's spreadsheet.

## Architecture

### Single entry point: `recorder.recordReceipt()`

New method in `src/services/expense-recorder.ts`:

```ts
interface RecordReceiptInput {
  date: string;                  // ISO YYYY-MM-DD, from receipt or today
  items: RecordReceiptItem[];    // already have this type
  receiptId?: number;            // FK to receipts table (bot flow)
  receiptFileId?: string;        // Telegram file_id (Mini App flow)
}

interface RecordedReceipt {
  expenses: RecordExpenseResult[]; // one per category
  categoriesAffected: string[];
}

class ExpenseRecorder {
  async recordReceipt(
    groupId: number,
    userId: number,
    input: RecordReceiptInput,
  ): Promise<RecordedReceipt>;
}
```

Inside:

1. Group items by `item.category` → `Map<category, items[]>`.
2. For each category:
   - `totalAmount = sum(items.total)`
   - `currency = items[0].currency` (all items in a receipt share currency; will assert this)
   - `comment = buildReceiptComment(items)` — **full**, `"Чек: name (qtyxprice), ..."`
   - `eurAmount = convertToEUR(totalAmount, currency)`
   - `rate = getExchangeRate(currency)`
   - Build `ExpenseRowData` row
3. **One call to `appendExpenseRows(conn, spreadsheetId, rows)`**. Atomic: throws on failure.
4. DB transaction:
   - For each category → `expenses.create({ ..., receipt_id, receipt_file_id })`
   - For each item → `expense_items.create({ expense_id, name_ru, name_original, quantity, price, total })`
5. Returns created expenses + category list (for budget check).

**Return type intentionally uniform** — both callers just use `expenses[].id` and `categoriesAffected[]`.

### Bot flow: `saveReceiptExpenses` thins down

After refactor:

```ts
export async function saveReceiptExpenses(photoQueueId, groupId, userId) {
  const items = database.receiptItems.findConfirmedByPhotoQueueId(photoQueueId);
  if (items.length === 0) return;

  const receipt = database.receipts.findByPhotoQueueId(photoQueueId);
  const date = receipt?.date ?? format(new Date(), 'yyyy-MM-dd');

  const result = await recorder.recordReceipt(groupId, userId, {
    date,
    items: items.map(toRecordReceiptItem),
    receiptId: receipt?.id,
  });

  database.receiptItems.deleteProcessedByPhotoQueueId(photoQueueId);

  await sendMessage(buildReceiptSummaryMessage(result, items.length));

  for (const cat of result.categoriesAffected) {
    await checkBudgetLimit(groupId, cat, date);
  }
}
```

Everything else (grouping, sheet write, DB insert) moves into `recordReceipt`.

### Mini App flow: `/api/receipt/confirm` thins down

```ts
const result = await recorder.recordReceipt(ctx.internalGroupId, ctx.internalUserId, {
  date: body.date ?? format(new Date(), 'yyyy-MM-dd'),
  items: parsedExpenseInputs.map(toRecordReceiptItem),
  receiptFileId: typeof body.fileId === 'string' ? body.fileId : undefined,
});

emitForGroup(ctx.internalGroupId, 'expense_added');

return Response.json({ created: result.expenses.length });
```

The ad-hoc loop and the separate `UPDATE expenses SET receipt_file_id = ...` query go away.

### Mini App client: pass receipt date

`miniapp/src/tabs/Scanner.tsx`:
- After `scanQR()` or `uploadOCR()`, store `result.date` in state alongside items.
- In `handleConfirm()`, pass `date` in the confirm request body (not per item — one date for the whole receipt).
- API type: add top-level `date?: string` to `ConfirmExpensesRequest` (drop per-item date, it was never used).

### Dead code to remove

- `expense-recorder.ts::recordBatch` — replaced by `recordReceipt`, not called by anything in production.
- `recordBatch` tests — rewrite as `recordReceipt` tests.

### Sheets API: exponential backoff for 429

New utility in `src/services/google/sheets.ts`:

```ts
const GOOGLE_SHEETS_LIMITS = {
  writeRequestsPerMinutePerUser: 60,
  writeRequestsPerMinutePerProject: 300,
  readRequestsPerMinutePerUser: 60,
  maxBackoffMs: 32_000,        // per Google's recommendation
  maxRetries: 5,
};

async function withSheetsRetry<T>(fn: () => Promise<T>, label: string): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 0; attempt <= GOOGLE_SHEETS_LIMITS.maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (!isRateLimitError(err) || attempt === GOOGLE_SHEETS_LIMITS.maxRetries) throw err;
      const base = Math.min(1000 * 2 ** attempt, GOOGLE_SHEETS_LIMITS.maxBackoffMs);
      const jitter = Math.floor(Math.random() * 1000);
      logger.warn({ attempt, waitMs: base + jitter, label }, '[SHEETS] 429, backing off');
      await sleep(base + jitter);
      lastErr = err;
    }
  }
  throw lastErr;
}
```

Wrap `sheets.spreadsheets.values.append` and `sheets.spreadsheets.values.batchUpdate` inside `appendExpenseRowsImpl`. Also wrap `appendExpenseRowImpl` (single-row path used by `recorder.record()` for manual expenses).

`isRateLimitError`: check `err.code === 429 || err.response?.status === 429 || err?.message?.includes('Quota exceeded')`.

### HTTP timeouts

Check and document:
1. **Bun serve** (`src/web/index.ts` or wherever `Bun.serve` is configured) — default idle timeout is 10s, can be raised with `idleTimeout: 0` (no limit) or a large value. For `/api/receipt/confirm`, set to 120s at minimum.
2. **Caddy** — upstream timeouts. Bot runs behind Caddy reverse proxy. Default `transport_timeout` is 30s. Raise to 120s+ for the Mini App API path.

Caddyfile is on the server — cannot edit from CI. Document in `DEPLOY.md` and the PR description so Alex can update manually after merge.

### N+2 comment truncation for Telegram

New helper in `src/utils/receipt-display.ts`:

```ts
/**
 * Truncate receipt item list for Telegram display using N+2 rule.
 * Full comment stays in DB and sheet; only the user-facing message is trimmed.
 */
export function truncateItemsForDisplay(
  itemNames: string[],
  maxVisible: number = 3,
): string {
  if (itemNames.length <= maxVisible + 2) return itemNames.join(', ');
  const shown = itemNames.slice(0, maxVisible).join(', ');
  const hidden = itemNames.length - maxVisible;
  return `${shown} и ещё ${hidden} ${pluralize(hidden, 'позиция', 'позиции', 'позиций')}`;
}
```

Use in:
- `buildReceiptSummaryMessage` (the post-save "✅ Чек обработан!" message)
- Any other place that prints item list from receipt

Full comment (untruncated) stays in `expenses.comment`, sheet cell, and DB. Telegram display only.

## Files changed

| File | Change |
|------|--------|
| `src/services/expense-recorder.ts` | Add `recordReceipt()`. Remove `recordBatch()`. Extract `buildReceiptComment()` helper. |
| `src/bot/services/expense-saver.ts` | `saveReceiptExpenses` → call `recordReceipt`. Delete inline grouping logic. Use `receipt.date`. |
| `src/web/miniapp-api.ts` | `/api/receipt/confirm` → call `recordReceipt`. Delete loop. Accept top-level `date`. |
| `miniapp/src/api/receipt.ts` | `ConfirmExpensesRequest` type: add `date?`, drop per-item `date?`. |
| `miniapp/src/tabs/Scanner.tsx` | Store `scan.date` in state, pass in confirm. |
| `src/services/google/sheets.ts` | Add `withSheetsRetry()`, `GOOGLE_SHEETS_LIMITS` const, wrap append/batchUpdate calls. |
| `src/utils/receipt-display.ts` | NEW — `truncateItemsForDisplay`, `buildReceiptSummaryMessage`. |
| `src/web/index.ts` (or wherever Bun.serve is) | Raise `idleTimeout` for `/api/receipt/confirm`. |
| `src/services/expense-recorder.test.ts` | Rewrite `recordBatch` tests as `recordReceipt` tests. Add date, receiptId, receiptFileId, retry, comment truncation tests. |
| `src/web/miniapp-api.test.ts` | Add regression: 70 items in 1 category → 1 `appendExpenseRows` call. |
| `src/bot/services/expense-saver.test.ts` | Add test that `saveReceiptExpenses` uses `recordReceipt` with receipt date. |
| `src/services/google/sheets.test.ts` | Add 429 retry tests. |
| `src/utils/receipt-display.test.ts` | N+2 truncation tests. |
| `docs/plans/2026-04-11-unified-receipt-batch-write.md` | This file. |
| `DEPLOY.md` | Document Caddy timeout requirement. |

## Tests

### Regression (the actual bug)

```ts
it('writes 70 items in a single category with ONE appendExpenseRows call', async () => {
  const items = Array.from({ length: 70 }, (_, i) => ({
    name: `Item ${i}`,
    quantity: 1,
    price: 100,
    total: 100,
    currency: 'RSD',
    category: 'Продукты',
  }));

  const result = await recorder.recordReceipt(groupId, userId, {
    date: '2026-04-11',
    items,
  });

  expect(mockSheetWriter.appendExpenseRows).toHaveBeenCalledTimes(1);
  expect(mockSheetWriter.appendExpenseRows.mock.calls[0][2]).toHaveLength(1); // one category row
  expect(result.expenses).toHaveLength(1);
  expect(result.expenses[0].amount).toBe(7000); // 70 × 100
});
```

### Grouping by category

70 items → 3 categories → 3 sheet rows → 3 expenses → 70 expense_items.

### Date handling

`recordReceipt` with `date: '2026-04-09'` writes that date to sheet row and DB, not today.

### receiptFileId linking

`recordReceipt({ ..., receiptFileId: 'BAADBAAD123' })` sets `expenses.receipt_file_id = 'BAADBAAD123'` on all created expenses for that receipt.

### receiptId linking

Same but for bot flow.

### 429 retry

Mock sheets API to return 429 twice then success → `withSheetsRetry` retries 2×, final call succeeds. Assert backoff delays.

### 429 give up

Mock 429 for all retries → throws, no partial DB state.

### Comment truncation (N+2)

- 3 items → show all.
- 5 items → show all (5 ≤ 3 + 2).
- 6 items → show 3, "и ещё 3 позиции".
- 70 items → show 3, "и ещё 67 позиций".
- Plural forms: 1, 2, 5, 21, 101.

### Mini App endpoint regression

`/api/receipt/confirm` with 70 items → one `appendExpenseRows` spy hit, response 200, body `{ created: 1 }`.

### Bot endpoint regression

`saveReceiptExpenses(photoQueueId)` after populating `receipt_items` with 70 items → one `appendExpenseRows` spy hit.

### Dead code removal

`recordBatch` no longer exists; `RecorderApi` type excludes it.

## Rollout / risks

- **Cleanup of 30 orphan rows in Alex's spreadsheet**: one-time script using the live OAuth credentials. Expenses IDs 3847–3876 in DB + sheet rows 292–321. Two steps:
  1. DELETE from `expenses` WHERE id IN (3847..3876)
  2. Clear sheet rows 292–321 via `sheets.spreadsheets.values.clear`
- **Risk**: Mini App client needs to rebuild after `Scanner.tsx` + `receipt.ts` changes. Auto-deploy handles this — verify `miniapp/dist` rebuilds in CI.
- **Risk**: `recordReceipt` is a new public API — anyone using `recordBatch` breaks. Grep confirmed no production callers, only tests.
- **Risk**: `withSheetsRetry` adds latency to happy-path writes (none — only on retry). Make sure non-429 errors still throw immediately.
- **Risk**: Caddy upstream timeout — cannot be fixed from code. Must be updated on the server, document in PR.

## Non-goals (explicitly deferred)

- **Streaming confirmation** (SSE progress for large receipts). Current fix makes confirmation fast enough (1–3 seconds for 70 items) that progress UI is unnecessary.
- **Merge duplicate items before recording** (3× "Куриное бедро" → qty 3). The grouping path already sums them into one category row. Individual item display in `expense_items` stays granular.

## Additional optimization (done in this PR)

- **1 sheet API call per batch instead of 2**: the EUR formula is baked directly into the row at build time via `=INDIRECT("<amountCol>"&ROW())*INDIRECT("<rateCol>"&ROW())`. `INDIRECT + ROW()` is self-positioning, so the formula works wherever the row lands — no need to look up the absolute row number from the append response and issue a second `values.batchUpdate`. Trade-off: `INDIRECT` is a volatile function (recalculates on any sheet change), but at the ~few thousand rows an expense tracker accumulates this is immeasurable. Net effect: one sheet write per receipt regardless of row count — write quota doubled for the hot path.

## Acceptance criteria

- [ ] Bot and Mini App both call `recorder.recordReceipt()`. No other receipt-write code paths.
- [ ] 70-item receipt: 1 sheet row, 1 expense, 70 expense_items, 1–2 sheet API calls total.
- [ ] `expenses.date` for receipt expenses matches `receipts.date`, not today.
- [ ] `expenses.comment` contains full item list; Telegram message uses N+2 truncation.
- [ ] Mock 429 response retries with exponential backoff up to 32s + jitter, then throws.
- [ ] `recordBatch` removed from `expense-recorder.ts`.
- [ ] 30 orphan rows cleaned from Alex's spreadsheet.
- [ ] All new tests green. Existing tests unchanged or migrated.
- [ ] `bunx knip` clean. `codex exec review --uncommitted` clean.
