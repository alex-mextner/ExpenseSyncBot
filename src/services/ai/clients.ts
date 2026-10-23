/**
 * OpenAI SDK client factories for all AI providers (z.ai, Claude, HF).
 * All providers share the same OpenAI SDK — only baseURL and apiKey differ.
 * Base URLs and keys are loaded from env — no hardcoded values.
 */

import OpenAI from 'openai';
import { env } from '../../config/env';

const DEFAULT_TIMEOUT_MS = 60_000;

function makeFetchDelegate(): (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response> {
  return async (url, init) => globalThis.fetch(url, init);
}

let _zai: OpenAI | null = null;
let _claude: OpenAI | null = null;
let _hf: OpenAI | null = null;

export function zaiClient(): OpenAI {
  if (!_zai) {
    _zai = new OpenAI({
      apiKey: env.ANTHROPIC_API_KEY,
      baseURL: env.AI_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
      fetch: makeFetchDelegate(),
    });
  }
  return _zai;
}

export function claudeClient(): OpenAI {
  if (!_claude) {
    _claude = new OpenAI({
      apiKey: env.CLAUDE_API_TOKEN,
      baseURL: env.CLAUDE_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
      fetch: makeFetchDelegate(),
    });
  }
  return _claude;
}

export function hfClient(): OpenAI {
  if (!_hf) {
    _hf = new OpenAI({
      apiKey: env.HF_TOKEN,
      baseURL: env.HF_BASE_URL,
      timeout: DEFAULT_TIMEOUT_MS,
      maxRetries: 0,
      fetch: makeFetchDelegate(),
    });
  }
  return _hf;
}

/** Reset cached clients (for tests). */
export function resetClients(): void {
  _zai = null;
  _claude = null;
  _hf = null;
}
