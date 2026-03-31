// Tests for receipt-fetcher.ts — uses dependency injection for browser

import { afterEach, describe, expect, it, mock } from 'bun:test';

const isUrlSafe = mock(() => Promise.resolve(true));
mock.module('./url-validator', () => ({ isUrlSafe }));

import { NetworkError } from '../../errors';
import { extractTextFromHTML, fetchReceiptData } from './receipt-fetcher';

// Minimal page interface matching what fetchReceiptData needs
interface FakePage {
  goto: ReturnType<typeof mock>;
  waitForTimeout: ReturnType<typeof mock>;
  content: ReturnType<typeof mock>;
  close: ReturnType<typeof mock>;
}

interface FakeContext {
  newPage: () => Promise<FakePage>;
  close: ReturnType<typeof mock>;
}

interface FakeBrowser {
  newContext: (opts?: unknown) => Promise<FakeContext>;
}

type BrowserFactory = () => Promise<FakeBrowser>;

// Build a fake browser factory for tests
function makeFakeBrowser(opts: { content?: string; gotoError?: Error } = {}): BrowserFactory {
  return async () => ({
    newContext: async (_opts?: unknown): Promise<FakeContext> => ({
      newPage: async (): Promise<FakePage> => ({
        goto: opts.gotoError
          ? mock(() => Promise.reject(opts.gotoError))
          : mock(() => Promise.resolve()),
        waitForTimeout: mock(() => Promise.resolve()),
        content: mock(() =>
          Promise.resolve(
            opts.content ??
              '<html><body>Receipt content with enough data to pass length check ' +
                'and more text to make it over 100 chars easily yes indeed</body></html>',
          ),
        ),
        close: mock(() => Promise.resolve()),
      }),
      close: mock(() => Promise.resolve()),
    }),
  });
}

afterEach(() => {
  mock.restore();
});

describe('fetchReceiptData', () => {
  describe('non-URL input (pass-through)', () => {
    it('returns plain QR data as-is when not a URL', async () => {
      const json = '{"amount":1500,"store":"Supermarket"}';
      const result = await fetchReceiptData(json, makeFakeBrowser());
      expect(result).toBe(json);
    });

    it('returns plain text as-is', async () => {
      const text = 'plain text content without URL';
      const result = await fetchReceiptData(text, makeFakeBrowser());
      expect(result).toBe(text);
    });

    it('returns numbers-as-string as-is', async () => {
      const num = '123456789';
      const result = await fetchReceiptData(num, makeFakeBrowser());
      expect(result).toBe(num);
    });

    it('does not call browser for non-URL input', async () => {
      let browserCalled = false;
      const trackingBrowser = async (): Promise<FakeBrowser> => {
        browserCalled = true;
        return makeFakeBrowser()();
      };
      await fetchReceiptData('plain text', trackingBrowser);
      expect(browserCalled).toBe(false);
    });

    it('handles empty string input (not a URL, returns as-is)', async () => {
      const result = await fetchReceiptData('', makeFakeBrowser());
      expect(result).toBe('');
    });
  });

  describe('URL input — success cases', () => {
    it('returns page HTML content for valid URL', async () => {
      const result = await fetchReceiptData('https://example.com/receipt', makeFakeBrowser());
      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('returned content contains the faked page content', async () => {
      const fakeContent =
        '<html><body>My Receipt Store: Item 1 - 100 EUR, Item 2 - 200 EUR, Total: 300 EUR date: 2026-01-01</body></html>';
      const result = await fetchReceiptData(
        'https://example.com/r',
        makeFakeBrowser({ content: fakeContent }),
      );
      expect(result).toBe(fakeContent);
    });

    it('calls browser for http URL', async () => {
      let browserCalled = false;
      const trackingBrowser = async (): Promise<FakeBrowser> => {
        browserCalled = true;
        return makeFakeBrowser()();
      };
      await fetchReceiptData('http://example.com/receipt', trackingBrowser);
      expect(browserCalled).toBe(true);
    });

    it('handles URL with query params', async () => {
      const result = await fetchReceiptData('https://store.com/r?id=abc&t=xyz', makeFakeBrowser());
      expect(typeof result).toBe('string');
    });
  });

  describe('URL input — NetworkError cases (TDD: these define new error behavior)', () => {
    it('throws NetworkError when page content is too short (< 100 chars)', async () => {
      const shortContent = '<html><body>Short</body></html>';
      await expect(
        fetchReceiptData('https://example.com/empty', makeFakeBrowser({ content: shortContent })),
      ).rejects.toBeInstanceOf(NetworkError);
    });

    it('throws NetworkError when page content is exactly empty', async () => {
      await expect(
        fetchReceiptData('https://example.com/empty', makeFakeBrowser({ content: '' })),
      ).rejects.toBeInstanceOf(NetworkError);
    });

    it('throws NetworkError when browser navigation fails', async () => {
      const navError = new Error('net::ERR_CONNECTION_REFUSED');
      await expect(
        fetchReceiptData(
          'https://unreachable.example.com',
          makeFakeBrowser({ gotoError: navError }),
        ),
      ).rejects.toBeInstanceOf(NetworkError);
    });

    it('NetworkError from navigation has NAVIGATION_FAILED code', async () => {
      const navError = new Error('net::ERR_CONNECTION_REFUSED');
      try {
        await fetchReceiptData(
          'https://unreachable.example.com',
          makeFakeBrowser({ gotoError: navError }),
        );
        throw new Error('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkError);
        if (err instanceof NetworkError) {
          expect(err.code).toBe('NAVIGATION_FAILED');
        }
      }
    });

    it('NetworkError from empty content has EMPTY_CONTENT code', async () => {
      const shortContent = '<html></html>';
      try {
        await fetchReceiptData(
          'https://example.com/empty',
          makeFakeBrowser({ content: shortContent }),
        );
        throw new Error('Should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(NetworkError);
        if (err instanceof NetworkError) {
          expect(err.code).toBe('EMPTY_CONTENT');
        }
      }
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
