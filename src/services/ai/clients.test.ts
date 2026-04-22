// Tests for OpenAI-compatible client factories (zai, hf, gemini).
// Verifies configuration is wired from env and clients are cached (singleton).

import { beforeEach, describe, expect, it, mock } from 'bun:test';
import { createMockLogger } from '../../test-utils/mocks/logger';

const logMock = createMockLogger();

mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

mock.module('../../config/env', () => ({
  env: {
    ANTHROPIC_API_KEY: 'zai-key',
    AI_BASE_URL: 'https://zai.test/v1',
    HF_TOKEN: 'hf-key',
    HF_BASE_URL: 'https://hf.test/v1',
    GEMINI_API_KEY: 'gemini-key',
    GEMINI_BASE_URL: 'https://gemini.test/v1',
  },
}));

// Capture every OpenAI constructor call so we can assert config without real HTTP
interface CapturedOpts {
  apiKey?: string;
  baseURL?: string;
  timeout?: number;
  maxRetries?: number;
  fetch?: unknown;
}
const constructorCalls: CapturedOpts[] = [];

class FakeOpenAI {
  apiKey: string | undefined;
  baseURL: string | undefined;
  timeout: number | undefined;
  maxRetries: number | undefined;
  fetch: unknown;

  constructor(opts: CapturedOpts) {
    this.apiKey = opts.apiKey;
    this.baseURL = opts.baseURL;
    this.timeout = opts.timeout;
    this.maxRetries = opts.maxRetries;
    this.fetch = opts.fetch;
    constructorCalls.push(opts);
  }
}

mock.module('openai', () => ({
  default: FakeOpenAI,
}));

const { zaiClient, hfClient, geminiClient, resetClients } = await import('./clients');

describe('client factories', () => {
  beforeEach(() => {
    resetClients();
    constructorCalls.length = 0;
  });

  describe('zaiClient', () => {
    it('constructs OpenAI with ANTHROPIC_API_KEY and AI_BASE_URL', () => {
      const c = zaiClient() as unknown as FakeOpenAI;
      expect(c.apiKey).toBe('zai-key');
      expect(c.baseURL).toBe('https://zai.test/v1');
      expect(c.maxRetries).toBe(0);
      expect(c.timeout).toBe(60_000);
      expect(typeof c.fetch).toBe('function');
    });

    it('caches the instance (singleton) across calls', () => {
      const a = zaiClient();
      const b = zaiClient();
      expect(a).toBe(b);
      expect(constructorCalls.length).toBe(1);
    });

    it('reconstructs after resetClients()', () => {
      zaiClient();
      resetClients();
      zaiClient();
      expect(constructorCalls.length).toBe(2);
    });

    it('fetch delegate proxies to globalThis.fetch', async () => {
      const c = zaiClient() as unknown as FakeOpenAI;
      const fetchFn = c.fetch as (url: string, init?: RequestInit) => Promise<Response>;

      const originalFetch = globalThis.fetch;
      let captured: string | undefined;
      globalThis.fetch = (async (url: string) => {
        captured = url;
        return new Response('ok');
      }) as unknown as typeof globalThis.fetch;

      try {
        const res = await fetchFn('https://probe.test');
        expect(captured).toBe('https://probe.test');
        expect(await res.text()).toBe('ok');
      } finally {
        globalThis.fetch = originalFetch;
      }
    });
  });

  describe('hfClient', () => {
    it('constructs OpenAI with HF_TOKEN and HF_BASE_URL', () => {
      const c = hfClient() as unknown as FakeOpenAI;
      expect(c.apiKey).toBe('hf-key');
      expect(c.baseURL).toBe('https://hf.test/v1');
      expect(c.maxRetries).toBe(0);
      expect(c.timeout).toBe(60_000);
    });

    it('caches the instance (singleton)', () => {
      const a = hfClient();
      const b = hfClient();
      expect(a).toBe(b);
    });
  });

  describe('geminiClient', () => {
    it('constructs OpenAI with GEMINI_API_KEY and GEMINI_BASE_URL', () => {
      const c = geminiClient() as unknown as FakeOpenAI;
      expect(c.apiKey).toBe('gemini-key');
      expect(c.baseURL).toBe('https://gemini.test/v1');
      expect(c.maxRetries).toBe(0);
    });

    it('uses longer 120s timeout (thinking-aware)', () => {
      const c = geminiClient() as unknown as FakeOpenAI;
      expect(c.timeout).toBe(120_000);
    });

    it('caches the instance (singleton)', () => {
      const a = geminiClient();
      const b = geminiClient();
      expect(a).toBe(b);
    });
  });

  describe('resetClients', () => {
    it('clears all three cached clients independently', () => {
      const z1 = zaiClient();
      const h1 = hfClient();
      const g1 = geminiClient();

      resetClients();

      const z2 = zaiClient();
      const h2 = hfClient();
      const g2 = geminiClient();

      expect(z2).not.toBe(z1);
      expect(h2).not.toBe(h1);
      expect(g2).not.toBe(g1);
    });
  });

  it('does not log errors on happy path', () => {
    zaiClient();
    hfClient();
    geminiClient();
    expect(logMock.error).not.toHaveBeenCalled();
    expect(logMock.warn).not.toHaveBeenCalled();
  });
});
