# Plan: Fix bank sync — transactions never arrive after initial setup

**Date:** 2026-05-21  
**Branch:** debug-bank-sync (worktree)

## Root Cause

`sync-service.ts:126` passes a **precise timestamp** as `fromDate` to every bank plugin:

```typescript
const fromDate = conn.last_sync_at ? new Date(conn.last_sync_at) : subDays(new Date(), 30);
// e.g. 2026-05-21T14:00:03.145Z — updated after every sync cycle
```

TBC-GE API groups transactions into **Georgia-day buckets** whose `date` field is set to the
Georgia midnight = UTC 20:00 of the *previous* day. For any sync running during today's business
hours, every "today" bucket has a date 4+ hours in the past relative to `fromDate`.

Two places break:

| Location | Code | Effect |
|---|---|---|
| `fetchHistoryV2:567` | `if (transactionByDate.date <= fromDate.getTime()) { stop = true }` | Stops pagination on page 1 |
| `convertTransactionsV2:310` | `if (date < fromDate) { continue }` | Filters out all bucket-dated transactions |

All StandardMovement entries in TBC-GE have `transactionDate: null, localTime: null`, so `dateNum`
always falls back to the bucket timestamp — which is then filtered by the converter.

**Evidence:**
- DB: last TBC-GE transaction 2026-05-05 (16 days ago), PriorBank 2026-04-08 (43 days ago)
- Server logs: 18 API requests per sync cycle → `transactions: 0`
- API response confirmed: all `StandardMovement`, bucket dates = UTC 20:00 prev day

## PriorBank

PriorBank's 43-day gap is a **separate investigation** — possibly the same issue (wider date
window accidentally helps), possibly not. Do not claim this plan fixes PriorBank. Investigate
PriorBank independently after this fix ships.

## Implementation Steps

### Step 1 — Add logging before scrape

In `sync-service.ts`, add a log line just before `await scrape(...)` that includes:
- `fromDate` (ISO string)
- `toDate` (ISO string)
- `bank` (conn.bank_name)
- `connectionId`

This was the operational gap that made root-cause investigation take hours.
Also add `rawTxCount` logging after scrape returns (before any filtering).

### Step 2 — Fix fromDate normalization

Replace line 126:

```typescript
// Before
const fromDate = conn.last_sync_at ? new Date(conn.last_sync_at) : subDays(new Date(), 30);

// After
const fromDate = conn.last_sync_at
  ? startOfDay(subDays(new Date(conn.last_sync_at), 1))
  : startOfDay(subDays(new Date(), 30));
```

Add `startOfDay` to the `date-fns` import on line 4.

**Why this works:**
- Georgia midnight for today = yesterday 20:00 UTC
- `startOfDay(yesterday) = yesterday 00:00 UTC`  
- `yesterday 20:00 UTC > yesterday 00:00 UTC` → passes both stop condition and converter filter
- `insertIgnore` on `external_id` handles any duplicate re-fetches safely

**Why "previous day" not "same day":**
- `startOfDay(lastSyncAt)` would give today 00:00 UTC — still before the Georgia midnight bucket
- We need to go back one more day

### Step 3 — Write tests

Add a test in `src/services/bank/sync-service.test.ts` that verifies:
- With `last_sync_at = '2026-05-21T14:00:00Z'`, `fromDate` = `2026-05-20T00:00:00.000Z`
- With `last_sync_at = null`, `fromDate` = today minus 30 days, floored to midnight

### Step 4 — Open draft upstream PR (separate, non-blocking)

After the sync-service fix is deployed, open a draft PR to `zenmoney/ZenPlugins` that fixes
`fetchHistoryV2:567` to use `< fromDate.getTime()` instead of `<=`. This is the right place
to fix it long-term, but the sync-service change is the practical fix.

## Verification

Ask user to run (requires TTY — OTP may be needed):

```
! bun scripts/zen-run.ts tbc-ge --env-prefix ZEN_TEST --from 2026-05-01
```

Expected: accounts returned, transactions list non-empty.

## Files Changed

- `src/services/bank/sync-service.ts` — fromDate fix + logging (Step 1+2)
- `src/services/bank/sync-service.test.ts` — tests (Step 3)
