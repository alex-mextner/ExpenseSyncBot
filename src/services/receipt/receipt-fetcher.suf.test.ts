// Serbian SUF (suf.purs.gov.rs) receipts without a browser: the QR of a real fixture receipt is
// decoded, its verification page is served from a recorded copy (no network) and must yield the
// receipt journal — the portal renders it server-side, so plain HTTP is enough.

import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { spyOnFetch } from '../../test-utils/mocks/fetch';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({ createLogger: () => logMock, logger: logMock }));

// DNS is not resolved in tests; the SSRF check itself is covered by url-validator.test.ts.
const isUrlSafe = mock((_url: string) => Promise.resolve(true));
mock.module('./url-validator', () => ({ isUrlSafe }));

// Imported after the mocks: static imports are hoisted and would bind the real logger.
const { scanQRFromImage } = await import('./qr-scanner');
const { extractTextFromHTML, fetchReceiptData } = await import('./receipt-fetcher');

const FIXTURES = path.resolve(import.meta.dir, '../../../tests/fixtures/receipts');
/** Recorded 2026-11-20 with a plain GET of the QR URL of shop-3items-847rsd.jpg (CRLF stored as LF). */
const RECORDED_PAGE = readFileSync(path.join(FIXTURES, 'suf-shop-3items-847rsd.html'), 'utf-8');

beforeEach(() => {
  logMock.error.mockClear();
});

afterEach(() => {
  mock.restore();
});

describe('SUF receipt from the fixture corpus', () => {
  it('fetches the receipt journal of a real SUF QR over plain HTTP', async () => {
    // Stubbed before the decode: if every local decode missed, qr-scanner would upload the
    // photo to an online QR API. Only the SUF verification page is served; anything else throws.
    const fetchSpy = spyOnFetch(async (input) => {
      if (new URL(String(input)).hostname !== 'suf.purs.gov.rs') {
        throw new Error(`unexpected request: ${String(input)}`);
      }
      return new Response(RECORDED_PAGE, {
        headers: { 'content-type': 'text/html; charset=utf-8' },
      });
    });

    const qr = await scanQRFromImage(readFileSync(path.join(FIXTURES, 'shop-3items-847rsd.jpg')));
    expect(qr).not.toBeNull();
    const url = new URL(qr ?? '');
    expect(url.hostname).toBe('suf.purs.gov.rs');
    expect(url.pathname).toBe('/v/');
    expect(fetchSpy).not.toHaveBeenCalled();

    const html = await fetchReceiptData(qr ?? '');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(String(fetchSpy.mock.calls[0]?.[0])).toBe(qr ?? '');

    const text = extractTextFromHTML(html);
    expect(text).toContain('ФИСКАЛНИ РАЧУН');
    expect(text).toContain('dm drogerie markt');
    expect(text).toContain('dmBio ulje susama 250ml');
    expect(text).toContain('essence olovka za oci');
    expect(text).toContain('Profissimo pap./pec.30kom');
    expect(text).toContain('Укупан износ: 847,00');
    expect(text).toContain('ПФР време: 24.11.2025. 15:48:23');
    // The page's own labels are numeric references (`&#x417;&#x410;…`), decoded to text.
    expect(text).toContain('Адреса ЗАПЛАЊСКА 32 Град БЕОГРАД (ВОЖДОВАЦ)');
    expect(text).not.toContain('&#');
    expect(logMock.error).not.toHaveBeenCalled();
  });
});
