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
    OAUTH_SERVER_PORT: parseInt(getEnvVariable('OAUTH_SERVER_PORT', false) || '3000'),
    DATABASE_PATH: getEnvVariable('DATABASE_PATH', false) || './data/expenses.db',
    ENCRYPTION_KEY: getEnvVariable('ENCRYPTION_KEY'),
    NODE_ENV: (process.env.NODE_ENV as 'development' | 'production') || 'development',
  };
}

export const env = validateEnv();
