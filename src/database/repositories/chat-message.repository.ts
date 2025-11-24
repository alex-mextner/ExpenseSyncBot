import type { Database } from 'bun:sqlite';
import type { ChatMessage, CreateChatMessageData } from '../types';

export class ChatMessageRepository {
  constructor(private db: Database) {}

  /**
   * Create new chat message
   */
  create(data: CreateChatMessageData): ChatMessage {
    const query = this.db.query<{ id: number }, [number, number, string, string]>(`
      INSERT INTO chat_messages (group_id, user_id, role, content)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `);

    const result = query.get(data.group_id, data.user_id, data.role, data.content);

    if (!result) {
      throw new Error('Failed to create chat message');
    }

    const message = this.findById(result.id);

    if (!message) {
      throw new Error('Failed to retrieve created chat message');
    }

    return message;
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
      ORDER BY created_at DESC
      LIMIT ?
    `);

    // Return in chronological order (oldest first)
    return query.all(groupId, limit).reverse();
  }

  /**
   * Delete old messages (keep only last N messages per group)
   */
  pruneOldMessages(groupId: number, keepCount: number = 50): number {
    const query = this.db.query<void, [number, number]>(`
      DELETE FROM chat_messages
      WHERE group_id = ? AND id NOT IN (
        SELECT id FROM chat_messages
        WHERE group_id = ?
        ORDER BY created_at DESC
        LIMIT ?
      )
    `);

    query.run(groupId, groupId, keepCount);
    return keepCount;
  }

  /**
   * Delete all messages for a group
   */
  deleteByGroupId(groupId: number): void {
    const query = this.db.query<void, [number]>(`
      DELETE FROM chat_messages WHERE group_id = ?
    `);

    query.run(groupId);
  }
}
