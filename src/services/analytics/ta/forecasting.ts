/** Forecasting methods: Holt-Winters, Holt, Median, Quantile Regression, Croston, Theta, Seasonal Naive, k-NN */

import { emaArray } from './moving-averages';
import { linearRegression } from './trend';
import type {
  CrostonResult,
  HoltResult,
  HoltWintersResult,
  KnnResult,
  QuantileResult,
  ThetaResult,
} from './types';

/** Sorted median helper */
function sortedMedian(data: number[]): number {
  const sorted = [...data].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Quantile from sorted array */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return 0;
  const pos = q * (sorted.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const frac = pos - lo;
  return (sorted[lo] ?? 0) * (1 - frac) + (sorted[hi] ?? 0) * frac;
}

/**
 * Holt-Winters Triple Exponential Smoothing (additive seasonality).
 * Best method for categories with seasonal patterns. Needs ≥2 full seasonal cycles.
 * @param seasonalPeriod default 12 (months)
 */
export function holtWinters(
  data: number[],
  seasonalPeriod = 12,
  alpha = 0.3,
  beta = 0.1,
  gamma = 0.3,
): HoltWintersResult {
  const n = data.length;

  if (n < seasonalPeriod) {
    // Not enough data — fall back to simple EMA
    const ema = emaArray(data, Math.min(n, 3));
    return {
      forecast: ema[ema.length - 1] ?? data[data.length - 1] ?? 0,
      level: ema[ema.length - 1] ?? 0,
      trend: 0,
      seasonal: Array.from({ length: seasonalPeriod }, () => 0),
    };
  }

  // Initialize level and trend from first season
  let level = data.slice(0, seasonalPeriod).reduce((s, v) => s + v, 0) / seasonalPeriod;
  let trend = 0;
  if (n >= 2 * seasonalPeriod) {
    const firstSeasonAvg =
      data.slice(0, seasonalPeriod).reduce((s, v) => s + v, 0) / seasonalPeriod;
    const secondSeasonAvg =
      data.slice(seasonalPeriod, 2 * seasonalPeriod).reduce((s, v) => s + v, 0) / seasonalPeriod;
    trend = (secondSeasonAvg - firstSeasonAvg) / seasonalPeriod;
  }

  // Initialize seasonal factors
  const seasonal = Array.from({ length: seasonalPeriod }, () => 0);
  for (let i = 0; i < seasonalPeriod; i++) {
    seasonal[i] = (data[i] ?? 0) - level;
  }

  // Apply Holt-Winters update equations
  for (let t = seasonalPeriod; t < n; t++) {
    const seasonIdx = t % seasonalPeriod;
    const value = data[t] ?? 0;
    const prevLevel = level;

    level = alpha * (value - (seasonal[seasonIdx] ?? 0)) + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
    seasonal[seasonIdx] = gamma * (value - level) + (1 - gamma) * (seasonal[seasonIdx] ?? 0);
  }

  const nextSeasonIdx = n % seasonalPeriod;
  const forecast = level + trend + (seasonal[nextSeasonIdx] ?? 0);

  return { forecast, level, trend, seasonal };
}

/**
 * Holt's Double Exponential Smoothing (level + trend, no seasonality).
 * For categories with a trend but no seasonal pattern. Needs ≥6 months.
 */
export function holt(data: number[], alpha = 0.3, beta = 0.1): HoltResult {
  if (data.length < 2) {
    const v = data[0] ?? 0;
    return { forecast: v, level: v, trend: 0 };
  }

  let level = data[0] ?? 0;
  let trend = (data[1] ?? 0) - (data[0] ?? 0);

  for (let i = 1; i < data.length; i++) {
    const prevLevel = level;
    level = alpha * (data[i] ?? 0) + (1 - alpha) * (level + trend);
    trend = beta * (level - prevLevel) + (1 - beta) * trend;
  }

  return { forecast: level + trend, level, trend };
}

/**
 * Median Forecast: robust baseline for categories with outliers.
 * Forecast = median of last N months. Unaffected by single large expense.
 */
export function medianForecast(data: number[], period = 6): number {
  const window = data.slice(-period);
  return sortedMedian(window);
}

/**
 * Quantile-based forecast: P50 (expected), P75 (likely ceiling), P90 (almost certain ceiling).
 * No normality assumption — works for right-skewed spending distributions.
 */
export function quantileForecast(data: number[]): QuantileResult {
  if (data.length === 0) return { p50: 0, p75: 0, p90: 0, p95: 0 };

  const sorted = [...data].sort((a, b) => a - b);
  return {
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
    p95: quantile(sorted, 0.95),
  };
}

/**
 * Croston's Method for intermittent demand (sporadic spending).
 * Separately forecasts: (1) amount of non-zero spending, (2) interval between non-zero periods.
 * Ideal for: car repairs, medical expenses — months of zero then a big expense.
 */
export function croston(data: number[], alpha = 0.3): CrostonResult {
  const nonZero: number[] = [];
  const intervals: number[] = [];
  let gap = 0;

  for (const v of data) {
    gap++;
    if (v > 0) {
      nonZero.push(v);
      intervals.push(gap);
      gap = 0;
    }
  }

  if (nonZero.length === 0)
    return { forecast: 0, expectedAmount: 0, expectedInterval: data.length || 1 };
  if (nonZero.length === 1)
    return {
      forecast: (nonZero[0] ?? 0) / (data.length || 1),
      expectedAmount: nonZero[0] ?? 0,
      expectedInterval: data.length,
    };

  // EMA of non-zero amounts
  let amountEma = nonZero[0] ?? 0;
  for (let i = 1; i < nonZero.length; i++) {
    amountEma = alpha * (nonZero[i] ?? 0) + (1 - alpha) * amountEma;
  }

  // EMA of intervals
  let intervalEma = intervals[0] ?? 1;
  for (let i = 1; i < intervals.length; i++) {
    intervalEma = alpha * (intervals[i] ?? 1) + (1 - alpha) * intervalEma;
  }

  // SBA (Syntetos-Boylan Approximation) bias correction
  // Classical Croston has positive bias; SBA removes it with factor (1 - α/2)
  const classicalForecast = intervalEma > 0 ? amountEma / intervalEma : 0;
  return {
    forecast: classicalForecast * (1 - alpha / 2),
    expectedAmount: amountEma,
    expectedInterval: intervalEma,
  };
}

/**
 * TSB (Teunter-Syntetos-Babai) — Croston variant for fading demand.
 * Unlike classical Croston which keeps forecasting the same amount forever,
 * TSB models demand probability directly and decays it on zero periods.
 * If a category stops being used, TSB gradually reduces the forecast to zero.
 */
export function crostonTSB(data: number[], alpha = 0.3, beta = 0.3): CrostonResult {
  if (data.length === 0) return { forecast: 0, expectedAmount: 0, expectedInterval: 1 };

  const firstNZ = data.findIndex((v) => v > 0);
  if (firstNZ === -1) return { forecast: 0, expectedAmount: 0, expectedInterval: data.length || 1 };

  let amount = data[firstNZ] ?? 0;
  let prob = 1 / (1 + firstNZ);

  for (let t = firstNZ + 1; t < data.length; t++) {
    if ((data[t] ?? 0) > 0) {
      amount = alpha * (data[t] ?? 0) + (1 - alpha) * amount;
      prob = beta + (1 - beta) * prob;
    } else {
      prob = (1 - beta) * prob;
    }
  }

  return {
    forecast: prob * amount,
    expectedAmount: amount,
    expectedInterval: prob > 0 ? 1 / prob : data.length,
  };
}

/**
 * Theta Method: M3-competition winner. Simple, effective on short series.
 * Decomposes into two theta-lines, extrapolates, and recombines.
 * Equivalent to: SES with drift = half the linear regression slope.
 */
export function theta(data: number[]): ThetaResult {
  if (data.length < 2) return { forecast: data[data.length - 1] ?? 0 };

  const reg = linearRegression(data);
  const drift = reg.slope / 2;

  // Simple exponential smoothing
  const ema = emaArray(data, Math.min(data.length, 6));
  const sesValue = ema[ema.length - 1] ?? 0;

  return { forecast: sesValue + drift };
}

/**
 * Seasonal Naive Forecast: next month = same month last year.
 * Best baseline for categories with strong annual seasonality (heating, vacation).
 */
export function seasonalNaive(data: number[], seasonalPeriod = 12): number {
  if (data.length < seasonalPeriod) return data[data.length - 1] ?? 0;

  // Average same-season values from all available years
  const seasonIdx = data.length % seasonalPeriod;
  const sameSeasonValues: number[] = [];
  for (let i = seasonIdx; i < data.length; i += seasonalPeriod) {
    sameSeasonValues.push(data[i] ?? 0);
  }

  return sameSeasonValues.length > 0
    ? sameSeasonValues.reduce((s, v) => s + v, 0) / sameSeasonValues.length
    : 0;
}

/**
 * k-Nearest Neighbors Regression: forecast = average of K most similar historical months.
 * Similarity based on: month index (seasonal), previous month's spending.
 * Intuitive: "find months that looked like this month and see what happened."
 */
export function knnForecast(data: number[], k = 3): KnnResult {
  const n = data.length;
  if (n < k + 1) return { forecast: data[data.length - 1] ?? 0, neighborIndices: [] };

  const target = data[n - 1] ?? 0;

  // Features: (previous month value, position in year as 0-11)
  const distances: Array<{ index: number; distance: number }> = [];

  for (let i = 1; i < n - 1; i++) {
    const prev = data[i - 1] ?? 0;
    // data[i + 1] is the "outcome" — the period we want to predict

    // Distance = weighted difference in previous spending + seasonal position
    const spendingDiff = Math.abs(prev - target);
    const seasonDiff = Math.min(
      Math.abs((i % 12) - ((n - 1) % 12)),
      12 - Math.abs((i % 12) - ((n - 1) % 12)),
    );

    // Normalize: spending by mean, season by 6 (max distance)
    const meanSpending = data.reduce((s, v) => s + v, 0) / n || 1;
    const distance = spendingDiff / meanSpending + seasonDiff / 6;

    distances.push({ index: i, distance });
  }

  distances.sort((a, b) => a.distance - b.distance);
  const neighbors = distances.slice(0, k);
  const neighborIndices = neighbors.map((d) => d.index);

  // Forecast = average of next-period values for the K nearest neighbors
  let sum = 0;
  let count = 0;
  for (const { index } of neighbors) {
    if (index + 1 < n) {
      sum += data[index + 1] ?? 0;
      count++;
    }
  }

  return { forecast: count > 0 ? sum / count : target, neighborIndices };
}
