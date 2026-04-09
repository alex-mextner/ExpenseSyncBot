# Streaming Receipt Scanner

## Problem

Receipt scanning (QR + OCR) uses a synchronous HTTP request that can take 1–12 minutes when AI providers are slow. Phone sleep kills the TCP connection → "load failed" in miniapp. No progress indication — user stares at spinner.

## Solution

Async scan with SSE streaming. Server accepts request, returns scanId immediately, processes in background, streams events (URL, items, done/error) via SSE. Client shows progressive UI. Polling fallback for connection recovery after phone sleep.

## Server

### Scan Store (`src/web/scan-store.ts`)

In-memory `Map<string, ScanState>` with 30-minute TTL auto-cleanup (setInterval 60s).

```typescript
type ScanPhase = 'pending' | 'fetching' | 'processing' | 'extracting' | 'done' | 'error'

interface ScanState {
  phase: ScanPhase
  groupId: number           // internal group ID — for auth on SSE/poll endpoints
  telegramGroupId: number   // Telegram group ID — for auth context resolution on SSE/poll
  url?: string              // shortened URL extracted from QR (for display)
  rawUrl?: string           // original URL from QR
  items: ScanReceiptItem[]  // items parsed so far (mapped to client-facing format)
  currency?: CurrencyCode
  fileId?: string | null    // Telegram file_id (OCR only)
  error?: string
  errorCode?: string
  createdAt: number
}
```

**Item type mapping:** AI extractor returns `AIReceiptItem` (with `name_ru`, `quantity`, `possible_categories`). The scan store and SSE events use the client-facing `ScanReceiptItem` type (`name`, `qty`, no `possible_categories`). The mapping (`name_ru → name`, `quantity → qty`) happens inside the processing pipeline before items are stored in ScanState or emitted via SSE. Both QR and OCR flows use the same mapping. This keeps the client simple — no post-processing needed.

**SSE pub/sub** is managed separately from data: `Map<string, Set<(event: string) => void>>` alongside the state map. This avoids mixing serializable data with function references.

Functions:
- `createScan(groupId: number, telegramGroupId: number): string` — generates `crypto.randomUUID()`, stores initial state with both IDs, returns scanId
- `getScan(id): ScanState | undefined`
- `updateScan(id, patch)` — merges patch, auto-emits `status` event when `phase` changes (except `done`/`error` which have their own events)
- `emitEvent(id, event, data)` — sends SSE-formatted message to all subscribers
- `subscribe(id, send): () => void` — adds SSE send fn, returns unsubscribe. Max 5 subscribers per scanId (rejects with 429 beyond that).
- Cleanup loop: delete scans older than 30 minutes every 60 seconds

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

**Body:** FormData with `image` field (JPEG, max 2MB). Client compresses image before upload: long side ≤ 1800px, JPEG quality 0.85, max 2 MB (uses `OffscreenCanvas` + `createImageBitmap`).

**Response:** `202 { scanId: string }`

Background processing — same streaming pattern as QR scan, but with vision models:

1. `updateScan(scanId, { phase: 'processing' })` — auto-emits `status` event
2. Sharp resize image (1800px, JPEG 85%)
3. Upload original image to Telegram via `bot.api.sendPhoto()` → extract `fileId` from response. Fire-and-forget: log warning on failure, continue with `fileId: null`
4. `updateScan(scanId, { phase: 'extracting', fileId })`
5. `streamExtractFromImage(imageBuffer, categories, onItem)` — streaming VLM extraction:
   - Same KIE prompt as QR scan (extract items with names, categories, prices as JSON)
   - Model chain: glm-5v-turbo (Z.ai direct API, `api.z.ai/api/paas/v4/chat/completions`) → Qwen2.5-VL-72B (HF default provider) as fallback
   - Z.ai API key: `ANTHROPIC_API_KEY` env var (shared with other Z.ai services)
   - Image passed as base64 data URL in chat message `image_url` content part
   - Uses `StreamJsonParser` + `stream: true` — items appear one by one, same as QR flow
   - Each item emitted as SSE `item` event immediately
   - Returns full `AIExtractionResult` for `done` event
6. On completion: `updateScan(scanId, { phase: 'done', items, currency })` + `emitEvent('done', { items, currency, fileId })`
7. On error: same as QR scan

#### `GET /api/receipt/scan/:scanId/stream`

SSE endpoint. Auth via `initData` query param (same as existing dashboard SSE).

1. Find scan state — 404 if missing
2. Verify that the authenticated user belongs to `scanState.groupId` — 403 if not
3. Create ReadableStream, register subscriber (reject with 429 if already at 5 subscribers)
4. Immediately replay current state:
   - If url exists → emit `url` event
   - For each item in `state.items` → emit `item` event
   - If phase is `done` → emit `done` + close
   - If phase is `error` → emit `error` + close
5. Keep alive with ping every 15 seconds
6. Unsubscribe + cleanup on disconnect

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

#### `GET /api/categories?groupId=X`

Returns category names for the group. Used by client to populate category combobox in confirm phase.

**Response:** `200 { categories: string[] }`

Auth via `X-Telegram-Init-Data` header (same as other endpoints).

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

### AI Streaming Functions

Two streaming functions, same pattern: `chatCompletionStream()` with `StreamJsonParser`, fallback model chain.

#### `streamExtractExpenses` (QR — text → items with categories)

```typescript
async function streamExtractExpenses(
  receiptData: string,
  existingCategories: string[],
  onItem: (item: ScanReceiptItem) => void,
  options?: { maxRetries?: number; categoryExamples?: Map<string, CategoryExample[]> }
): Promise<AIExtractionResult>
```

- Input: text (HTML or plain) from `fetchReceiptData()`
- Models: DeepSeek-R1 (novita) → DeepSeek-V3 (fireworks-ai)
- `onItem` receives mapped `ScanReceiptItem` (name_ru → name, quantity → qty)
- 3 attempts per model, 30s `AbortSignal` timeout per attempt

#### `streamExtractFromImage` (OCR — image → items with categories)

```typescript
async function streamExtractFromImage(
  imageBuffer: Buffer,
  existingCategories: string[],
  onItem: (item: ScanReceiptItem) => void,
  options?: { maxRetries?: number; categoryExamples?: Map<string, CategoryExample[]> }
): Promise<AIExtractionResult>
```

- Input: JPEG buffer, passed as base64 data URL in `image_url` content part
- Models: glm-5v-turbo (Z.ai direct, `api.z.ai/api/paas/v4/chat/completions`) → Qwen2.5-VL-72B (HF default)
- Z.ai auth: `ANTHROPIC_API_KEY` env var, OpenAI-compatible chat completion format
- Same KIE prompt, same `StreamJsonParser`, same `onItem` callback as QR flow
- Items streamed with categories — unified behavior with QR scan

The non-streaming `extractExpensesFromReceipt` stays for backward compatibility (photo-processor bot flow). It should also get the 30s `AbortSignal` timeout.

Algorithm:
1. Append chunk to buffer
2. Strip `<think>...</think>` blocks (handle partial: if `<think>` seen but no `</think>` yet, buffer and wait)
3. Strip markdown code fences (`` ```json `` / `` ``` ``)
4. Find `"items"` + `[` in buffer
5. Walk chars from array start, track brace depth
6. When `}` closes at depth 0 inside array → try `JSON.parse()` on that substring
7. If valid and has required fields for current mode → it's a complete item
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

### API Functions (`miniapp/src/api/receipt-stream.ts`)

```typescript
/** Start async QR scan, returns scanId */
export async function startScan(groupId: number, qr: string): Promise<string>

/** Start async OCR scan, returns scanId. Client compresses image before upload. */
export async function startOcr(groupId: number, imageBlob: Blob): Promise<string>

/** Fetch group categories for combobox */
export async function fetchCategories(groupId: number): Promise<string[]>

/** Poll scan state (fallback) */
export async function pollScan(scanId: string): Promise<ScanPollResult>

/** Open SSE stream for scan results. Returns cleanup function. */
export function streamScan(
  scanId: string,
  callbacks: {
    onUrl?: (url: string, raw?: string) => void
    onStatus?: (phase: string) => void
    onItem?: (item: ReceiptItem) => void
    onDone?: (result: { items: ReceiptItem[]; currency?: string; fileId?: string | null }) => void
    onError?: (error: { message: string; code: string }) => void
  }
): () => void
```

`streamScan` implementation:
1. Opens `EventSource` to `/api/receipt/scan/:scanId/stream?initData=...`
2. Registers event listeners for each event type (url, status, item, done, error)
3. On `onerror`: close EventSource, start polling with exponential backoff (`×1.5` starting at 3s, cap at 10s: 3 → 4.5 → 6.75 → 10)
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

Same streaming pattern as QR — items appear one by one with categories.

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
│  Распознаём позиции...      │  ← phase 'extracting', items stream from VLM
│  ┌─────────────────────────┐│
│  │ Редиска         94.99   ││  ← items appear one by one with categories
│  │ 1 × 94.99   [Еда]      ││
│  └─────────────────────────┘│
│  ┌─────────────────────────┐│
│  │ Мороженое       369.98  ││
│  │ 2 × 184.99  [Еда]      ││
│  └─────────────────────────┘│
│  ┌ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┐│
│  │ ░░░░░░░░░░░░░░░░░░░░░  ││  ← skeleton placeholder
│  └ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ─ ┘│
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
  animation: scanMove 2.5s ease-in-out infinite alternate;
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

### Connection Recovery

Two scenarios:

**SSE drop without reload (phone sleep):**
1. EventSource `onerror` fires
2. Client polls `GET /api/receipt/scan/:scanId` once to get current state
3. If `done` → go straight to confirm with full items
4. If `error` → show error
5. If still processing → reconnect SSE (replay mechanism sends all items parsed so far)

**Page reload (Telegram killed WebView, INIT_DATA_EXPIRED recovery, etc.):**

Extends the existing `INIT_DATA_EXPIRED` session recovery pattern in Scanner.tsx. Currently it saves `{ phase, items, fileId, currency, urlInput, scrollPosition }` to sessionStorage key `scanner_saved_state`, sets `reloadAttempted` flag to prevent infinite loops, reloads page for fresh initData, then restores state on mount.

New flow adds `scanId` to the saved state:

1. On scan start: save `{ scanId, groupId }` to sessionStorage (alongside existing fields)
2. On any `INIT_DATA_EXPIRED` error (SSE, poll, or confirm): save full state + scanId, reload (same as current pattern)
3. On mount, if sessionStorage has `scanId`:
   - Poll `GET /api/receipt/scan/:scanId` with fresh initData
   - If `done` → restore full items + currency, go to `confirm` phase
   - If still processing → open SSE stream (replay sends all parsed items), enter `streaming` phase
   - If 404 (scan expired on server) → clear sessionStorage, show `idle`
   - If `error` → show error
4. `reloadAttempted` flag logic — **unchanged** from current implementation (prevents loops when initData keeps expiring)
5. On `done`/`error`/confirm success → clear scanId from sessionStorage
6. Photo preview on reload: convert blob to base64 data URL via `FileReader.readAsDataURL()` and save to sessionStorage alongside scanId. After JPEG compression the image is ~200KB, base64 adds ~33% → ~270KB, well within sessionStorage 5MB limit. On mount, if data URL present, show it as photo preview during streaming recovery.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| HF provider timeout (30s) | Retry next attempt, same model |
| All attempts on model fail | Try next model |
| All models fail (QR or OCR) | `error` event + admin notification + scan state = error |
| Provider billing exhausted | `error` event with CREDITS_EXHAUSTED code + admin notification |
| Telegram file upload fails (OCR) | Log warning, continue with `fileId: null` — non-blocking |
| Network error during fetch | `error` event with FETCH_FAILED code |
| Phone sleep (SSE drops) | Client polls GET, reconnects SSE, replays items |
| Page reload | sessionStorage recovery, poll for current state |
| scanId expired (>30 min) | GET returns 404, client shows "Скан истёк, попробуй ещё раз" |
| Invalid auth (initData expired) | Existing session recovery flow (save + reload) |

## Migration

Old sync endpoints (`POST /api/receipt/scan` returning items directly, `POST /api/receipt/ocr` returning items + file_id) are **replaced** — not kept for backward compatibility. Miniapp and server deploy together via single push to main.

`POST /api/receipt/confirm` endpoint — **unchanged**. Still accepts items array, still writes expenses.

## Out of Scope

- Admin notification for individual provider failures (Novita down but V3 saves) — separate issue
- Changing AI model IDs (R1-0528 vs R1) — separate from streaming
- WebSocket transport — SSE is sufficient and simpler
- Persistent scan store (Redis/SQLite) — in-memory Map is fine for 30-min TTL, single process
