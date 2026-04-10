# Batch Tool Parameters & Pre-calculated Statistics

## Problem

AI calls `get_expenses` 7 times for a monthly summary request (each month + all + last_3_months), then tries to calculate totals in its head instead of using the calculator tool. This wastes tokens and produces inaccurate results.

## Solution

1. **Array parameters**: Tool parameters that accept `string` now also accept `string[]`. One call replaces many.
2. **Pre-calculated stats**: Summary responses include avg, median, min, max — no calculator needed.
3. **Smart diff/trend**: 2-value arrays get a diff comparison; 3+ get trend ranking.

Pattern borrowed from `hypercalendarbot` timezone tool: same parameter, behavior adapts by array length.

## Affected Tools

### Read tools (array filters)

| Tool | Parameter | Array support |
|------|-----------|--------------|
| `get_expenses` | `period` | Per-period breakdown + overall stats |
| `get_expenses` | `category` | Multi-category filter (OR) |
| `get_budgets` | `month` | Per-month budget trends |
| `get_budgets` | `category` | Multi-category filter (OR) |
| `get_bank_transactions` | `period` | Concat transactions across periods |
| `get_bank_transactions` | `bank_name` | Multi-bank filter (OR) |
| `get_bank_transactions` | `status` | Multi-status filter (OR) |
| `get_bank_balances` | `bank_name` | Multi-bank filter (OR) |
| `find_missing_expenses` | `period` | Per-period missing counts |

### Write tools (batch operations)

Write tools accept either a single object (current behavior) or an array of objects. Each item in the array is executed independently. Response is a per-item result list.

| Tool | Batch parameter | Use case |
|------|----------------|----------|
| `set_budget` | array of `{category, amount, currency?, month?}` | "Set budgets: Еда 50к, Транспорт 10к, Развлечения 20к" |
| `delete_budget` | `category: string \| string[]` | "Delete budgets for Еда, Транспорт, Развлечения" |
| `add_expense` | array of `{amount, currency?, category, comment?, date?}` | "Record: кофе 300, обед 800, такси 500" |
| `delete_expense` | `expense_id: number \| number[]` | "Delete expenses 45, 46, 47" |
| `manage_category` | `name: string \| string[]` | "Create categories: Еда, Транспорт, Развлечения" |
| `manage_recurring_pattern` | `pattern_id: number \| number[]` | "Pause patterns 1, 2, 3" |

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

---

## Write Tool Batch Details

### Schema pattern

Every write tool keeps backward compatibility: single-object input works as before. Array input triggers batch mode.

**Option A — top-level array parameter** (for tools with a single "target" field):

```
delete_budget:   { category: "Еда" }                     → single
delete_budget:   { category: ["Еда", "Транспорт"] }      → batch (same month)

delete_expense:  { expense_id: 45 }                       → single
delete_expense:  { expense_id: [45, 46, 47] }             → batch

manage_category: { action: "create", name: "Еда" }       → single
manage_category: { action: "create", name: ["Еда", "Транспорт"] } → batch (same action)

manage_recurring_pattern: { pattern_id: 1, action: "pause" }       → single
manage_recurring_pattern: { pattern_id: [1, 2, 3], action: "pause" } → batch (same action)
```

**Option B — `items` array** (for tools where each item has multiple independent fields):

```
set_budget: { category: "Еда", amount: 50000 }           → single (current)
set_budget: { items: [
  { category: "Еда", amount: 50000 },
  { category: "Транспорт", amount: 10000, currency: "EUR" },
  { category: "Развлечения", amount: 20000 }
] }                                                        → batch

add_expense: { amount: 300, category: "Еда" }             → single (current)
add_expense: { items: [
  { amount: 300, category: "Еда", comment: "кофе" },
  { amount: 800, category: "Еда", comment: "обед" },
  { amount: 500, category: "Транспорт", comment: "такси" }
] }                                                        → batch
```

When `items` is present, top-level fields are ignored. This avoids ambiguity.

### Batch response format

```
=== Batch result (3/3 succeeded) ===
✓ set_budget: Еда — 50,000 RSD
✓ set_budget: Транспорт — 10,000 EUR
✓ set_budget: Развлечения — 20,000 RSD
```

On partial failure:

```
=== Batch result (2/3 succeeded) ===
✓ set_budget: Еда — 50,000 RSD
✗ set_budget: Жильё — category not found
✓ set_budget: Развлечения — 20,000 RSD
```

Each item is independent — one failure doesn't abort the rest. No transaction rollback (matches current behavior where sequential tool calls don't roll back either).

### Batch limits

- Max **20 items** per batch call. Prevents runaway loops from hallucinated AI input.
- Over 20 → tool returns error, nothing executed.

### Tools NOT batched

| Tool | Why |
|------|-----|
| `sync_from_sheets` | Global operation, no per-item semantics |
| `sync_budgets` | Same — global |
| `calculate` | Already handles complex expressions; batching adds nothing |
| `set_custom_prompt` | Single shared resource per group |
| `send_feedback` | One message per intent |
| `render_table` | Single render per call (Telegram message = 1 image) |
| `get_recurring_patterns` | No parameters, returns everything |
| `get_categories` | No parameters, returns everything |
| `get_group_settings` | No parameters |
| `get_exchange_rates` | No parameters |

### Token savings estimate

Typical "set up budgets" conversation today:

```
User: "поставь бюджеты: Еда 50к, Транспорт 10к, Развлечения 20к, Жильё 100к, Здоровье 15к"
AI: 5× set_budget tool calls = 5 request/response cycles
```

With batch: 1 call. ~4× fewer tool-call tokens, ~5× fewer round-trips in the agent loop.

Same pattern for `add_expense` — users often dictate 3-5 expenses at once.

### System prompt additions

```
For batch operations:
- set_budget and add_expense accept an `items` array for multiple operations in one call.
- delete_budget, delete_expense, manage_category, manage_recurring_pattern accept arrays
  in their primary field (category, expense_id, name, pattern_id).
- Max 20 items per batch. Prefer batch over sequential calls.
- Each item is independent — partial failures don't abort the batch.
```
