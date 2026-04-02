// Bank transaction storage — all read queries require group_id for isolation.
import type { Database } from 'bun:sqlite';
import { resolvePeriodDates } from '../../utils/period';
import type { BankTransaction, BankTransactionFilters, CreateBankTransactionData } from '../types';

export class BankTransactionsRepository {
  constructor(private db: Database) {}

  /**
   * Insert a new transaction. Returns null if external_id already exists (ON CONFLICT DO NOTHING).
   */
  insertIgnore(data: CreateBankTransactionData): BankTransaction | null {
    const result = this.db
      .query<
        { id: number },
        [
          number,
          string,
          string | null,
          string,
          string | null,
          number,
          string,
          string,
          number | null,
          string | null,
          string | null,
          string | null,
          number | null,
          string,
          string,
        ]
      >(`
        INSERT INTO bank_transactions
          (connection_id, external_id, account_id, date, time, amount, sign_type, currency,
           invoice_amount, invoice_currency, merchant, merchant_normalized, mcc, raw_data, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(connection_id, external_id) DO NOTHING
        RETURNING id
      `)
      .get(
        data.connection_id,
        data.external_id,
        data.account_id ?? null,
        data.date,
        data.time ?? null,
        data.amount,
        data.sign_type,
        data.currency,
        data.invoice_amount ?? null,
        data.invoice_currency ?? null,
        data.merchant ?? null,
        data.merchant_normalized ?? null,
        data.mcc ?? null,
        data.raw_data,
        data.status,
      );

    if (!result) return null;
    return (
      this.db
        .query<BankTransaction, [number]>('SELECT * FROM bank_transactions WHERE id = ?')
        .get(result.id) ?? null
    );
  }

  findById(id: number, groupId: number): BankTransaction | null {
    return (
      this.db
        .query<BankTransaction, [number, number]>(`
          SELECT bt.* FROM bank_transactions bt
          JOIN bank_connections bc ON bt.connection_id = bc.id
          WHERE bt.id = ? AND bc.group_id = ?
        `)
        .get(id, groupId) ?? null
    );
  }

  findPendingByConnectionId(connectionId: number): BankTransaction[] {
    return this.db
      .query<BankTransaction, [number]>(`
        SELECT * FROM bank_transactions
        WHERE connection_id = ? AND status = 'pending'
        ORDER BY date DESC, created_at DESC
      `)
      .all(connectionId);
  }

  findByGroupId(groupId: number, filters: BankTransactionFilters): BankTransaction[] {
    const conditions: string[] = ['bc.group_id = ?'];
    const values: (string | number)[] = [groupId];

    if (filters.bank_name) {
      if (Array.isArray(filters.bank_name)) {
        const placeholders = filters.bank_name.map(() => '?').join(', ');
        conditions.push(`bc.bank_name IN (${placeholders})`);
        values.push(...filters.bank_name);
      } else {
        conditions.push('bc.bank_name = ?');
        values.push(filters.bank_name);
      }
    }

    if (filters.status) {
      if (Array.isArray(filters.status)) {
        const placeholders = filters.status.map(() => '?').join(', ');
        conditions.push(`bt.status IN (${placeholders})`);
        values.push(...filters.status);
      } else {
        conditions.push('bt.status = ?');
        values.push(filters.status);
      }
    }

    if (filters.period) {
      const periods = Array.isArray(filters.period) ? filters.period : [filters.period];
      const [firstPeriod] = periods;
      if (periods.length === 1 && firstPeriod) {
        const { startDate, endDate } = resolvePeriodDates(firstPeriod);
        conditions.push('bt.date >= ?', 'bt.date <= ?');
        values.push(startDate, endDate);
      } else {
        // Multiple periods: OR of date ranges
        const dateConditions = periods.map((p) => {
          const { startDate, endDate } = resolvePeriodDates(p);
          values.push(startDate, endDate);
          return '(bt.date >= ? AND bt.date <= ?)';
        });
        conditions.push(`(${dateConditions.join(' OR ')})`);
      }
    }

    return this.db
      .query<BankTransaction, typeof values>(`
        SELECT bt.* FROM bank_transactions bt
        JOIN bank_connections bc ON bt.connection_id = bc.id
        WHERE ${conditions.join(' AND ')}
        ORDER BY bt.date DESC, bt.created_at DESC
      `)
      .all(...values);
  }

  updateStatus(id: number, groupId: number, status: BankTransaction['status']): void {
    this.db
      .query<void, [string, number, number]>(`
        UPDATE bank_transactions SET status = ?
        WHERE id = ? AND connection_id IN (
          SELECT id FROM bank_connections WHERE group_id = ?
        )
      `)
      .run(status, id, groupId);
  }

  setMatchedExpense(id: number, groupId: number, expenseId: number): void {
    this.db
      .query<void, [number, number, number]>(`
        UPDATE bank_transactions SET matched_expense_id = ?
        WHERE id = ? AND connection_id IN (
          SELECT id FROM bank_connections WHERE group_id = ?
        )
      `)
      .run(expenseId, id, groupId);
  }

  setTelegramMessageId(id: number, messageId: number): void {
    this.db
      .query<void, [number, number]>(
        'UPDATE bank_transactions SET telegram_message_id = ? WHERE id = ?',
      )
      .run(messageId, id);
  }

  setEditInProgress(id: number, flag: boolean): void {
    this.db
      .query<void, [number, number]>(
        'UPDATE bank_transactions SET edit_in_progress = ? WHERE id = ?',
      )
      .run(flag ? 1 : 0, id);
  }

  setAwaitingComment(id: number, flag: boolean): void {
    this.db
      .query<void, [number, number]>(
        'UPDATE bank_transactions SET awaiting_comment = ? WHERE id = ?',
      )
      .run(flag ? 1 : 0, id);
  }

  setPrefill(id: number, category: string, comment: string): void {
    this.db
      .query<void, [string, string, number]>(
        'UPDATE bank_transactions SET prefill_category = ?, prefill_comment = ? WHERE id = ?',
      )
      .run(category, comment, id);
  }

  updateMerchantNormalized(id: number, merchantNormalized: string): void {
    this.db
      .query<void, [string, number]>(
        'UPDATE bank_transactions SET merchant_normalized = ? WHERE id = ?',
      )
      .run(merchantNormalized, id);
  }

  /**
   * Find pending/confirmed debit transactions with no matched expense in a period.
   * Used by find_missing_expenses AI tool.
   */
  findUnmatched(groupId: number, startDate: string, endDate: string): BankTransaction[] {
    return this.db
      .query<BankTransaction, [number, string, string]>(`
        SELECT bt.* FROM bank_transactions bt
        JOIN bank_connections bc ON bt.connection_id = bc.id
        WHERE bc.group_id = ?
          AND bt.date >= ? AND bt.date <= ?
          AND bt.sign_type = 'debit'
          AND bt.matched_expense_id IS NULL
          AND bt.status IN ('pending', 'confirmed')
        ORDER BY bt.date DESC
      `)
      .all(groupId, startDate, endDate);
  }
}
