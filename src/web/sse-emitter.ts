// In-process SSE event bus keyed by internal group DB ID — subscribe/emit for dashboard real-time updates

/** Event types that can be emitted to group subscribers */
export type SseEventType = 'expense_added' | 'budget_updated';

/** Map of internalGroupId → set of send functions */
const subscribers = new Map<number, Set<(event: string) => void>>();

/**
 * Subscribe to SSE events for a group.
 * Returns an unsubscribe function — call it on client disconnect.
 */
export function subscribeGroup(groupId: number, send: (event: string) => void): () => void {
  let group = subscribers.get(groupId);
  if (!group) {
    group = new Set();
    subscribers.set(groupId, group);
  }
  group.add(send);

  return () => {
    const subs = subscribers.get(groupId);
    if (subs) {
      subs.delete(send);
      if (subs.size === 0) {
        subscribers.delete(groupId);
      }
    }
  };
}

/**
 * Emit an SSE event to all subscribers of a group.
 * No-op if nobody is subscribed.
 */
export function emitForGroup(groupId: number, eventType: SseEventType): void {
  const subs = subscribers.get(groupId);
  if (!subs || subs.size === 0) return;

  const message = `event: ${eventType}\ndata: {}\n\n`;
  for (const send of subs) {
    send(message);
  }
}
