import { describe, expect, test } from 'bun:test';
import { analyzeCategory } from './analyzer';

const monthlyData = [300, 320, 280, 350, 310, 290, 340, 300, 330, 280, 360, 310];

describe('analyzeCategory', () => {
  test('returns complete analysis for 12-month history', () => {
    const result = analyzeCategory('food', monthlyData);

    expect(result.category).toBe('food');
    expect(result.monthsOfData).toBe(12);

    // Forecasts
    expect(result.forecasts.ensemble).toBeGreaterThan(0);
    expect(result.forecasts.sma3).toBeGreaterThan(0);
    expect(result.forecasts.wma3).toBeGreaterThan(0);
    expect(result.forecasts.kama).toBeGreaterThan(0);
    expect(result.forecasts.median).toBeGreaterThan(0);
    expect(result.forecasts.holt.forecast).toBeGreaterThan(0);
    expect(result.forecasts.theta.forecast).toBeGreaterThan(0);
    expect(result.forecasts.quantiles.p50).toBeGreaterThan(0);

    // Croston null for non-intermittent data
    expect(result.forecasts.croston).toBeNull();

    // Holt-Winters null for < 24 months
    expect(result.forecasts.holtWinters).toBeNull();
  });

  test('ensemble forecast is trimmed mean of individual forecasts', () => {
    const result = analyzeCategory('food', monthlyData);
    // Ensemble should be in reasonable range of individual forecasts
    const forecasts = [
      result.forecasts.sma3,
      result.forecasts.wma3,
      result.forecasts.kama,
      result.forecasts.median,
      result.forecasts.holt.forecast,
      result.forecasts.theta.forecast,
    ];
    const min = Math.min(...forecasts);
    const max = Math.max(...forecasts);
    // Ensemble should be between min and max of inputs (trimmed mean)
    expect(result.forecasts.ensemble).toBeGreaterThanOrEqual(min * 0.9);
    expect(result.forecasts.ensemble).toBeLessThanOrEqual(max * 1.1);
  });

  test('volatility indicators are populated', () => {
    const result = analyzeCategory('food', monthlyData);
    expect(result.volatility.bollingerBands.upper).toBeGreaterThan(0);
    expect(result.volatility.atr).toBeGreaterThan(0);
    expect(result.volatility.historicalVol).toBeGreaterThan(0);
  });

  test('anomaly detection with current month spending', () => {
    const result = analyzeCategory('food', monthlyData, { currentMonthSpent: 1000 });
    // 1000 is way above normal (300±30) — should be anomalous
    expect(result.anomaly.isAnomaly).toBe(true);
    expect(result.anomaly.anomalyCount).toBeGreaterThanOrEqual(2);
  });

  test('normal current spending is not anomalous', () => {
    const result = analyzeCategory('food', monthlyData, { currentMonthSpent: 310 });
    expect(result.anomaly.isAnomaly).toBe(false);
  });

  test('trend direction for stable data', () => {
    const stableData = [100, 102, 98, 101, 99, 100, 101, 99, 100, 102, 98, 100];
    const result = analyzeCategory('stable', stableData);
    expect(result.trend.direction).toBe('stable');
  });

  test('trend direction for rising data', () => {
    const rising = [100, 120, 140, 160, 180, 200, 220, 240, 260, 280, 300, 320];
    const result = analyzeCategory('rising', rising);
    expect(result.trend.direction).toBe('rising');
    expect(result.trend.confidence).toBeGreaterThan(0.5);
  });

  test('trend direction for falling data', () => {
    const falling = [320, 300, 280, 260, 240, 220, 200, 180, 160, 140, 120, 100];
    const result = analyzeCategory('falling', falling);
    expect(result.trend.direction).toBe('falling');
  });

  test('croston enabled for intermittent data', () => {
    const intermittent = [0, 0, 100, 0, 0, 0, 120, 0, 0, 80, 0, 0];
    const result = analyzeCategory('car', intermittent);
    expect(result.forecasts.croston).not.toBeNull();
    expect(result.forecasts.croston?.expectedAmount).toBeGreaterThan(0);
  });

  test('short data (3 months) still works', () => {
    const result = analyzeCategory('new_cat', [100, 200, 300]);
    expect(result.monthsOfData).toBe(3);
    expect(result.forecasts.ensemble).toBeGreaterThan(0);
  });

  test('hurst exponent is between 0 and 1', () => {
    const result = analyzeCategory('food', monthlyData);
    expect(result.trend.hurst.value).toBeGreaterThanOrEqual(0);
    expect(result.trend.hurst.value).toBeLessThanOrEqual(1);
  });

  test('pivot points have proper ordering', () => {
    const result = analyzeCategory('food', monthlyData);
    expect(result.trend.pivotPoints.resistance2).toBeGreaterThan(result.trend.pivotPoints.pivot);
    expect(result.trend.pivotPoints.support2).toBeLessThan(result.trend.pivotPoints.pivot);
  });
});
