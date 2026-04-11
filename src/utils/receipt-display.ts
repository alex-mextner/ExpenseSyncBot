// Formatters for displaying receipt data in Telegram messages. Full comment
// text lives in DB and Google Sheets; these helpers only shorten it for
// user-facing messages (notifications, summaries, confirmation cards).

import { pluralize } from './pluralize';

/**
 * Truncate an item list for display in Telegram using the project's N+2 rule:
 * if hiding fewer than 3 items is pointless ("и ещё 1..." is wasteful), show
 * everything instead. Only when the hidden count is ≥ 3 do we truncate.
 *
 * Examples with `maxVisible = 3`:
 * - 3 items  → "a, b, c"
 * - 5 items  → "a, b, c, d, e"          (5 ≤ 3 + 2, show all)
 * - 6 items  → "a, b, c и ещё 3 позиции"
 * - 70 items → "a, b, c и ещё 67 позиций"
 */
export function truncateItemsForDisplay(itemNames: string[], maxVisible: number = 3): string {
  if (itemNames.length === 0) return '';

  // N+2 rule: never show "и ещё 1" or "и ещё 2" — just show all items
  if (itemNames.length - maxVisible < 3) {
    return itemNames.join(', ');
  }

  const shown = itemNames.slice(0, maxVisible).join(', ');
  const hidden = itemNames.length - maxVisible;
  const noun = pluralize(hidden, 'позиция', 'позиции', 'позиций');
  return `${shown} и ещё ${hidden} ${noun}`;
}

/**
 * Parse the full comment string that `expense-recorder.buildReceiptComment`
 * writes ("Чек: name1 (qty x price), name2 (...), ...") and return just the
 * display form for Telegram.
 *
 * Returns the original string unchanged if it doesn't match the expected
 * receipt comment shape — this keeps manual-expense comments safe.
 */
export function formatReceiptCommentForTelegram(
  fullComment: string,
  maxVisible: number = 3,
): string {
  const RECEIPT_PREFIX = 'Чек: ';
  if (!fullComment.startsWith(RECEIPT_PREFIX)) return fullComment;

  const body = fullComment.slice(RECEIPT_PREFIX.length);
  if (body.length === 0) return fullComment;

  // Split on ", " — item names in the receipt comment never contain ", "
  // because they're sanitized upstream (normalizeName in ai-extractor).
  const names = body.split(', ').map((entry) => {
    // Strip the "(qty x price)" suffix if present
    const parenIdx = entry.lastIndexOf(' (');
    return parenIdx > 0 ? entry.slice(0, parenIdx) : entry;
  });

  return `${RECEIPT_PREFIX}${truncateItemsForDisplay(names, maxVisible)}`;
}
