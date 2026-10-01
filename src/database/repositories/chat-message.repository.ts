/** Chat message repository — stores AI conversation history per group for multi-turn context */
import type { Database } from 'bun:sqlite';
import type { ChatMessage, CreateChatMessageData } from '../types';

const MAX_RETENTION_COUNTERS = 512;

export class ChatMessageRepository {
  private readonly writesSincePrune = new Map<string, number>();

  constructor(private db: Database) {}

  /**
   * Create new chat message
   */
  create(data: CreateChatMessageData): ChatMessage {
    const query = this.db.query<ChatMessage, [number, number, string, string, number | null]>(`
      INSERT INTO chat_messages (group_id, user_id, role, content, message_thread_id)
      VALUES (?, ?, ?, ?, ?)
      RETURNING id, group_id, user_id, role, content, message_thread_id, created_at
    `);

    const result = query.get(
      data.group_id,
      data.user_id,
      data.role,
      data.content,
      data.message_thread_id ?? null,
    );

    if (!result) {
      throw new Error('Failed to create chat message');
    }

    return result;
  }

  /**
   * Find message by ID
   */
  findById(id: number): ChatMessage | null {
    const query = this.db.query<ChatMessage, [number]>(`
      SELECT * FROM chat_messages WHERE id = ?
    `);

    return query.get(id) || null;
  }

  /**
   * Get recent messages for a group (for conversation history)
   */
  getRecentMessages(groupId: number, limit: number = 10): ChatMessage[] {
    const query = this.db.query<ChatMessage, [number, number]>(`
      SELECT * FROM chat_messages
      WHERE group_id = ?
      ORDER BY id DESC
      LIMIT ?
    `);

    // Return in chronological order (oldest first)
    return query.all(groupId, limit).reverse();
  }

  /**
   * Get the recent causal history strictly before one stored message.
   * Using the monotonic DB id avoids same-second timestamp ties and prevents a
   * concurrent later Telegram update from leaking into an earlier AI request.
   */
  getRecentMessagesBefore(
    groupId: number,
    beforeId: number,
    limit: number = 10,
    messageThreadId: number | null = null,
  ): ChatMessage[] {
    const query = this.db.query<ChatMessage, [number, number | null, number, number]>(`
      SELECT * FROM chat_messages
      WHERE group_id = ? AND message_thread_id IS ? AND id < ?
      ORDER BY id DESC
      LIMIT ?
    `);

    return query.all(groupId, messageThreadId, beforeId, limit).reverse();
  }

  /**
   * Delete old messages in one conversation scope (group + Telegram topic),
   * keeping only the newest N rows in that scope.
   */
  pruneOldMessages(
    groupId: number,
    keepCount: number = 50,
    messageThreadId: number | null = null,
  ): number {
    const query = this.db.query<void, [number, number | null, number, number | null, number]>(`
      DELETE FROM chat_messages
      WHERE group_id = ? AND message_thread_id IS ? AND id NOT IN (
        SELECT id FROM chat_messages
        WHERE group_id = ? AND message_thread_id IS ?
        ORDER BY id DESC
        LIMIT ?
      )
    `);

    const result = query.run(groupId, messageThreadId, groupId, messageThreadId, keepCount);
    return result.changes;
  }

  /**
   * Amortized retention for the hot message path. No COUNT/DELETE runs on every
   * message; every Nth write in this exact group/topic scope prunes back to keepCount.
   */
  pruneOldMessagesIfNeeded(
    groupId: number,
    messageThreadId: number | null = null,
    keepCount: number = 50,
    everyWrites: number = 10,
  ): number {
    const key = `${groupId}:${messageThreadId ?? 'general'}`;
    if (!this.writesSincePrune.has(key) && this.writesSincePrune.size >= MAX_RETENTION_COUNTERS) {
      const oldestKey = this.writesSincePrune.keys().next().value;
      if (oldestKey !== undefined) this.writesSincePrune.delete(oldestKey);
    }
    const writes = (this.writesSincePrune.get(key) ?? 0) + 1;
    if (writes < everyWrites) {
      this.writesSincePrune.set(key, writes);
      return 0;
    }

    this.writesSincePrune.delete(key);
    return this.pruneOldMessages(groupId, keepCount, messageThreadId);
  }

  /**
   * Delete all messages for a group
   */
  deleteByGroupId(groupId: number): void {
    const query = this.db.query<void, [number]>(`
      DELETE FROM chat_messages WHERE group_id = ?
    `);

    query.run(groupId);
    const prefix = `${groupId}:`;
    for (const key of this.writesSincePrune.keys()) {
      if (key.startsWith(prefix)) this.writesSincePrune.delete(key);
    }
  }
}
