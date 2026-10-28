// Pins the fixes for the two CodeQL Self-Gate findings that failed every PR (ExpenseSyncBot #227):
// the gate (.github/workflows/codeql.yml) suppresses a finding only via a `codeql[<rule>]` marker in
// the contiguous comment block above the flagged line, so the marker and its reason must stay put,
// and the test temp dir must come from mkdtemp, not a predictable name under the OS temp dir.
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '../..');
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');

describe('stage-bot.yml untrusted-checkout suppression', () => {
  const lines = read('.github/workflows/stage-bot.yml').split('\n');
  const stepIndex = lines.findIndex((line) => line.trim() === '- name: Deploy or stop stage bot');

  test('the deploy step exists', () => {
    expect(stepIndex).toBeGreaterThan(0);
  });

  test('a contiguous comment block above the step carries the rule marker and a stated reason', () => {
    const block: string[] = [];
    for (let i = stepIndex - 1; i >= 0 && /^\s*#/.test(lines[i] ?? ''); i--) {
      block.unshift(lines[i] ?? '');
    }
    const text = block.join('\n');
    expect(text).toContain('codeql[actions/untrusted-checkout/medium]');
    expect(text).toContain('Justified:');
  });

  test('the suppression reason holds: the script fetches and resets to the pinned head sha only', () => {
    const script = lines.slice(stepIndex).join('\n');
    expect(script).toContain('git fetch origin "$HEAD_SHA"');
    expect(script).toContain('git worktree add --detach "$WORKTREE" "$HEAD_SHA"');
    expect(script).toContain('git reset --hard "$HEAD_SHA"');
  });
});

describe('receipt.repository.test.ts temp files', () => {
  const source = read('src/database/repositories/receipt.repository.test.ts');

  test('creates the image directory with mkdtempSync', () => {
    expect(source).toContain('mkdtempSync(');
  });

  test('does not build a predictable temp directory name', () => {
    expect(source).not.toContain('mkdirSync');
  });
});
