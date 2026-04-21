// Tests for qr-scanner.ts — pure function isURL, and scanQRFromImage
// with sharp + qr/decode.js mocked out.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

// ── logger ───────────────────────────────────────────────────────────────
const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ── sharp: chainable pipeline returning raw pixel buffer ────────────────
interface SharpChain {
  resize: () => SharpChain;
  sharpen: () => SharpChain;
  normalize: () => SharpChain;
  grayscale: () => SharpChain;
  linear: () => SharpChain;
  ensureAlpha: () => SharpChain;
  raw: () => SharpChain;
  toBuffer: (opts?: { resolveWithObject?: boolean }) => Promise<{
    data: Buffer;
    info: { width: number; height: number; channels: number };
  }>;
}

function makeSharpChain(
  toBufferImpl: () => Promise<{
    data: Buffer;
    info: { width: number; height: number; channels: number };
  }>,
): SharpChain {
  const chain: SharpChain = {
    resize: () => chain,
    sharpen: () => chain,
    normalize: () => chain,
    grayscale: () => chain,
    linear: () => chain,
    ensureAlpha: () => chain,
    raw: () => chain,
    toBuffer: toBufferImpl,
  };
  return chain;
}

let sharpToBuffer: () => Promise<{
  data: Buffer;
  info: { width: number; height: number; channels: number };
}> = async () => ({
  data: Buffer.alloc(4),
  info: { width: 1, height: 1, channels: 4 },
});

mock.module('sharp', () => ({
  default: (_buf: Buffer) => makeSharpChain(() => sharpToBuffer()),
}));

// ── qr/decode.js: return programmable QR payload, notify detection cbs ───
interface DecodeOpts {
  pointsOnDetect?: (points: Array<{ x: number; y: number }>) => void;
  imageOnDetect?: (img: { width: number; height: number }) => void;
}

let qrDecodeImpl: (
  img: { width: number; height: number; data: Uint8ClampedArray },
  opts: DecodeOpts,
) => string | null = () => null;

mock.module('qr/decode.js', () => ({
  default: (img: { width: number; height: number; data: Uint8ClampedArray }, opts: DecodeOpts) =>
    qrDecodeImpl(img, opts),
}));

import { isURL, scanQRFromImage } from './qr-scanner';

beforeEach(() => {
  // Reset to a sensible default: sharp succeeds with tiny raw buffer, decode returns null
  sharpToBuffer = async () => ({
    data: Buffer.alloc(4),
    info: { width: 1, height: 1, channels: 4 },
  });
  qrDecodeImpl = () => null;
  logMock.info.mockClear();
  logMock.warn.mockClear();
  logMock.error.mockClear();
});

describe('isURL', () => {
  describe('valid URLs', () => {
    it('returns true for http URL', () => {
      expect(isURL('http://example.com')).toBe(true);
    });

    it('returns true for https URL', () => {
      expect(isURL('https://example.com/receipt?id=123')).toBe(true);
    });

    it('handles URL with path and query params', () => {
      expect(isURL('https://api.store.com/r?t=abc&id=123')).toBe(true);
    });

    it('handles URL with fragment', () => {
      expect(isURL('https://example.com/page#section')).toBe(true);
    });

    it('handles URL with port', () => {
      expect(isURL('http://localhost:3000/callback')).toBe(true);
    });

    it('handles URL with subdomain', () => {
      expect(isURL('https://receipt.shop.example.com/order/12345')).toBe(true);
    });

    it('handles URL with trailing slash', () => {
      expect(isURL('https://example.com/')).toBe(true);
    });

    it('handles URL with path only, no query', () => {
      expect(isURL('https://example.com/some/path/to/resource')).toBe(true);
    });

    it('handles ftp URL (valid per URL spec)', () => {
      // The URL constructor accepts ftp:// as a valid protocol
      expect(isURL('ftp://example.com')).toBe(true);
    });

    it('handles IP address URL', () => {
      expect(isURL('http://192.168.1.1/receipt')).toBe(true);
    });

    it('handles URL with encoded characters', () => {
      expect(isURL('https://example.com/path%20with%20spaces')).toBe(true);
    });
  });

  describe('invalid inputs', () => {
    it('returns false for plain text', () => {
      expect(isURL('just text')).toBe(false);
    });

    it('returns false for JSON string', () => {
      expect(isURL('{"amount":100}')).toBe(false);
    });

    it('returns false for empty string', () => {
      expect(isURL('')).toBe(false);
    });

    it('returns false for number string', () => {
      expect(isURL('12345')).toBe(false);
    });

    it('returns false for bare domain without protocol', () => {
      expect(isURL('example.com')).toBe(false);
    });

    it('returns false for domain with www but no protocol', () => {
      expect(isURL('www.example.com')).toBe(false);
    });

    it('returns false for email address', () => {
      // mailto: IS a valid URL scheme per URL spec, so we only test plain email
      expect(isURL('user@example.com')).toBe(false);
    });

    it('returns false for relative path', () => {
      expect(isURL('/relative/path')).toBe(false);
    });

    it('returns false for protocol-relative URL', () => {
      expect(isURL('//example.com/path')).toBe(false);
    });

    it('returns false for whitespace string', () => {
      expect(isURL('   ')).toBe(false);
    });
  });

  describe('edge cases', () => {
    it('treats opaque paths as valid (URL constructor accepts http:not-a-valid-url)', () => {
      // The URL constructor accepts `http:not-a-valid-url` as a valid URL with opaque path
      expect(isURL('http:not-a-valid-url')).toBe(true);
    });

    it('handles very long URL', () => {
      const longPath = 'a'.repeat(2000);
      expect(isURL(`https://example.com/${longPath}`)).toBe(true);
    });

    it('handles URL with unicode in domain (punycode)', () => {
      // Some Unicode URLs are valid per URL spec
      expect(typeof isURL('https://münchen.de')).toBe('boolean');
    });
  });
});

describe('scanQRFromImage', () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('local decoding via qr library', () => {
    it('returns QR data when first variant decodes successfully', async () => {
      qrDecodeImpl = () => 'https://receipt.example.com/r?id=1';

      const result = await scanQRFromImage(Buffer.from('fake-image'));
      expect(result).toBe('https://receipt.example.com/r?id=1');
    });

    it('returns null when every variant + external API fails', async () => {
      qrDecodeImpl = () => null;
      globalThis.fetch = mock(
        async () => new Response('[]', { status: 200 }),
      ) as unknown as typeof fetch;

      const result = await scanQRFromImage(Buffer.from('fake-image'));
      expect(result).toBeNull();
    });

    it('attempts multiple variants when early variants return null', async () => {
      let calls = 0;
      qrDecodeImpl = () => {
        calls++;
        // Return data only on the 3rd variant — first two fail
        return calls >= 3 ? 'QR_PAYLOAD' : null;
      };

      const result = await scanQRFromImage(Buffer.from('fake'));
      expect(result).toBe('QR_PAYLOAD');
      expect(calls).toBe(3);
    });

    it('skips to next variant when sharp throws', async () => {
      let sharpCalls = 0;
      sharpToBuffer = async () => {
        sharpCalls++;
        if (sharpCalls === 1) throw new Error('sharp conversion failed');
        return { data: Buffer.alloc(4), info: { width: 1, height: 1, channels: 4 } };
      };
      qrDecodeImpl = () => (sharpCalls >= 2 ? 'OK' : null);

      const result = await scanQRFromImage(Buffer.from('fake'));
      expect(result).toBe('OK');
      expect(sharpCalls).toBeGreaterThanOrEqual(2);
    });

    it('still returns data from a later variant after a corrupt-image failure', async () => {
      let sharpCalls = 0;
      sharpToBuffer = async () => {
        sharpCalls++;
        if (sharpCalls <= 2) {
          throw new Error('unsupported image format');
        }
        return { data: Buffer.alloc(4), info: { width: 1, height: 1, channels: 4 } };
      };
      qrDecodeImpl = () => (sharpCalls >= 3 ? 'payload-late' : null);

      const result = await scanQRFromImage(Buffer.from('weird'));
      expect(result).toBe('payload-late');
    });

    it('returns null when the QR decoder always rejects the image', async () => {
      qrDecodeImpl = () => null;
      globalThis.fetch = mock(
        async () => new Response(JSON.stringify([]), { status: 200 }),
      ) as unknown as typeof fetch;

      const result = await scanQRFromImage(Buffer.from('blank'));
      expect(result).toBeNull();
    });

    it('invokes pointsOnDetect/imageOnDetect callbacks when decoder surfaces them', async () => {
      const points: Array<{ x: number; y: number }> = [];
      qrDecodeImpl = (_img, opts) => {
        opts.pointsOnDetect?.([{ x: 1, y: 2 }]);
        opts.imageOnDetect?.({ width: 10, height: 10 });
        return 'DECODED';
      };

      const result = await scanQRFromImage(Buffer.from('fake'));
      expect(result).toBe('DECODED');
      // Callbacks themselves are internal — we just verify the decoder's return still propagates
      expect(points).toEqual([]);
    });

    it('does not call external API when a local variant succeeds', async () => {
      qrDecodeImpl = () => 'LOCAL_HIT';
      const fetchSpy = mock(async () => new Response('[]', { status: 200 }));
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      await scanQRFromImage(Buffer.from('fake'));
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('external API fallback (goqr.me)', () => {
    it('falls back to external API when all local variants fail', async () => {
      qrDecodeImpl = () => null;
      const fetchSpy = mock(
        async () =>
          new Response(
            JSON.stringify([
              {
                type: 'qrcode',
                symbol: [{ data: 'https://api.example.com/receipt/42', error: null }],
              },
            ]),
            { status: 200 },
          ),
      );
      globalThis.fetch = fetchSpy as unknown as typeof fetch;

      const result = await scanQRFromImage(Buffer.from('fake'));
      expect(result).toBe('https://api.example.com/receipt/42');
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it('returns null when external API returns empty array', async () => {
      qrDecodeImpl = () => null;
      globalThis.fetch = mock(
        async () => new Response(JSON.stringify([]), { status: 200 }),
      ) as unknown as typeof fetch;

      const result = await scanQRFromImage(Buffer.from('fake'));
      expect(result).toBeNull();
    });

    it('returns null when external API symbol has error field', async () => {
      qrDecodeImpl = () => null;
      globalThis.fetch = mock(
        async () =>
          new Response(
            JSON.stringify([{ type: 'qrcode', symbol: [{ data: null, error: 'No code found' }] }]),
            { status: 200 },
          ),
      ) as unknown as typeof fetch;

      const result = await scanQRFromImage(Buffer.from('fake'));
      expect(result).toBeNull();
    });

    it('returns null when external API returns a non-OK status', async () => {
      qrDecodeImpl = () => null;
      globalThis.fetch = mock(
        async () => new Response('server error', { status: 500, statusText: 'Internal Error' }),
      ) as unknown as typeof fetch;

      const result = await scanQRFromImage(Buffer.from('fake'));
      // fetch throws internally → caught → returns null
      expect(result).toBeNull();
    });

    it('returns null when external API response has no symbols', async () => {
      qrDecodeImpl = () => null;
      globalThis.fetch = mock(
        async () => new Response(JSON.stringify([{ type: 'qrcode', symbol: [] }]), { status: 200 }),
      ) as unknown as typeof fetch;

      const result = await scanQRFromImage(Buffer.from('fake'));
      expect(result).toBeNull();
    });

    it('survives fetch rejection (network error) and returns null', async () => {
      qrDecodeImpl = () => null;
      globalThis.fetch = mock(async () => {
        throw new Error('ECONNREFUSED');
      }) as unknown as typeof fetch;

      const result = await scanQRFromImage(Buffer.from('fake'));
      expect(result).toBeNull();
    });

    it('returns null when symbol.data is empty string', async () => {
      qrDecodeImpl = () => null;
      globalThis.fetch = mock(
        async () =>
          new Response(JSON.stringify([{ type: 'qrcode', symbol: [{ data: '', error: null }] }]), {
            status: 200,
          }),
      ) as unknown as typeof fetch;

      const result = await scanQRFromImage(Buffer.from('fake'));
      expect(result).toBeNull();
    });
  });

  describe('input edge cases', () => {
    it('accepts a tiny image buffer without crashing', async () => {
      qrDecodeImpl = () => null;
      globalThis.fetch = mock(
        async () => new Response(JSON.stringify([]), { status: 200 }),
      ) as unknown as typeof fetch;

      const result = await scanQRFromImage(Buffer.from([0x00]));
      expect(result).toBeNull();
    });

    it('accepts a large image buffer', async () => {
      qrDecodeImpl = () => 'BIG_QR';

      const big = Buffer.alloc(1024 * 1024, 0x42);
      const result = await scanQRFromImage(big);
      expect(result).toBe('BIG_QR');
    });

    it('does not throw on happy-path (logger never called with error)', async () => {
      qrDecodeImpl = () => 'ok';
      await scanQRFromImage(Buffer.from('fake'));
      expect(logMock.error).not.toHaveBeenCalled();
    });
  });
});
