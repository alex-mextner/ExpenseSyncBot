// Manages pending OTP/readLine requests from ZenPlugins during sync.
// When a plugin calls ZenMoney.readLine(), execution pauses here until
// the user sends the code in the Telegram chat.

import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('otp-manager');

// 5 minutes — enough time for the user to receive and enter an OTP code.
// The global shim mutex is released during this wait (see sync-service.ts readLineImpl).
const OTP_TIMEOUT_MS = 5 * 60 * 1000;

type PendingOtp = {
  connectionId: number;
  telegramGroupId: number;
  resolve: (code: string) => void;
  reject: (err: Error) => void;
  timeoutId: ReturnType<typeof setTimeout>;
};

const pending = new Map<number, PendingOtp>();

/** Register a pending OTP request. Returns a Promise that resolves when the user sends a code. */
export function registerOtpRequest(connectionId: number, telegramGroupId: number): Promise<string> {
  // Cancel any stale request for this connection first
  cancelOtpRequest(connectionId);

  return new Promise<string>((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(connectionId);
      reject(new Error('Время ожидания кода истекло (5 мин)'));
    }, OTP_TIMEOUT_MS);

    pending.set(connectionId, { connectionId, telegramGroupId, resolve, reject, timeoutId });
    logger.info({ connectionId, telegramGroupId }, 'OTP request registered');
  });
}

/**
 * Called from message.handler when a message arrives in a group.
 * Returns true if the message was consumed as an OTP code.
 */
export function resolveOtpForGroup(telegramGroupId: number, code: string): boolean {
  for (const [connectionId, req] of pending) {
    if (req.telegramGroupId === telegramGroupId) {
      clearTimeout(req.timeoutId);
      pending.delete(connectionId);
      logger.info({ connectionId, code: code.replace(/./g, '*') }, 'OTP resolved');
      req.resolve(code);
      return true;
    }
  }
  return false;
}

/** Cancel the pending OTP request for a connection (on sync error/cleanup). */
export function cancelOtpRequest(connectionId: number): void {
  const req = pending.get(connectionId);
  if (req) {
    clearTimeout(req.timeoutId);
    pending.delete(connectionId);
    req.reject(new Error('OTP запрос отменён'));
    logger.info({ connectionId }, 'OTP request cancelled');
  }
}
