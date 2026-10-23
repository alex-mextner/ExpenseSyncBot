// Tests for env config loading: which AI provider variables are required at startup.
// env.ts validates at import time, so each case loads it in a fresh `bun` process with an exact
// environment. The child runs from a temp dir so Bun's automatic .env loading can't leak real keys.

import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ENV_MODULE = join(import.meta.dir, 'env.ts');

/** Every variable validateEnv() requires — nothing else. */
const REQUIRED_ENV: Record<string, string> = {
  BOT_TOKEN: 'test-bot-token',
  GOOGLE_CLIENT_ID: 'test-client-id',
  GOOGLE_CLIENT_SECRET: 'test-client-secret',
  GOOGLE_REDIRECT_URI: 'http://localhost:3000/callback',
  ANTHROPIC_API_KEY: 'test-zai-key',
  AI_BASE_URL: 'https://test.zai/v4',
  AI_MODEL: 'glm-test',
  AI_FAST_MODEL: 'glm-fast-test',
  HF_TOKEN: 'test-hf-token',
  HF_BASE_URL: 'https://test.hf/v1',
  HF_MODEL: 'hf-test',
  HF_FAST_MODEL: 'hf-fast-test',
  HF_VISION_MODEL: 'hf-vision-test',
};

interface LoadResult {
  status: number | null;
  stdout: string;
  stderr: string;
}

function loadEnv(vars: Record<string, string>): LoadResult {
  const cwd = mkdtempSync(join(tmpdir(), 'env-test-'));
  try {
    // The child reports the loaded config on stdout; the parent parses it.
    const script = `const { env } = await import(${JSON.stringify(ENV_MODULE)});
process.stdout.write('REPORT:' + JSON.stringify({ keys: Object.keys(env), claudeVisionModel: env.CLAUDE_VISION_MODEL, smartChain: env.AI_SMART_CHAIN, fastChain: env.AI_FAST_CHAIN }) + '\\n');`;
    const child = spawnSync(process.execPath, ['-e', script], {
      cwd,
      env: { PATH: process.env['PATH'] ?? '', ...vars },
      encoding: 'utf8',
    });
    return { status: child.status, stdout: child.stdout, stderr: child.stderr };
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

interface ChainOrderJson {
  order: string[];
  fromEnv: boolean;
  fallback: string[];
}

function loadedConfig(result: LoadResult): {
  keys: string[];
  claudeVisionModel: string;
  smartChain: ChainOrderJson;
  fastChain: ChainOrderJson;
} {
  expect(result.stderr).not.toContain('Missing required environment variable');
  expect(result.status).toBe(0);
  // A chain-order warning is logged to stdout around the report line.
  const line = result.stdout.split('\n').find((l) => l.startsWith('REPORT:')) ?? '';
  return JSON.parse(line.slice('REPORT:'.length));
}

describe('env config loading', () => {
  it('defaults both text chains to z.ai → Claude → HF', () => {
    const { smartChain, fastChain } = loadedConfig(loadEnv(REQUIRED_ENV));
    const expected = {
      order: ['zai', 'claude', 'hf'],
      fromEnv: false,
      fallback: ['zai', 'claude', 'hf'],
    };
    expect(smartChain).toEqual(expected);
    expect(fastChain).toEqual(expected);
  });

  it('AI_SMART_CHAIN / AI_FAST_CHAIN set the order; unknown ids and duplicates are dropped', () => {
    const { smartChain, fastChain } = loadedConfig(
      loadEnv({ ...REQUIRED_ENV, AI_SMART_CHAIN: 'hf, claude,groq,hf', AI_FAST_CHAIN: 'claude' }),
    );
    expect(smartChain.order).toEqual(['hf', 'claude']);
    expect(smartChain.fromEnv).toBe(true);
    expect(fastChain.order).toEqual(['claude']);
  });

  it('a chain order naming no known provider falls back to the default order', () => {
    const { smartChain } = loadedConfig(
      loadEnv({ ...REQUIRED_ENV, AI_SMART_CHAIN: 'groq,gemini' }),
    );
    expect(smartChain).toEqual({
      order: ['zai', 'claude', 'hf'],
      fromEnv: false,
      fallback: ['zai', 'claude', 'hf'],
    });
  });

  it('starts with only the required variables set — no CLAUDE_* and no retired provider keys', () => {
    const { keys, claudeVisionModel } = loadedConfig(loadEnv(REQUIRED_ENV));
    // The full credential set: a provider dropped from the chains must not linger in the config.
    expect(keys.filter((key) => /_(API_KEY|TOKEN)$/.test(key)).sort()).toEqual([
      'ANTHROPIC_API_KEY',
      'BOT_TOKEN',
      'CLAUDE_API_TOKEN',
      'GITHUB_TOKEN',
      'HF_TOKEN',
    ]);
    // Claude stays optional: CLAUDE_API_TOKEN is exposed (empty) and its slots are skipped.
    // OCR defaults to Sonnet (measured: Haiku accepted a misread degraded receipt).
    expect(claudeVisionModel).toBe('claude-sonnet-5-5');
  });

  it('reads CLAUDE_VISION_MODEL from the environment when set', () => {
    const { claudeVisionModel } = loadedConfig(
      loadEnv({ ...REQUIRED_ENV, CLAUDE_VISION_MODEL: 'claude-vision-override' }),
    );
    expect(claudeVisionModel).toBe('claude-vision-override');
  });

  it('still fails fast when a required provider variable is missing', () => {
    const withoutHfVision = Object.fromEntries(
      Object.entries(REQUIRED_ENV).filter(([name]) => name !== 'HF_VISION_MODEL'),
    );
    const result = loadEnv(withoutHfVision);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('Missing required environment variable: HF_VISION_MODEL');
  });
});
