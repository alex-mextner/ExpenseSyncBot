import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dir, '../..');
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a8ioAAAAASUVORK5CYII=';
interface Attempt {
  authorization: string | null;
  claude: boolean;
  body: string;
}

function runProbe(
  script: string,
  vision = false,
  secondaryOnly = false,
): { code: number; stdout: string; stderr: string; attempts: Attempt[] } {
  const dir = mkdtempSync(join(tmpdir(), 'esb-claude-probe-'));
  try {
    const preload = join(dir, 'preload.ts');
    const attemptsPath = join(dir, 'attempts.json');
    const image = join(dir, 'synthetic.png');
    writeFileSync(image, Buffer.from(PIXEL, 'base64'));
    writeFileSync(
      preload,
      `
import { mock } from 'bun:test';
import * as fs from 'node:fs';
const fixture = Buffer.from(${JSON.stringify(PIXEL)}, 'base64');
const originalFs = { ...fs };
mock.module('node:fs', () => ({
  ...originalFs,
  existsSync: (name) => String(name).endsWith('debug-images') ? false : String(name).endsWith('tests/fixtures/receipts') ? true : originalFs.existsSync(name),
  readdirSync: (name, ...args) => String(name).endsWith('tests/fixtures/receipts') ? ['synthetic.png'] : originalFs.readdirSync(name, ...args),
  readFileSync: (name, ...args) => String(name).endsWith('tests/fixtures/receipts/synthetic.png') ? fixture : originalFs.readFileSync(name, ...args),
}));
const logger = { info() {}, warn() {}, error() {}, debug() {} };
mock.module(${JSON.stringify(join(ROOT, 'src/utils/logger'))}, () => ({ createLogger: () => logger, logger }));
const env = {
  ANTHROPIC_API_KEY: 'zai-key', AI_BASE_URL: 'https://zai.test/v1', AI_MODEL: 'zai-fixture', AI_FAST_MODEL: 'zai-fast-fixture',
  HF_TOKEN: 'hf-key', HF_BASE_URL: 'https://hf.test/v1', HF_MODEL: 'hf-fixture', HF_FAST_MODEL: 'hf-fast-fixture', HF_VISION_MODEL: 'hf-vision-fixture',
  CLAUDE_API_TOKEN: ${JSON.stringify(secondaryOnly ? '' : 'primary-key')}, CLAUDE_API_TOKEN2: 'secondary-key', CLAUDE_BASE_URL: 'https://claude.test/v1',
  CLAUDE_MODEL: 'claude-sonnet-fixture', CLAUDE_FAST_MODEL: 'claude-haiku-fixture', CLAUDE_VISION_MODEL: 'claude-sonnet-fixture',
  AI_SMART_CHAIN: { order: ['zai', 'claude', 'hf'] }, AI_FAST_CHAIN: { order: ['zai', 'claude', 'hf'] },
};
mock.module(${JSON.stringify(join(ROOT, 'src/config/env'))}, () => ({ env }));
const { chatRequestParams } = await import(${JSON.stringify(join(ROOT, 'src/services/ai/streaming/request-params.ts'))});
mock.module(${JSON.stringify(join(ROOT, 'src/services/ai/streaming'))}, () => ({ chatRequestParams }));
const attempts = [];
globalThis.fetch = async (url, init) => {
  const authorization = new Headers(init?.headers).get('authorization');
  const claude = new URL(String(url)).host === 'claude.test';
  attempts.push({ authorization, claude, body: init?.body });
  originalFs.writeFileSync(${JSON.stringify(attemptsPath)}, JSON.stringify(attempts));
  if (!claude) return Response.json({ error: { message: 'synthetic unavailable credit' } }, { status: 402 });
  if (authorization === 'Bearer primary-key') return Response.json({ error: { message: 'synthetic unauthorized' } }, { status: 401 });
  return Response.json({ id: 'synthetic', object: 'chat.completion', created: 0, model: JSON.parse(init.body).model,
    choices: [{ index: 0, message: { role: 'assistant', content: '{"status":"ok","test":true}' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 8, total_tokens: 18 } });
};
`,
    );
    const child = Bun.spawnSync({
      cmd: [
        process.execPath,
        '--no-env-file',
        '--preload',
        preload,
        join(ROOT, script),
        ...(vision ? [image, 'claude'] : []),
      ],
      cwd: ROOT,
      env: { PATH: process.env['PATH'] ?? '' },
      timeout: 15_000,
    });
    return {
      code: child.exitCode,
      stdout: child.stdout.toString(),
      stderr: child.stderr.toString(),
      attempts: JSON.parse(readFileSync(attemptsPath, 'utf8')) as Attempt[],
    };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the actual chain verification script checks all Claude models through credential failover', () => {
  const result = runProbe('scripts/verify-ai-chains.ts');
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  expect(result.stdout).toContain('Total: 3/8 slots OK');
  const claude = result.attempts.filter((attempt) => attempt.claude);
  expect(claude.map((attempt) => attempt.authorization)).toEqual([
    'Bearer primary-key',
    'Bearer secondary-key',
    'Bearer secondary-key',
    'Bearer secondary-key',
  ]);
  expect(claude[1]?.body).toBe(claude[0]?.body);
  expect(
    result.attempts
      .filter((attempt) => !attempt.claude)
      .every((attempt) => attempt.authorization !== 'Bearer secondary-key'),
  ).toBe(true);
});

test('the chain verification script still checks every Claude model with only the secondary key', () => {
  const result = runProbe('scripts/verify-ai-chains.ts', false, true);
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  expect(result.stdout).toContain('Total: 3/8 slots OK');
  expect(
    result.attempts.filter((attempt) => attempt.claude).map((attempt) => attempt.authorization),
  ).toEqual(['Bearer secondary-key', 'Bearer secondary-key', 'Bearer secondary-key']);
});

test('the actual vision probe preserves its request while using the working Claude credential', () => {
  const result = runProbe('scripts/test-vision.ts', true);
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  expect(result.stdout).toContain('claude vision OK');
  expect(result.attempts.map((attempt) => attempt.authorization)).toEqual([
    'Bearer primary-key',
    'Bearer secondary-key',
  ]);
  expect(result.attempts[1]?.body).toBe(result.attempts[0]?.body);
});

test('a secondary-only vision probe works before rotation is needed', () => {
  const result = runProbe('scripts/test-vision.ts', true, true);
  expect({ code: result.code, stderr: result.stderr }).toEqual({ code: 0, stderr: '' });
  expect(result.attempts.map((attempt) => attempt.authorization)).toEqual(['Bearer secondary-key']);
});
