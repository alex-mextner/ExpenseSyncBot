// Tests for the TESTING-stage output parsing and Telegram report formatting.
import { describe, expect, test } from 'bun:test';
import {
  buildFullOutput,
  extractTscErrors,
  formatAllPassedMessage,
  formatFailureReportLines,
  parseTestCounts,
  prioritizeFailures,
  type TestingOutcome,
  tailSlice,
} from './test-report';

function makeOutcome(overrides: Partial<TestingOutcome> = {}): TestingOutcome {
  return {
    typeCheckPassed: true,
    tscOOM: false,
    typeCheckExitCode: 0,
    typeCheckOutput: '',
    testsPassed: true,
    testExitCode: 0,
    testsOutput: '',
    passCount: 5,
    failCount: 0,
    errorCount: 0,
    ...overrides,
  };
}

describe('parseTestCounts', () => {
  test('reads pass/fail/error counts from the bun summary', () => {
    expect(parseTestCounts(' 12 pass\n 3 fail\n 1 error')).toEqual({ pass: 12, fail: 3, error: 1 });
  });

  test('missing counters are zero, and "passing" words do not count as pass', () => {
    expect(parseTestCounts('4 passing')).toEqual({ pass: 0, fail: 0, error: 0 });
  });
});

describe('prioritizeFailures', () => {
  test('failure lines come first, then truncated to maxChars', () => {
    const out = prioritizeFailures('ok one\nFAIL two\nok three', 11);
    expect(out).toBe('FAIL two\nok');
  });
});

describe('tailSlice', () => {
  test('keeps short text and prefixes an ellipsis when cutting from the front', () => {
    expect(tailSlice('abc', 3)).toBe('abc');
    expect(tailSlice('abcdef', 2)).toBe('…ef');
  });
});

describe('extractTscErrors', () => {
  test('keeps only error TS lines, trimmed; falls back to raw output when none', () => {
    expect(extractTscErrors('noise\n  a.ts(1,1): error TS2322: bad  \nmore')).toBe(
      'a.ts(1,1): error TS2322: bad',
    );
    expect(extractTscErrors('boom')).toBe('boom');
  });
});

describe('buildFullOutput', () => {
  test('is the stable error_log text used for retry-loop detection', () => {
    const outcome = makeOutcome({
      typeCheckPassed: false,
      typeCheckOutput: 'tsc bad',
      testsPassed: false,
      testExitCode: 1,
      testsOutput: 'tests bad',
    });
    expect(buildFullOutput(outcome)).toBe(
      'TYPE CHECK FAILED:\ntsc bad\n\nTESTS FAILED (exit code 1):\ntests bad',
    );
  });
});

describe('formatAllPassedMessage', () => {
  test('flags a skipped type check (OOM) and appends the PR url only when given', () => {
    const oom = formatAllPassedMessage(7, makeOutcome({ tscOOM: true }));
    expect(oom).toContain('⚠️ <b>Тайпчекер:</b> OOM (skipped)');
    expect(oom).not.toContain('PR:');
    expect(formatAllPassedMessage(7, makeOutcome(), 'https://pr/1')).toEndWith(
      '\n\nPR: https://pr/1',
    );
  });
});

describe('formatFailureReportLines', () => {
  test('counts tsc errors with singular/plural and lists test counters', () => {
    const lines = formatFailureReportLines(
      3,
      2,
      makeOutcome({
        typeCheckPassed: false,
        typeCheckExitCode: 2,
        typeCheckOutput: 'a.ts: error TS1: x\nb.ts: error TS2: y',
        testsPassed: false,
        testExitCode: 1,
        testsOutput: 'FAIL <t>',
        passCount: 4,
        failCount: 1,
        errorCount: 2,
      }),
    );
    expect(lines[0]).toContain('попытка 2/');
    expect(lines).toContain('❌ <b>Тайпчекер:</b> 2 ошибок');
    expect(lines).toContain('❌ <b>Тесты:</b> 4 ✅ / 1 ❌ / 2 💥');
    expect(lines.at(-1)).toBe('<blockquote expandable>FAIL &lt;t&gt;</blockquote>');
  });

  test('type check failing without TS errors reports the exit code; silent test failure shows exit code', () => {
    const lines = formatFailureReportLines(
      3,
      1,
      makeOutcome({
        typeCheckPassed: false,
        typeCheckExitCode: 9,
        testsPassed: false,
        testExitCode: 4,
        passCount: 0,
      }),
    );
    expect(lines).toContain('⚠️ <b>Тайпчекер:</b> failed (exit code 9)');
    expect(lines).toContain('<blockquote expandable>(no output)</blockquote>');
    expect(lines).toContain('⚠️ <b>Тесты:</b> exit code 4');
  });
});
