/** Tests for shortenReceiptUrl -- truncates receipt URLs for display */
import { describe, expect, it } from 'bun:test';
import { shortenReceiptUrl } from './url-shortener';

describe('shortenReceiptUrl', () => {
  it('shortens a typical Serbian fiscal receipt URL', () => {
    const url = 'https://suf.rs/v/vl?pib=100049340&dp=02.04.2025&boi=AAABBB123456';
    const result = shortenReceiptUrl(url);
    expect(result).toBe('suf.rs/v/vl?...');
  });

  it('keeps short URLs with query intact', () => {
    const url = 'https://example.com/r?id=123';
    const result = shortenReceiptUrl(url);
    expect(result).toBe('example.com/r?...');
  });

  it('returns hostname + pathname for URLs without query string', () => {
    const url = 'https://receipt.example.com/view/abc';
    const result = shortenReceiptUrl(url);
    expect(result).toBe('receipt.example.com/view/abc');
  });

  it('truncates long pathnames to ~30 chars', () => {
    const url = 'https://example.com/very/long/path/that/exceeds/thirty/characters/here';
    const result = shortenReceiptUrl(url);
    expect(result.length).toBeLessThanOrEqual(65);
    expect(result).toContain('...');
  });

  it('returns first 80 chars + ... for non-URL input', () => {
    const qrData = 'A'.repeat(100);
    const result = shortenReceiptUrl(qrData);
    expect(result).toBe(`${'A'.repeat(80)}...`);
  });

  it('returns short non-URL input as-is', () => {
    const qrData = 'some-short-data';
    const result = shortenReceiptUrl(qrData);
    expect(result).toBe('some-short-data');
  });

  it('handles URL with no pathname', () => {
    const url = 'https://example.com?key=value';
    const result = shortenReceiptUrl(url);
    expect(result).toBe('example.com?...');
  });
});
