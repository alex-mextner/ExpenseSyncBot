/** Receipt fetcher — loads receipt/QR URLs over plain HTTP (no browser) and extracts text from HTML */
// node:util's TextDecoder is Bun's global one; its typing accepts any charset label (bun-types lists three).
import { TextDecoder } from 'node:util';
import { NetworkError } from '../../errors';
import { isURL } from './qr-scanner';
import { isUrlSafe } from './url-validator';

/** Whole request including redirects and the body. */
const FETCH_TIMEOUT_MS = 30_000;
const MAX_REDIRECTS = 5;
/** A fiscal receipt page is tens of KB; anything this large is not a receipt. */
const MAX_BODY_BYTES = 5 * 1024 * 1024;
/** Minimum text of a receipt: the page's visible text for HTML, the body otherwise. */
const MIN_CONTENT_LENGTH = 100;
/** HTML requires a `<meta charset>` to sit in the first 1024 bytes. */
const META_CHARSET_SCAN_BYTES = 1024;
/** `charset=` of a Content-Type header, or of `<meta charset>` / `<meta http-equiv content>`. */
const CHARSET = /charset=["']?([\w-]+)/i;

// Fiscal portals answer browsers; a bare client UA can get a stripped or blocked page.
const REQUEST_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,text/plain;q=0.8',
};

const TEXT_CONTENT_TYPE = /^(text\/|application\/(json|xhtml\+xml|xml)\b)/i;

/**
 * GET the URL, following redirects by hand so every hop passes the SSRF check
 * (fetch's own redirect handling would follow a public URL into a private address).
 */
async function getFollowingSafeRedirects(url: string, signal: AbortSignal): Promise<Response> {
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!(await isUrlSafe(current))) {
      throw new NetworkError(`URL blocked by SSRF protection: ${current}`, 'SSRF_BLOCKED');
    }
    const response = await fetch(current, { headers: REQUEST_HEADERS, redirect: 'manual', signal });
    const location = response.headers.get('location');
    if (response.status < 300 || response.status >= 400 || !location) return response;
    await response.body?.cancel();
    current = new URL(location, current).href;
  }
  throw new NetworkError(`Too many redirects: ${url}`, 'TOO_MANY_REDIRECTS');
}

/**
 * Read the body up to MAX_BODY_BYTES, decoded with the charset the server declared, or else
 * the one a `<meta>` tag in the first KB declares (as a browser would), or else UTF-8.
 */
async function readBodyText(response: Response): Promise<string> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > MAX_BODY_BYTES) {
    await response.body?.cancel();
    throw new NetworkError(`Response too large: ${declared} bytes`, 'TOO_LARGE');
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > MAX_BODY_BYTES) {
        throw new NetworkError(`Response too large: over ${MAX_BODY_BYTES} bytes`, 'TOO_LARGE');
      }
      chunks.push(chunk);
    }
  }
  const body = Buffer.concat(chunks);
  const charset =
    CHARSET.exec(response.headers.get('content-type') ?? '')?.[1] ??
    CHARSET.exec(body.toString('latin1', 0, META_CHARSET_SCAN_BYTES))?.[1];
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset ?? 'utf-8');
  } catch {
    // An unknown charset label: UTF-8 is what nearly every receipt portal serves.
    decoder = new TextDecoder('utf-8');
  }
  return decoder.decode(body);
}

/** True for an HTML document; raw pages may write `<HTML>` or `<!doctype html>`. */
export function isHTMLDocument(content: string): boolean {
  return /<html[\s>]|<!doctype\s+html/i.test(content);
}

/**
 * Fetch receipt data from QR code data
 * @param qrData - QR code data (URL or text/JSON)
 * @returns Receipt page HTML (or JSON/text body), or the QR data itself when it is not a URL
 * @throws NetworkError if the URL is blocked, cannot be loaded, is not text or is empty
 */
export async function fetchReceiptData(qrData: string): Promise<string> {
  // Not a URL: the QR carries the data itself (JSON or other text)
  if (!isURL(qrData)) return qrData;

  let content: string;
  try {
    const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
    const response = await getFollowingSafeRedirects(qrData, signal);
    if (!response.ok) {
      await response.body?.cancel();
      throw new NetworkError(`Receipt page answered HTTP ${response.status}`, 'HTTP_ERROR');
    }
    const contentType = response.headers.get('content-type');
    if (contentType && !TEXT_CONTENT_TYPE.test(contentType)) {
      await response.body?.cancel();
      throw new NetworkError(`Not a text page: ${contentType}`, 'UNSUPPORTED_CONTENT');
    }
    content = await readBodyText(response);
  } catch (error) {
    if (error instanceof NetworkError) throw error;
    throw new NetworkError(
      `Receipt fetch failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
      'FETCH_FAILED',
      error,
    );
  }

  // An HTML page is judged by its text: a page that only a browser can render (a script
  // app shell) is long markup with next to no text, and must fail here so a photo
  // receipt falls back to OCR instead of parsing an empty page.
  const text = isHTMLDocument(content) ? extractTextFromHTML(content) : content;
  if (text.length < MIN_CONTENT_LENGTH) {
    throw new NetworkError('Page loaded but content is empty or too short', 'EMPTY_CONTENT');
  }
  return content;
}

/** Elements whose body is code, not text: dropped with their content. */
const RAW_TEXT_ELEMENTS = ['script', 'style'];

function decodeCodePoint(match: string, codePoint: number): string {
  return codePoint > 0 && codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
}

/** What one scan step adds to the text, and where the scan resumes. */
interface ScanStep {
  text: string;
  next: number;
}

/**
 * Skip the <script>/<style> element opening at `lt`, or null when none opens there.
 * An unclosed one runs to the end of the page.
 */
function skipRawElement(html: string, lt: number): ScanStep | null {
  const rawElement = RAW_TEXT_ELEMENTS.find(
    (name) =>
      html.slice(lt + 1, lt + 1 + name.length).toLowerCase() === name &&
      /^[\s/>]?$/.test(html.charAt(lt + 1 + name.length)),
  );
  if (!rawElement) return null;
  const endTag = new RegExp(`</${rawElement}`, 'gi');
  endTag.lastIndex = lt + 1 + rawElement.length;
  const end = endTag.exec(html);
  const close = end ? html.indexOf('>', end.index) : -1;
  if (close === -1) return { text: '', next: html.length };
  return { text: ' ', next: close + 1 };
}

/**
 * Steps over the tag or literal `<` at each `<` the scan reaches, in increasing order.
 * It keeps the next `>` at or after the scan point (-1 once the page has none left) and the last
 * `<` before it. Both are recomputed only once the scan passes that `>`, over ranges that do not
 * overlap, so a page of unclosed `<` costs one pass, not one per `<`.
 */
function createTagStepper(html: string): (lt: number) => ScanStep {
  let nextGt = 0;
  let lastLtBeforeGt = -1;
  return (lt) => {
    if (nextGt !== -1 && nextGt <= lt) {
      nextGt = html.indexOf('>', lt + 1);
      if (nextGt !== -1) lastLtBeforeGt = html.lastIndexOf('<', nextGt);
    }
    if (nextGt === -1) return { text: html.slice(lt), next: html.length };
    // Another `<` before the `>`: this one is text, as a browser reads it.
    if (lastLtBeforeGt > lt) return { text: '<', next: lt + 1 };
    return { text: ' ', next: nextGt + 1 };
  };
}

/**
 * Extract the visible text of an HTML page: tags removed, <script>/<style> blocks dropped with
 * their bodies, entities decoded, whitespace collapsed.
 *
 * The input is a raw page from any URL a group member sends (up to 5 MB), so this is one forward
 * scan with `indexOf` and no backtracking regex: `<[^>]+>` or a lazy `<script>[\s\S]*?</script>`
 * is quadratic on a page of unclosed `<` and would block the event loop for minutes.
 * A `<` that another `<` follows before any `>` is text, as in a browser; an unclosed
 * <script>/<style> drops the rest of the page. The result is plain text — parsed as receipt
 * data, never rendered as HTML — so this is not an HTML-injection sink.
 */
export function extractTextFromHTML(html: string): string {
  const parts: string[] = [];
  const stepOverTag = createTagStepper(html);
  let position = 0;
  while (position < html.length) {
    const lt = html.indexOf('<', position);
    if (lt === -1) {
      parts.push(html.slice(position));
      break;
    }
    parts.push(html.slice(position, lt));
    const step = skipRawElement(html, lt) ?? stepOverTag(lt);
    parts.push(step.text);
    position = step.next;
  }

  // Decode entities, &amp; LAST so `&amp;lt;` stays the literal text `&lt;`. Raw pages encode
  // non-ASCII as numeric references (SUF writes Cyrillic labels as `&#x423;`).
  return parts
    .join('')
    .replace(/&#x([0-9a-f]{1,6});/gi, (match, hex: string) =>
      decodeCodePoint(match, Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d{1,7});/g, (match, decimal: string) => decodeCodePoint(match, Number(decimal)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}
