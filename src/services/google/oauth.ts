import { google } from 'googleapis';
import { GOOGLE_SCOPES } from '../../config/constants';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';
import { decryptToken, isEncryptedToken } from './token-encryption';

/**
 * OAuth2 client instance
 */
export const oauth2Client = new google.auth.OAuth2(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
  env.GOOGLE_REDIRECT_URI,
);

/**
 * Generate OAuth URL for user authorization
 */
export function generateAuthUrl(userId: number): string {
  return oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: GOOGLE_SCOPES,
    state: userId.toString(), // Pass user ID to retrieve after callback
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

/**
 * Get OAuth2 client with refresh token.
 * Automatically decrypts the token if it's in encrypted format (iv:authTag:ciphertext).
 * Supports plaintext tokens for backward compatibility during migration.
 */
export function getAuthenticatedClient(refreshToken: string) {
  let plainToken = refreshToken;

  if (isEncryptedToken(refreshToken)) {
    try {
      plainToken = decryptToken(refreshToken, env.ENCRYPTION_KEY);
    } catch (err) {
      logger.error({ err }, 'Failed to decrypt refresh token');
      throw new Error('Failed to decrypt stored refresh token');
    }
  }

  const client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI,
  );

  client.setCredentials({
    refresh_token: plainToken,
  });

  return client;
}

/**
 * Refresh access token
 */
export async function refreshAccessToken(refreshToken: string): Promise<string> {
  const client = getAuthenticatedClient(refreshToken);

  const { credentials } = await client.refreshAccessToken();

  if (!credentials.access_token) {
    throw new Error('Failed to refresh access token');
  }

  return credentials.access_token;
}

/**
 * Revoke access token
 */
export async function revokeToken(refreshToken: string): Promise<void> {
  const client = getAuthenticatedClient(refreshToken);
  await client.revokeCredentials();
}
