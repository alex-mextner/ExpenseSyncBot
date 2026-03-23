/**
 * Environment variables configuration
 */

interface EnvConfig {
  BOT_TOKEN: string;
  GOOGLE_CLIENT_ID: string;
  GOOGLE_CLIENT_SECRET: string;
  GOOGLE_REDIRECT_URI: string;
  OAUTH_SERVER_PORT: number;
  DATABASE_PATH: string;
  ENCRYPTION_KEY: string;
  HF_TOKEN: string;
  ANTHROPIC_API_KEY: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
  GITHUB_TOKEN: string;
  NODE_ENV: 'development' | 'production';
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
    GOOGLE_CLIENT_ID: getEnvVariable('GOOGLE_CLIENT_ID'),
    GOOGLE_CLIENT_SECRET: getEnvVariable('GOOGLE_CLIENT_SECRET'),
    GOOGLE_REDIRECT_URI: getEnvVariable('GOOGLE_REDIRECT_URI'),
    OAUTH_SERVER_PORT: parseInt(getEnvVariable('OAUTH_SERVER_PORT', false) || '3000', 10),
    DATABASE_PATH: getEnvVariable('DATABASE_PATH', false) || './data/expenses.db',
    ENCRYPTION_KEY: getEnvVariable('ENCRYPTION_KEY'),
    HF_TOKEN: getEnvVariable('HF_TOKEN', false),
    ANTHROPIC_API_KEY: getEnvVariable('ANTHROPIC_API_KEY', false),
    AI_BASE_URL: getEnvVariable('AI_BASE_URL', false),
    AI_MODEL: getEnvVariable('AI_MODEL', false) || 'glm-4.7',
    GITHUB_TOKEN: getEnvVariable('GITHUB_TOKEN', false),
    NODE_ENV: (process.env.NODE_ENV as 'development' | 'production') || 'development',
  };
}

export const env = validateEnv();
