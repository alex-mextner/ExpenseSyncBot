import type { Database } from 'bun:sqlite';
import type { ExpenseItem, CreateExpenseItemData } from '../types';

export class ExpenseItemsRepository {
  constructor(private db: Database) {}

  /**
   * Find expense item by ID
   */
  findById(id: number): ExpenseItem | null {
    const query = this.db.query<ExpenseItem, [number]>(`
      SELECT * FROM expense_items WHERE id = ?
    `);

    return query.get(id) || null;
  }

  /**
   * Find all items for an expense
   */
  findByExpenseId(expenseId: number): ExpenseItem[] {
    const query = this.db.query<ExpenseItem, [number]>(`
      SELECT * FROM expense_items
      WHERE expense_id = ?
      ORDER BY created_at ASC
    `);

    return query.all(expenseId);
  }

  /**
   * Create new expense item
   */
  create(data: CreateExpenseItemData): ExpenseItem {
    const query = this.db.query<{ id: number }, [number, string, string | null, number, number, number]>(`
      INSERT INTO expense_items (
        expense_id,
        name_ru,
        name_original,
        quantity,
        price,
        total
      )
      VALUES (?, ?, ?, ?, ?, ?)
      RETURNING id
    `);

    const result = query.get(
      data.expense_id,
      data.name_ru,
      data.name_original || null,
      data.quantity,
      data.price,
      data.total
    );

    if (!result) {
      throw new Error('Failed to create expense item');
    }

    const item = this.findById(result.id);

    if (!item) {
      throw new Error('Failed to retrieve created expense item');
    }

    return item;
  }

  /**
   * Create multiple expense items in a transaction
   */
  createMany(items: CreateExpenseItemData[]): ExpenseItem[] {
    const createdItems: ExpenseItem[] = [];

    for (const itemData of items) {
      const item = this.create(itemData);
      createdItems.push(item);
    }

    return createdItems;
  }

  /**
   * Delete expense item
   */
  delete(id: number): boolean {
    const query = this.db.query<void, [number]>(`
      DELETE FROM expense_items WHERE id = ?
    `);

    query.run(id);
    return true;
  }

  /**
   * Delete all items for an expense
   */
  deleteByExpenseId(expenseId: number): number {
    const countQuery = this.db.query<{ count: number }, [number]>(`
      SELECT COUNT(*) as count FROM expense_items WHERE expense_id = ?
    `);

    const result = countQuery.get(expenseId);
    const count = result?.count || 0;

    const deleteQuery = this.db.query<void, [number]>(`
      DELETE FROM expense_items WHERE expense_id = ?
    `);

    deleteQuery.run(expenseId);
    return count;
  }
}
