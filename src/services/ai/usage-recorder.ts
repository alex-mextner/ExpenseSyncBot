/**
 * Persists AI usage events off the request path. A storage failure is logged and never reaches the
 * caller: recording must not change or delay the answer a user is waiting for.
 */
import { database } from '../../database';
import type { AiUsageEventInput } from '../../database/repositories/ai-usage-events.repository';
import { createLogger } from '../../utils/logger';

const logger = createLogger('ai-usage');

/** Inserts still queued behind the current event-loop turn. */
const pending = new Set<Promise<void>>();

/**
 * Queue events for storage and return at once. The insert runs on a later event-loop turn (after
 * the caller has continued with its answer); an error — missing table, locked DB — is logged with
 * logger.warn and dropped.
 */
export function recordAiUsage(events: readonly AiUsageEventInput[]): void {
  if (events.length === 0) return;
  const { promise, resolve } = Promise.withResolvers<void>();
  pending.add(promise);
  setImmediate(() => {
    try {
      database.aiUsageEvents.recordMany(events);
    } catch (err) {
      logger.warn({ err }, '[AI_USAGE] Failed to store usage events');
    } finally {
      pending.delete(promise);
      resolve();
    }
  });
}

/** Resolves once every queued insert has run (tests and one-shot scripts that read the rows back). */
export async function flushAiUsageRecording(): Promise<void> {
  await Promise.all(pending);
}
