// Google OAuth2 client with dual credentials (current + legacy), URL generation, and secure state management

import { google } from 'googleapis';
import { GOOGLE_SCOPES } from '../../config/constants';
import { env } from '../../config/env';
import type { OAuthClientType } from '../../database/types';
import { createLogger } from '../../utils/logger.ts';
import { decryptToken, isEncryptedToken } from './token-encryption';

/** One-hour TTL — OAuth URL is pre-generated in /connect, user may not click immediately */
const STATE_TTL_MS = 60 * 60 * 1000;

/** In-memory map of UUID state → { groupId, expiresAt } */
const pendingStates = new Map<string, { groupId: number; expiresAt: number }>();

/**
 * Register an OAuth state token for a group.
 * Returns the UUID to embed in the OAuth URL state param.
 * Accepts an optional ttlMs override (primarily for testing).
 */
export function registerOAuthState(groupId: number, ttlMs: number = STATE_TTL_MS): string {
  const uuid = crypto.randomUUID();
  pendingStates.set(uuid, { groupId, expiresAt: Date.now() + ttlMs });
  return uuid;
}

/**
 * Resolve a UUID state token to a groupId.
 * One-time use: the entry is deleted on first successful lookup.
 * Returns null if the state is unknown or expired.
 */
export function resolveOAuthState(state: string): number | null {
  const entry = pendingStates.get(state);
  if (!entry) return null;

  pendingStates.delete(state);

  if (Date.now() > entry.expiresAt) return null;

  return entry.groupId;
}

/**
 * OAuth2 client instance
 */
export const oauth2Client = new google.auth.OAuth2(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
  env.GOOGLE_REDIRECT_URI,
);

/**
 * Generate OAuth URL for group authorization.
 * Embeds a random UUID as the state param (maps to groupId server-side).
 */
export function generateAuthUrl(groupId: number): string {
  const state = registerOAuthState(groupId);
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_SCOPES,
    state,
    prompt: 'consent', // Force consent screen to get refresh token
  });
}

/**
 * Exchange authorization code for tokens
 */
export async function getTokensFromCode(code: string): Promise<{
  access_token: string;
  refresh_token: string;
  expiry_date: number;
}> {
  const { tokens } = await oauth2Client.getToken(code);

  if (!tokens.access_token) {
    throw new Error('No access token received');
  }

  if (!tokens.refresh_token) {
    throw new Error('No refresh token received');
  }

  return {
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token,
    expiry_date: tokens.expiry_date || Date.now() + 3600 * 1000,
  };
}

const logger = createLogger('oauth');

const hasLegacyCredentials = Boolean(
  env.GOOGLE_LEGACY_CLIENT_ID && env.GOOGLE_LEGACY_CLIENT_SECRET,
);

/** Create a bare OAuth2 client for the given credential set */
function createOAuth2Client(clientType: OAuthClientType) {
  if (clientType === 'legacy') {
    if (!hasLegacyCredentials) {
      throw new Error(
        'Legacy OAuth credentials not configured (GOOGLE_LEGACY_CLIENT_ID / GOOGLE_LEGACY_CLIENT_SECRET)',
      );
    }
    return new google.auth.OAuth2(
      env.GOOGLE_LEGACY_CLIENT_ID,
      env.GOOGLE_LEGACY_CLIENT_SECRET,
      env.GOOGLE_REDIRECT_URI,
    );
  }
  return new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );
}

/**
 * Get OAuth2 client with refresh token, using credentials matching the group's oauth_client type.
 * Automatically decrypts the token if it's in encrypted format (iv:authTag:ciphertext).
 * Supports plaintext tokens for backward compatibility during migration.
 */
export function getAuthenticatedClient(
  refreshToken: string,
  clientType: OAuthClientType = 'current',
) {
  let plainToken = refreshToken;

  if (isEncryptedToken(refreshToken)) {
    try {
      plainToken = decryptToken(refreshToken, env.ENCRYPTION_KEY);
    } catch (err) {
      logger.error({ err }, 'Failed to decrypt refresh token');
      throw new Error('Failed to decrypt stored refresh token');
    }
  }

  const client = createOAuth2Client(clientType);

  client.setCredentials({
    refresh_token: plainToken,
  });

  return client;
}

/**
 * Check if an error indicates an expired or revoked OAuth token.
 * Matches HTTP 401, invalid_grant, and common Google OAuth error messages.
 */
export function isTokenExpiredError(error: unknown): boolean {
  if (!(error instanceof Error)) return false;
  const msg = error.message.toLowerCase();
  return (
    msg.includes('invalid_grant') ||
    msg.includes('token has been expired or revoked') ||
    msg.includes('token has been revoked') ||
    msg.includes('unauthorized') ||
    msg.includes('401')
  );
}

/**
 * Refresh access token using the correct OAuth credentials
 */
export async function refreshAccessToken(
  refreshToken: string,
  clientType: OAuthClientType = 'current',
): Promise<string> {
  const client = getAuthenticatedClient(refreshToken, clientType);

  const { credentials } = await client.refreshAccessToken();

  if (!credentials.access_token) {
    throw new Error('Failed to refresh access token');
  }

  return credentials.access_token;
}

/**
 * Revoke access token
 */
export async function revokeToken(
  refreshToken: string,
  clientType: OAuthClientType = 'current',
): Promise<void> {
  const client = getAuthenticatedClient(refreshToken, clientType);
  await client.revokeCredentials();
}

if (hasLegacyCredentials) {
  logger.info('Legacy Google OAuth credentials configured');
}
