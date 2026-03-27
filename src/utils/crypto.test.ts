import { describe, expect, test } from 'bun:test';
import { decryptData, encryptData } from './crypto';

// Set ENCRYPTION_KEY for tests (32 bytes hex)
process.env['ENCRYPTION_KEY'] = 'a'.repeat(64);

describe('crypto', () => {
  test('round-trip: encrypt then decrypt returns original', () => {
    const original = 'hello world secret';
    const encrypted = encryptData(original);
    expect(encrypted).not.toBe(original);
    expect(decryptData(encrypted)).toBe(original);
  });

  test('encrypted output has iv:tag:data format', () => {
    const encrypted = encryptData('test');
    const parts = encrypted.split(':');
    expect(parts).toHaveLength(3);
    expect(parts[0]).toHaveLength(24); // 12 bytes IV → 24 hex chars
    expect(parts[1]).toHaveLength(32); // 16 bytes auth tag → 32 hex chars
  });

  test('each encryption produces different ciphertext (random IV)', () => {
    const c1 = encryptData('same');
    const c2 = encryptData('same');
    expect(c1).not.toBe(c2);
    expect(decryptData(c1)).toBe('same');
    expect(decryptData(c2)).toBe('same');
  });

  test('decrypt throws on tampered ciphertext', () => {
    const encrypted = encryptData('data');
    const tampered = `${encrypted.slice(0, -4)}ffff`;
    expect(() => decryptData(tampered)).toThrow();
  });

  test('encrypts and decrypts JSON credentials', () => {
    const creds = JSON.stringify({ username: 'user@bank.ge', password: 'secret123' });
    expect(JSON.parse(decryptData(encryptData(creds)))).toEqual(JSON.parse(creds));
  });
});
