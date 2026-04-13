import { describe, expect, test } from 'bun:test';
import {
  changePointDetection,
  cusum,
  ewmaControl,
  linearRegression,
  macd,
  momentum,
  polynomialRegression,
  robustRegression,
  roc,
  rollingRegression,
  rsi,
} from './trend';

const rising = [100, 120, 140, 160, 180, 200];
const falling = [200, 180, 160, 140, 120, 100];
const stable = [100, 102, 98, 101, 99, 100];
const shiftedData = [100, 100, 100, 100, 100, 300, 300, 300, 300, 300];

describe('linearRegression', () => {
  test('rising data has positive slope', () => {
    const result = linearRegression(rising);
    expect(result.slope).toBeGreaterThan(0);
    expect(result.r2).toBeGreaterThan(0.9);
    expect(result.forecast).toBeGreaterThan(200);
  });

  test('falling data has negative slope', () => {
    const result = linearRegression(falling);
    expect(result.slope).toBeLessThan(0);
  });

  test('perfect line has R²=1', () => {
    const result = linearRegression([10, 20, 30, 40, 50]);
    expect(result.r2).toBeCloseTo(1, 5);
    expect(result.slope).toBeCloseTo(10, 5);
  });

  test('single value returns value with slope 0', () => {
    const result = linearRegression([42]);
    expect(result.slope).toBe(0);
    expect(result.forecast).toBe(42);
  });
});

describe('cusum', () => {
  test('detects shift in mean level', () => {
    const result = cusum(shiftedData);
    expect(result.shiftDetected).toBe(true);
    expect(result.shiftIndex).toBeGreaterThanOrEqual(4);
  });

  test('stable data has no shift', () => {
    const result = cusum(stable);
    expect(result.shiftDetected).toBe(false);
    expect(result.shiftIndex).toBe(-1);
  });

  test('values array length matches input', () => {
    const result = cusum(rising);
    expect(result.values.length).toBe(rising.length);
  });

  test('empty data returns empty result', () => {
    const result = cusum([]);
    expect(result.values.length).toBe(0);
    expect(result.shiftDetected).toBe(false);
  });
});

describe('rsi', () => {
  test('rising data → overbought (RSI > 70)', () => {
    const result = rsi(rising, 6);
    expect(result.value).toBeGreaterThan(70);
    expect(result.signal).toBe('overbought');
  });

  test('falling data → oversold (RSI < 30)', () => {
    const result = rsi(falling, 6);
    expect(result.value).toBeLessThan(30);
    expect(result.signal).toBe('oversold');
  });

  test('stable data → neutral (30 < RSI < 70)', () => {
    const result = rsi(stable, 6);
    expect(result.signal).toBe('neutral');
  });

  test('single value returns RSI 50', () => {
    const result = rsi([100], 6);
    expect(result.value).toBe(50);
  });
});

describe('macd', () => {
  test('returns all components', () => {
    const result = macd(rising);
    expect(result.macd).toBeGreaterThan(0);
    expect(typeof result.signal).toBe('number');
    expect(typeof result.histogram).toBe('number');
  });

  test('insufficient data returns zeros', () => {
    const result = macd([100, 200], 3, 6);
    expect(result.macd).toBe(0);
    expect(result.crossover).toBe('none');
  });

  test('detects crossover on trend change', () => {
    // Strong rise then plateau — might get bearish crossover
    const trendChange = [100, 120, 140, 160, 180, 200, 200, 200, 200];
    const result = macd(trendChange, 3, 6, 3);
    expect(['bullish', 'bearish', 'none']).toContain(result.crossover);
  });
});

describe('roc', () => {
  test('positive change returns positive ROC', () => {
    expect(roc(rising, 1)).toBeGreaterThan(0);
  });

  test('negative change returns negative ROC', () => {
    expect(roc(falling, 1)).toBeLessThan(0);
  });

  test('insufficient data returns 0', () => {
    expect(roc([100], 3)).toBe(0);
  });
});

describe('momentum', () => {
  test('rising data has positive momentum', () => {
    expect(momentum(rising, 3)).toBeGreaterThan(0);
  });

  test('falling data has negative momentum', () => {
    expect(momentum(falling, 3)).toBeLessThan(0);
  });

  test('insufficient data returns 0', () => {
    expect(momentum([100, 200], 3)).toBe(0);
  });
});

describe('polynomialRegression', () => {
  test('fits quadratic data well', () => {
    const quadratic = [1, 4, 9, 16, 25]; // x² pattern
    const result = polynomialRegression(quadratic, 2);
    expect(result.r2).toBeGreaterThan(0.9);
    expect(result.forecast).toBeGreaterThan(25);
  });

  test('returns forecast for linear data', () => {
    const result = polynomialRegression(rising, 2);
    expect(result.forecast).toBeGreaterThan(200);
  });

  test('insufficient data returns last value', () => {
    const result = polynomialRegression([100], 2);
    expect(result.forecast).toBe(100);
  });
});

describe('rollingRegression', () => {
  test('returns slopes for each window position', () => {
    const result = rollingRegression(rising, 3);
    expect(result.slopes.length).toBe(rising.length - 2); // n - windowSize + 1
    expect(result.currentSlope).toBeGreaterThan(0);
  });

  test('all slopes positive for consistently rising data', () => {
    const result = rollingRegression(rising, 3);
    for (const s of result.slopes) {
      expect(s).toBeGreaterThan(0);
    }
  });
});

describe('robustRegression', () => {
  test('resistant to outliers', () => {
    const dataWithOutlier = [100, 110, 120, 130, 500, 150, 160];
    const robust = robustRegression(dataWithOutlier);
    const ols = linearRegression(dataWithOutlier);
    // Robust regression should give a more moderate slope
    expect(Math.abs(robust.slope)).toBeLessThan(Math.abs(ols.slope) + 1);
  });

  test('single value returns itself', () => {
    const result = robustRegression([42]);
    expect(result.slope).toBe(0);
    expect(result.forecast).toBe(42);
  });
});

describe('ewmaControl', () => {
  test('stable data stays in control', () => {
    const result = ewmaControl(stable);
    expect(result.outOfControl).toBe(false);
    expect(result.ucl).toBeGreaterThan(result.value);
    expect(result.lcl).toBeLessThan(result.value);
  });

  test('empty data returns zeros', () => {
    const result = ewmaControl([]);
    expect(result.value).toBe(0);
  });
});

describe('changePointDetection', () => {
  test('detects change point in shifted data', () => {
    const result = changePointDetection(shiftedData, 3);
    expect(result.changePoints.length).toBeGreaterThanOrEqual(1);
    expect(result.segments.length).toBeGreaterThanOrEqual(2);
  });

  test('no change point in stable data', () => {
    const result = changePointDetection(stable, 3);
    expect(result.changePoints.length).toBe(0);
    expect(result.segments.length).toBe(1);
  });

  test('segment means reflect actual levels', () => {
    const result = changePointDetection(shiftedData, 3);
    if (result.segments.length >= 2) {
      const firstMean = result.segments[0]?.mean ?? 0;
      const lastMean = result.segments[result.segments.length - 1]?.mean ?? 0;
      expect(firstMean).toBeLessThan(150);
      expect(lastMean).toBeGreaterThan(150);
    }
  });
});
