// CRUD for bank_connections table — wizard lifecycle and sync service queries.

import type { Database } from 'bun:sqlite';
import type { BankConnection, CreateBankConnectionData, UpdateBankConnectionData } from '../types';

export class BankConnectionsRepository {
  constructor(private db: Database) {}

  create(data: CreateBankConnectionData): BankConnection {
    const result = this.db
      .query<{ id: number }, [number, string, string, string]>(`
      INSERT INTO bank_connections (group_id, bank_name, display_name, status)
      VALUES (?, ?, ?, ?)
      RETURNING id
    `)
      .get(data.group_id, data.bank_name, data.display_name, data.status ?? 'setup');

    if (!result) throw new Error('Failed to create bank connection');
    const conn = this.findById(result.id);
    if (!conn) throw new Error('Failed to retrieve created bank connection');
    return conn;
  }

  findById(id: number): BankConnection | null {
    return (
      this.db
        .query<BankConnection, [number]>('SELECT * FROM bank_connections WHERE id = ?')
        .get(id) ?? null
    );
  }

  findByGroupAndBank(groupId: number, bankName: string): BankConnection | null {
    return (
      this.db
        .query<BankConnection, [number, string]>(
          'SELECT * FROM bank_connections WHERE group_id = ? AND bank_name = ?',
        )
        .get(groupId, bankName) ?? null
    );
  }

  findActiveByGroupId(groupId: number): BankConnection[] {
    return this.db
      .query<BankConnection, [number]>(
        "SELECT * FROM bank_connections WHERE group_id = ? AND status = 'active' ORDER BY created_at",
      )
      .all(groupId);
  }

  findAllByGroupId(groupId: number): BankConnection[] {
    return this.db
      .query<BankConnection, [number]>(
        "SELECT * FROM bank_connections WHERE group_id = ? AND status != 'setup' ORDER BY created_at",
      )
      .all(groupId);
  }

  findAllActive(): BankConnection[] {
    return this.db
      .query<BankConnection, []>("SELECT * FROM bank_connections WHERE status = 'active'")
      .all();
  }

  update(id: number, data: UpdateBankConnectionData): void {
    const fields: string[] = [];
    const values: (string | number | null)[] = [];

    if (data.status !== undefined) {
      fields.push('status = ?');
      values.push(data.status);
    }
    if (data.consecutive_failures !== undefined) {
      fields.push('consecutive_failures = ?');
      values.push(data.consecutive_failures);
    }
    if (data.last_sync_at !== undefined) {
      fields.push('last_sync_at = ?');
      values.push(data.last_sync_at);
    }
    if (data.last_error !== undefined) {
      fields.push('last_error = ?');
      values.push(data.last_error);
    }
    if (data.panel_message_id !== undefined) {
      fields.push('panel_message_id = ?');
      values.push(data.panel_message_id);
    }
    if (data.panel_message_thread_id !== undefined) {
      fields.push('panel_message_thread_id = ?');
      values.push(data.panel_message_thread_id);
    }

    if (fields.length === 0) return;
    values.push(id);
    this.db.prepare(`UPDATE bank_connections SET ${fields.join(', ')} WHERE id = ?`).run(...values);
  }

  deleteById(id: number): void {
    this.db.query<void, [number]>('DELETE FROM bank_connections WHERE id = ?').run(id);
  }

  findSetupByGroupId(groupId: number): BankConnection | null {
    return (
      this.db
        .query<BankConnection, [number]>(
          "SELECT * FROM bank_connections WHERE group_id = ? AND status = 'setup' ORDER BY created_at DESC LIMIT 1",
        )
        .get(groupId) ?? null
    );
  }

  /** Delete setup-status rows older than 10 minutes for a group (stale wizard sessions). */
  deleteStaleSetup(groupId: number): number[] {
    return this.db.transaction(() => {
      const stale = this.db
        .query<{ id: number }, [number]>(`
          SELECT id FROM bank_connections
          WHERE group_id = ? AND status = 'setup'
            AND created_at < datetime('now', '-10 minutes')
        `)
        .all(groupId);
      if (stale.length > 0) {
        this.db
          .query<void, [number]>(`
            DELETE FROM bank_connections
            WHERE group_id = ? AND status = 'setup'
              AND created_at < datetime('now', '-10 minutes')
          `)
          .run(groupId);
      }
      return stale.map((r) => r.id);
    })();
  }
}
