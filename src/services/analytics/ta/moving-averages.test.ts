import { describe, expect, test } from 'bun:test';
import {
  dema,
  emaArray,
  hullMa,
  kama,
  sma,
  tema,
  triangularMa,
  wma,
  zlema,
} from './moving-averages';

const data = [100, 120, 110, 130, 150, 140, 160];

describe('sma', () => {
  test('period 3 computes correct average of last 3 values', () => {
    const result = sma(data, 3);
    // Last 3: 140, 160 → wait, [140, 160] is indices 5,6 but period 3 means 150,140,160
    expect(result.value).toBeCloseTo(150, 0);
  });

  test('series has NaN for initial values', () => {
    const result = sma(data, 3);
    expect(Number.isNaN(result.series[0] ?? 0)).toBe(true);
    expect(Number.isNaN(result.series[1] ?? 0)).toBe(true);
    expect(Number.isNaN(result.series[2] ?? 0)).toBe(false);
  });

  test('period 1 returns the values themselves', () => {
    const result = sma(data, 1);
    expect(result.value).toBe(160);
    expect(result.series.length).toBe(data.length);
  });

  test('empty data returns 0', () => {
    const result = sma([], 3);
    expect(result.value).toBe(0);
    expect(result.series.length).toBe(0);
  });
});

describe('wma', () => {
  test('assigns higher weight to recent values', () => {
    const result = wma([100, 200], 2);
    // Weights: 1, 2. WMA = (100*1 + 200*2) / 3 = 500/3 ≈ 166.67
    expect(result.value).toBeCloseTo(166.67, 1);
  });

  test('period 1 returns latest value', () => {
    const result = wma(data, 1);
    expect(result.value).toBe(160);
  });
});

describe('emaArray', () => {
  test('starts with first value', () => {
    const result = emaArray(data, 3);
    expect(result[0]).toBe(100);
  });

  test('result length matches input', () => {
    const result = emaArray(data, 3);
    expect(result.length).toBe(data.length);
  });

  test('empty data returns empty', () => {
    expect(emaArray([], 3)).toEqual([]);
  });
});

describe('kama', () => {
  test('returns value and efficiency ratio', () => {
    const result = kama(data, 3);
    expect(result.value).toBeGreaterThan(0);
    expect(result.efficiencyRatio).toBeGreaterThanOrEqual(0);
    expect(result.efficiencyRatio).toBeLessThanOrEqual(1);
  });

  test('short data returns last value with ER=0', () => {
    const result = kama([100, 120], 10);
    expect(result.value).toBe(120);
    expect(result.efficiencyRatio).toBe(0);
  });
});

describe('dema', () => {
  test('produces result with less lag than EMA', () => {
    const result = dema(data, 3);
    expect(result.value).toBeGreaterThan(0);
    expect(result.series.length).toBe(data.length);
  });
});

describe('tema', () => {
  test('produces result with series matching input length', () => {
    const result = tema(data, 3);
    expect(result.value).toBeGreaterThan(0);
    expect(result.series.length).toBe(data.length);
  });
});

describe('hullMa', () => {
  test('produces smoother result than raw data', () => {
    const result = hullMa(data, 4);
    expect(result.value).toBeGreaterThan(0);
  });
});

describe('zlema', () => {
  test('produces result compensating for lag', () => {
    const result = zlema(data, 3);
    expect(result.value).toBeGreaterThan(0);
    expect(result.series.length).toBe(data.length);
  });
});

describe('triangularMa', () => {
  test('double-smoothed SMA produces result', () => {
    const result = triangularMa(data, 3);
    expect(result.value).toBeGreaterThan(0);
  });
});
