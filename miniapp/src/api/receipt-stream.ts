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
      } catch {
        /* ignore malformed data */
      }
    });

    es.addEventListener('status', (e: Event) => {
      if (closed) return;
      const me = e as MessageEvent;
      try {
        const data = JSON.parse(me.data);
        callbacks.onStatus?.(data.phase);
      } catch {
        /* ignore malformed data */
      }
    });

    es.addEventListener('item', (e: Event) => {
      if (closed) return;
      const me = e as MessageEvent;
      try {
        const item = JSON.parse(me.data) as ReceiptItem;
        callbacks.onItem?.(item);
      } catch {
        /* ignore malformed data */
      }
    });

    es.addEventListener('done', (e: Event) => {
      if (closed) return;
      const me = e as MessageEvent;
      try {
        const data = JSON.parse(me.data);
        callbacks.onDone?.(data);
      } catch {
        /* ignore malformed data */
      }
      cleanup();
    });

    // Named 'error' events from server arrive as MessageEvent with data.
    // Connection errors arrive as plain Event without data.
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
        } catch {
          /* not a data event — fall through to connection error handling */
        }
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

/** Client-side JPEG compression: long side <= 1800px, quality 0.85, max 2 MB */
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
