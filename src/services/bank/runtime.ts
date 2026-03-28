// ZenMoney API shim — provides the ZenMoney global interface that ZenPlugins expect.
// Backed by bank_plugin_state SQLite table for persistent state.
import type { Database } from 'bun:sqlite';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('zen-runtime');

export interface ZenMoneyShim {
  getData(key: string): unknown;
  /** Stage data to be persisted. In our shim, writes immediately (same as saveData). */
  setData(key: string, value: unknown): void;
  saveData(key?: string, value?: unknown): void;
  getPreferences(): Record<string, string>;
  addAccount(account: unknown): void;
  addTransaction(tx: unknown): void;
  readLine(prompt: string): Promise<string>;
  setResult(data: unknown): void;
  trustCertificates(): void;
  clearData(): void;
  isAccountSkipped(id: string): boolean;
  /** Stub: cookie management used by legacy plugin flows. No-op in background sync. */
  getCookies(): Promise<Array<{ name: string; value: string; domain: string }>>;
  setCookie(domain: string, name: string, value: string): Promise<void>;
  clearCookies(): Promise<void>;
  saveCookies(): Promise<void>;
  restoreCookies(): Promise<void>;
  locale: string;
  application: { platform: string; version: string };
  device: {
    manufacturer: string;
    model: string;
    os: { name: string; version: string };
  };
  _getCollectedAccounts(): unknown[];
  _getCollectedTransactions(): unknown[];
  _getSetResult(): unknown;
}

export function createZenMoneyShim(
  connectionId: number,
  db: Database,
  preferences: Record<string, string>,
  readLineImpl?: (prompt: string) => Promise<string>,
): ZenMoneyShim {
  const collectedAccounts: unknown[] = [];
  const collectedTransactions: unknown[] = [];
  let setResultValue: unknown;

  const getState = db.query<{ value: string }, [number, string]>(
    'SELECT value FROM bank_plugin_state WHERE connection_id = ? AND key = ?',
  );
  const upsertState = db.query<void, [number, string, string]>(`
    INSERT INTO bank_plugin_state (connection_id, key, value)
    VALUES (?, ?, ?)
    ON CONFLICT(connection_id, key) DO UPDATE SET value = excluded.value
  `);
  const clearState = db.query<void, [number]>(
    'DELETE FROM bank_plugin_state WHERE connection_id = ?',
  );

  return {
    getData(key: string): unknown {
      const row = getState.get(connectionId, key);
      if (!row) return undefined;
      try {
        return JSON.parse(row.value);
      } catch {
        return row.value;
      }
    },

    setData(key: string, value: unknown): void {
      upsertState.run(connectionId, key, JSON.stringify(value));
    },

    saveData(key?: string, value?: unknown): void {
      if (key !== undefined) {
        upsertState.run(connectionId, key, JSON.stringify(value));
      }
      // No-arg variant: all writes are synchronous, nothing to flush.
    },

    getPreferences(): Record<string, string> {
      return preferences;
    },

    addAccount(account: unknown): void {
      collectedAccounts.push(account);
    },

    addTransaction(tx: unknown): void {
      collectedTransactions.push(tx);
    },

    readLine(prompt: string): Promise<string> {
      if (readLineImpl) return readLineImpl(prompt);
      logger.warn({ prompt }, 'ZenMoney.readLine called but no readLine handler registered');
      return Promise.resolve('');
    },

    setResult(data: unknown): void {
      setResultValue = data;
    },

    trustCertificates(): void {
      // no-op: Bun handles SSL natively
    },

    isAccountSkipped(_id: string): boolean {
      return false;
    },

    async getCookies() {
      return [];
    },

    async setCookie(_domain: string, _name: string, _value: string) {},

    async clearCookies() {},

    async saveCookies() {},

    async restoreCookies() {},

    locale: 'en',

    application: { platform: 'Android', version: '6.66.3' },

    device: {
      manufacturer: 'Samsung',
      model: 'SM-G991B',
      os: { name: 'Android', version: '13' },
    },

    clearData(): void {
      clearState.run(connectionId);
    },

    _getCollectedAccounts(): unknown[] {
      return collectedAccounts;
    },

    _getCollectedTransactions(): unknown[] {
      return collectedTransactions;
    },

    _getSetResult(): unknown {
      return setResultValue;
    },
  };
}
