// Tests for OAuth URL generation and client setup (no live API calls)

import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { GOOGLE_SCOPES } from '../../config/constants';
import { env } from '../../config/env';
import {
  generateAuthUrl,
  getAuthenticatedClient,
  getTokensFromCode,
  isTokenExpiredError,
  oauth2Client,
  refreshAccessToken,
  registerOAuthState,
  resolveOAuthState,
  revokeToken,
} from './oauth';
import { encryptToken } from './token-encryption';

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

  it('detects "token has been revoked" variant', () => {
    expect(isTokenExpiredError(new Error('Token has been revoked by the user.'))).toBe(true);
  });

  it('detects unauthorized error text', () => {
    expect(isTokenExpiredError(new Error('Unauthorized: missing credentials'))).toBe(true);
  });

  it('is case-insensitive on error text', () => {
    expect(isTokenExpiredError(new Error('INVALID_GRANT'))).toBe(true);
    expect(isTokenExpiredError(new Error('Invalid_Grant'))).toBe(true);
  });

  it('returns false for Error without matching text', () => {
    expect(isTokenExpiredError(new Error('500 internal server error'))).toBe(false);
  });

  it('returns false for undefined', () => {
    expect(isTokenExpiredError(undefined)).toBe(false);
  });
});

describe('generateAuthUrl scope (drive.file narrowing per PR #84)', () => {
  it('contains the drive.file scope only, not broader drive or spreadsheets', () => {
    const url = generateAuthUrl(1);
    const scope = new URL(url).searchParams.get('scope') ?? '';
    // GOOGLE_SCOPES is narrowed to drive.file (non-sensitive)
    expect(scope).toContain('drive.file');
    // Must NOT contain the broader sensitive scopes
    expect(scope).not.toContain('auth/drive ');
    expect(scope).not.toContain('spreadsheets');
  });

  it('requests exactly one scope', () => {
    expect(GOOGLE_SCOPES).toHaveLength(1);
    expect(GOOGLE_SCOPES[0]).toBe('https://www.googleapis.com/auth/drive.file');
  });

  it('url scope param matches GOOGLE_SCOPES constant exactly', () => {
    const url = generateAuthUrl(1);
    const scope = new URL(url).searchParams.get('scope') ?? '';
    // The URL encodes the single-element array as a space-joined string
    expect(scope).toBe(GOOGLE_SCOPES.join(' '));
  });

  it('encodes access_type=offline for refresh token issuance', () => {
    const parsed = new URL(generateAuthUrl(1));
    expect(parsed.searchParams.get('access_type')).toBe('offline');
  });

  it('encodes prompt=consent to force refresh token every time', () => {
    const parsed = new URL(generateAuthUrl(1));
    expect(parsed.searchParams.get('prompt')).toBe('consent');
  });

  it('sets response_type=code (authorization code flow)', () => {
    const parsed = new URL(generateAuthUrl(1));
    expect(parsed.searchParams.get('response_type')).toBe('code');
  });

  it('includes configured client_id', () => {
    const parsed = new URL(generateAuthUrl(1));
    expect(parsed.searchParams.get('client_id')).toBe(env.GOOGLE_CLIENT_ID);
  });

  it('includes configured redirect_uri', () => {
    const parsed = new URL(generateAuthUrl(1));
    expect(parsed.searchParams.get('redirect_uri')).toBe(env.GOOGLE_REDIRECT_URI);
  });
});

describe('getTokensFromCode', () => {
  afterEach(() => {
    // Restore oauth2Client.getToken after each test
    // (spyOn attaches mock to the same object)
    if ('mockRestore' in (oauth2Client.getToken as unknown as { mockRestore?: () => void })) {
      (oauth2Client.getToken as unknown as { mockRestore: () => void }).mockRestore();
    }
  });

  it('returns full token shape on success', async () => {
    const expiry = Date.now() + 3600 * 1000;
    spyOn(oauth2Client, 'getToken').mockImplementation((() =>
      Promise.resolve({
        tokens: {
          access_token: 'at-123',
          refresh_token: 'rt-456',
          expiry_date: expiry,
        },
        res: null,
      })) as unknown as typeof oauth2Client.getToken);

    const result = await getTokensFromCode('valid-code');
    expect(result).toEqual({
      access_token: 'at-123',
      refresh_token: 'rt-456',
      expiry_date: expiry,
    });
  });

  it('synthesizes expiry_date when Google omits it (falls back to ~1h)', async () => {
    spyOn(oauth2Client, 'getToken').mockImplementation((() =>
      Promise.resolve({
        tokens: { access_token: 'a', refresh_token: 'r' /* no expiry_date */ },
        res: null,
      })) as unknown as typeof oauth2Client.getToken);

    const before = Date.now();
    const result = await getTokensFromCode('code');
    // Should be roughly ~1h in the future (allow generous slack for CI)
    expect(result.expiry_date).toBeGreaterThanOrEqual(before + 3500 * 1000);
    expect(result.expiry_date).toBeLessThanOrEqual(before + 3700 * 1000);
  });

  it('throws when access_token is missing', async () => {
    spyOn(oauth2Client, 'getToken').mockImplementation((() =>
      Promise.resolve({
        tokens: { refresh_token: 'rt' },
        res: null,
      })) as unknown as typeof oauth2Client.getToken);

    await expect(getTokensFromCode('code')).rejects.toThrow('No access token received');
  });

  it('throws when refresh_token is missing (consent not granted)', async () => {
    spyOn(oauth2Client, 'getToken').mockImplementation((() =>
      Promise.resolve({
        tokens: { access_token: 'at' },
        res: null,
      })) as unknown as typeof oauth2Client.getToken);

    await expect(getTokensFromCode('code')).rejects.toThrow('No refresh token received');
  });

  it('propagates Google API errors (invalid_grant, bad code, etc.)', async () => {
    spyOn(oauth2Client, 'getToken').mockImplementation((() =>
      Promise.reject(new Error('invalid_grant'))) as unknown as typeof oauth2Client.getToken);

    await expect(getTokensFromCode('revoked-code')).rejects.toThrow('invalid_grant');
  });

  it('propagates generic network errors', async () => {
    spyOn(oauth2Client, 'getToken').mockImplementation((() =>
      Promise.reject(new Error('ECONNREFUSED'))) as unknown as typeof oauth2Client.getToken);

    await expect(getTokensFromCode('code')).rejects.toThrow('ECONNREFUSED');
  });
});

describe('getAuthenticatedClient — token handling', () => {
  it('decrypts an encrypted refresh token transparently', () => {
    const plaintext = '1//rt-plaintext-secret';
    const encrypted = encryptToken(plaintext, env.ENCRYPTION_KEY);

    const client = getAuthenticatedClient(encrypted);
    // The client should have setCredentials (real OAuth2 client shape).
    expect(typeof client.setCredentials).toBe('function');
    // Verify the decrypted value was set — OAuth2 client stores it on credentials.
    expect((client.credentials as { refresh_token?: string }).refresh_token).toBe(plaintext);
  });

  it('accepts plaintext (unencrypted) tokens for backward compatibility', () => {
    const client = getAuthenticatedClient('plaintext-token-no-colons');
    expect((client.credentials as { refresh_token?: string }).refresh_token).toBe(
      'plaintext-token-no-colons',
    );
  });

  it('throws on malformed encrypted tokens (wrong auth tag)', () => {
    // Use a deliberately malformed token that LOOKS encrypted per isEncryptedToken
    // (iv=24hex : tag=32hex : ct=nonempty) but has tampered ciphertext.
    const fakeIv = 'a'.repeat(24);
    const fakeTag = 'b'.repeat(32);
    const fakeCt = 'cc';
    const bogus = `${fakeIv}:${fakeTag}:${fakeCt}`;
    expect(() => getAuthenticatedClient(bogus)).toThrow(/decrypt/i);
  });

  it('falls back to current client when clientType omitted', () => {
    const client = getAuthenticatedClient('t');
    // Can't inspect private client_id on OAuth2, but we can at least assert no throw and default path
    expect(client).toBeTruthy();
  });

  it('throws a helpful error when clientType=legacy but credentials are not configured', () => {
    // In the standard .env, legacy credentials are blank, so asking for 'legacy' must throw.
    // If this test runs in an env with legacy creds present, skip this assertion.
    if (env.GOOGLE_LEGACY_CLIENT_ID && env.GOOGLE_LEGACY_CLIENT_SECRET) {
      // eslint-disable-next-line no-console
      expect(() => getAuthenticatedClient('t', 'legacy')).not.toThrow();
    } else {
      expect(() => getAuthenticatedClient('t', 'legacy')).toThrow(/legacy/i);
    }
  });
});

describe('refreshAccessToken', () => {
  it('returns the new access token from Google', async () => {
    // The client refreshAccessToken method is on the instance returned by getAuthenticatedClient.
    // We can't easily spy on instance methods created fresh each call, so we spy on the
    // OAuth2 prototype via googleapis — instead, stub the helper by spying on getAuthenticatedClient.
    const fakeClient = {
      refreshAccessToken: () =>
        Promise.resolve({ credentials: { access_token: 'new-at-789' }, res: null }),
    };
    const mod = await import('./oauth');
    const spy = spyOn(mod, 'getAuthenticatedClient').mockImplementation(
      (() => fakeClient) as unknown as typeof mod.getAuthenticatedClient,
    );

    try {
      const result = await refreshAccessToken('any-refresh');
      expect(result).toBe('new-at-789');
    } finally {
      spy.mockRestore();
    }
  });

  it('throws when Google returns no access_token on refresh', async () => {
    const fakeClient = {
      refreshAccessToken: () => Promise.resolve({ credentials: {}, res: null }),
    };
    const mod = await import('./oauth');
    const spy = spyOn(mod, 'getAuthenticatedClient').mockImplementation(
      (() => fakeClient) as unknown as typeof mod.getAuthenticatedClient,
    );

    try {
      await expect(refreshAccessToken('any-refresh')).rejects.toThrow(
        'Failed to refresh access token',
      );
    } finally {
      spy.mockRestore();
    }
  });

  it('propagates Google errors (e.g. invalid_grant on revoked token)', async () => {
    const fakeClient = {
      refreshAccessToken: () => Promise.reject(new Error('invalid_grant')),
    };
    const mod = await import('./oauth');
    const spy = spyOn(mod, 'getAuthenticatedClient').mockImplementation(
      (() => fakeClient) as unknown as typeof mod.getAuthenticatedClient,
    );

    try {
      await expect(refreshAccessToken('revoked')).rejects.toThrow('invalid_grant');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('revokeToken', () => {
  it('calls revokeCredentials on the authenticated client', async () => {
    let called = false;
    const fakeClient = {
      revokeCredentials: () => {
        called = true;
        return Promise.resolve({ data: {} });
      },
    };
    const mod = await import('./oauth');
    const spy = spyOn(mod, 'getAuthenticatedClient').mockImplementation(
      (() => fakeClient) as unknown as typeof mod.getAuthenticatedClient,
    );

    try {
      await revokeToken('any-refresh');
      expect(called).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('propagates errors from revokeCredentials', async () => {
    const fakeClient = {
      revokeCredentials: () => Promise.reject(new Error('revoke failed')),
    };
    const mod = await import('./oauth');
    const spy = spyOn(mod, 'getAuthenticatedClient').mockImplementation(
      (() => fakeClient) as unknown as typeof mod.getAuthenticatedClient,
    );

    try {
      await expect(revokeToken('any-refresh')).rejects.toThrow('revoke failed');
    } finally {
      spy.mockRestore();
    }
  });
});

describe('registerOAuthState TTL handling', () => {
  it('honours a custom positive ttlMs (resolvable before expiry)', () => {
    const uuid = registerOAuthState(12345, 5_000); // 5s
    expect(resolveOAuthState(uuid)).toBe(12345);
  });

  it('treats negative ttlMs as already expired', () => {
    // ttlMs=0 is technically "not-yet-expired" at the same tick (`Date.now() > entry.expiresAt`
    // is strict). Any negative value is unambiguously in the past.
    const uuid = registerOAuthState(67890, -10);
    expect(resolveOAuthState(uuid)).toBeNull();
  });

  it('two different groups get distinct resolvable states', () => {
    const uuidA = registerOAuthState(1001);
    const uuidB = registerOAuthState(1002);
    expect(uuidA).not.toBe(uuidB);
    expect(resolveOAuthState(uuidA)).toBe(1001);
    expect(resolveOAuthState(uuidB)).toBe(1002);
  });

  it('resolveOAuthState on empty string returns null', () => {
    expect(resolveOAuthState('')).toBeNull();
  });

  it('resolveOAuthState on non-UUID garbage returns null', () => {
    expect(resolveOAuthState('not-a-uuid-at-all')).toBeNull();
  });
});
