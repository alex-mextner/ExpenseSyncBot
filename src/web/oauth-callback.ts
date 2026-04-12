// OAuth callback HTTP server — handles Google OAuth redirects and token exchange.
import { fullSyncAfterReconnect } from '../bot/commands/reconnect';
import { createCurrencyKeyboard } from '../bot/keyboards';
import { MESSAGES } from '../config/constants';
import { env } from '../config/env';
import { database } from '../database';
import { sendMessage, withChatContext } from '../services/bank/telegram-sender';
import { getTokensFromCode, resolveOAuthState } from '../services/google/oauth';
import { encryptToken } from '../services/google/token-encryption';
import { createLogger } from '../utils/logger.ts';
import { escapeHtml } from './html-escape';
import { handleMiniAppRequest } from './miniapp-api.ts';
import { handleTempImage } from './temp-image.handler';

const logger = createLogger('oauth-callback');

/**
 * OAuth callback server
 */
export function startOAuthServer(): void {
  const server = Bun.serve({
    port: env.OAUTH_SERVER_PORT,
    // Raise idle timeout for /api/receipt/confirm — a 70-item receipt with
    // batched sheet write typically completes in 1-3s, but with 429 retries
    // + exponential backoff (up to 32s) it can legitimately take longer.
    // Bun default is 10s which would kill the connection mid-retry.
    // Max allowed is 255s. See https://bun.com/docs/api/http
    idleTimeout: 255,
    async fetch(req) {
      const corsOrigin = env.MINIAPP_URL ?? 'https://expense-sync-bot-app.invntrm.ru';
      const miniAppResponse = await handleMiniAppRequest(req, corsOrigin);
      if (miniAppResponse !== null) return miniAppResponse;

      // Defensive: Bun hands us a relative URL for some malformed requests
      // (port scanners, HTTP/0.9). Parse with a base fallback instead of
      // letting TypeError escape the fetch handler.
      let url: URL;
      try {
        url = new URL(req.url, 'http://localhost');
      } catch {
        return new Response('Bad Request', { status: 400 });
      }

      if (url.pathname === '/callback') {
        return handleOAuthCallback(url);
      }

      if (url.pathname.startsWith('/temp-images/')) {
        return handleTempImage(url);
      }

      if (url.pathname === '/health') {
        try {
          database.groups.findById(1);
          return Response.json({ status: 'ok', uptime: process.uptime() });
        } catch {
          return Response.json({ status: 'error' }, { status: 503 });
        }
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
    logger.error({ error, errorDescription }, '[OAuth] Google returned error');

    if (state) {
      const groupId = resolveOAuthState(state);
      if (groupId !== null) {
        notifyTelegramError(groupId, errorDescription).catch((notifyErr) => {
          logger.error({ err: notifyErr }, '[OAuth] Failed to send error to Telegram');
        });
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
    logger.error('[OAuth] Invalid or expired state token');
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
      oauth_client: 'current',
    });

    logger.info(`✓ OAuth successful for group ${groupId}`);

    // Branch on whether a spreadsheet already exists:
    //   - no spreadsheet → /connect flow (new group), send currency picker
    //   - has spreadsheet → /reconnect flow, run full bidirectional sync
    // Both run as background operations so the HTTP response is not blocked.
    if (group.spreadsheet_id) {
      withChatContext(group.telegram_group_id, group.active_topic_id, () =>
        fullSyncAfterReconnect(group.id),
      ).catch((syncErr) => {
        logger.error({ err: syncErr, groupId: group.id }, '[OAuth] fullSyncAfterReconnect failed');
      });
    } else {
      notifyTelegramSuccess(group.telegram_group_id, group.active_topic_id).catch((notifyErr) => {
        logger.error({ err: notifyErr }, '[OAuth] Failed to send success message to Telegram');
      });
    }

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
    logger.error({ err }, 'Error handling OAuth callback');

    notifyTelegramError(groupId, err instanceof Error ? err.message : 'Unknown error').catch(
      (notifyErr) => {
        logger.error({ err: notifyErr }, '[OAuth] Failed to send error to Telegram');
      },
    );

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

/**
 * Send success message + currency selection keyboard to Telegram chat.
 * Runs as a background operation (outside handler context) — uses withChatContext.
 */
async function notifyTelegramSuccess(
  telegramGroupId: number,
  activeTopicId: number | null,
): Promise<void> {
  await withChatContext(telegramGroupId, activeTopicId, async () => {
    await sendMessage(MESSAGES.authSuccess);

    const keyboard = createCurrencyKeyboard();
    await sendMessage(
      '💱 Шаг 1/2: Выбери набор валют для учета:\n\n' +
        '• Можно выбрать несколько\n' +
        '• Эти валюты будут столбцами в таблице\n' +
        '• Нажми ✅ Далее когда закончишь',
      { reply_markup: keyboard },
    );
  });
}

/**
 * Send error message to Telegram chat after failed OAuth.
 * Looks up the group by DB id to get the telegram_group_id.
 */
async function notifyTelegramError(groupId: number, errorMessage: string): Promise<void> {
  const group = database.groups.findById(groupId);
  if (!group) {
    logger.error({ groupId }, '[OAuth] Group not found — cannot send error message');
    return;
  }

  await withChatContext(group.telegram_group_id, group.active_topic_id, () =>
    sendMessage(
      `❌ Не удалось подключить Google аккаунт: ${errorMessage}\n\nПопробуй еще раз: /connect`,
    ),
  );
}
