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

  // z.ai primary provider (kept ANTHROPIC_API_KEY name — it's the z.ai key)
  ANTHROPIC_API_KEY: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
  AI_FAST_MODEL: string;

  // HuggingFace Router (fallback + vision)
  HF_TOKEN: string;
  HF_BASE_URL: string;
  HF_MODEL: string;
  HF_FAST_MODEL: string;
  HF_VISION_MODEL: string;

  // Google Gemini (fallback + vision primary)
  GEMINI_API_KEY: string;
  GEMINI_BASE_URL: string;
  GEMINI_MODEL: string;
  GEMINI_FAST_MODEL: string;
  GEMINI_VISION_MODEL: string;

  GITHUB_TOKEN: string;
  BOT_ADMIN_CHAT_ID: number | null;
  LARGE_TX_THRESHOLD_EUR: number;
  AI_DEBUG_LOGS: boolean;
  NODE_ENV: 'development' | 'production';
  MINIAPP_URL: string | undefined;
  MINIAPP_SHORTNAME: string | undefined;
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

    ANTHROPIC_API_KEY: getEnvVariable('ANTHROPIC_API_KEY'),
    AI_BASE_URL: getEnvVariable('AI_BASE_URL'),
    AI_MODEL: getEnvVariable('AI_MODEL'),
    AI_FAST_MODEL: getEnvVariable('AI_FAST_MODEL'),

    HF_TOKEN: getEnvVariable('HF_TOKEN'),
    HF_BASE_URL: getEnvVariable('HF_BASE_URL'),
    HF_MODEL: getEnvVariable('HF_MODEL'),
    HF_FAST_MODEL: getEnvVariable('HF_FAST_MODEL'),
    HF_VISION_MODEL: getEnvVariable('HF_VISION_MODEL'),

    GEMINI_API_KEY: getEnvVariable('GEMINI_API_KEY'),
    GEMINI_BASE_URL: getEnvVariable('GEMINI_BASE_URL'),
    GEMINI_MODEL: getEnvVariable('GEMINI_MODEL'),
    GEMINI_FAST_MODEL: getEnvVariable('GEMINI_FAST_MODEL'),
    GEMINI_VISION_MODEL: getEnvVariable('GEMINI_VISION_MODEL'),

    GITHUB_TOKEN: getEnvVariable('GITHUB_TOKEN', false),
    BOT_ADMIN_CHAT_ID: process.env['BOT_ADMIN_CHAT_ID']
      ? parseInt(process.env['BOT_ADMIN_CHAT_ID'], 10)
      : null,
    LARGE_TX_THRESHOLD_EUR: parseInt(process.env['LARGE_TX_THRESHOLD_EUR'] || '100', 10),
    AI_DEBUG_LOGS: process.env['AI_DEBUG_LOGS'] === 'true',
    NODE_ENV: (process.env.NODE_ENV as 'development' | 'production') || 'development',
    MINIAPP_URL: getEnvVariable('MINIAPP_URL', false) || undefined,
    MINIAPP_SHORTNAME: getEnvVariable('MINIAPP_SHORTNAME', false) || undefined,
  };
}

export const env = validateEnv();
