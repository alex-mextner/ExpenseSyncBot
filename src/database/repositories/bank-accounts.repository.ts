// Account balance storage — upserted after each scrape cycle.

import type { Database } from 'bun:sqlite';
import type { BankAccount, UpsertBankAccountData } from '../types';

export class BankAccountsRepository {
  constructor(private db: Database) {}

  upsert(data: UpsertBankAccountData): BankAccount {
    const result = this.db
      .query<{ id: number }, [number, string, string, number, string, string | null]>(`
      INSERT INTO bank_accounts (connection_id, account_id, title, balance, currency, type)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(connection_id, account_id)
      DO UPDATE SET balance = excluded.balance, title = excluded.title, updated_at = datetime('now')
      RETURNING id
    `)
      .get(
        data.connection_id,
        data.account_id,
        data.title,
        data.balance,
        data.currency,
        data.type ?? null,
      );

    if (!result) throw new Error('Failed to upsert bank account');
    const account = this.findById(result.id);
    if (!account) throw new Error('Failed to retrieve bank account');
    return account;
  }

  findById(id: number): BankAccount | null {
    return (
      this.db.query<BankAccount, [number]>('SELECT * FROM bank_accounts WHERE id = ?').get(id) ??
      null
    );
  }

  findByConnectionId(connectionId: number): BankAccount[] {
    return this.db
      .query<BankAccount, [number]>(
        'SELECT * FROM bank_accounts WHERE connection_id = ? ORDER BY title',
      )
      .all(connectionId);
  }

  setExcluded(id: number, excluded: boolean): void {
    this.db
      .query<void, [number, number]>('UPDATE bank_accounts SET is_excluded = ? WHERE id = ?')
      .run(excluded ? 1 : 0, id);
  }

  findByGroupId(groupId: number): BankAccount[] {
    return this.db
      .query<BankAccount, [number]>(`
      SELECT ba.* FROM bank_accounts ba
      JOIN bank_connections bc ON ba.connection_id = bc.id
      WHERE bc.group_id = ? AND bc.status = 'active'
      ORDER BY bc.bank_name, ba.title
    `)
      .all(groupId);
  }
}
