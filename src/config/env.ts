/**
 * Environment variables configuration
 */

import { PROVIDER_IDS, type ProviderId } from '../services/ai/provider-ids';
import { createLogger } from '../utils/logger';

const logger = createLogger('env');

/** Default order of the smart chain: z.ai → Claude → HF. Overridden by AI_SMART_CHAIN. */
export const DEFAULT_SMART_CHAIN: ProviderId[] = ['zai', 'claude', 'hf'];
/** Default order of the fast chain: z.ai → Claude → HF. Overridden by AI_FAST_CHAIN. */
export const DEFAULT_FAST_CHAIN: ProviderId[] = ['zai', 'claude', 'hf'];

/**
 * A chain order together with where it came from. The source is carried rather than inferred,
 * because the two cases warrant different noise: a provider the operator named and did not
 * configure deserves a warning, while one that is merely absent from the default order is the
 * documented minimal deployment.
 */
export interface ChainOrder {
  readonly order: ProviderId[];
  readonly fromEnv: boolean;
  /** Where to fall back when nothing in `order` turns out to be configured. */
  readonly fallback: ProviderId[];
}

function parseChain(name: string, fallback: ProviderId[]): ChainOrder {
  const raw = process.env[name];
  if (!raw) return { order: fallback, fromEnv: false, fallback };
  const parsed: ProviderId[] = [];
  for (const part of raw.split(',')) {
    const id = part.trim();
    if (!id) continue;
    const known = PROVIDER_IDS.find((candidate): candidate is ProviderId => candidate === id);
    if (!known) {
      logger.warn(
        { name, id, known: PROVIDER_IDS },
        'Unknown provider in chain order — ignoring it',
      );
      continue;
    }
    if (!parsed.includes(known)) parsed.push(known);
  }
  if (parsed.length === 0) {
    logger.warn(
      { name, raw, fallback },
      'Chain order named no known provider — using the default order',
    );
    return { order: fallback, fromEnv: false, fallback };
  }
  return { order: parsed, fromEnv: true, fallback };
}

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

  // z.ai provider (kept ANTHROPIC_API_KEY name — it's the z.ai key); head of the default chains
  ANTHROPIC_API_KEY: string;
  AI_BASE_URL: string;
  AI_MODEL: string;
  AI_FAST_MODEL: string;

  // Provider order of the text chains (AI_SMART_CHAIN / AI_FAST_CHAIN: comma-separated provider ids).
  AI_SMART_CHAIN: ChainOrder;
  AI_FAST_CHAIN: ChainOrder;

  // Anthropic Claude (OpenAI-compat endpoint; optional key — second in smart/fast, OCR primary).
  // Without the key every Claude slot is skipped and OCR runs on HF vision alone.
  CLAUDE_API_TOKEN: string;
  CLAUDE_BASE_URL: string;
  CLAUDE_MODEL: string;
  CLAUDE_FAST_MODEL: string;
  CLAUDE_VISION_MODEL: string;

  // HuggingFace Router (fallback + vision)
  HF_TOKEN: string;
  HF_BASE_URL: string;
  HF_MODEL: string;
  HF_FAST_MODEL: string;
  HF_VISION_MODEL: string;

  GITHUB_TOKEN: string;
  BOT_ADMIN_CHAT_ID: number | null;
  LARGE_TX_THRESHOLD_EUR: number;
  AI_DEBUG_LOGS: boolean;
  AUTO_ADVICE_ENABLED: boolean;
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

    AI_SMART_CHAIN: parseChain('AI_SMART_CHAIN', DEFAULT_SMART_CHAIN),
    AI_FAST_CHAIN: parseChain('AI_FAST_CHAIN', DEFAULT_FAST_CHAIN),

    CLAUDE_API_TOKEN: getEnvVariable('CLAUDE_API_TOKEN', false),
    CLAUDE_BASE_URL: getEnvVariable('CLAUDE_BASE_URL', false) || 'https://api.anthropic.com/v1/',
    CLAUDE_MODEL: getEnvVariable('CLAUDE_MODEL', false) || 'claude-sonnet-5-5',
    CLAUDE_FAST_MODEL: getEnvVariable('CLAUDE_FAST_MODEL', false) || 'claude-haiku-5-5',
    // Sonnet, not Haiku: on degraded receipt photos Haiku returned a wrong yet sum-verified receipt.
    CLAUDE_VISION_MODEL: getEnvVariable('CLAUDE_VISION_MODEL', false) || 'claude-sonnet-5-5',

    HF_TOKEN: getEnvVariable('HF_TOKEN'),
    HF_BASE_URL: getEnvVariable('HF_BASE_URL'),
    HF_MODEL: getEnvVariable('HF_MODEL'),
    HF_FAST_MODEL: getEnvVariable('HF_FAST_MODEL'),
    HF_VISION_MODEL: getEnvVariable('HF_VISION_MODEL'),

    GITHUB_TOKEN: getEnvVariable('GITHUB_TOKEN', false),
    BOT_ADMIN_CHAT_ID: process.env['BOT_ADMIN_CHAT_ID']
      ? parseInt(process.env['BOT_ADMIN_CHAT_ID'], 10)
      : null,
    LARGE_TX_THRESHOLD_EUR: parseInt(process.env['LARGE_TX_THRESHOLD_EUR'] || '100', 10),
    AI_DEBUG_LOGS: process.env['AI_DEBUG_LOGS'] === 'true',
    AUTO_ADVICE_ENABLED: process.env['AUTO_ADVICE_ENABLED'] === 'true',
    NODE_ENV: (process.env.NODE_ENV as 'development' | 'production') || 'development',
    MINIAPP_URL: getEnvVariable('MINIAPP_URL', false) || undefined,
    MINIAPP_SHORTNAME: getEnvVariable('MINIAPP_SHORTNAME', false) || undefined,
  };
}

export const env = validateEnv();
