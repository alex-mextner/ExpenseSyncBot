/** Truncate receipt URLs for display in the streaming scanner UI */

const MAX_PATH_LENGTH = 30;
const MAX_NON_URL_LENGTH = 80;

/**
 * Shorten a receipt URL (or QR data) for display.
 * URLs: hostname + truncated pathname + "?..." if query present.
 * Non-URLs: first 80 chars + "..."
 */
export function shortenReceiptUrl(urlOrQr: string): string {
  let parsed: URL;
  try {
    parsed = new URL(urlOrQr);
  } catch {
    if (urlOrQr.length <= MAX_NON_URL_LENGTH) return urlOrQr;
    return `${urlOrQr.substring(0, MAX_NON_URL_LENGTH)}...`;
  }

  let pathname = parsed.pathname;
  if (pathname === '/') pathname = '';

  if (pathname.length > MAX_PATH_LENGTH) {
    const start = pathname.substring(0, 15);
    const end = pathname.substring(pathname.length - 12);
    pathname = `${start}...${end}`;
  }

  const base = `${parsed.hostname}${pathname}`;
  const hasQuery = parsed.search.length > 1;

  return hasQuery ? `${base}?...` : base;
}
