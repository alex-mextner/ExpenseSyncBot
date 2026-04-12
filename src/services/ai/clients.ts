/**
 * OpenAI SDK client factories for all AI providers.
 * All providers share the same OpenAI SDK — only baseURL and apiKey differ.
 * Base URLs and keys are loaded from env — no hardcoded values.
 */

import OpenAI from 'openai';
import { env } from '../../config/env';

const DEFAULT_TIMEOUT_MS = 60_000;
// Gemini 2.5 Pro has always-on "thinking" that adds significant latency.
// 60s is too tight for large receipts (70 items: 27s measured, but network
// jitter + thinking can push past 60s). 120s matches PARSE_TIMEOUT_MS in
// receipt-parser.ts so the client doesn't kill the request before the
// application-level timeout fires.
const GEMINI_TIMEOUT_MS = 120_000;

function makeFetchDelegate(): (
  url: string | URL | Request,
  init?: RequestInit,
) => Promise<Response> {
  return async (url, init) => globalThis.fetch(url, init);
}

let _zai: OpenAI | null = null;
let _hf: OpenAI | null = null;
let _gemini: OpenAI | null = null;

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

export function geminiClient(): OpenAI {
  if (!_gemini) {
    _gemini = new OpenAI({
      apiKey: env.GEMINI_API_KEY,
      baseURL: env.GEMINI_BASE_URL,
      timeout: GEMINI_TIMEOUT_MS,
      maxRetries: 0,
      fetch: makeFetchDelegate(),
    });
  }
  return _gemini;
}

/** Reset cached clients (for tests). */
export function resetClients(): void {
  _zai = null;
  _hf = null;
  _gemini = null;
}
