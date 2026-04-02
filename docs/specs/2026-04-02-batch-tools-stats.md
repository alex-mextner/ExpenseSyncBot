# Batch Tool Parameters & Pre-calculated Statistics

## Problem

AI calls `get_expenses` 7 times for a monthly summary request (each month + all + last_3_months), then tries to calculate totals in its head instead of using the calculator tool. This wastes tokens and produces inaccurate results.

## Solution

1. **Array parameters**: Tool parameters that accept `string` now also accept `string[]`. One call replaces many.
2. **Pre-calculated stats**: Summary responses include avg, median, min, max — no calculator needed.
3. **Smart diff/trend**: 2-value arrays get a diff comparison; 3+ get trend ranking.

Pattern borrowed from `hypercalendarbot` timezone tool: same parameter, behavior adapts by array length.

## Affected Tools

| Tool | Parameter | Array support |
|------|-----------|--------------|
| `get_expenses` | `period` | Per-period breakdown + overall stats |
| `get_expenses` | `category` | Multi-category filter (OR) |
| `get_budgets` | `month` | Per-month budget trends |
| `get_budgets` | `category` | Multi-category filter (OR) |
| `get_bank_transactions` | `period` | Concat transactions across periods |
| `get_bank_transactions` | `bank_name` | Multi-bank filter (OR) |
| `get_bank_transactions` | `status` | Multi-status filter (OR) |
| `find_missing_expenses` | `period` | Per-period missing counts |

## Stats Block

Every `summary_only` response includes:

```
=== Stats ===
count: 87
total: 275,304 RSD
avg: 3,164 RSD
median: 1,850 RSD
min: 120 RSD — "Хлеб" (Еда, 2025-11-05)
max: 45,000 RSD — "Ресторан НГ" (Развлечения, 2025-12-31)
```

Stats use display currency (group.default_currency) for consistent comparison.

## Diff (exactly 2 values)

```
=== Diff: 2026-02 → 2026-03 ===
total: +138,804 RSD (+25.1%)
count: +12 (+16.4%)
median: +200 RSD (+10.8%)
Biggest growth: Еда +45,077 RSD
Biggest drop: Жилье −82,198 RSD
```

## Trend (3+ values)

```
=== Trend (sorted by total desc) ===
1. 2025-11: 698,578 RSD (max)
2. 2026-03: 691,519 RSD
3. 2026-02: 552,715 RSD
4. 2026-01: 331,128 RSD
5. 2025-12: 317,719 RSD (min)
Range: 380,859 RSD
```

## System Prompt Changes

1. Median is preferred over avg for "typical" expense references.
2. Pre-calculated stats don't require a calculator call.
3. For multi-period comparisons, pass array of periods.

## Non-summary batch (period array, summary_only=false)

Expenses from all periods are concatenated, sorted by date desc, paginated as usual. Stats still included in header.
