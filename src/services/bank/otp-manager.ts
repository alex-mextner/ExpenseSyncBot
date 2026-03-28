// Manages pending OTP/readLine requests from ZenPlugins during sync.
// When a plugin calls ZenMoney.readLine(), execution pauses here until
// the user sends the code in the Telegram chat.
// State is stored in SQLite so bank-sync and expensesyncbot (separate processes) share it.

import { database } from '../../database';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('otp-manager');

// 5 minutes — enough time for the user to receive and enter an OTP code.
const OTP_TIMEOUT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 200;

type OtpRow = {
  id: number;
  connection_id: number;
  group_telegram_id: number;
  code: string | null;
  status: string;
};

/** Register a pending OTP request. Returns a Promise that resolves when the user sends a code. */
export function registerOtpRequest(connectionId: number, telegramGroupId: number): Promise<string> {
  // Remove any stale request for this connection first
  database.db.query('DELETE FROM bank_otp_requests WHERE connection_id = ?').run(connectionId);

  const expiresAt = new Date(Date.now() + OTP_TIMEOUT_MS).toISOString();
  database.db
    .query(
      "INSERT INTO bank_otp_requests (connection_id, group_telegram_id, status, expires_at) VALUES (?, ?, 'pending', ?)",
    )
    .run(connectionId, telegramGroupId, expiresAt);

  logger.info({ connectionId, telegramGroupId }, 'OTP request registered');

  return new Promise<string>((resolve, reject) => {
    const deadline = Date.now() + OTP_TIMEOUT_MS;

    const pollId = setInterval(() => {
      const row = database.db
        .query<OtpRow, [number]>('SELECT * FROM bank_otp_requests WHERE connection_id = ? LIMIT 1')
        .get(connectionId);

      if (!row) {
        clearInterval(pollId);
        reject(new Error('OTP запрос отменён'));
        return;
      }

      if (row.status === 'resolved' && row.code) {
        clearInterval(pollId);
        database.db
          .query('DELETE FROM bank_otp_requests WHERE connection_id = ?')
          .run(connectionId);
        logger.info({ connectionId }, 'OTP resolved');
        resolve(row.code);
        return;
      }

      if (row.status === 'cancelled') {
        clearInterval(pollId);
        database.db
          .query('DELETE FROM bank_otp_requests WHERE connection_id = ?')
          .run(connectionId);
        reject(new Error('OTP запрос отменён'));
        return;
      }

      if (Date.now() >= deadline) {
        clearInterval(pollId);
        database.db
          .query('DELETE FROM bank_otp_requests WHERE connection_id = ?')
          .run(connectionId);
        reject(new Error('Время ожидания кода истекло (5 мин)'));
      }
    }, POLL_INTERVAL_MS);
  });
}

/**
 * Called from message.handler when a message arrives in a group.
 * Returns true if the message was consumed as an OTP code.
 */
export function resolveOtpForGroup(telegramGroupId: number, code: string): boolean {
  const row = database.db
    .query<OtpRow, [number]>(
      "SELECT * FROM bank_otp_requests WHERE group_telegram_id = ? AND status = 'pending' AND expires_at > datetime('now') LIMIT 1",
    )
    .get(telegramGroupId);

  if (!row) return false;

  database.db
    .query("UPDATE bank_otp_requests SET code = ?, status = 'resolved' WHERE connection_id = ?")
    .run(code, row.connection_id);

  logger.info({ connectionId: row.connection_id, code: code.replace(/./g, '*') }, 'OTP resolved');
  return true;
}

/** Cancel the pending OTP request for a connection (on sync error/cleanup). */
export function cancelOtpRequest(connectionId: number): void {
  const row = database.db
    .query<OtpRow, [number]>(
      "SELECT * FROM bank_otp_requests WHERE connection_id = ? AND status = 'pending' LIMIT 1",
    )
    .get(connectionId);

  if (row) {
    database.db
      .query("UPDATE bank_otp_requests SET status = 'cancelled' WHERE connection_id = ?")
      .run(connectionId);
    logger.info({ connectionId }, 'OTP request cancelled');
  }
}
