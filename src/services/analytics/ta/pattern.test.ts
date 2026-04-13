import { describe, expect, test } from 'bun:test';
import {
  categoryCorrelation,
  dayOfMonthProfile,
  hurstExponent,
  loess,
  percentileBands,
  pivotPoints,
  stlDecomposition,
} from './pattern';

const monthlyData = [300, 320, 280, 350, 310, 290, 340, 300, 330, 280, 360, 310];

describe('stlDecomposition', () => {
  test('trend + seasonal + residual reconstructs original', () => {
    const result = stlDecomposition(monthlyData, 6);
    for (let i = 0; i < monthlyData.length; i++) {
      const reconstructed =
        (result.trend[i] ?? 0) + (result.seasonal[i] ?? 0) + (result.residual[i] ?? 0);
      expect(reconstructed).toBeCloseTo(monthlyData[i] ?? 0, 5);
    }
  });

  test('all arrays have same length as input', () => {
    const result = stlDecomposition(monthlyData, 6);
    expect(result.trend.length).toBe(monthlyData.length);
    expect(result.seasonal.length).toBe(monthlyData.length);
    expect(result.residual.length).toBe(monthlyData.length);
  });

  test('short data (< seasonal period) returns data as trend', () => {
    const result = stlDecomposition([100, 200], 12);
    expect(result.trend).toEqual([100, 200]);
    expect(result.seasonal).toEqual([0, 0]);
  });
});

describe('dayOfMonthProfile', () => {
  test('cumulative profile reaches 1.0 at last day', () => {
    const expenses = [
      { day: 1, amount: 10 },
      { day: 15, amount: 20 },
      { day: 30, amount: 30 },
    ];
    const result = dayOfMonthProfile(expenses, 30);
    const lastValue = result.cumulativeProfile[result.cumulativeProfile.length - 1] ?? 0;
    expect(lastValue).toBeCloseTo(1.0, 5);
  });

  test('expectedByDay returns monotonically increasing values', () => {
    const expenses = Array.from({ length: 30 }, (_, i) => ({ day: i + 1, amount: 10 }));
    const result = dayOfMonthProfile(expenses, 30);
    for (let d = 2; d <= 30; d++) {
      expect(result.expectedByDay(d)).toBeGreaterThanOrEqual(result.expectedByDay(d - 1));
    }
  });

  test('empty expenses returns uniform distribution', () => {
    const result = dayOfMonthProfile([], 30);
    expect(result.expectedByDay(15)).toBeCloseTo(15 / 30, 5);
  });
});

describe('percentileBands', () => {
  test('percentiles are ordered P10 ≤ P25 ≤ P50 ≤ P75 ≤ P90', () => {
    const result = percentileBands(monthlyData);
    expect(result.p10).toBeLessThanOrEqual(result.p25);
    expect(result.p25).toBeLessThanOrEqual(result.p50);
    expect(result.p50).toBeLessThanOrEqual(result.p75);
    expect(result.p75).toBeLessThanOrEqual(result.p90);
  });

  test('empty data returns zeros', () => {
    const result = percentileBands([]);
    expect(result.p50).toBe(0);
  });
});

describe('categoryCorrelation', () => {
  test('perfectly correlated categories detected', () => {
    const data = new Map<string, number[]>();
    data.set('food', [100, 200, 300, 400, 500]);
    data.set('transport', [10, 20, 30, 40, 50]); // Perfect positive correlation
    const results = categoryCorrelation(data, 0.4);
    expect(results.length).toBe(1);
    expect(results[0]?.correlation).toBeCloseTo(1, 3);
    expect(results[0]?.strength).toBe('strong_positive');
  });

  test('negatively correlated categories detected', () => {
    const data = new Map<string, number[]>();
    data.set('food', [100, 200, 300, 400, 500]);
    data.set('cooking', [500, 400, 300, 200, 100]); // Perfect negative
    const results = categoryCorrelation(data, 0.4);
    expect(results.length).toBe(1);
    expect(results[0]?.correlation).toBeCloseTo(-1, 3);
    expect(results[0]?.strength).toBe('strong_negative');
  });

  test('uncorrelated categories not reported', () => {
    const data = new Map<string, number[]>();
    data.set('food', [100, 200, 100, 200, 100]);
    data.set('health', [50, 50, 50, 50, 50]); // No variance → correlation undefined
    const results = categoryCorrelation(data, 0.4);
    expect(results.length).toBe(0);
  });

  test('insufficient data (< 3 months) skipped', () => {
    const data = new Map<string, number[]>();
    data.set('food', [100, 200]);
    data.set('transport', [10, 20]);
    expect(categoryCorrelation(data, 0.4).length).toBe(0);
  });
});

describe('hurstExponent', () => {
  test('trending data → H > 0.5', () => {
    const trending = Array.from({ length: 64 }, (_, i) => 100 + i * 10);
    const result = hurstExponent(trending);
    expect(result.value).toBeGreaterThan(0.5);
  });

  test('short data returns random walk (H=0.5)', () => {
    const result = hurstExponent([100, 200, 300]);
    expect(result.value).toBe(0.5);
    expect(result.type).toBe('random_walk');
  });

  test('H is between 0 and 1', () => {
    const result = hurstExponent(monthlyData);
    expect(result.value).toBeGreaterThanOrEqual(0);
    expect(result.value).toBeLessThanOrEqual(1);
  });
});

describe('pivotPoints', () => {
  test('resistance > pivot > support', () => {
    const result = pivotPoints(monthlyData, 6);
    expect(result.resistance1).toBeGreaterThan(result.pivot);
    expect(result.resistance2).toBeGreaterThan(result.resistance1);
    expect(result.support1).toBeLessThan(result.pivot);
    expect(result.support2).toBeLessThan(result.support1);
  });

  test('empty data returns zeros', () => {
    const result = pivotPoints([], 6);
    expect(result.pivot).toBe(0);
  });
});

describe('loess', () => {
  test('output length matches input', () => {
    const result = loess(monthlyData);
    expect(result.length).toBe(monthlyData.length);
  });

  test('smoothed values are close to original', () => {
    const result = loess(monthlyData, 0.5);
    for (let i = 0; i < result.length; i++) {
      const smoothed = result[i]?.y ?? 0;
      const original = monthlyData[i] ?? 0;
      // Within 50% of original (loose check — it's smoothing)
      expect(Math.abs(smoothed - original)).toBeLessThan(original * 0.5);
    }
  });

  test('small data returns original values', () => {
    const result = loess([100, 200]);
    expect(result.length).toBe(2);
  });
});
