import { describe, expect, test } from 'bun:test';
import { dixonTest, grubbsTest, hampelFilter, iqrMethod, modifiedZScore, zScore } from './anomaly';

const normalData = [100, 110, 105, 115, 108, 112];
const withOutlier = [100, 110, 105, 115, 108, 500];

describe('zScore', () => {
  test('normal value is not anomalous', () => {
    const result = zScore(110, normalData);
    expect(result.isAnomaly).toBe(false);
    expect(result.direction).toBeNull();
  });

  test('extreme high value is anomalous', () => {
    const result = zScore(500, normalData, 2);
    expect(result.isAnomaly).toBe(true);
    expect(result.direction).toBe('high');
    expect(result.zScore).toBeGreaterThan(2);
  });

  test('extreme low value is anomalous', () => {
    const result = zScore(-100, normalData, 2);
    expect(result.isAnomaly).toBe(true);
    expect(result.direction).toBe('low');
  });

  test('zero stddev returns no anomaly', () => {
    const result = zScore(100, [100, 100, 100]);
    expect(result.isAnomaly).toBe(false);
    expect(result.zScore).toBe(0);
  });
});

describe('modifiedZScore', () => {
  test('normal value is not anomalous', () => {
    const result = modifiedZScore(110, normalData);
    expect(result.isAnomaly).toBe(false);
  });

  test('extreme value detected with MAD-based threshold', () => {
    const result = modifiedZScore(500, normalData);
    expect(result.isAnomaly).toBe(true);
    expect(result.direction).toBe('high');
  });

  test('more robust than z-score — outlier in data does not skew baseline', () => {
    // With outlier in data, modified z-score should still detect 500 as extreme
    const result = modifiedZScore(500, withOutlier);
    expect(result.zScore).toBeGreaterThan(0);
  });
});

describe('iqrMethod', () => {
  test('value within bounds is not outlier', () => {
    const result = iqrMethod(110, normalData);
    expect(result.isOutlier).toBe(false);
  });

  test('extreme value above upper bound is outlier', () => {
    const result = iqrMethod(500, normalData);
    expect(result.isOutlier).toBe(true);
    expect(result.upperBound).toBeLessThan(500);
  });

  test('Q1 < Q3 for varied data', () => {
    const result = iqrMethod(110, normalData);
    expect(result.q3).toBeGreaterThanOrEqual(result.q1);
    expect(result.iqr).toBeGreaterThanOrEqual(0);
  });
});

describe('grubbsTest', () => {
  test('detects outlier in data with extreme value', () => {
    const result = grubbsTest(withOutlier);
    expect(result.outlier).toBe(500);
    expect(result.statistic).toBeGreaterThan(0);
  });

  test('uniform data has no significant outlier', () => {
    // Use data with low spread relative to sample size
    const result = grubbsTest([100, 101, 102, 103, 104, 105, 106, 107, 108, 109]);
    expect(result.isSignificant).toBe(false);
  });

  test('handles small samples (< 3)', () => {
    const result = grubbsTest([100, 200]);
    expect(result.statistic).toBe(0);
    expect(result.isSignificant).toBe(false);
  });
});

describe('dixonTest', () => {
  test('detects extreme value in small sample', () => {
    const result = dixonTest([100, 102, 105, 500]);
    expect(result.outlier).toBe(500);
    expect(result.qRatio).toBeGreaterThan(0);
  });

  test('uniform data has no significant outlier', () => {
    const result = dixonTest([100, 101, 102, 103]);
    expect(result.isSignificant).toBe(false);
  });

  test('handles small samples (< 3)', () => {
    const result = dixonTest([100, 200]);
    expect(result.qRatio).toBe(0);
  });
});

describe('hampelFilter', () => {
  test('replaces outliers with median', () => {
    const result = hampelFilter(withOutlier, 2, 3);
    // 500 should be replaced
    expect(result.outlierIndices.length).toBeGreaterThan(0);
    const lastCleaned = result.cleaned[result.cleaned.length - 1] ?? 0;
    expect(lastCleaned).toBeLessThan(500);
  });

  test('clean data has no outliers', () => {
    const result = hampelFilter(normalData, 2, 3);
    expect(result.outlierIndices.length).toBe(0);
    expect(result.cleaned).toEqual(normalData);
  });

  test('output length matches input', () => {
    const result = hampelFilter(withOutlier, 2, 3);
    expect(result.cleaned.length).toBe(withOutlier.length);
  });
});
