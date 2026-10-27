# Streaming Receipt Scanner — Implementation Plan — Part 3/4: Tasks 6-7: client API, Scanner.tsx streaming UI

[← Back to index](../2026-04-02-streaming-receipt-scanner.md)

## Task 6: Client API Functions

**Files:**
- Create: `miniapp/src/api/receipt-stream.ts`
- Modify: `miniapp/src/api/receipt.ts`

New API functions for streaming flow + category fetching.

- [ ] **Step 6.1: Create receipt-stream.ts**

```typescript
// miniapp/src/api/receipt-stream.ts

/** Streaming receipt scan API — starts async scans and subscribes to SSE events */
import { ApiError, apiRequest } from './client';
import type { ReceiptItem } from './receipt';

// ── Types ───────────────────────────────────────────────────────────────────

export interface ScanPollResult {
  phase: string;
  url: string | null;
  items: ReceiptItem[];
  currency: string | null;
  fileId: string | null;
  error: string | null;
  errorCode: string | null;
}

export interface StreamCallbacks {
  onUrl?: (url: string, raw?: string) => void;
  onStatus?: (phase: string) => void;
  onItem?: (item: ReceiptItem) => void;
  onDone?: (result: { items: ReceiptItem[]; currency?: string; fileId?: string | null }) => void;
  onError?: (error: { message: string; code: string }) => void;
}

// ── API Functions ───────────────────────────────────────────────────────────

/** Start async QR scan — returns scanId immediately */
export async function startScan(groupId: number, qr: string): Promise<string> {
  const result = await apiRequest<{ scanId: string }>(`/api/receipt/scan?groupId=${groupId}`, {
    method: 'POST',
    body: JSON.stringify({ qr }),
  });
  return result.scanId;
}

/** Start async OCR scan — returns scanId immediately */
export async function startOcr(groupId: number, imageBlob: Blob): Promise<string> {
  const compressed = await compressImage(imageBlob);
  const formData = new FormData();
  formData.append('image', compressed, 'receipt.jpg');
  const result = await apiRequest<{ scanId: string }>(`/api/receipt/ocr?groupId=${groupId}`, {
    method: 'POST',
    body: formData,
  });
  return result.scanId;
}

/** Fetch group categories for combobox */
export async function fetchCategories(groupId: number): Promise<string[]> {
  const result = await apiRequest<{ categories: string[] }>(`/api/categories?groupId=${groupId}`);
  return result.categories;
}

/** Poll scan state (fallback when SSE fails) */
export async function pollScan(scanId: string): Promise<ScanPollResult> {
  const initData = window.Telegram?.WebApp?.initData ?? '';
  return apiRequest<ScanPollResult>(
    `/api/receipt/scan/${scanId}?initData=${encodeURIComponent(initData)}`,
  );
}

/**
 * Open SSE stream for scan results.
 * Returns cleanup function. Falls back to polling on SSE failure.
 */
export function streamScan(scanId: string, callbacks: StreamCallbacks): () => void {
  const initData = window.Telegram?.WebApp?.initData ?? '';
  const baseUrl = import.meta.env.VITE_API_URL ?? '';
  const url = `${baseUrl}/api/receipt/scan/${scanId}/stream?initData=${encodeURIComponent(initData)}`;

  let es: EventSource | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let closed = false;
  let pollBackoff = 3000;

  function startSSE() {
    es = new EventSource(url);

    es.addEventListener('url', (e: Event) => {
      if (closed) return;
      const me = e as MessageEvent;
      try {
        const data = JSON.parse(me.data);
        callbacks.onUrl?.(data.url, data.raw);
      } catch { /* ignore */ }
    });

    es.addEventListener('status', (e: Event) => {
      if (closed) return;
      const me = e as MessageEvent;
      try {
        const data = JSON.parse(me.data);
        callbacks.onStatus?.(data.phase);
      } catch { /* ignore */ }
    });

    es.addEventListener('item', (e: Event) => {
      if (closed) return;
      const me = e as MessageEvent;
      try {
        const item = JSON.parse(me.data) as ReceiptItem;
        callbacks.onItem?.(item);
      } catch { /* ignore */ }
    });

    es.addEventListener('done', (e: Event) => {
      if (closed) return;
      const me = e as MessageEvent;
      try {
        const data = JSON.parse(me.data);
        callbacks.onDone?.(data);
      } catch { /* ignore */ }
      cleanup();
    });

    // Named 'error' events from server come as MessageEvent with data.
    // Connection errors come as plain Event without data.
    es.addEventListener('error', (e: Event) => {
      if (closed) return;

      // Try server-sent error event first (MessageEvent with data)
      const me = e as MessageEvent;
      if (me.data) {
        try {
          const data = JSON.parse(me.data);
          if (data.message || data.code) {
            callbacks.onError?.(data);
            cleanup();
            return;
          }
        } catch { /* not a data event */ }
      }

      // Connection error — close SSE and fall back to polling
      es?.close();
      es = null;
      startPolling();
    });
  }

  function startPolling() {
    if (closed) return;

    async function poll() {
      if (closed) return;
      try {
        const state = await pollScan(scanId);

        if (state.url) callbacks.onUrl?.(state.url);

        if (state.phase === 'done') {
          callbacks.onDone?.({
            items: state.items,
            currency: state.currency ?? undefined,
            fileId: state.fileId,
          });
          cleanup();
          return;
        }
        if (state.phase === 'error') {
          callbacks.onError?.({
            message: state.error ?? 'Unknown error',
            code: state.errorCode ?? 'SCAN_FAILED',
          });
          cleanup();
          return;
        }

        pollBackoff = Math.min(pollBackoff * 1.5, 10_000);
        pollTimer = setTimeout(poll, pollBackoff);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'INIT_DATA_EXPIRED') {
          callbacks.onError?.({ message: 'Session expired', code: 'INIT_DATA_EXPIRED' });
          cleanup();
          return;
        }
        if (err instanceof ApiError && err.status === 404) {
          callbacks.onError?.({ message: 'Скан истёк, попробуй ещё раз', code: 'SCAN_EXPIRED' });
          cleanup();
          return;
        }
        pollTimer = setTimeout(poll, pollBackoff);
      }
    }

    poll();
  }

  function cleanup() {
    closed = true;
    es?.close();
    es = null;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = null;
    }
  }

  if (typeof EventSource !== 'undefined') {
    startSSE();
  } else {
    startPolling();
  }

  return cleanup;
}

// ── Image Compression ───────────────────────────────────────────────────────

async function compressImage(blob: Blob): Promise<Blob> {
  const MAX_SIDE = 1800;
  const QUALITY = 0.85;
  const MAX_SIZE = 2 * 1024 * 1024;

  const img = await createImageBitmap(blob);
  const { width, height } = img;
  let w = width;
  let h = height;

  if (w > MAX_SIDE || h > MAX_SIDE) {
    const ratio = Math.min(MAX_SIDE / w, MAX_SIDE / h);
    w = Math.round(w * ratio);
    h = Math.round(h * ratio);
  }

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    if (blob.size <= MAX_SIZE) return blob;
    throw new Error('Cannot compress image: OffscreenCanvas not supported');
  }

  ctx.drawImage(img, 0, 0, w, h);
  const compressed = await canvas.convertToBlob({ type: 'image/jpeg', quality: QUALITY });

  if (compressed.size > MAX_SIZE) {
    throw new Error('Image too large after compression');
  }

  return compressed;
}
```

- [ ] **Step 6.2: Update receipt.ts — remove scanQR and uploadOCR**

Remove `scanQR`, `uploadOCR`, and `compressImage` functions. Keep:
- `ReceiptItem`, `ScanResult`, `OcrResult`, `ConfirmExpense` types
- `confirmExpenses` function

- [ ] **Step 6.3: Commit**

```bash
git add miniapp/src/api/receipt-stream.ts miniapp/src/api/receipt.ts
git commit -m "feat(miniapp): add streaming scan API client with SSE + polling fallback"
```

---

## Task 7: Scanner.tsx — Streaming UI + Font Fix + Category Combobox

**Files:**
- Modify: `miniapp/src/tabs/Scanner.tsx`
- Modify: `miniapp/index.html`

Replace `loading` phase with `streaming`. Show progressive item rendering. Add scan line animation for OCR. Update session recovery with scanId dedup fix. Fix global font-family. Replace category text inputs with comboboxes.

- [ ] **Step 7.1: Fix global font-family in miniapp/index.html**

Telegram does NOT provide a `--tg-theme-font-family` CSS variable. Add system font stack to `<head>`:

```html
<style>
  * { box-sizing: border-box; }
  body, input, button, select, textarea {
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif;
  }
</style>
```

Add this before the `<script>` tag for `telegram-web-app.js`.

- [ ] **Step 7.2: Update types and imports in Scanner.tsx**

```typescript
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ApiError } from '../api/client';
import { confirmExpenses } from '../api/receipt';
import type { ReceiptItem } from '../api/receipt';
import { startScan, startOcr, streamScan, pollScan, fetchCategories } from '../api/receipt-stream';
```

Update Phase type:
```typescript
type Phase = 'idle' | 'url-input' | 'ocr-input' | 'streaming' | 'confirm' | 'done' | 'error';
```

Update SavedState:
```typescript
interface SavedState {
  phase: Phase;
  items: ReceiptItem[];
  fileId: string | null;
  currency: string;
  urlInput: string;
  scrollY: number;
  reloadAttempted: boolean;
  scanId?: string;
  groupId?: number;
  photoPreview?: string;
}
```

- [ ] **Step 7.3: Add new state variables**

```typescript
const [scanId, setScanId] = useState<string | null>(null);
const [streamUrl, setStreamUrl] = useState<string | null>(null);
const [photoPreview, setPhotoPreview] = useState<string | null>(null);
const [isOcrMode, setIsOcrMode] = useState(false);
const [categories, setCategories] = useState<string[]>([]);
const cleanupRef = useRef<(() => void) | null>(null);
```

- [ ] **Step 7.4: Add CSS keyframes injection + cleanup**

```typescript
useEffect(() => {
  const id = 'scanner-keyframes';
  if (document.getElementById(id)) return;
  const style = document.createElement('style');
  style.id = id;
  style.textContent = `
    @keyframes scanMove {
      0% { top: 5%; }
      100% { top: 95%; }
    }
    @keyframes pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.4; }
    }
    @keyframes slideIn {
      from { opacity: 0; transform: translateY(8px); }
      to { opacity: 1; transform: translateY(0); }
    }
  `;
  document.head.appendChild(style);
  return () => { document.getElementById(id)?.remove(); };
}, []);
```

- [ ] **Step 7.5: Fetch categories on mount**

```typescript
useEffect(() => {
  fetchCategories(groupId).then(setCategories).catch(() => {});
}, [groupId]);
```

- [ ] **Step 7.6: Cleanup SSE on unmount**

```typescript
useEffect(() => {
  return () => { cleanupRef.current?.(); };
}, []);
```

- [ ] **Step 7.7: Implement streaming scan flow**

Replace `handleQRDetected`:
```typescript
const handleQRDetected = useCallback(
  async (qrData: string) => {
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
    setPhase('streaming');
    setIsOcrMode(false);
    setItems([]);
    setStreamUrl(null);

    try {
      const id = await startScan(groupId, qrData);
      setScanId(id);
      sessionStorage.setItem('scanner_scanId', id);

      cleanupRef.current = streamScan(id, {
        onUrl: (url) => setStreamUrl(url),
        onItem: (item) => setItems((prev) => [...prev, item]),
        onDone: (result) => {
          setItems(result.items);
          setCurrency(result.currency ?? '');
          setFileId(result.fileId ?? null);
          setPhase('confirm');
          sessionStorage.removeItem('scanner_scanId');
        },
        onError: (error) => {
          if (error.code === 'INIT_DATA_EXPIRED') {
            handleExpiredSession('streaming');
            return;
          }
          setError(friendlyErrorMessage(new ApiError(0, error.message, error.code)));
          setPhase('error');
          sessionStorage.removeItem('scanner_scanId');
        },
      });
    } catch (e) {
      if (isExpiredSession(e)) {
        handleExpiredSession('idle');
        return;
      }
      setError(friendlyErrorMessage(e));
      setPhase('error');
    }
  },
  [groupId, handleExpiredSession],
);
```

Replace `handleFileUpload`:
```typescript
const handleFileUpload = useCallback(
  async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setPhase('streaming');
    setIsOcrMode(true);
    setItems([]);

    // Save photo preview as data URL for session recovery
    const reader = new FileReader();
    reader.onload = () => setPhotoPreview(reader.result as string);
    reader.readAsDataURL(file);

    try {
      const id = await startOcr(groupId, file);
      setScanId(id);
      sessionStorage.setItem('scanner_scanId', id);

      cleanupRef.current = streamScan(id, {
        onItem: (item) => setItems((prev) => [...prev, item]),
        onDone: (result) => {
          setItems(result.items);
          setCurrency(result.currency ?? '');
          setFileId(result.fileId ?? null);
          setPhase('confirm');
          setPhotoPreview(null);
          sessionStorage.removeItem('scanner_scanId');
        },
        onError: (error) => {
          if (error.code === 'INIT_DATA_EXPIRED') {
            handleExpiredSession('streaming');
            return;
          }
          setError(friendlyErrorMessage(new ApiError(0, error.message, error.code)));
          setPhase('error');
          sessionStorage.removeItem('scanner_scanId');
        },
      });
    } catch (uploadErr) {
      if (isExpiredSession(uploadErr)) {
        handleExpiredSession('ocr-input');
        return;
      }
      setError(friendlyErrorMessage(uploadErr));
      setPhase('error');
    }
  },
  [groupId, handleExpiredSession],
);
```

- [ ] **Step 7.8: Session recovery with dedup fix**

Key fix: when reconnecting from session recovery, do NOT append items from SSE if poll already returned them. Instead, poll first → if still processing, set items from poll, then open SSE with `onItem` that only appends items BEYOND the known count.

```typescript
async function reconnectToScan(id: string, photo?: string) {
  try {
    const state = await pollScan(id);
    setScanId(id);
    if (photo) setPhotoPreview(photo);

    if (state.phase === 'done') {
      setItems(state.items);
      setCurrency(state.currency ?? '');
      setFileId(state.fileId ?? null);
      setPhase('confirm');
      sessionStorage.removeItem('scanner_scanId');
      return;
    }

    if (state.phase === 'error') {
      setError(state.error ?? 'Ошибка сканирования');
      setPhase('error');
      sessionStorage.removeItem('scanner_scanId');
      return;
    }

    // Still processing — set known items, open SSE
    setPhase('streaming');
    setItems(state.items);
    if (state.url) setStreamUrl(state.url);
    setIsOcrMode(!!photo);

    // Track known item count to skip SSE replayed items
    const knownCount = state.items.length;
    let sseItemIndex = 0;

    cleanupRef.current = streamScan(id, {
      onUrl: (url) => setStreamUrl(url),
      onItem: (item) => {
        sseItemIndex++;
        // Skip replayed items that we already have from poll
        if (sseItemIndex <= knownCount) return;
        setItems((prev) => [...prev, item]);
      },
      onDone: (result) => {
        setItems(result.items); // Full replace on done
        setCurrency(result.currency ?? '');
        setFileId(result.fileId ?? null);
        setPhase('confirm');
        setPhotoPreview(null);
        sessionStorage.removeItem('scanner_scanId');
      },
      onError: (error) => {
        setError(error.message);
        setPhase('error');
        sessionStorage.removeItem('scanner_scanId');
      },
    });
  } catch {
    sessionStorage.removeItem('scanner_scanId');
    setPhase('idle');
  }
}
```

Update the mount useEffect:
```typescript
useEffect(() => {
  const saved = loadSavedState();
  if (!saved) {
    const orphanedScanId = sessionStorage.getItem('scanner_scanId');
    if (orphanedScanId) {
      reconnectToScan(orphanedScanId);
    }
    return;
  }

  setReloadAttempted(saved.reloadAttempted);
  setUrlInput(saved.urlInput);
  setCurrency(saved.currency);
  setFileId(saved.fileId);

  if (saved.scanId) {
    reconnectToScan(saved.scanId, saved.photoPreview);
  } else {
    setItems(saved.items);
    setPhase(saved.phase);
    requestAnimationFrame(() => window.scrollTo(0, saved.scrollY));
  }
}, []);
```

- [ ] **Step 7.9: Update handleExpiredSession to include scanId + photo**

```typescript
const handleExpiredSession = useCallback(
  (currentPhase: Phase) => {
    if (reloadAttempted) {
      setError('Сессия истекла. Закрой и открой Mini App заново.');
      setPhase('error');
      return;
    }
    cleanupRef.current?.();
    saveAndReload({
      phase: currentPhase,
      items,
      fileId,
      currency,
      urlInput,
      scanId: scanId ?? undefined,
      groupId,
      photoPreview: photoPreview ?? undefined,
    });
  },
  [reloadAttempted, items, fileId, currency, urlInput, scanId, photoPreview, groupId],
);
```

- [ ] **Step 7.10: Update resetToIdle**

```typescript
const resetToIdle = () => {
  cleanupRef.current?.();
  cleanupRef.current = null;
  setItems([]);
  setFileId(null);
  setCurrency('');
  setError('');
  setUrlInput('');
  setScanId(null);
  setStreamUrl(null);
  setPhotoPreview(null);
  setIsOcrMode(false);
  setPhase('idle');
  sessionStorage.removeItem('scanner_scanId');
};
```

- [ ] **Step 7.11: Implement streaming phase UI**

Replace the `loading` phase render:

```typescript
if (phase === 'streaming') {
  return (
    <div style={pageStyle}>
      {/* OCR: photo with scan line */}
      {isOcrMode && photoPreview && (
        <div style={scanOverlayStyle}>
          <img
            src={photoPreview}
            alt="Receipt"
            style={{
              width: '100%',
              borderRadius: 8,
              maxHeight: items.length > 0 ? 120 : 240,
              objectFit: 'cover',
              transition: 'max-height 0.3s ease',
            }}
          />
          {items.length === 0 && <div style={scanLineStyle} />}
        </div>
      )}

      {/* QR: shortened URL */}
      {!isOcrMode && streamUrl && (
        <div style={{
          fontSize: 13,
          color: 'var(--tg-theme-hint-color, #999)',
          marginBottom: 12,
          wordBreak: 'break-all',
        }}>
          🔗 {streamUrl}
        </div>
      )}

      {/* Status label with pulsing dot */}
      <div style={{ fontSize: 15, marginBottom: 12, display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={pulsingDotStyle} />
        {items.length === 0
          ? (isOcrMode ? 'Сканируем чек...' : 'Загружаем чек...')
          : 'Распознаём позиции...'}
      </div>

      {/* Items appearing one by one */}
      {items.map((item, i) => (
        <div key={i} style={{ ...streamingItemStyle, animation: 'slideIn 0.3s ease' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
            <span style={{ fontWeight: 600, whiteSpace: 'nowrap', marginLeft: 8 }}>
              {item.total.toLocaleString('ru-RU')}
            </span>
          </div>
          {item.qty > 1 && (
            <div style={{ fontSize: 13, color: 'var(--tg-theme-hint-color, #999)' }}>
              {item.qty} × {item.price.toLocaleString('ru-RU')}
            </div>
          )}
        </div>
      ))}

      {/* Skeleton placeholder */}
      <div style={skeletonStyle}>
        <div style={skeletonBarStyle} />
      </div>

      <button type="button" onClick={() => { cleanupRef.current?.(); resetToIdle(); }} style={{ ...secondaryBtnStyle, marginTop: 16 }}>
        Отмена
      </button>
    </div>
  );
}
```

- [ ] **Step 7.12: Redesign confirm phase with category combobox**

Replace the confirm phase render. Key changes:
- Category input → `<input>` with `<datalist>` (native combobox — works everywhere, no extra deps)
- Cleaner card layout with better visual hierarchy
- Total line at top

```typescript
if (phase === 'confirm') {
  const total = items.reduce((sum, it) => sum + it.total, 0);

  return (
    <div style={pageStyle}>
      <h3 style={{ margin: '0 0 4px' }}>Подтверди расходы</h3>
      <div style={{ fontSize: 14, color: 'var(--tg-theme-hint-color, #999)', marginBottom: 16 }}>
        {items.length} {pluralize(items.length, 'позиция', 'позиции', 'позиций')} · {total.toLocaleString('ru-RU')} {currency}
      </div>

      {/* Category datalist — shared by all items */}
      <datalist id="category-options">
        {categories.map((cat) => (
          <option key={cat} value={cat} />
        ))}
      </datalist>

      {items.map((item, i) => (
        <div
          key={i}
          style={{
            border: '1px solid var(--tg-theme-hint-color, rgba(128,128,128,0.2))',
            borderRadius: 10,
            padding: '10px 12px',
            marginBottom: 8,
          }}
        >
          {/* Row 1: name + total + delete */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              value={item.name}
              onChange={(e) => handleItemChange(i, 'name', e.target.value)}
              style={{ ...inputStyle, flex: 1, padding: '8px 10px', fontSize: 15 }}
            />
            <span style={{ fontWeight: 600, whiteSpace: 'nowrap', fontSize: 15 }}>
              {item.total.toLocaleString('ru-RU')}
            </span>
            <button
              type="button"
              onClick={() => handleRemoveItem(i)}
              style={{
                background: 'none',
                border: 'none',
                color: 'var(--tg-theme-hint-color, #999)',
                fontSize: 20,
                cursor: 'pointer',
                padding: '0 4px',
                lineHeight: 1,
              }}
            >
              ×
            </button>
          </div>
          {/* Row 2: category combobox + qty info */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 6 }}>
            <input
              list="category-options"
              value={item.category}
              onChange={(e) => handleItemChange(i, 'category', e.target.value)}
              placeholder="Категория"
              style={{
                ...inputStyle,
                flex: 1,
                padding: '6px 10px',
                fontSize: 14,
                color: 'var(--tg-theme-hint-color, #777)',
              }}
            />
            {item.qty > 1 && (
              <span style={{ fontSize: 13, color: 'var(--tg-theme-hint-color, #999)', whiteSpace: 'nowrap' }}>
                {item.qty} × {item.price.toLocaleString('ru-RU')}
              </span>
            )}
          </div>
        </div>
      ))}

      {items.length > 0 && (
        <button type="button" onClick={handleConfirm} style={{ ...btnStyle, marginTop: 8 }}>
          Записать {items.length} {pluralize(items.length, 'расход', 'расхода', 'расходов')}
        </button>
      )}
      <button type="button" onClick={resetToIdle} style={{ ...secondaryBtnStyle, marginTop: 8 }}>
        Отмена
      </button>
    </div>
  );
}
```

The native `<datalist>` provides:
- Dropdown with existing categories on tap/focus
- Filtering as user types
- Ability to enter new categories (not locked to list)
- Works in Telegram WebView (iOS Safari + Android Chrome)
- Zero dependencies

- [ ] **Step 7.13: Add new style constants**

Add alongside existing `pageStyle`, `btnStyle`, etc.:

```typescript
const scanOverlayStyle: React.CSSProperties = {
  position: 'relative',
  overflow: 'hidden',
  borderRadius: 8,
  marginBottom: 16,
};

const scanLineStyle: React.CSSProperties = {
  position: 'absolute',
  left: 0,
  right: 0,
  height: 3,
  background: 'linear-gradient(to right, transparent 0%, #4CAF50 30%, #4CAF50 70%, transparent 100%)',
  boxShadow: '0 0 8px rgba(76, 175, 80, 0.6)',
  animation: 'scanMove 2.5s ease-in-out infinite alternate',
  top: '5%',
};

const pulsingDotStyle: React.CSSProperties = {
  width: 8,
  height: 8,
  borderRadius: '50%',
  background: 'var(--tg-theme-button-color, #2196F3)',
  animation: 'pulse 1.5s ease-in-out infinite',
  flexShrink: 0,
};

const streamingItemStyle: React.CSSProperties = {
  border: '1px solid var(--tg-theme-hint-color, rgba(128,128,128,0.2))',
  borderRadius: 8,
  padding: 10,
  marginBottom: 6,
};

const skeletonStyle: React.CSSProperties = {
  border: '1px dashed var(--tg-theme-hint-color, rgba(128,128,128,0.2))',
  borderRadius: 8,
  padding: 14,
  marginBottom: 6,
};

const skeletonBarStyle: React.CSSProperties = {
  height: 14,
  borderRadius: 4,
  background: 'var(--tg-theme-hint-color, rgba(128,128,128,0.15))',
  animation: 'pulse 1.5s ease-in-out infinite',
  width: '60%',
};
```

- [ ] **Step 7.14: Build miniapp**

Run: `cd miniapp && npx vite build`
Expected: Build succeeds

- [ ] **Step 7.15: Typecheck**

Run: `bun run type-check`
Expected: No type errors

- [ ] **Step 7.16: Lint**

Run: `bun run lint`
Expected: No errors

- [ ] **Step 7.17: Commit**

```bash
git add miniapp/src/tabs/Scanner.tsx miniapp/src/api/receipt-stream.ts miniapp/src/api/receipt.ts miniapp/index.html
git commit -m "feat(miniapp): streaming scanner UI, font fix, category combobox"
```

---

