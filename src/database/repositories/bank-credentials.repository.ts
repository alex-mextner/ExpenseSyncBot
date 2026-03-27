// Encrypted bank credentials storage — one row per bank connection.

import type { Database } from 'bun:sqlite';
import type { BankCredential } from '../types';

export class BankCredentialsRepository {
  constructor(private db: Database) {}

  upsert(connectionId: number, encryptedData: string): void {
    this.db
      .query<void, [number, string]>(`
      INSERT INTO bank_credentials (connection_id, encrypted_data)
      VALUES (?, ?)
      ON CONFLICT(connection_id) DO UPDATE SET encrypted_data = excluded.encrypted_data
    `)
      .run(connectionId, encryptedData);
  }

  findByConnectionId(connectionId: number): BankCredential | null {
    return (
      this.db
        .query<BankCredential, [number]>('SELECT * FROM bank_credentials WHERE connection_id = ?')
        .get(connectionId) ?? null
    );
  }

  deleteByConnectionId(connectionId: number): void {
    this.db
      .query<void, [number]>('DELETE FROM bank_credentials WHERE connection_id = ?')
      .run(connectionId);
  }
}
