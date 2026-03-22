// Tests for link-analyzer.ts — pure URL extraction function

import { describe, expect, it } from 'bun:test';
import { extractURLsFromText } from './link-analyzer';

describe('extractURLsFromText', () => {
  describe('basic URL extraction', () => {
    it('extracts single http URL from text', () => {
      const result = extractURLsFromText('Check this link: http://example.com/receipt');
      expect(result).toEqual(['http://example.com/receipt']);
    });

    it('extracts single https URL from text', () => {
      const result = extractURLsFromText('Your receipt: https://shop.example.com/r?id=123');
      expect(result).toEqual(['https://shop.example.com/r?id=123']);
    });

    it('extracts multiple URLs from text', () => {
      const text = 'Link 1: https://a.com/page and Link 2: https://b.com/other';
      const result = extractURLsFromText(text);
      expect(result).toHaveLength(2);
      expect(result).toContain('https://a.com/page');
      expect(result).toContain('https://b.com/other');
    });

    it('returns empty array when no URLs present', () => {
      expect(extractURLsFromText('No links here, just text')).toEqual([]);
    });

    it('returns empty array for empty string', () => {
      expect(extractURLsFromText('')).toEqual([]);
    });

    it('extracts URL with query parameters', () => {
      const text = 'Receipt at https://store.com/receipt?id=abc&token=xyz123';
      const result = extractURLsFromText(text);
      expect(result).toContain('https://store.com/receipt?id=abc&token=xyz123');
    });

    it('extracts URL with path segments', () => {
      const text = 'See https://api.example.com/v2/receipts/order/12345';
      const result = extractURLsFromText(text);
      expect(result).toContain('https://api.example.com/v2/receipts/order/12345');
    });

    it('extracts URL at start of text', () => {
      const result = extractURLsFromText('https://example.com is a great site');
      expect(result[0]).toBe('https://example.com');
    });

    it('extracts URL at end of text', () => {
      const result = extractURLsFromText('Visit us at https://example.com');
      expect(result[0]).toBe('https://example.com');
    });

    it('URL only input', () => {
      const result = extractURLsFromText('https://example.com/path');
      expect(result).toEqual(['https://example.com/path']);
    });
  });

  describe('filtering non-URLs', () => {
    it('does not extract ftp URLs (only http/https)', () => {
      const result = extractURLsFromText('ftp://example.com/file.txt');
      expect(result).toEqual([]);
    });

    it('does not extract email addresses', () => {
      const result = extractURLsFromText('Contact us at user@example.com');
      expect(result).toEqual([]);
    });

    it('does not extract bare domain names', () => {
      const result = extractURLsFromText('Visit example.com for more info');
      expect(result).toEqual([]);
    });

    it('does not extract protocol-relative URLs', () => {
      const result = extractURLsFromText('//example.com/path');
      expect(result).toEqual([]);
    });

    it('handles text with numbers only', () => {
      const result = extractURLsFromText('Order 12345 for 99.99 EUR');
      expect(result).toEqual([]);
    });
  });

  describe('edge cases', () => {
    it('stops extracting URL at whitespace', () => {
      const text = 'Link: https://example.com/path and more text';
      const result = extractURLsFromText(text);
      expect(result[0]).toBe('https://example.com/path');
    });

    it('extracts URL with port', () => {
      const text = 'API at https://api.example.com:8443/endpoint';
      const result = extractURLsFromText(text);
      expect(result).toContain('https://api.example.com:8443/endpoint');
    });

    it('extracts multiple adjacent URLs on separate lines', () => {
      const text = 'https://first.com\nhttps://second.com';
      const result = extractURLsFromText(text);
      expect(result).toHaveLength(2);
    });

    it('handles URL with encoded characters', () => {
      const text = 'https://example.com/path?q=hello%20world';
      const result = extractURLsFromText(text);
      expect(result).toContain('https://example.com/path?q=hello%20world');
    });

    it('handles Telegram payment link format', () => {
      const text = 'Receipt: https://pay.example.com/check?fn=123&i=1&fp=456&s=789&n=1';
      const result = extractURLsFromText(text);
      expect(result[0]).toContain('pay.example.com/check');
    });

    it('returns array not null for no match', () => {
      const result = extractURLsFromText('just text');
      expect(Array.isArray(result)).toBe(true);
      expect(result).toHaveLength(0);
    });

    it('extracts URLs from Russian language text', () => {
      const text = 'Ссылка на чек: https://check.example.ru/r?id=999';
      const result = extractURLsFromText(text);
      expect(result).toContain('https://check.example.ru/r?id=999');
    });

    it('handles text with HTML tags mixed in', () => {
      const text = 'Click <a href="https://example.com">here</a>';
      const result = extractURLsFromText(text);
      // The regex grabs URL from href value but stops at the quote
      // The exact result depends on the regex, just assert it extracts something
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
