import { describe, expect, test } from 'bun:test';
import {
  croston,
  holt,
  holtWinters,
  knnForecast,
  medianForecast,
  quantileForecast,
  seasonalNaive,
  theta,
} from './forecasting';

const monthlyData = [300, 320, 280, 350, 310, 290, 340, 300, 330, 280, 360, 310];
const intermittentData = [0, 0, 100, 0, 0, 0, 120, 0, 0, 80, 0, 0];

describe('holtWinters', () => {
  test('produces forecast for 2+ seasonal cycles', () => {
    const twoYears = [...monthlyData, ...monthlyData.map((v) => v + 20)];
    const result = holtWinters(twoYears, 12);
    expect(result.forecast).toBeGreaterThan(0);
    expect(result.seasonal.length).toBe(12);
  });

  test('falls back to EMA for insufficient data', () => {
    const result = holtWinters([100, 200, 300], 12);
    expect(result.forecast).toBeGreaterThan(0);
    expect(result.trend).toBe(0);
  });

  test('seasonal factors sum close to 0 initially', () => {
    const twoYears = [...monthlyData, ...monthlyData];
    const result = holtWinters(twoYears, 12);
    // After centering, seasonal should approximate 0 mean
    const seasonalSum = result.seasonal.reduce((s, v) => s + v, 0);
    expect(Math.abs(seasonalSum)).toBeLessThan(50);
  });
});

describe('holt', () => {
  test('rising data produces forecast above last value', () => {
    const result = holt([100, 120, 140, 160, 180]);
    expect(result.forecast).toBeGreaterThan(180);
    expect(result.trend).toBeGreaterThan(0);
  });

  test('falling data produces forecast below last value', () => {
    const result = holt([180, 160, 140, 120, 100]);
    expect(result.forecast).toBeLessThan(100);
    expect(result.trend).toBeLessThan(0);
  });

  test('single value returns itself', () => {
    const result = holt([42]);
    expect(result.forecast).toBe(42);
    expect(result.trend).toBe(0);
  });
});

describe('medianForecast', () => {
  test('returns median of last N values', () => {
    expect(medianForecast([10, 20, 30, 40, 50], 5)).toBe(30);
  });

  test('period larger than data uses all data', () => {
    expect(medianForecast([10, 30, 20], 10)).toBe(20);
  });
});

describe('quantileForecast', () => {
  test('quantiles are ordered P50 < P75 < P90 < P95', () => {
    const result = quantileForecast(monthlyData);
    expect(result.p50).toBeLessThanOrEqual(result.p75);
    expect(result.p75).toBeLessThanOrEqual(result.p90);
    expect(result.p90).toBeLessThanOrEqual(result.p95);
  });

  test('empty data returns zeros', () => {
    const result = quantileForecast([]);
    expect(result.p50).toBe(0);
  });

  test('single value returns that value for all quantiles', () => {
    const result = quantileForecast([100]);
    expect(result.p50).toBe(100);
    expect(result.p95).toBe(100);
  });
});

describe('croston', () => {
  test('handles intermittent data (many zeros)', () => {
    const result = croston(intermittentData);
    expect(result.forecast).toBeGreaterThan(0);
    expect(result.expectedAmount).toBeGreaterThan(0);
    expect(result.expectedInterval).toBeGreaterThan(1);
  });

  test('all zeros returns zero forecast', () => {
    const result = croston([0, 0, 0, 0]);
    expect(result.forecast).toBe(0);
    expect(result.expectedAmount).toBe(0);
  });

  test('single non-zero event', () => {
    const result = croston([0, 0, 100, 0, 0]);
    expect(result.expectedAmount).toBe(100);
  });
});

describe('theta', () => {
  test('produces reasonable forecast', () => {
    const result = theta(monthlyData);
    expect(result.forecast).toBeGreaterThan(0);
  });

  test('single value returns itself', () => {
    const result = theta([100]);
    expect(result.forecast).toBe(100);
  });

  test('trending data captures drift', () => {
    const rising = [100, 120, 140, 160, 180, 200];
    const result = theta(rising);
    // Theta = SES + half slope drift, so forecast should be above last SES
    expect(result.forecast).toBeGreaterThan(150);
  });
});

describe('seasonalNaive', () => {
  test('with 12+ months returns average of same-season values', () => {
    const twoYears = [...monthlyData, ...monthlyData.map((v) => v + 50)];
    const forecast = seasonalNaive(twoYears, 12);
    expect(forecast).toBeGreaterThan(0);
  });

  test('insufficient data returns last value', () => {
    const forecast = seasonalNaive([100, 200, 300], 12);
    expect(forecast).toBe(300);
  });
});

describe('knnForecast', () => {
  test('produces forecast from neighbors', () => {
    const result = knnForecast(monthlyData, 3);
    expect(result.forecast).toBeGreaterThan(0);
    expect(result.neighborIndices.length).toBeLessThanOrEqual(3);
  });

  test('insufficient data returns last value', () => {
    const result = knnForecast([100, 200], 3);
    expect(result.forecast).toBe(200);
    expect(result.neighborIndices.length).toBe(0);
  });
});
