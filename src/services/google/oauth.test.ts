// Tests for OAuth URL generation and client setup (no live API calls)

import { describe, expect, it } from 'bun:test';
import { generateAuthUrl, getAuthenticatedClient } from './oauth';

describe('generateAuthUrl', () => {
  it('returns a string URL', () => {
    const url = generateAuthUrl(123);
    expect(typeof url).toBe('string');
    expect(url.length).toBeGreaterThan(10);
  });

  it('contains accounts.google.com', () => {
    expect(generateAuthUrl(123)).toContain('accounts.google.com');
  });

  it('contains access_type=offline', () => {
    expect(generateAuthUrl(123)).toContain('access_type=offline');
  });

  it('contains the user ID in state param', () => {
    expect(generateAuthUrl(456)).toContain('456');
  });

  it('different user IDs produce different URLs', () => {
    const url1 = generateAuthUrl(1);
    const url2 = generateAuthUrl(2);
    expect(url1).not.toBe(url2);
  });

  it('contains prompt=consent', () => {
    expect(generateAuthUrl(1)).toContain('consent');
  });

  it('returns a valid URL string parseable by URL constructor', () => {
    const url = generateAuthUrl(999);
    expect(() => new URL(url)).not.toThrow();
  });

  it('contains https protocol', () => {
    expect(generateAuthUrl(1)).toContain('https://');
  });

  it('large user ID is included correctly', () => {
    const bigId = 9999999999;
    expect(generateAuthUrl(bigId)).toContain(bigId.toString());
  });

  it('user ID 0 is included in URL', () => {
    expect(generateAuthUrl(0)).toContain('0');
  });

  it('negative user ID is included in URL', () => {
    expect(generateAuthUrl(-1)).toContain('-1');
  });
});

describe('getAuthenticatedClient', () => {
  it('returns an object (truthy)', () => {
    const client = getAuthenticatedClient('dummy-refresh-token');
    expect(client).toBeTruthy();
  });

  it('returned client has refreshAccessToken method', () => {
    const client = getAuthenticatedClient('dummy-refresh-token');
    expect(typeof client.refreshAccessToken).toBe('function');
  });

  it('creates a new client per call (not a singleton)', () => {
    const c1 = getAuthenticatedClient('token-1');
    const c2 = getAuthenticatedClient('token-2');
    expect(c1).not.toBe(c2);
  });

  it('clients created with different tokens are different objects', () => {
    const c1 = getAuthenticatedClient('token-a');
    const c2 = getAuthenticatedClient('token-b');
    expect(c1).not.toStrictEqual(c2);
  });

  it('accepts empty string token without throwing', () => {
    expect(() => getAuthenticatedClient('')).not.toThrow();
  });

  it('accepts long token string without throwing', () => {
    const longToken = 'x'.repeat(1000);
    expect(() => getAuthenticatedClient(longToken)).not.toThrow();
  });

  it('returned client has revokeCredentials method', () => {
    const client = getAuthenticatedClient('token');
    expect(typeof client.revokeCredentials).toBe('function');
  });

  it('returned client has setCredentials method', () => {
    const client = getAuthenticatedClient('token');
    expect(typeof client.setCredentials).toBe('function');
  });
});
