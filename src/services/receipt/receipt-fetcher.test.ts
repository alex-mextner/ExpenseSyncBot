// Tests for receipt-fetcher.ts — plain-HTTP receipt fetching (fetch stubbed, no network) and HTML text extraction

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';

const isUrlSafe = mock((_url: string) => Promise.resolve(true));
mock.module('./url-validator', () => ({ isUrlSafe }));

import { NetworkError } from '../../errors';
import { spyOnFetch } from '../../test-utils/mocks/fetch';
import { extractTextFromHTML, fetchReceiptData } from './receipt-fetcher';

const RECEIPT_HTML =
  '<html><body>Receipt content with enough data to pass length check ' +
  'and more text to make it over 100 chars easily yes indeed</body></html>';

function htmlResponse(body: string, init: ResponseInit = {}): Response {
  return new Response(body, {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    ...init,
  });
}

function redirectResponse(location: string): Response {
  return new Response(null, { status: 302, headers: { location } });
}

/** Stub fetch with one response per call, in order; records the requested URLs. */
function stubFetch(...responses: Array<Response | Error>) {
  const requested: string[] = [];
  const inits: Array<RequestInit | undefined> = [];
  const spy = spyOnFetch(async (input, init) => {
    requested.push(String(input));
    inits.push(init);
    const next = responses.shift();
    if (next === undefined) throw new Error('unexpected fetch');
    if (next instanceof Error) throw next;
    return next;
  });
  return { spy, requested, inits };
}

async function rejectionCode(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(NetworkError);
    return err instanceof NetworkError ? err.code : undefined;
  }
  throw new Error('Should have thrown');
}

beforeEach(() => {
  isUrlSafe.mockClear();
  isUrlSafe.mockImplementation(() => Promise.resolve(true));
});

afterEach(() => {
  mock.restore();
});

describe('fetchReceiptData', () => {
  describe('non-URL input (pass-through)', () => {
    it('returns QR data that is not a URL as-is, without a request', async () => {
      const { spy } = stubFetch();
      for (const data of ['{"amount":1500,"store":"Supermarket"}', 'plain text', '123456789', '']) {
        expect(await fetchReceiptData(data)).toBe(data);
      }
      expect(spy).not.toHaveBeenCalled();
    });
  });

  describe('URL input — success cases', () => {
    it('returns the page HTML of a receipt URL', async () => {
      const { requested } = stubFetch(htmlResponse(RECEIPT_HTML));
      expect(await fetchReceiptData('https://example.com/receipt')).toBe(RECEIPT_HTML);
      expect(requested).toEqual(['https://example.com/receipt']);
    });

    it('sends a browser user agent and handles redirects itself', async () => {
      const { inits } = stubFetch(htmlResponse(RECEIPT_HTML));
      await fetchReceiptData('http://example.com/receipt');
      const init = inits[0];
      expect(init?.redirect).toBe('manual');
      expect(new Headers(init?.headers).get('user-agent')).toContain('Mozilla/5.0');
      expect(init?.signal).toBeInstanceOf(AbortSignal);
    });

    it('keeps query parameters of the URL', async () => {
      const { requested } = stubFetch(htmlResponse(RECEIPT_HTML));
      await fetchReceiptData('https://store.com/r?id=abc&t=xyz');
      expect(requested).toEqual(['https://store.com/r?id=abc&t=xyz']);
    });

    it('returns a JSON body (portal data endpoints answer JSON)', async () => {
      const json = JSON.stringify({ total: 847, items: ['a', 'b', 'c'], padding: 'x'.repeat(100) });
      stubFetch(new Response(json, { headers: { 'content-type': 'application/json' } }));
      expect(await fetchReceiptData('https://api.store.com/receipt/1')).toBe(json);
    });

    it('decodes the body with the charset the server declares', async () => {
      // "Итого" in windows-1251, padded past the minimum length
      const bytes = new Uint8Array([0xc8, 0xf2, 0xee, 0xe3, 0xee, ...new Array(120).fill(0x20)]);
      stubFetch(
        new Response(bytes, { headers: { 'content-type': 'text/html; charset=windows-1251' } }),
      );
      expect(await fetchReceiptData('https://check.example.ru/r')).toStartWith('Итого');
    });

    it('decodes with a <meta> charset when the header declares none', async () => {
      const head = Buffer.from(
        '<!DOCTYPE html><html><head><meta charset="windows-1251"></head><body>',
        'latin1',
      );
      const total = Buffer.from([0xc8, 0xf2, 0xee, 0xe3, 0xee]); // "Итого" in windows-1251
      const tail = Buffer.from(`${' line 847,00'.repeat(10)}</body></html>`, 'latin1');
      stubFetch(
        new Response(Buffer.concat([head, total, tail]), {
          headers: { 'content-type': 'text/html' },
        }),
      );
      const html = await fetchReceiptData('https://check.example.ru/r');
      expect(extractTextFromHTML(html)).toStartWith('Итого line 847,00');
    });

    it('prefers the header charset over a <meta> one', async () => {
      const page = `<!DOCTYPE html><html><head><meta charset="windows-1251"></head><body>Итого${' line 847,00'.repeat(10)}</body></html>`;
      stubFetch(htmlResponse(page));
      expect(await fetchReceiptData('https://check.example.ru/r')).toBe(page);
    });

    it('follows a redirect after checking the target', async () => {
      const { requested } = stubFetch(
        redirectResponse('/v/receipt?id=1'),
        htmlResponse(RECEIPT_HTML),
      );
      expect(await fetchReceiptData('https://receipt.example.com/short')).toBe(RECEIPT_HTML);
      expect(requested).toEqual([
        'https://receipt.example.com/short',
        'https://receipt.example.com/v/receipt?id=1',
      ]);
      expect(isUrlSafe.mock.calls.map(([url]) => url)).toEqual(requested);
    });
  });

  describe('URL input — NetworkError cases', () => {
    it('blocks a URL that fails the SSRF check without a request', async () => {
      isUrlSafe.mockImplementation(() => Promise.resolve(false));
      const { spy } = stubFetch();
      expect(await rejectionCode(fetchReceiptData('https://internal.corp/r'))).toBe('SSRF_BLOCKED');
      expect(spy).not.toHaveBeenCalled();
    });

    it('blocks a redirect into a private address', async () => {
      isUrlSafe.mockImplementation((url) => Promise.resolve(!url.startsWith('http://10.')));
      const { requested } = stubFetch(redirectResponse('http://10.0.0.1/admin'));
      expect(await rejectionCode(fetchReceiptData('https://pay.example.com/r'))).toBe(
        'SSRF_BLOCKED',
      );
      expect(requested).toEqual(['https://pay.example.com/r']);
    });

    it('gives up after too many redirects', async () => {
      stubFetch(...Array.from({ length: 6 }, (_, i) => redirectResponse(`/hop${i}`)));
      expect(await rejectionCode(fetchReceiptData('https://pay.example.com/loop'))).toBe(
        'TOO_MANY_REDIRECTS',
      );
    });

    it('rejects an HTTP error status', async () => {
      stubFetch(htmlResponse(RECEIPT_HTML, { status: 404 }));
      expect(await rejectionCode(fetchReceiptData('https://example.com/missing'))).toBe(
        'HTTP_ERROR',
      );
    });

    it('rejects a body that is not text (image, PDF)', async () => {
      stubFetch(new Response(new Uint8Array(200), { headers: { 'content-type': 'image/png' } }));
      expect(await rejectionCode(fetchReceiptData('https://example.com/photo.png'))).toBe(
        'UNSUPPORTED_CONTENT',
      );
    });

    it('rejects a body declared larger than 5 MB', async () => {
      stubFetch(
        htmlResponse(RECEIPT_HTML, {
          headers: { 'content-type': 'text/html', 'content-length': String(6 * 1024 * 1024) },
        }),
      );
      expect(await rejectionCode(fetchReceiptData('https://example.com/huge'))).toBe('TOO_LARGE');
    });

    it('rejects a streamed body that grows past 5 MB', async () => {
      const chunk = new Uint8Array(1024 * 1024).fill(0x61);
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          for (let i = 0; i < 6; i++) controller.enqueue(chunk);
          controller.close();
        },
      });
      stubFetch(new Response(stream, { headers: { 'content-type': 'text/html' } }));
      expect(await rejectionCode(fetchReceiptData('https://example.com/stream'))).toBe('TOO_LARGE');
    });

    it('wraps a network failure as FETCH_FAILED', async () => {
      stubFetch(new Error('Unable to connect'));
      expect(await rejectionCode(fetchReceiptData('https://unreachable.example.com'))).toBe(
        'FETCH_FAILED',
      );
    });

    it('rejects a page whose content is shorter than 100 chars', async () => {
      stubFetch(htmlResponse('<html><body>Short</body></html>'));
      expect(await rejectionCode(fetchReceiptData('https://example.com/empty'))).toBe(
        'EMPTY_CONTENT',
      );
    });

    it('rejects an empty page', async () => {
      stubFetch(htmlResponse(''));
      expect(await rejectionCode(fetchReceiptData('https://example.com/empty'))).toBe(
        'EMPTY_CONTENT',
      );
    });

    it('rejects a page only a browser can render (script app shell)', async () => {
      // Long markup, no text: without this the receipt would parse as empty instead of
      // a photo receipt falling back to OCR.
      const shell =
        '<!doctype html><html><head><script src="/app.js"></script>' +
        `<script>window.__STATE__=${JSON.stringify('x'.repeat(500))}</script></head>` +
        '<body><div id="root"></div><noscript>Enable JavaScript</noscript></body></html>';
      stubFetch(htmlResponse(shell));
      expect(await rejectionCode(fetchReceiptData('https://verify.example.me/ic/'))).toBe(
        'EMPTY_CONTENT',
      );
    });

    it('judges an upper-case HTML page by its text too', async () => {
      const page = `<HTML><HEAD><STYLE>${'.c{}'.repeat(100)}</STYLE></HEAD><BODY>Short</BODY></HTML>`;
      stubFetch(htmlResponse(page));
      expect(await rejectionCode(fetchReceiptData('https://example.com/upper'))).toBe(
        'EMPTY_CONTENT',
      );
    });
  });
});

describe('extractTextFromHTML', () => {
  describe('HTML tag removal', () => {
    it('strips basic HTML tags', () => {
      const result = extractTextFromHTML('<p>Hello world</p>');
      expect(result).toBe('Hello world');
    });

    it('removes script tags and their content', () => {
      const html = '<html><script>var x = 1;</script><p>Content</p></html>';
      const result = extractTextFromHTML(html);
      expect(result).not.toContain('var x');
      expect(result).toContain('Content');
    });

    it('removes style tags and their content', () => {
      const html = '<html><style>.cls { color: red; }</style><p>Text</p></html>';
      const result = extractTextFromHTML(html);
      expect(result).not.toContain('.cls');
      expect(result).toContain('Text');
    });

    it('handles nested tags', () => {
      const result = extractTextFromHTML('<div><p><b>Bold text</b> and normal</p></div>');
      expect(result).toContain('Bold text');
      expect(result).toContain('and normal');
    });
  });

  describe('security — sanitization edge cases', () => {
    // End tags may carry trailing whitespace (`</script >`); a strict `</script>`
    // pattern would leave the block (and its JS body) in the extracted text.
    it('removes a script block whose end tag has trailing whitespace', () => {
      const result = extractTextFromHTML('<script>steal()</script ><p>Total 42</p>');
      expect(result).not.toContain('steal');
      expect(result).toContain('Total 42');
    });

    // A partial/nested script must not reassemble into a live tag whose body
    // survives — the removal loops to a fixpoint.
    it('removes a reassembling nested script block', () => {
      const result = extractTextFromHTML('<scr<script>evil()</script>ipt><p>Sum 7</p>');
      expect(result).not.toContain('evil');
      expect(result).toContain('Sum 7');
    });

    // js/bad-tag-filter: an end tag with junk before `>` (`</script foo>`) must still
    // close the block. The previous `</script\s*>` pattern would leave the body in.
    it('removes a script block whose end tag carries junk before >', () => {
      const result = extractTextFromHTML('<script>steal()</script foo><p>Due 8</p>');
      expect(result).not.toContain('steal');
      expect(result).toContain('Due 8');
    });

    // Mirror of the script cases for <style>: same end-tag-whitespace and
    // reassembly handling must hold, so a regression in the style branch is caught.
    it('removes a style block whose end tag has trailing whitespace', () => {
      const result = extractTextFromHTML('<style>.x{color:red}</style ><p>Net 9</p>');
      expect(result).not.toContain('color:red');
      expect(result).toContain('Net 9');
    });

    it('removes a reassembling nested style block', () => {
      const result = extractTextFromHTML('<sty<style>.y{}</style>le><p>Tax 3</p>');
      expect(result).not.toContain('.y{}');
      expect(result).toContain('Tax 3');
    });

    // &amp; is decoded LAST so `&amp;lt;` stays the literal text `&lt;` instead of
    // double-unescaping into a real `<`.
    it('does not double-unescape &amp;lt; into <', () => {
      expect(extractTextFromHTML('&amp;lt;b&amp;gt;')).toBe('&lt;b&gt;');
    });

    // Plain-text output on deeply nested input: the generic `<[^>]+>` flatten is a
    // single global pass that removes every complete tag, so no angle brackets
    // remain regardless of nesting depth (and there is no superlinear loop to abuse).
    it('returns tag-free text on deeply nested input', () => {
      const deep = `${'<div>'.repeat(5000)}Amount 5${'</div>'.repeat(5000)}`;
      const result = extractTextFromHTML(deep);
      expect(result).toContain('Amount 5');
      expect(result).not.toContain('<');
      expect(result).not.toContain('>');
    });

    // The input is a raw page from any URL a group member posts. A backtracking tag regex
    // (`<[^>]+>`, a lazy `<script>…</script>`) is quadratic on these and blocks the bot.
    it.each([
      ['unclosed <', `<html>${'<'.repeat(1_000_000)}`],
      ['unclosed <script>', `<html>${'<script>'.repeat(150_000)}`],
      ['unclosed <style>', `<html>${'<style>'.repeat(150_000)}`],
      ['many < before one >', `<html>${`<${'x'.repeat(100)}`.repeat(10_000)}>`],
    ])('extracts a 1 MB page of %s in linear time', (_name, page) => {
      const started = performance.now();
      extractTextFromHTML(page);
      expect(performance.now() - started).toBeLessThan(1000);
    });

    it('reads a < that another < follows before any > as text', () => {
      expect(extractTextFromHTML('a < b <i>c</i>')).toBe('a < b c');
    });

    it('drops the rest of the page after an unclosed <script>', () => {
      expect(extractTextFromHTML('<p>Total 5</p><script>steal(); <p>x</p>')).toBe('Total 5');
    });
  });

  describe('HTML entity decoding', () => {
    it('decodes &nbsp; to space', () => {
      const result = extractTextFromHTML('Hello&nbsp;World');
      expect(result).toContain('Hello World');
    });

    it('decodes &amp; to ampersand', () => {
      const result = extractTextFromHTML('Fish &amp; Chips');
      expect(result).toBe('Fish & Chips');
    });

    it('decodes &lt; to less-than', () => {
      const result = extractTextFromHTML('5 &lt; 10');
      expect(result).toBe('5 < 10');
    });

    it('decodes &gt; to greater-than', () => {
      const result = extractTextFromHTML('10 &gt; 5');
      expect(result).toBe('10 > 5');
    });

    it('decodes &quot; to double quote', () => {
      const result = extractTextFromHTML('He said &quot;hello&quot;');
      expect(result).toBe('He said "hello"');
    });

    it('decodes &#39; to single quote', () => {
      const result = extractTextFromHTML('It&#39;s fine');
      expect(result).toBe("It's fine");
    });

    it('decodes numeric references (raw pages encode non-ASCII this way)', () => {
      expect(extractTextFromHTML('&#x423;&#x43A;&#x443;&#x43F;&#x430;&#x43D; &#1080;&#1079;')).toBe(
        'Укупан из',
      );
    });

    it('keeps an out-of-range numeric reference as text', () => {
      expect(extractTextFromHTML('a &#x110000; b &#0; c')).toBe('a &#x110000; b &#0; c');
    });

    it('does not double-unescape &amp;#x41F; into a character', () => {
      expect(extractTextFromHTML('&amp;#x41F;')).toBe('&#x41F;');
    });
  });

  describe('whitespace normalization', () => {
    it('collapses multiple spaces into one', () => {
      const result = extractTextFromHTML('Hello   World');
      expect(result).toBe('Hello World');
    });

    it('trims leading and trailing whitespace', () => {
      const result = extractTextFromHTML('  Hello World  ');
      expect(result).toBe('Hello World');
    });

    it('normalizes newlines to spaces', () => {
      const html = '<p>Line 1</p>\n<p>Line 2</p>';
      const result = extractTextFromHTML(html);
      // Tags removed, newline between paragraphs collapsed
      expect(result).toContain('Line 1');
      expect(result).toContain('Line 2');
    });
  });

  describe('edge cases', () => {
    it('handles empty string', () => {
      expect(extractTextFromHTML('')).toBe('');
    });

    it('handles plain text without HTML', () => {
      const text = 'Just plain text here';
      expect(extractTextFromHTML(text)).toBe(text);
    });

    it('handles HTML with no text content', () => {
      const result = extractTextFromHTML('<html><head></head><body></body></html>');
      expect(result.trim()).toBe('');
    });

    it('strips multiline script blocks', () => {
      const html =
        '<p>Before</p><script type="text/javascript">\nvar x = 1;\nvar y = 2;\n</script><p>After</p>';
      const result = extractTextFromHTML(html);
      expect(result).not.toContain('var x');
      expect(result).toContain('Before');
      expect(result).toContain('After');
    });
  });
});
