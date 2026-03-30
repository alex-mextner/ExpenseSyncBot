// Tests for OAuth URL generation and client setup (no live API calls)

import { describe, expect, it } from 'bun:test';
import {
  generateAuthUrl,
  getAuthenticatedClient,
  isTokenExpiredError,
  registerOAuthState,
  resolveOAuthState,
} from './oauth';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

  it('state param is a UUID, not the raw group ID', () => {
    const groupId = 456;
    const url = generateAuthUrl(groupId);
    const parsed = new URL(url);
    const state = parsed.searchParams.get('state') ?? '';
    expect(state).not.toBe('');
    expect(UUID_PATTERN.test(state)).toBe(true);
    // Raw groupId must NOT appear as the state value
    expect(state).not.toBe(groupId.toString());
  });

  it('different group IDs produce different URLs (different UUIDs)', () => {
    const url1 = generateAuthUrl(1);
    const url2 = generateAuthUrl(2);
    expect(url1).not.toBe(url2);
  });

  it('same group ID called twice produces different UUIDs (non-deterministic)', () => {
    const url1 = generateAuthUrl(42);
    const url2 = generateAuthUrl(42);
    const state1 = new URL(url1).searchParams.get('state');
    const state2 = new URL(url2).searchParams.get('state');
    expect(state1).not.toBe(state2);
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
});

describe('registerOAuthState', () => {
  it('returns a UUID string', () => {
    const uuid = registerOAuthState(100);
    expect(UUID_PATTERN.test(uuid)).toBe(true);
  });

  it('returns a different UUID each call for same groupId', () => {
    const uuid1 = registerOAuthState(200);
    const uuid2 = registerOAuthState(200);
    expect(uuid1).not.toBe(uuid2);
  });
});

describe('resolveOAuthState', () => {
  it('returns groupId for a valid registered state', () => {
    const groupId = 999;
    const uuid = registerOAuthState(groupId);
    expect(resolveOAuthState(uuid)).toBe(groupId);
  });

  it('returns null for an unknown state', () => {
    expect(resolveOAuthState('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('is one-time use — returns null on second call', () => {
    const groupId = 777;
    const uuid = registerOAuthState(groupId);
    expect(resolveOAuthState(uuid)).toBe(groupId);
    expect(resolveOAuthState(uuid)).toBeNull();
  });

  it('returns null for expired state (past TTL)', () => {
    const groupId = 555;
    const uuid = registerOAuthState(groupId, -1); // already expired
    expect(resolveOAuthState(uuid)).toBeNull();
  });

  it('generateAuthUrl registers a resolvable state', () => {
    const groupId = 321;
    const url = generateAuthUrl(groupId);
    const state = new URL(url).searchParams.get('state') ?? '';
    expect(state).not.toBe('');
    expect(resolveOAuthState(state)).toBe(groupId);
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

describe('isTokenExpiredError', () => {
  it('detects invalid_grant', () => {
    expect(isTokenExpiredError(new Error('invalid_grant'))).toBe(true);
  });

  it('detects Token has been expired or revoked', () => {
    expect(isTokenExpiredError(new Error('Token has been expired or revoked'))).toBe(true);
  });

  it('detects 401 Unauthorized', () => {
    expect(isTokenExpiredError(new Error('Request failed with status 401'))).toBe(true);
  });

  it('does not match unrelated errors', () => {
    expect(isTokenExpiredError(new Error('Network timeout'))).toBe(false);
    expect(isTokenExpiredError(new Error('ECONNREFUSED'))).toBe(false);
  });

  it('returns false for non-Error values', () => {
    expect(isTokenExpiredError('string')).toBe(false);
    expect(isTokenExpiredError(null)).toBe(false);
    expect(isTokenExpiredError(42)).toBe(false);
  });
});
