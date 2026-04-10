/** Classifies Google Sheets write errors and produces user-facing messages */
import { isTokenExpiredError } from '../../services/google/oauth';

export type SheetErrorType = 'auth' | 'not_found' | 'rate_limit' | 'network' | 'unknown';

/**
 * Classify a Google Sheets API error into a category we can show to the user.
 * Order matters: auth checks come first because token errors can manifest as 401/403.
 */
export function classifySheetError(error: unknown): SheetErrorType {
  if (isTokenExpiredError(error)) return 'auth';

  if (!(error instanceof Error)) return 'unknown';
  const msg = error.message.toLowerCase();

  // Permission denied or spreadsheet deleted
  if (
    msg.includes('404') ||
    msg.includes('not found') ||
    msg.includes('requested entity was not found')
  ) {
    return 'not_found';
  }
  if (msg.includes('403') || msg.includes('forbidden') || msg.includes('permission')) {
    return 'not_found'; // Same UX — sheet inaccessible
  }

  // Rate limiting
  if (
    msg.includes('429') ||
    msg.includes('too many requests') ||
    msg.includes('quota') ||
    msg.includes('rate limit')
  ) {
    return 'rate_limit';
  }

  // Network/transient
  if (
    msg.includes('econnreset') ||
    msg.includes('etimedout') ||
    msg.includes('enotfound') ||
    msg.includes('socket hang up') ||
    msg.includes('network') ||
    msg.includes('timeout')
  ) {
    return 'network';
  }

  return 'unknown';
}

/**
 * User-facing message for a sheet write failure.
 * Pass the caught error for context-specific advice.
 */
export function getSheetErrorMessage(error: unknown): string {
  const type = classifySheetError(error);
  switch (type) {
    case 'auth':
      return '❌ Не удалось записать в Google таблицу — авторизация устарела. Выполни /reconnect и повтори попытку.';
    case 'not_found':
      return '❌ Не удалось записать в Google таблицу — таблица недоступна или удалена. Проверь её и выполни /reconnect.';
    case 'rate_limit':
      return '⚠️ Google Sheets временно ограничил запросы. Подожди минуту и повтори попытку.';
    case 'network':
      return '🌐 Проблемы с сетью при записи в Google таблицу. Повтори попытку.';
    default:
      return '❌ Не удалось записать в Google таблицу. Повтори попытку, а если не получится — /reconnect.';
  }
}
