# Streaming Receipt Scanner

## Problem

Receipt scanning (QR + OCR) uses a synchronous HTTP request that can take 1–12 minutes when AI providers are slow. Phone sleep kills the TCP connection → "load failed" in miniapp. No progress indication — user stares at spinner.

## Solution

Async scan with SSE streaming. Server accepts request, returns scanId immediately, processes in background, streams events (URL, items, done/error) via SSE. Client shows progressive UI. Polling fallback for connection recovery after phone sleep.

## Server

### Scan Store (`src/web/scan-store.ts`)

In-memory `Map<string, ScanState>` with 5-minute TTL auto-cleanup (setInterval 60s).

```typescript
type ScanPhase = 'pending' | 'fetching' | 'processing' | 'extracting' | 'done' | 'error'

interface ScanState {
  phase: ScanPhase
  url?: string              // shortened URL extracted from QR (for display)
  rawUrl?: string           // original URL from QR
  items: MiniappReceiptItem[] // items parsed so far
  currency?: string
  fileId?: string | null    // Telegram file_id (OCR only)
  error?: string
  errorCode?: string
  createdAt: number
  subscribers: Set<(event: string) => void>  // SSE connections
}
```

Functions:
- `createScan(): string` — generates nanoid, stores initial state, returns scanId
- `getScan(id): ScanState | undefined`
- `updateScan(id, patch)` — merges patch, notifies all SSE subscribers
- `emitEvent(id, event, data)` — sends SSE-formatted message to all subscribers
- `subscribe(id, send): () => void` — adds SSE send fn, returns unsubscribe
- Cleanup loop: delete scans older than 5 minutes every 60 seconds

### API Endpoints

All three endpoints validate `X-Telegram-Init-Data` and group membership (same as current).

#### `POST /api/receipt/scan?groupId=X`

**Body:** `{ qr: string }`

**Response:** `202 { scanId: string }`

Kicks off background processing (fire-and-forget, no await):

1. `updateScan(scanId, { phase: 'fetching' })`
2. `fetchReceiptData(qr)` — get HTML
3. `emitEvent(scanId, 'url', { url: shortenUrl(qr) })` — emit URL for display
4. `updateScan(scanId, { phase: 'extracting', url: shortenUrl(qr) })`
5. `streamExtractExpenses(html, categories, (item) => { emitEvent(scanId, 'item', item) })` — streaming AI extraction, emits items as they parse
6. On completion: `updateScan(scanId, { phase: 'done', items, currency })` + `emitEvent(scanId, 'done', { items, currency })`
7. On error: `updateScan(scanId, { phase: 'error', error, errorCode })` + `emitEvent(scanId, 'error', { message, code })` + `notifyScanFailure(...)`

#### `POST /api/receipt/ocr?groupId=X`

**Body:** FormData with `image` field (JPEG, max 2MB)

**Response:** `202 { scanId: string }`

Background processing:

1. `updateScan(scanId, { phase: 'processing' })` + `emitEvent(scanId, 'status', { phase: 'processing' })`
2. Sharp resize image
3. Qwen vision OCR → extracted text
4. Upload original to Telegram → fileId
5. `updateScan(scanId, { phase: 'extracting', fileId })` + `emitEvent(scanId, 'status', { phase: 'extracting' })`
6. `streamExtractExpenses(text, categories, onItem)` — same streaming extraction
7. Same completion/error handling as QR scan

#### `GET /api/receipt/scan/:scanId/stream`

SSE endpoint. Auth via `initData` query param (same as existing dashboard SSE).

1. Find scan state — 404 if missing
2. Create ReadableStream, register subscriber
3. Immediately replay current state:
   - If url exists → emit `url` event
   - For each item already parsed → emit `item` event
   - If phase is `done` → emit `done` + close
   - If phase is `error` → emit `error` + close
4. Keep alive with ping every 15 seconds
5. Unsubscribe + cleanup on disconnect

This replay mechanism is what enables phone sleep recovery: client reconnects, gets all already-parsed items instantly, then continues receiving new ones.

#### `GET /api/receipt/scan/:scanId`

Polling fallback. Returns current state as JSON:

```json
{
  "phase": "extracting",
  "url": "suf.rs/v/vl?...",
  "items": [...],
  "currency": null,
  "fileId": null,
  "error": null
}
```

Used when EventSource fails and client needs to check if scan is done.

### SSE Event Protocol

```
event: url
data: {"url":"suf.rs/v/vl?...","raw":"https://suf.rs/v/vl?pib=..."}

event: status
data: {"phase":"extracting"}

event: item
data: {"name":"Редиска","qty":1,"price":94.99,"total":94.99,"category":"Еда"}

event: done
data: {"items":[...],"currency":"RSD","fileId":null}

event: error
data: {"message":"Не удалось распознать чек","code":"SCAN_FAILED"}

event: ping
data: {}
```

### AI Streaming Extractor

New function in `ai-extractor.ts`:

```typescript
async function streamExtractExpenses(
  text: string,
  existingCategories: string[],
  onItem: (item: MiniappReceiptItem) => void,
  options?: { maxRetries?: number }
): Promise<AIExtractionResult>
```

Changes from current `extractExpensesFromReceipt`:
- Uses `client.chatCompletionStream()` instead of `client.chatCompletion()`
- Adds `AbortSignal.timeout(30_000)` on each attempt
- Accumulates tokens into buffer
- Strips `<think>...</think>` blocks on the fly
- Uses partial JSON parser to detect complete items → calls `onItem` for each
- After stream ends, does final validation (same as current: category matching, field validation)
- Returns full result as before (for `done` event and state update)
- Retry logic unchanged (3 attempts per model, exponential backoff), but timeout prevents 2-min 504 hangs

The non-streaming `extractExpensesFromReceipt` stays for backward compatibility (used by photo-processor background worker for bot photo flow).

### Partial JSON Item Parser (`src/services/receipt/stream-json-parser.ts`)

Extracts complete items from a growing JSON string buffer:

```typescript
class StreamJsonParser {
  private buffer = ''
  private emittedCount = 0
  private insideThink = false

  /** Append new tokens, returns newly completed items */
  push(chunk: string): AIReceiptItem[]

  /** Get all items found so far */
  getAllItems(): AIReceiptItem[]
}
```

Algorithm:
1. Append chunk to buffer
2. Strip `<think>...</think>` blocks (handle partial: if `<think>` seen but no `</think>` yet, buffer and wait)
3. Strip markdown code fences (`` ```json `` / `` ``` ``)
4. Find `"items"` + `[` in buffer
5. Walk chars from array start, track brace depth
6. When `}` closes at depth 0 inside array → try `JSON.parse()` on that substring
7. If valid and has required fields (name_ru, total) → it's a complete item
8. Return items beyond `emittedCount`, update counter

Edge cases handled:
- Strings containing `{` or `}` — track quote state to skip string contents
- Escaped quotes `\"` inside strings — track escape state
- Partial `<think>` at end of chunk — buffer until closed
- Fix comma separators (`,` → `.` for decimals like `399,99`)

### URL Shortener

```typescript
function shortenReceiptUrl(urlOrQr: string): string
```

Logic:
1. Try `new URL(urlOrQr)` — if not a URL, return first 80 chars + `...`
2. Result: `hostname + pathname`
3. If has query string: append `?...`
4. If pathname longer than 30 chars: truncate middle with `...`
5. Total max ~60 chars

Example: `https://suf.rs/v/vl?pib=100049340&dp=02.04.2025&boi=...` → `suf.rs/v/vl?...`

### AbortSignal Timeout

Every HF `chatCompletionStream()` / `chatCompletion()` call gets:

```typescript
const controller = new AbortController()
const timeout = setTimeout(() => controller.abort(), 30_000)

await client.chatCompletionStream({
  ...,
  signal: controller.signal,
})
```

If HF inference client doesn't support `signal` parameter directly, wrap in `Promise.race` with `AbortSignal.timeout(30_000)`.

This reduces worst-case from 2 min × 3 retries × 2 models = 12 min → 30s × 3 × 2 = 3 min. In practice much less because a working model responds in 2–8 seconds.

## Client (Miniapp)

### API Functions (`miniapp/src/api/receipt.ts`)

```typescript
/** Start async QR scan, returns scanId */
export async function startScan(groupId: number, qr: string): Promise<{ scanId: string }>

/** Start async OCR scan, returns scanId */
export async function startOcr(groupId: number, imageBlob: Blob): Promise<{ scanId: string }>

/** Poll scan state (fallback) */
export async function pollScan(scanId: string): Promise<ScanPollResult>

/** Open SSE stream for scan results. Returns cleanup function. */
export function streamScan(
  scanId: string,
  callbacks: {
    onUrl?: (url: string) => void
    onStatus?: (phase: string) => void
    onItem?: (item: ReceiptItem) => void
    onDone?: (result: ScanResult) => void
    onError?: (error: { message: string; code: string }) => void
  }
): () => void
```

`streamScan` implementation:
1. Opens `EventSource` to `/api/receipt/scan/:scanId/stream?initData=...`
2. Registers event listeners for each event type
3. On `onerror`: close EventSource, start polling every 3 seconds
4. Polling: call `pollScan()`, check phase, replay any new items, stop when done/error
5. Returns cleanup function (close ES + clear poll interval)

### Scanner Phases

Current: `idle | url-input | ocr-input | loading | confirm | done | error`

New: `idle | url-input | ocr-input | streaming | confirm | done | error`

`loading` phase is removed — replaced by `streaming` which shows progress from the start.

### Streaming Phase UI

#### QR Scan Flow

```
┌─────────────────────────────┐
│  🔗 suf.rs/v/vl?...        │  ← shortened URL, appears first
│                              │
│  Распознаём позиции...      │  ← label with pulsing dot animation
│                              │
│  ┌─────────────────────────┐│
│  │ Редиска         94.99   ││  ← items appear one by one
│  │ 1 × 94.99              ││
│  └─────────────────────────┘│
│  ┌─────────────────────────┐│
│  │ Мороженое       369.98  ││
│  │ 2 × 184.99             ││
│  └─────────────────────────┘│
│  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐│
│  │ ░░░░░░░░░░░░░░░░░░░░░  ││  ← skeleton placeholder for next item
│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘│
└─────────────────────────────┘
```

New items slide in with CSS transition. Skeleton placeholder at bottom pulses while extracting.

#### OCR Flow

```
┌─────────────────────────────┐
│  ┌─────────────────────────┐│
│  │                         ││
│  │     [receipt photo]     ││
│  │  ━━━━━━━━━━━━━━━━━━━━━  ││  ← green scan line moving top→bottom
│  │                         ││
│  └─────────────────────────┘│
│                              │
│  Сканируем чек...           │  ← while phase is 'processing'
│                              │
│  ── then when items start ──│
│                              │
│  Распознаём позиции...      │  ← phase 'extracting'
│  ┌─────────────────────────┐│
│  │ Редиска         94.99   ││
│  └─────────────────────────┘│
└─────────────────────────────┘
```

Photo shown via `URL.createObjectURL(blob)` — stored in component state. As items start arriving, photo shrinks (CSS transition height) and items list grows below it.

#### Scan Line Animation (CSS)

```css
.scan-overlay {
  position: relative;
  overflow: hidden;
}

.scan-line {
  position: absolute;
  left: 0;
  right: 0;
  height: 3px;
  background: linear-gradient(to right, transparent 0%, #4CAF50 30%, #4CAF50 70%, transparent 100%);
  box-shadow: 0 0 8px rgba(76, 175, 80, 0.6);
  animation: scanMove 2.5s ease-in-out infinite;
}

@keyframes scanMove {
  0% { top: 5%; }
  100% { top: 95%; }
}
```

### Transition streaming → confirm

When `done` event arrives:
1. Remove skeleton placeholder
2. Remove scan line / photo shrinks to 0
3. Items become editable (category picker, delete button appear)
4. Total line + "Записать N расходов" button fades in
5. CSS transitions for smooth visual change (~300ms)

No items are re-rendered — the same list elements get additional controls.

### Session Recovery (Phone Sleep)

State persisted to `sessionStorage`:
- `scanId` — to reconnect
- `photoObjectUrl` — can't persist blobs, but scan line animation stops; if photo lost, just show items
- `items` — already received items (for instant render before SSE replay)

On component mount:
1. Check sessionStorage for active scan
2. If found: restore items to state, open SSE stream
3. SSE replay sends all items — deduplicate by index
4. Continue from where we left off

## Error Handling

| Scenario | Behavior |
|----------|----------|
| HF provider timeout (30s) | Retry next attempt, same model |
| All attempts on model fail | Try next model |
| All models fail | `error` event + admin notification + scan state = error |
| Network error during fetch | `error` event with FETCH_FAILED code |
| Phone sleep (SSE drops) | Client polls GET, reconnects SSE, replays items |
| Page reload | sessionStorage recovery, poll for current state |
| scanId expired (>5 min) | GET returns 404, client shows "Скан истёк, попробуй ещё раз" |
| Invalid auth (initData expired) | Existing session recovery flow (save + reload) |

## Migration

Old sync endpoints (`POST /api/receipt/scan` returning items directly, `POST /api/receipt/ocr` returning items + file_id) are **replaced** — not kept for backward compatibility. Miniapp and server deploy together via single push to main.

`POST /api/receipt/confirm` endpoint — **unchanged**. Still accepts items array, still writes expenses.

## Out of Scope

- Admin notification for individual provider failures (Novita down but V3 saves) — separate issue
- Changing AI model IDs (R1-0528 vs R1) — separate from streaming
- WebSocket transport — SSE is sufficient and simpler
- Persistent scan store (Redis/SQLite) — in-memory Map is fine for 5-min TTL, single process
