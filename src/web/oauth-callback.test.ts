// Tests for the OAuth callback HTTP handler — happy path, validation errors,
// spreadsheet branch, group lookup failure.
//
// We start the real Bun.serve via startOAuthServer() and spy on the modules it
// depends on (OAuth exchange, encryption, DB, fullSyncAfterReconnect, telegram
// sender). This exercises the exact routing + error-handling code from prod
// without modifying it.

import { afterAll, beforeAll, beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import * as reconnectModule from '../bot/commands/reconnect.ts';
import { env } from '../config/env.ts';
import { database } from '../database/index.ts';
import type { Group } from '../database/types.ts';
import * as telegramSenderModule from '../services/bank/telegram-sender.ts';
import * as oauthModule from '../services/google/oauth.ts';
import * as tokenEncryptionModule from '../services/google/token-encryption.ts';
import { createMockLogger } from '../test-utils/mocks/logger.ts';
import * as loggerModule from '../utils/logger.ts';

// ── Helpers ───────────────────────────────────────────────────────────────────

function stubGroup(overrides: Partial<Group> & { id: number }): Group {
  return {
    telegram_group_id: -1001234567,
    title: null,
    invite_link: null,
    default_currency: 'RSD',
    enabled_currencies: ['RSD'],
    google_refresh_token: null,
    spreadsheet_id: null,
    custom_prompt: null,
    active_topic_id: null,
    bank_panel_summary_message_id: null,
    oauth_client: 'current',
    created_at: '2024-01-01',
    updated_at: '2024-01-01',
    ...overrides,
  };
}

// ── Mocks ─────────────────────────────────────────────────────────────────────

const mockGetTokensFromCode = mock(
  (_code: string): Promise<{ access_token: string; refresh_token: string; expiry_date: number }> =>
    Promise.resolve({
      access_token: 'access_xyz',
      refresh_token: 'refresh_xyz',
      expiry_date: Date.now() + 3600 * 1000,
    }),
);
const mockResolveOAuthState = mock((_state: string): number | null => null);
const mockEncryptToken = mock(
  (plaintext: string, _key: string): string => `encrypted:${plaintext}`,
);
const mockGroupsFindById = mock((_id: number): Group | null => null);
const mockGroupsUpdate = mock(
  (_telegramGroupId: number, _data: Partial<Group>): Group | null => null,
);
const mockFullSyncAfterReconnect = mock((_groupId: number): Promise<void> => Promise.resolve());
// sendMessage is called by notifyTelegramSuccess / notifyTelegramError. We
// stub it to avoid needing initSender() and the real gramio client.
const mockSendMessage = mock(
  (_text: string, _opts?: unknown): Promise<null> => Promise.resolve(null),
);

spyOn(oauthModule, 'getTokensFromCode').mockImplementation(mockGetTokensFromCode);
spyOn(oauthModule, 'resolveOAuthState').mockImplementation(mockResolveOAuthState);
spyOn(tokenEncryptionModule, 'encryptToken').mockImplementation(mockEncryptToken);
spyOn(database.groups, 'findById').mockImplementation(mockGroupsFindById);
// `update` returns the updated Group | null — widen via `as typeof database.groups.update`
// because the mock signature intentionally accepts a looser Partial<Group>.
spyOn(database.groups, 'update').mockImplementation(
  mockGroupsUpdate as typeof database.groups.update,
);
spyOn(reconnectModule, 'fullSyncAfterReconnect').mockImplementation(mockFullSyncAfterReconnect);
spyOn(telegramSenderModule, 'sendMessage').mockImplementation(
  mockSendMessage as typeof telegramSenderModule.sendMessage,
);

// Silence logger so test output is pristine + we can assert on it if needed.
const logMock = createMockLogger();
spyOn(loggerModule, 'createLogger').mockImplementation(
  (_module: string) => logMock as unknown as ReturnType<typeof loggerModule.createLogger>,
);

// Random high port to avoid collisions with any running dev server
const TEST_PORT = 19_876 + Math.floor(Math.random() * 1000);
const originalPort = env.OAUTH_SERVER_PORT;
const BASE_URL = `http://localhost:${TEST_PORT}`;

// `startOAuthServer` calls Bun.serve with side-effects (registers the port);
// hold a reference so we can stop it in afterAll.
// biome-ignore lint/suspicious/noExplicitAny: Bun.Server type isn't exported pre-1.2 in a way that survives our tsconfig; tests-only.
let serverRef: any;

beforeAll(async () => {
  (env as { OAUTH_SERVER_PORT: number }).OAUTH_SERVER_PORT = TEST_PORT;
  // Import after mocks are set up. Cache the module so we can grab the server.
  const mod = await import('./oauth-callback.ts');

  // startOAuthServer() creates the server internally and doesn't return it.
  // Spy on Bun.serve to capture the reference so we can stop it at teardown.
  const originalServe = Bun.serve;
  // biome-ignore lint/suspicious/noExplicitAny: Bun.serve has many overloads; capture via intercept.
  (Bun as any).serve = ((...args: Parameters<typeof Bun.serve>) => {
    const server = originalServe(...args);
    serverRef = server;
    return server;
    // biome-ignore lint/suspicious/noExplicitAny: see above
  }) as any;
  mod.startOAuthServer();
  // biome-ignore lint/suspicious/noExplicitAny: restore
  (Bun as any).serve = originalServe;
});

afterAll(() => {
  if (serverRef) serverRef.stop(true);
  (env as { OAUTH_SERVER_PORT: number }).OAUTH_SERVER_PORT = originalPort;
  mock.restore();
});

beforeEach(() => {
  mockGetTokensFromCode.mockClear();
  mockResolveOAuthState.mockReset();
  mockEncryptToken.mockClear();
  mockGroupsFindById.mockReset();
  mockGroupsUpdate.mockReset();
  mockFullSyncAfterReconnect.mockReset().mockImplementation(() => Promise.resolve());
  mockSendMessage.mockClear();
  logMock.error.mockClear();
  logMock.warn.mockClear();
  logMock.info.mockClear();

  // Default mocks for the happy path — individual tests override as needed
  mockGetTokensFromCode.mockImplementation(() =>
    Promise.resolve({
      access_token: 'access_xyz',
      refresh_token: 'refresh_xyz',
      expiry_date: Date.now() + 3600 * 1000,
    }),
  );
});

/** Wait for fire-and-forget `.catch(...)` background work to settle. */
async function flushMicrotasks(): Promise<void> {
  await new Promise((r) => setTimeout(r, 10));
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('/callback — parameter validation', () => {
  test('missing code → 400 with plain-text message', async () => {
    const res = await fetch(`${BASE_URL}/callback?state=some-uuid`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Missing code or state parameter');
  });

  test('missing state → 400 with plain-text message', async () => {
    const res = await fetch(`${BASE_URL}/callback?code=abc`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Missing code or state parameter');
  });

  test('missing both code and state → 400', async () => {
    const res = await fetch(`${BASE_URL}/callback`);
    expect(res.status).toBe(400);
  });

  test('invalid / expired state → 400 HTML error page', async () => {
    mockResolveOAuthState.mockImplementation(() => null);
    const res = await fetch(`${BASE_URL}/callback?code=abc&state=expired-uuid`);
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Authorization Failed');
    expect(body).toContain('Invalid or expired authorization request');
    // Token exchange must NOT run on invalid state
    expect(mockGetTokensFromCode).not.toHaveBeenCalled();
    // Logger recorded the failure
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('/callback — Google-returned error parameter', () => {
  test('?error=access_denied → 400 HTML with escaped description', async () => {
    mockResolveOAuthState.mockImplementation(() => 1);
    const res = await fetch(
      `${BASE_URL}/callback?error=access_denied&error_description=User+denied+access&state=some-uuid`,
    );
    expect(res.status).toBe(400);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Authorization Failed');
    expect(body).toContain('User denied access');
    expect(mockGetTokensFromCode).not.toHaveBeenCalled();
  });

  test('?error without description → shows "Unknown error" fallback', async () => {
    const res = await fetch(`${BASE_URL}/callback?error=access_denied`);
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Unknown error');
  });

  test('HTML in error_description is escaped (XSS defense)', async () => {
    // Google shouldn't send HTML but we still escape — verify the handler
    // uses escapeHtml rather than concatenating raw user input.
    const res = await fetch(
      `${BASE_URL}/callback?error=x&error_description=${encodeURIComponent('<script>alert(1)</script>')}`,
    );
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain('<script>alert(1)</script>');
    expect(body).toContain('&lt;script&gt;');
  });
});

describe('/callback — happy path (new group, /connect flow)', () => {
  test('valid code + state + no spreadsheet → token exchange, encrypt, store, success page', async () => {
    mockResolveOAuthState.mockImplementation(() => 42);
    mockGroupsFindById.mockImplementation((id) =>
      id === 42 ? stubGroup({ id: 42, spreadsheet_id: null }) : null,
    );

    const res = await fetch(`${BASE_URL}/callback?code=auth_code_abc&state=valid-uuid`);

    expect(res.status).toBe(200);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Authorization Successful');

    // Token exchange called with the received code
    expect(mockGetTokensFromCode).toHaveBeenCalledTimes(1);
    expect(mockGetTokensFromCode.mock.calls[0]?.[0]).toBe('auth_code_abc');

    // Refresh token encrypted before storage
    expect(mockEncryptToken).toHaveBeenCalledTimes(1);
    expect(mockEncryptToken.mock.calls[0]?.[0]).toBe('refresh_xyz');

    // DB updated with encrypted token + oauth_client
    expect(mockGroupsUpdate).toHaveBeenCalledTimes(1);
    const [telegramGroupId, patch] = mockGroupsUpdate.mock.calls[0] ?? [];
    expect(telegramGroupId).toBe(-1001234567);
    expect(patch).toMatchObject({
      google_refresh_token: 'encrypted:refresh_xyz',
      oauth_client: 'current',
    });

    // No spreadsheet → reconnect sync is NOT triggered
    await flushMicrotasks();
    expect(mockFullSyncAfterReconnect).not.toHaveBeenCalled();
  });
});

describe('/callback — /reconnect flow (group already has spreadsheet)', () => {
  test('existing spreadsheet → fullSyncAfterReconnect fires in background', async () => {
    mockResolveOAuthState.mockImplementation(() => 77);
    mockGroupsFindById.mockImplementation((id) =>
      id === 77
        ? stubGroup({
            id: 77,
            telegram_group_id: -1009999999,
            spreadsheet_id: 'spreadsheet_abc',
            active_topic_id: 101,
          })
        : null,
    );

    const res = await fetch(`${BASE_URL}/callback?code=another_code&state=valid-uuid`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('Authorization Successful');

    // sync runs async — wait a tick for the .catch() chain to register
    await flushMicrotasks();

    expect(mockFullSyncAfterReconnect).toHaveBeenCalledTimes(1);
    expect(mockFullSyncAfterReconnect.mock.calls[0]?.[0]).toBe(77);
  });
});

describe('/callback — token exchange / internal failure', () => {
  test('getTokensFromCode throws → 500 error page + error logged', async () => {
    mockResolveOAuthState.mockImplementation(() => 5);
    mockGroupsFindById.mockImplementation(() => stubGroup({ id: 5 }));
    mockGetTokensFromCode.mockImplementation(() =>
      Promise.reject(new Error('invalid_grant: revoked')),
    );

    const res = await fetch(`${BASE_URL}/callback?code=bad_code&state=valid-uuid`);
    expect(res.status).toBe(500);
    expect(res.headers.get('Content-Type')).toContain('text/html');
    const body = await res.text();
    expect(body).toContain('Error');
    expect(body).toContain('invalid_grant: revoked');

    // DB must NOT be updated when token exchange fails
    expect(mockGroupsUpdate).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });

  test('token exchange error message is HTML-escaped (XSS defense)', async () => {
    mockResolveOAuthState.mockImplementation(() => 5);
    mockGroupsFindById.mockImplementation(() => stubGroup({ id: 5 }));
    mockGetTokensFromCode.mockImplementation(() =>
      Promise.reject(new Error('<img src=x onerror=alert(1)>')),
    );

    const res = await fetch(`${BASE_URL}/callback?code=bad&state=s`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).not.toContain('<img src=x');
    expect(body).toContain('&lt;img');
  });
});

describe('/callback — group-lookup failure', () => {
  test('resolved state but group row missing → 500 error page', async () => {
    mockResolveOAuthState.mockImplementation(() => 999);
    mockGroupsFindById.mockImplementation(() => null); // stale state / deleted group

    const res = await fetch(`${BASE_URL}/callback?code=abc&state=uuid`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toContain('Error');
    expect(body).toContain('Group not found');

    // Token exchange DID run (happens before the group lookup)
    expect(mockGetTokensFromCode).toHaveBeenCalled();
    // but we never persist when the group doesn't exist
    expect(mockGroupsUpdate).not.toHaveBeenCalled();
    expect(logMock.error).toHaveBeenCalled();
  });
});

describe('other routes do not interfere', () => {
  test('/health → 200 JSON', async () => {
    const res = await fetch(`${BASE_URL}/health`);
    // database is real (in-memory in test mode), so /health should respond ok
    expect([200, 503]).toContain(res.status); // either ok or fail — we only care it's not 404
    expect(res.headers.get('content-type')).toContain('application/json');
  });

  test('unknown path → 404', async () => {
    const res = await fetch(`${BASE_URL}/does-not-exist`);
    expect(res.status).toBe(404);
  });
});
