/** In-memory scan state store with SSE pub/sub and 30-minute TTL cleanup */

import type { CurrencyCode } from '../config/constants';
import { createLogger } from '../utils/logger';

const logger = createLogger('scan-store');

// ── Types ───────────────────────────────────────────────────────────────────

export type ScanPhase = 'pending' | 'fetching' | 'processing' | 'extracting' | 'done' | 'error';

/** Client-facing receipt item (mapped from AIReceiptItem) */
export interface ScanReceiptItem {
  name: string;
  qty: number;
  price: number;
  total: number;
  category: string;
}

export interface ScanState {
  phase: ScanPhase;
  groupId: number;
  telegramGroupId: number;
  url?: string;
  rawUrl?: string;
  items: ScanReceiptItem[];
  currency?: CurrencyCode;
  fileId?: string | null;
  error?: string;
  errorCode?: string;
  createdAt: number;
}

// ── State ───────────────────────────────────────────────────────────────────

const scans = new Map<string, ScanState>();
const subscribers = new Map<string, Set<(event: string) => void>>();

const TTL_MS = 30 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 60 * 1000;
const MAX_SUBSCRIBERS = 5;

let cleanupTimer: ReturnType<typeof setInterval> | null = null;

// ── Public API ──────────────────────────────────────────────────────────────

/** Create a new scan entry, returns scanId */
export function createScan(groupId: number, telegramGroupId: number): string {
  const scanId = crypto.randomUUID();
  scans.set(scanId, {
    phase: 'pending',
    groupId,
    telegramGroupId,
    items: [],
    createdAt: Date.now(),
  });
  startCleanupIfNeeded();
  return scanId;
}

/** Get current scan state */
export function getScan(id: string): ScanState | undefined {
  return scans.get(id);
}

/** Merge patch into scan state and notify subscribers with a status event */
export function updateScan(id: string, patch: Partial<ScanState>): void {
  const state = scans.get(id);
  if (!state) return;
  Object.assign(state, patch);

  if (patch.phase) {
    emitEvent(id, 'status', { phase: patch.phase });
  }
}

/** Send SSE-formatted event to all subscribers of a scan */
export function emitEvent(id: string, event: string, data: unknown): void {
  const subs = subscribers.get(id);
  if (!subs || subs.size === 0) return;

  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const send of subs) {
    try {
      send(message);
    } catch {
      // Subscriber may have disconnected
    }
  }
}

/** Subscribe to SSE events for a scan. Returns unsubscribe fn, or null if max reached. */
export function subscribe(id: string, send: (event: string) => void): (() => void) | null {
  let subs = subscribers.get(id);
  if (!subs) {
    subs = new Set();
    subscribers.set(id, subs);
  }

  if (subs.size >= MAX_SUBSCRIBERS) return null;

  subs.add(send);

  return () => {
    const s = subscribers.get(id);
    if (s) {
      s.delete(send);
      if (s.size === 0) subscribers.delete(id);
    }
  };
}

// ── Cleanup ─────────────────────────────────────────────────────────────────

/** Remove scans older than TTL */
export function _cleanupExpired(): void {
  const now = Date.now();
  for (const [id, state] of scans) {
    if (now - state.createdAt > TTL_MS) {
      scans.delete(id);
      subscribers.delete(id);
      logger.info({ scanId: id }, 'Cleaned up expired scan');
    }
  }

  if (scans.size === 0 && cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

function startCleanupIfNeeded(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(_cleanupExpired, CLEANUP_INTERVAL_MS);
}

/** Reset all state — for tests only */
export function _resetForTests(): void {
  scans.clear();
  subscribers.clear();
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
