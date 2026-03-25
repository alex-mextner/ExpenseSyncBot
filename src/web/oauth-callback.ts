// OAuth callback HTTP server — handles Google OAuth redirects and token exchange.
import { env } from '../config/env';
import { database } from '../database';
import { getTokensFromCode, resolveOAuthState } from '../services/google/oauth';
import { encryptToken } from '../services/google/token-encryption';
import { createLogger } from '../utils/logger.ts';
import { escapeHtml } from './html-escape';
import { handleTempImage } from './temp-image.handler';

const logger = createLogger('oauth-callback');

/**
 * Pending OAuth promises (groupId -> resolve/reject functions).
 * Keyed by numeric groupId so connect.ts can cancel on timeout.
 */
const pendingOAuthPromises = new Map<
  number,
  {
    resolve: (refreshToken: string) => void;
    reject: (error: Error) => void;
  }
>();

/**
 * Register a promise callback for a pending OAuth flow.
 * Called by connect.ts after generating the auth URL.
 */
export function registerOAuthPromise(
  groupId: number,
  resolve: (refreshToken: string) => void,
  reject: (error: Error) => void,
): void {
  pendingOAuthPromises.set(groupId, { resolve, reject });
}

/**
 * Remove a pending OAuth promise (e.g. on timeout).
 */
export function unregisterOAuthPromise(groupId: number): void {
  pendingOAuthPromises.delete(groupId);
}

/**
 * OAuth callback server
 */
export function startOAuthServer(): void {
  const server = Bun.serve({
    port: env.OAUTH_SERVER_PORT,
    async fetch(req) {
      const url = new URL(req.url);

      if (url.pathname === '/callback') {
        return handleOAuthCallback(url);
      }

      if (url.pathname === '/health') {
        return new Response('OK', { status: 200 });
      }

      // Serve temporary images for OCR processing
      if (url.pathname.startsWith('/temp-images/')) {
        return handleTempImage(url);
      }

      return new Response('Not Found', { status: 404 });
    },
  });

  logger.info(`✓ OAuth server running on http://localhost:${server.port}`);
}

/**
 * Handle OAuth callback
 */
async function handleOAuthCallback(url: URL): Promise<Response> {
  const code = url.searchParams.get('code');
  const state = url.searchParams.get('state'); // UUID token
  const error = url.searchParams.get('error');

  // Handle OAuth error from Google
  if (error) {
    const errorDescription = url.searchParams.get('error_description') || 'Unknown error';
    logger.error(`OAuth error: ${error} ${errorDescription}`);

    if (state) {
      const groupId = resolveOAuthState(state);
      if (groupId !== null) {
        const pending = pendingOAuthPromises.get(groupId);
        if (pending) {
          pending.reject(new Error(errorDescription));
          pendingOAuthPromises.delete(groupId);
        }
      }
    }

    return new Response(
      `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Authorization Error</title>
          <style>
            body {
              font-family: system-ui, -apple-system, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
              background: #f5f5f5;
            }
            .container {
              background: white;
              padding: 2rem;
              border-radius: 8px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
              max-width: 400px;
              text-align: center;
            }
            .error { color: #dc3545; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1 class="error">❌ Authorization Failed</h1>
            <p>${escapeHtml(errorDescription)}</p>
            <p>Please return to Telegram and try again.</p>
          </div>
        </body>
      </html>
      `,
      {
        status: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      },
    );
  }

  // Validate required parameters
  if (!code || !state) {
    return new Response('Missing code or state parameter', { status: 400 });
  }

  // Resolve UUID state to groupId — returns null for unknown or expired tokens
  const groupId = resolveOAuthState(state);
  if (groupId === null) {
    logger.error(`OAuth callback: invalid or expired state token`);
    return new Response(
      `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Authorization Error</title>
          <style>
            body {
              font-family: system-ui, -apple-system, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
              background: #f5f5f5;
            }
            .container {
              background: white;
              padding: 2rem;
              border-radius: 8px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
              max-width: 400px;
              text-align: center;
            }
            .error { color: #dc3545; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1 class="error">❌ Authorization Failed</h1>
            <p>Invalid or expired authorization request.</p>
            <p>Please return to Telegram and try again.</p>
          </div>
        </body>
      </html>
      `,
      {
        status: 400,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      },
    );
  }

  try {
    // Exchange code for tokens
    const tokens = await getTokensFromCode(code);

    // Update group in database
    const group = database.groups.findById(groupId);

    if (!group) {
      throw new Error('Group not found');
    }

    const encryptedToken = encryptToken(tokens.refresh_token, env.ENCRYPTION_KEY);
    database.groups.update(group.telegram_group_id, {
      google_refresh_token: encryptedToken,
    });

    // Resolve pending OAuth promise
    const pending = pendingOAuthPromises.get(groupId);
    if (pending) {
      pending.resolve(tokens.refresh_token);
      pendingOAuthPromises.delete(groupId);
    } else {
      logger.info(`[OAuth] No pending promise for group ${groupId} (token saved to DB anyway)`);
    }

    logger.info(`✓ OAuth successful for group ${groupId}`);

    return new Response(
      `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Authorization Successful</title>
          <style>
            body {
              font-family: system-ui, -apple-system, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
              background: #f5f5f5;
            }
            .container {
              background: white;
              padding: 2rem;
              border-radius: 8px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
              max-width: 400px;
              text-align: center;
            }
            .success { color: #28a745; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1 class="success">✅ Authorization Successful!</h1>
            <p>You can now close this window and return to Telegram.</p>
            <p>The bot will continue the setup process.</p>
          </div>
        </body>
      </html>
      `,
      {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      },
    );
  } catch (err) {
    logger.error({ err: err }, 'Error handling OAuth callback');

    const pending = pendingOAuthPromises.get(groupId);
    if (pending) {
      pending.reject(err as Error);
      pendingOAuthPromises.delete(groupId);
    }

    return new Response(
      `
      <!DOCTYPE html>
      <html>
        <head>
          <meta charset="utf-8">
          <title>Authorization Error</title>
          <style>
            body {
              font-family: system-ui, -apple-system, sans-serif;
              display: flex;
              align-items: center;
              justify-content: center;
              min-height: 100vh;
              margin: 0;
              background: #f5f5f5;
            }
            .container {
              background: white;
              padding: 2rem;
              border-radius: 8px;
              box-shadow: 0 2px 8px rgba(0,0,0,0.1);
              max-width: 400px;
              text-align: center;
            }
            .error { color: #dc3545; }
          </style>
        </head>
        <body>
          <div class="container">
            <h1 class="error">❌ Error</h1>
            <p>${escapeHtml(err instanceof Error ? err.message : 'Unknown error occurred')}</p>
            <p>Please return to Telegram and try again.</p>
          </div>
        </body>
      </html>
      `,
      {
        status: 500,
        headers: { 'Content-Type': 'text/html; charset=utf-8' },
      },
    );
  }
}
