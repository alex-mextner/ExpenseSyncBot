// HTML escaping utility to prevent XSS in server-rendered HTML pages.

const HTML_ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * Escapes a value for safe insertion into HTML content.
 * Converts to string first, then replaces &, <, >, ", ' with HTML entities.
 * Returns empty string for null/undefined.
 */
export function escapeHtml(value: unknown): string {
  if (value === null || value === undefined) {
    return '';
  }
  return String(value).replace(/[&<>"']/g, (char) => HTML_ESCAPE_MAP[char] ?? char);
}
