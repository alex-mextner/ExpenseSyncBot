// Tests for AES-256-GCM token encryption/decryption

import { describe, expect, it } from 'bun:test';
import crypto from 'node:crypto';
import { decryptToken, encryptToken } from './token-encryption';

const TEST_KEY = crypto.randomBytes(32).toString('hex'); // 64 hex chars

describe('encryptToken', () => {
  it('returns a string in iv:authTag:ciphertext format', () => {
    const encrypted = encryptToken('my-secret-token', TEST_KEY);
    const parts = encrypted.split(':');
    expect(parts.length).toBe(3);
    const [ivPart, tagPart, ctPart] = parts;
    // IV is 12 bytes = 24 hex chars
    expect(ivPart).toBeDefined();
    expect((ivPart as string).length).toBe(24);
    // Auth tag is 16 bytes = 32 hex chars
    expect(tagPart).toBeDefined();
    expect((tagPart as string).length).toBe(32);
    // Ciphertext is non-empty hex
    expect(ctPart).toBeDefined();
    expect((ctPart as string).length).toBeGreaterThan(0);
  });

  it('produces different ciphertext for same plaintext (random IV)', () => {
    const plaintext = 'same-token-value';
    const encrypted1 = encryptToken(plaintext, TEST_KEY);
    const encrypted2 = encryptToken(plaintext, TEST_KEY);
    expect(encrypted1).not.toBe(encrypted2);
  });

  it('throws on invalid key (wrong length)', () => {
    expect(() => encryptToken('token', 'short-key')).toThrow();
  });

  it('throws on invalid key (not hex)', () => {
    const notHex = 'g'.repeat(64);
    expect(() => encryptToken('token', notHex)).toThrow();
  });

  it('handles empty plaintext', () => {
    const encrypted = encryptToken('', TEST_KEY);
    const decrypted = decryptToken(encrypted, TEST_KEY);
    expect(decrypted).toBe('');
  });
});

describe('decryptToken', () => {
  it('decrypts an encrypted token correctly', () => {
    const original = '1//0abcDEF-ghiJKL_mnoPQR';
    const encrypted = encryptToken(original, TEST_KEY);
    const decrypted = decryptToken(encrypted, TEST_KEY);
    expect(decrypted).toBe(original);
  });

  it('handles unicode characters', () => {
    const original = 'token-with-unicode-\u00e9\u00e8\u00ea';
    const encrypted = encryptToken(original, TEST_KEY);
    const decrypted = decryptToken(encrypted, TEST_KEY);
    expect(decrypted).toBe(original);
  });

  it('throws on tampered ciphertext', () => {
    const encrypted = encryptToken('secret', TEST_KEY);
    const [iv, tag, ct] = encrypted.split(':') as [string, string, string];
    // Flip a byte in the ciphertext
    const tampered = `${iv}:${tag}:${ct.slice(0, -2)}ff`;
    expect(() => decryptToken(tampered, TEST_KEY)).toThrow();
  });

  it('throws on tampered auth tag', () => {
    const encrypted = encryptToken('secret', TEST_KEY);
    const [iv, , ct] = encrypted.split(':') as [string, string, string];
    const tamperedTag = '0'.repeat(32);
    const tampered = `${iv}:${tamperedTag}:${ct}`;
    expect(() => decryptToken(tampered, TEST_KEY)).toThrow();
  });

  it('throws on tampered IV', () => {
    const encrypted = encryptToken('secret', TEST_KEY);
    const [, tag, ct] = encrypted.split(':') as [string, string, string];
    const tamperedIv = '0'.repeat(24);
    const tampered = `${tamperedIv}:${tag}:${ct}`;
    expect(() => decryptToken(tampered, TEST_KEY)).toThrow();
  });

  it('throws on wrong key', () => {
    const encrypted = encryptToken('secret', TEST_KEY);
    const wrongKey = crypto.randomBytes(32).toString('hex');
    expect(() => decryptToken(encrypted, wrongKey)).toThrow();
  });

  it('throws on malformed input (missing parts)', () => {
    expect(() => decryptToken('not-encrypted', TEST_KEY)).toThrow();
  });

  it('throws on malformed input (empty string)', () => {
    expect(() => decryptToken('', TEST_KEY)).toThrow();
  });
});

describe('round-trip', () => {
  it('encrypts and decrypts long tokens', () => {
    const longToken = `1//${'a'.repeat(500)}`;
    const encrypted = encryptToken(longToken, TEST_KEY);
    const decrypted = decryptToken(encrypted, TEST_KEY);
    expect(decrypted).toBe(longToken);
  });

  it('works with realistic Google refresh token format', () => {
    const realisticToken =
      '1//0e9xYzAbCdEfGhIjKlMnOpQrStUvWxYz-AbCdEfGhIjKlMnOpQrStUvWxYzAbCdEfGhI';
    const encrypted = encryptToken(realisticToken, TEST_KEY);
    const decrypted = decryptToken(encrypted, TEST_KEY);
    expect(decrypted).toBe(realisticToken);
  });
});
