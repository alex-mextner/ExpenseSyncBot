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
});
