// OAuth callback HTTP server — handles Google OAuth redirects and token exchange.
import type { Bot } from 'gramio';
import { createCurrencyKeyboard } from '../bot/keyboards';
import { MESSAGES } from '../config/constants';
import { env } from '../config/env';
import { database } from '../database';
import { getTokensFromCode, resolveOAuthState } from '../services/google/oauth';
import { encryptToken } from '../services/google/token-encryption';
import { createLogger } from '../utils/logger.ts';
import { escapeHtml } from './html-escape';
import { handleTempImage } from './temp-image.handler';

const logger = createLogger('oauth-callback');

/** Bot instance for sending messages after OAuth completes (set via setBotInstance) */
let botInstance: Bot | null = null;

/**
 * Register the bot instance so the OAuth callback can send Telegram messages.
 * Called from startBot() after the bot is created and started.
 */
export function setBotInstance(bot: Bot): void {
  botInstance = bot;
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
        try {
          database.groups.findById(1);
          return Response.json({ status: 'ok', uptime: process.uptime() });
        } catch {
          return Response.json({ status: 'error' }, { status: 503 });
        }
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

    logger.info(`✓ OAuth successful for group ${groupId}`);

    // Send success message + currency keyboard to Telegram (background, non-blocking for HTTP response)
    notifyTelegramSuccess(group.telegram_group_id, group.active_topic_id).catch((notifyErr) => {
      logger.error({ err: notifyErr }, '[OAuth] Failed to send success message to Telegram');
    });

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
 * Runs as a background operation (outside handler context), so message_thread_id is passed explicitly.
 */
async function notifyTelegramSuccess(
  telegramGroupId: number,
  activeTopicId: number | null,
): Promise<void> {
  if (!botInstance) {
    logger.error('[OAuth] Bot instance not set — cannot send success message');
    return;
  }

  const topicParams = activeTopicId ? { message_thread_id: activeTopicId } : {};

  await botInstance.api.sendMessage({
    chat_id: telegramGroupId,
    text: MESSAGES.authSuccess,
    ...topicParams,
  });

  const keyboard = createCurrencyKeyboard();
  await botInstance.api.sendMessage({
    chat_id: telegramGroupId,
    text:
      '💱 Шаг 1/2: Выбери набор валют для учета:\n\n' +
      '• Можно выбрать несколько\n' +
      '• Эти валюты будут столбцами в таблице\n' +
      '• Нажми ✅ Далее когда закончишь',
    reply_markup: keyboard,
    ...topicParams,
  });
}

/**
 * Send error message to Telegram chat after failed OAuth.
 * Looks up the group by DB id to get the telegram_group_id.
 */
async function notifyTelegramError(groupId: number, errorMessage: string): Promise<void> {
  if (!botInstance) {
    logger.error('[OAuth] Bot instance not set — cannot send error message');
    return;
  }

  const group = database.groups.findById(groupId);
  if (!group) {
    logger.error(`[OAuth] Group ${groupId} not found — cannot send error message`);
    return;
  }

  const topicParams = group.active_topic_id ? { message_thread_id: group.active_topic_id } : {};

  await botInstance.api.sendMessage({
    chat_id: group.telegram_group_id,
    text: `❌ Не удалось подключить Google аккаунт: ${errorMessage}\n\nПопробуй еще раз: /connect`,
    ...topicParams,
  });
}
