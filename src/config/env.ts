/**
 * Environment variables configuration
 */

interface EnvConfig {
  BOT_TOKEN: string;
  BOT_USERNAME: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  GOOGLE_LEGACY_CLIENT_ID: string;
  GOOGLE_LEGACY_CLIENT_SECRET: string;
  OAUTH_SERVER_PORT: number;
  DATABASE_PATH: string;
  ENCRYPTION_KEY: string; // empty string when not set — encryption features deactivate gracefully
  HF_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
  AI_VALIDATION_MODEL: string;
  GITHUB_TOKEN: string;
  BOT_ADMIN_CHAT_ID: number | null;
  LARGE_TX_THRESHOLD_EUR: number;
  AI_DEBUG_LOGS: boolean;
  NODE_ENV: 'development' | 'production';
  MINIAPP_URL: string | undefined;
}

function getEnvVariable(name: string, required = true): string {
  const value = process.env[name];

  if (!value && required) {
    throw new Error(`Missing required environment variable: ${name}`);
  }

  return value || '';
}

function validateEnv(): EnvConfig {
  return {
    BOT_TOKEN: getEnvVariable('BOT_TOKEN'),
    BOT_USERNAME: getEnvVariable('BOT_USERNAME', false) || 'ExpenseSyncBot',
    GOOGLE_CLIENT_ID: getEnvVariable('GOOGLE_CLIENT_ID'),
    GOOGLE_CLIENT_SECRET: getEnvVariable('GOOGLE_CLIENT_SECRET'),
    GOOGLE_REDIRECT_URI: getEnvVariable('GOOGLE_REDIRECT_URI'),
    GOOGLE_LEGACY_CLIENT_ID: getEnvVariable('GOOGLE_LEGACY_CLIENT_ID', false),
    GOOGLE_LEGACY_CLIENT_SECRET: getEnvVariable('GOOGLE_LEGACY_CLIENT_SECRET', false),
    OAUTH_SERVER_PORT: parseInt(getEnvVariable('OAUTH_SERVER_PORT', false) || '3000', 10),
    DATABASE_PATH: getEnvVariable('DATABASE_PATH', false) || './data/expenses.db',
    ENCRYPTION_KEY: getEnvVariable('ENCRYPTION_KEY', false),
    HF_TOKEN: getEnvVariable('HF_TOKEN', false),
    ANTHROPIC_API_KEY: getEnvVariable('ANTHROPIC_API_KEY', false),
    AI_BASE_URL: getEnvVariable('AI_BASE_URL', false) || 'https://api.z.ai/api/anthropic',
    AI_MODEL: getEnvVariable('AI_MODEL', false) || 'glm-5',
    AI_VALIDATION_MODEL: getEnvVariable('AI_VALIDATION_MODEL', false) || 'glm-4.7-flash',
    GITHUB_TOKEN: getEnvVariable('GITHUB_TOKEN', false),
    BOT_ADMIN_CHAT_ID: process.env['BOT_ADMIN_CHAT_ID']
      ? parseInt(process.env['BOT_ADMIN_CHAT_ID'], 10)
      : null,
    LARGE_TX_THRESHOLD_EUR: parseInt(process.env['LARGE_TX_THRESHOLD_EUR'] || '100', 10),
    AI_DEBUG_LOGS: process.env['AI_DEBUG_LOGS'] === 'true',
    NODE_ENV: (process.env.NODE_ENV as 'development' | 'production') || 'development',
    MINIAPP_URL: getEnvVariable('MINIAPP_URL', false) || undefined,
  };
}

export const env = validateEnv();
