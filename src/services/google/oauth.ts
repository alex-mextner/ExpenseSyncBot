import { google } from 'googleapis';
import { env } from '../../config/env';
import { GOOGLE_SCOPES } from '../../config/constants';

/**
 * OAuth2 client instance
 */
export const oauth2Client = new google.auth.OAuth2(
  env.GOOGLE_CLIENT_ID,
  env.GOOGLE_CLIENT_SECRET,
  env.GOOGLE_REDIRECT_URI
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

/**
 * Get OAuth2 client with refresh token
 */
export function getAuthenticatedClient(refreshToken: string) {
  const client = new google.auth.OAuth2(
    env.GOOGLE_CLIENT_ID,
    env.GOOGLE_CLIENT_SECRET,
    env.GOOGLE_REDIRECT_URI
  );

  client.setCredentials({
    refresh_token: refreshToken,
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
