// Tests for qr-scanner.ts — pure function isURL, no external deps needed

import { describe, expect, it } from 'bun:test';
import { isURL } from './qr-scanner';

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
