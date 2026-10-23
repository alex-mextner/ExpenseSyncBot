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
process.stdout.write('REPORT:' + JSON.stringify({ keys: Object.keys(env), claudeVisionModel: env.CLAUDE_VISION_MODEL, openrouter: [env.OPENROUTER_BASE_URL, env.OPENROUTER_MODEL, env.OPENROUTER_FAST_MODEL], routing: { mode: env.AI_ROUTING, userIds: env.AI_ROUTING_USER_IDS ?? null, chains: Object.fromEntries(Object.entries(env.AI_ROLE_CHAINS).map(([role, entries]) => [role, entries.map((e) => e.provider + (e.preset ? ':' + e.preset.id : ''))])) }, smartChain: env.AI_SMART_CHAIN, fastChain: env.AI_FAST_CHAIN }) + '\\n');`;
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
  openrouter: string[];
  routing: { mode: string; userIds: number[] | null; chains: Record<string, string[]> };
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

  it('openrouter is a valid provider id but stays out of the default order', () => {
    const { smartChain, fastChain } = loadedConfig(
      loadEnv({
        ...REQUIRED_ENV,
        AI_SMART_CHAIN: 'openrouter,claude',
        AI_FAST_CHAIN: 'zai,openrouter',
      }),
    );
    expect(smartChain.order).toEqual(['openrouter', 'claude']);
    expect(fastChain.order).toEqual(['zai', 'openrouter']);
  });

  it('OpenRouter reads its base URL (default https://openrouter.ai/api/v1) and models from the environment', () => {
    expect(loadedConfig(loadEnv(REQUIRED_ENV)).openrouter).toEqual([
      'https://openrouter.ai/api/v1',
      '',
      '',
    ]);
    const { openrouter } = loadedConfig(
      loadEnv({
        ...REQUIRED_ENV,
        OPENROUTER_BASE_URL: 'https://or.test/v1',
        OPENROUTER_MODEL: 'a/b',
        OPENROUTER_FAST_MODEL: 'c/d',
      }),
    );
    expect(openrouter).toEqual(['https://or.test/v1', 'a/b', 'c/d']);
  });

  it('role routing is off by default: legacy mode, no canary list, empty role chains', () => {
    expect(loadedConfig(loadEnv(REQUIRED_ENV)).routing).toEqual({
      mode: 'legacy',
      userIds: null,
      chains: { planner: [], executor: [], repair: [] },
    });
  });

  it('AI_ROUTING, AI_ROUTING_USER_IDS and the three role chains are read from the environment', () => {
    const { routing } = loadedConfig(
      loadEnv({
        ...REQUIRED_ENV,
        AI_ROUTING: 'roles',
        AI_ROUTING_USER_IDS: '11,22',
        AI_PLANNER_CHAIN: 'openrouter:glm53-flash-low',
        AI_EXECUTOR_CHAIN: 'openrouter:glm53-flash-low,openrouter:deepseek41-flash,claude',
        AI_REPAIR_CHAIN: 'openrouter:glm53-low,groq,claude',
      }),
    );
    expect(routing).toEqual({
      mode: 'roles',
      userIds: [11, 22],
      chains: {
        planner: ['openrouter:glm53-flash-low'],
        executor: ['openrouter:glm53-flash-low', 'openrouter:deepseek41-flash', 'claude'],
        repair: ['openrouter:glm53-low', 'claude'],
      },
    });
  });

  it('a misspelled AI_ROUTING stops the process at startup', () => {
    const result = loadEnv({ ...REQUIRED_ENV, AI_ROUTING: 'role' });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain('AI_ROUTING must be legacy or roles');
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
      'OPENROUTER_API_KEY',
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
