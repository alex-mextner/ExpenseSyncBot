import type { Database } from 'bun:sqlite';
import type { ReceiptItem, CreateReceiptItemData, UpdateReceiptItemData } from '../types';

export class ReceiptItemsRepository {
  constructor(private db: Database) {}

  /**
   * Find receipt item by ID
   */
  findById(id: number): ReceiptItem | null {
    const query = this.db.query<Omit<ReceiptItem, 'possible_categories'> & { possible_categories: string }, [number]>(`
      SELECT * FROM receipt_items WHERE id = ?
    `);

    const result = query.get(id);

    if (!result) {
      return null;
    }

    return {
      ...result,
      possible_categories: JSON.parse(result.possible_categories),
    };
  }

  /**
   * Find all pending items (status = 'pending')
   */
  findPending(): ReceiptItem[] {
    const query = this.db.query<Omit<ReceiptItem, 'possible_categories'> & { possible_categories: string }, []>(`
      SELECT * FROM receipt_items
      WHERE status = 'pending'
      ORDER BY created_at ASC
    `);

    const results = query.all();

    return results.map((r) => ({
      ...r,
      possible_categories: JSON.parse(r.possible_categories),
    }));
  }

  /**
   * Find by photo queue ID
   */
  findByPhotoQueueId(photoQueueId: number): ReceiptItem[] {
    const query = this.db.query<Omit<ReceiptItem, 'possible_categories'> & { possible_categories: string }, [number]>(`
      SELECT * FROM receipt_items
      WHERE photo_queue_id = ?
      ORDER BY created_at ASC
    `);

    const results = query.all(photoQueueId);

    return results.map((r) => ({
      ...r,
      possible_categories: JSON.parse(r.possible_categories),
    }));
  }

  /**
   * Find next pending item (for confirmation flow)
   */
  findNextPending(): ReceiptItem | null {
    const query = this.db.query<Omit<ReceiptItem, 'possible_categories'> & { possible_categories: string }, []>(`
      SELECT * FROM receipt_items
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
    `);

    const result = query.get();

    if (!result) {
      return null;
    }

    return {
      ...result,
      possible_categories: JSON.parse(result.possible_categories),
    };
  }

  /**
   * Create new receipt item
   */
  create(data: CreateReceiptItemData): ReceiptItem {
    const query = this.db.query<{ id: number }, [number, string, string | null, number, number, number, string, string, string, string]>(`
      INSERT INTO receipt_items (
        photo_queue_id,
        name_ru,
        name_original,
        quantity,
        price,
        total,
        currency,
        suggested_category,
        possible_categories,
        status
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    const result = query.get(
      data.photo_queue_id,
      data.name_ru,
      data.name_original || null,
      data.quantity,
      data.price,
      data.total,
      data.currency,
      data.suggested_category,
      JSON.stringify(data.possible_categories),
      data.status
    );

    if (!result) {
      throw new Error('Failed to create receipt item');
    }

    const item = this.findById(result.id);

    if (!item) {
      throw new Error('Failed to retrieve created receipt item');
    }

    return item;
  }

  /**
   * Update receipt item
   */
  update(id: number, data: UpdateReceiptItemData): ReceiptItem {
    const updates: string[] = [];
    const values: (string | number)[] = [];

    if (data.status !== undefined) {
      updates.push('status = ?');
      values.push(data.status);
    }

    if (data.confirmed_category !== undefined) {
      updates.push('confirmed_category = ?');
      values.push(data.confirmed_category);
    }

    if (data.waiting_for_category_input !== undefined) {
      updates.push('waiting_for_category_input = ?');
      values.push(data.waiting_for_category_input);
    }

    if (data.possible_categories !== undefined) {
      updates.push('possible_categories = ?');
      values.push(data.possible_categories);
    }

    if (updates.length === 0) {
      throw new Error('No fields to update');
    }

    values.push(id);

    const query = this.db.query<void, (string | number)[]>(`
      UPDATE receipt_items
      SET ${updates.join(', ')}
      WHERE id = ?
    `);

    query.run(...values);

    const item = this.findById(id);

    if (!item) {
      throw new Error('Failed to retrieve updated receipt item');
    }

    return item;
  }

  /**
   * Find receipt item waiting for category text input from user
   */
  findWaitingForCategoryInput(groupId: number): ReceiptItem | null {
    const query = this.db.query<Omit<ReceiptItem, 'possible_categories'> & { possible_categories: string }, [number]>(`
      SELECT ri.* FROM receipt_items ri
      JOIN photo_processing_queue ppq ON ri.photo_queue_id = ppq.id
      WHERE ppq.group_id = ? AND ri.waiting_for_category_input = 1
      ORDER BY ri.created_at ASC
      LIMIT 1
    `);

    const result = query.get(groupId);

    if (!result) {
      return null;
    }

    return {
      ...result,
      possible_categories: JSON.parse(result.possible_categories),
    };
  }

  /**
   * Delete receipt item
   */
  delete(id: number): boolean {
    const query = this.db.query<void, [number]>(`
      DELETE FROM receipt_items WHERE id = ?
    `);

    query.run(id);
    return true;
  }

  /**
   * Delete all confirmed items by photo queue ID
   */
  deleteConfirmedByPhotoQueueId(photoQueueId: number): number {
    const countQuery = this.db.query<{ count: number }, [number]>(`
      SELECT COUNT(*) as count
      FROM receipt_items
      WHERE photo_queue_id = ? AND status = 'confirmed'
    `);

    const result = countQuery.get(photoQueueId);
    const count = result?.count || 0;

    const deleteQuery = this.db.query<void, [number]>(`
      DELETE FROM receipt_items
      WHERE photo_queue_id = ? AND status = 'confirmed'
    `);

    deleteQuery.run(photoQueueId);
    return count;
  }

  /**
   * Get all confirmed items by photo queue ID
   */
  findConfirmedByPhotoQueueId(photoQueueId: number): ReceiptItem[] {
    const query = this.db.query<Omit<ReceiptItem, 'possible_categories'> & { possible_categories: string }, [number]>(`
      SELECT * FROM receipt_items
      WHERE photo_queue_id = ? AND status = 'confirmed'
      ORDER BY created_at ASC
    `);

    const results = query.all(photoQueueId);

    return results.map((r) => ({
      ...r,
      possible_categories: JSON.parse(r.possible_categories),
    }));
  }
}
