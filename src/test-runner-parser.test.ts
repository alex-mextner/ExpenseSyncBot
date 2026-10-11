// Regression tests for the isolated test runner's Bun summary parser (#118)

import { describe, expect, test } from 'bun:test';
import { parseBunTestSummary } from '../scripts/test-runner';

describe('parseBunTestSummary', () => {
  test('ignores numeric failure words inside passing test names', () => {
    const output = [
      '(pass) fallback > handles 400 failure',
      '(pass) retry > survives 429 fail response',
      '(pass) wording > mentions 77 pass candidates',
      '',
      ' 77 pass',
      ' 0 fail',
    ].join('\n');
    expect(parseBunTestSummary(output)).toEqual({ pass: 77, fail: 0 });
  });

  test('reads a real nonzero final summary', () => {
    expect(parseBunTestSummary('noise\n 12 pass\n 3 fail\n')).toEqual({ pass: 12, fail: 3 });
  });

  test('returns null when Bun summary lines are absent', () => {
    expect(parseBunTestSummary('(pass) name says 400 failure')).toBeNull();
  });

  test('takes the final summary over a summary-shaped line a test logged earlier', () => {
    expect(
      parseBunTestSummary(' 999 pass\n 0 fail\n(fail) real > case\n 2 pass\n 1 fail\n'),
    ).toEqual({
      pass: 2,
      fail: 1,
    });
  });

  test('a fake summary on stdout loses to the real one Bun writes last on stderr', () => {
    const stdout = 'bun test v1\n999 pass\n0 fail\n';
    const stderr = '(fail) real > case\n 2 pass\n 1 fail\n';
    expect(parseBunTestSummary(stdout + stderr)).toEqual({ pass: 2, fail: 1 });
  });

  test('tolerates CRLF line endings', () => {
    expect(parseBunTestSummary(' 2 pass\r\n 1 fail\r\n')).toEqual({ pass: 2, fail: 1 });
  });

  test('does not join a bare number and a bare status word across lines', () => {
    expect(parseBunTestSummary('77\npass\n77\nfail\n')).toBeNull();
  });

  test('returns null when only one of the two summary lines is present', () => {
    expect(parseBunTestSummary(' 12 pass\n')).toBeNull();
  });
});
