/** Receipt repository — CRUD and dedup-matching for stored receipt images */
import type { Database } from 'bun:sqlite';
import type { CreateReceiptData, Receipt } from '../types';

export class ReceiptRepository {
  constructor(private db: Database) {}

  findById(id: number): Receipt | null {
    return this.db.query<Receipt, [number]>('SELECT * FROM receipts WHERE id = ?').get(id) ?? null;
  }

  findByPhotoQueueId(photoQueueId: number): Receipt | null {
    return (
      this.db
        .query<Receipt, [number]>('SELECT * FROM receipts WHERE photo_queue_id = ?')
        .get(photoQueueId) ?? null
    );
  }

  create(data: CreateReceiptData): Receipt {
    const result = this.db
      .query<{ id: number }, [number, number | null, string, number, string, string]>(
        `INSERT INTO receipts (group_id, photo_queue_id, image_path, total_amount, currency, date)
         VALUES (?, ?, ?, ?, ?, ?)
         RETURNING id`,
      )
      .get(
        data.group_id,
        data.photo_queue_id ?? null,
        data.image_path,
        data.total_amount,
        data.currency,
        data.date,
      );

    if (!result) {
      throw new Error('Failed to create receipt');
    }

    const receipt = this.findById(result.id);
    if (!receipt) {
      throw new Error('Failed to retrieve created receipt');
    }
    return receipt;
  }

  /**
   * Find receipts that may match a bank transaction by total amount, currency, and date.
   * Uses ±5% tolerance on amount and ±1 day on date (fuzzy).
   * Excludes receipts already linked to a confirmed bank transaction.
   */
  findPotentialMatches(
    groupId: number,
    date: string,
    amount: number,
    currency: string,
  ): { exact: Receipt[]; fuzzy: Receipt[] } {
    const amountTolerance = amount * 0.05;

    const linkedFilter = `
      AND NOT EXISTS (
        SELECT 1 FROM expenses e2
        JOIN bank_transactions bt ON bt.matched_expense_id = e2.id
        WHERE e2.receipt_id = r.id AND bt.status = 'confirmed'
      )`;

    const exact = this.db
      .query<Receipt, [number, string, string, number, number]>(
        `SELECT r.* FROM receipts r
         WHERE r.group_id = ?
           AND r.date = ?
           AND r.currency = ?
           AND ABS(r.total_amount - ?) <= ?
           ${linkedFilter}
         ORDER BY r.created_at DESC
         LIMIT 5`,
      )
      .all(groupId, date, currency, amount, amountTolerance);

    const exactIds = new Set(exact.map((r) => r.id));

    const fuzzy = this.db
      .query<Receipt, [number, string, string, string, string, number, number, string]>(
        `SELECT r.* FROM receipts r
         WHERE r.group_id = ?
           AND r.date >= date(?, '-1 day')
           AND r.date <= date(?, '+1 day')
           AND r.date != ?
           AND r.currency = ?
           AND ABS(r.total_amount - ?) <= ?
           ${linkedFilter}
         ORDER BY ABS(julianday(r.date) - julianday(?)) ASC, r.created_at DESC
         LIMIT 5`,
      )
      .all(groupId, date, date, date, currency, amount, amountTolerance, date);

    return {
      exact,
      fuzzy: fuzzy.filter((r) => !exactIds.has(r.id)),
    };
  }

  /**
   * Find all expenses linked to a receipt
   */
  findExpensesByReceiptId(
    receiptId: number,
  ): Array<{ id: number; category: string; amount: number; currency: string; comment: string }> {
    return this.db
      .query<
        { id: number; category: string; amount: number; currency: string; comment: string },
        [number]
      >('SELECT id, category, amount, currency, comment FROM expenses WHERE receipt_id = ?')
      .all(receiptId);
  }

  delete(id: number): boolean {
    this.db.query<void, [number]>('DELETE FROM receipts WHERE id = ?').run(id);
    return true;
  }
}
