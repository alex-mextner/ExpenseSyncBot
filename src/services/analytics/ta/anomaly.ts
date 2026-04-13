/** Anomaly detection: Z-Score, Modified Z-Score (MAD), IQR, Grubbs, Dixon, Hampel Filter */

import type { DixonResult, GrubbsResult, HampelResult, IqrResult, ZScoreResult } from './types';

/** Median of a sorted-in-place copy */
function median(data: number[]): number {
  if (data.length === 0) return 0;
  const sorted = [...data].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/** Mean of array */
function mean(data: number[]): number {
  if (data.length === 0) return 0;
  return data.reduce((s, v) => s + v, 0) / data.length;
}

/** Standard deviation */
function stddev(data: number[]): number {
  if (data.length < 2) return 0;
  const m = mean(data);
  const variance = data.reduce((s, v) => s + (v - m) ** 2, 0) / data.length;
  return Math.sqrt(variance);
}

/**
 * Z-Score: how many standard deviations a value is from the mean.
 * |Z| > 2 = suspicious, |Z| > 3 = almost certainly anomalous.
 */
export function zScore(value: number, data: number[], threshold = 2): ZScoreResult {
  const m = mean(data);
  const sd = stddev(data);
  if (sd === 0) return { zScore: 0, isAnomaly: false, direction: null };

  const z = (value - m) / sd;
  const isAnomaly = Math.abs(z) > threshold;
  const direction = isAnomaly ? (z > 0 ? 'high' : 'low') : null;
  return { zScore: z, isAnomaly, direction };
}

/**
 * Modified Z-Score using Median Absolute Deviation (MAD).
 * Robust to outliers — single large expense doesn't skew the "normal" level.
 * Threshold: |modified Z| > 3.5 = anomaly.
 */
export function modifiedZScore(value: number, data: number[], threshold = 3.5): ZScoreResult {
  const med = median(data);
  const mad = median(data.map((v) => Math.abs(v - med)));

  if (mad === 0) return { zScore: 0, isAnomaly: false, direction: null };

  const z = (0.6745 * (value - med)) / mad;
  const isAnomaly = Math.abs(z) > threshold;
  const direction = isAnomaly ? (z > 0 ? 'high' : 'low') : null;
  return { zScore: z, isAnomaly, direction };
}

/**
 * IQR (Interquartile Range) method.
 * Outlier = value outside [Q1 - 1.5×IQR, Q3 + 1.5×IQR].
 * No normality assumption — works for right-skewed spending data.
 */
export function iqrMethod(value: number, data: number[], multiplier = 1.5): IqrResult {
  const sorted = [...data].sort((a, b) => a - b);
  const q1Idx = Math.floor(sorted.length * 0.25);
  const q3Idx = Math.floor(sorted.length * 0.75);
  const q1 = sorted[q1Idx] ?? 0;
  const q3 = sorted[q3Idx] ?? 0;
  const iqr = q3 - q1;

  const lowerBound = q1 - multiplier * iqr;
  const upperBound = q3 + multiplier * iqr;

  return {
    q1,
    q3,
    iqr,
    lowerBound,
    upperBound,
    isOutlier: value < lowerBound || value > upperBound,
  };
}

/**
 * Grubbs' Test for a single outlier in a normally distributed sample.
 * Tests: is the most extreme value statistically significant?
 * Uses approximate critical values for alpha = 0.05.
 */
export function grubbsTest(data: number[]): GrubbsResult {
  if (data.length < 3) {
    return { outlier: data[0] ?? 0, statistic: 0, isSignificant: false };
  }

  const m = mean(data);
  const sd = stddev(data);
  if (sd === 0) return { outlier: m, statistic: 0, isSignificant: false };

  // Find most extreme value
  let maxDeviation = 0;
  let outlierValue = data[0] ?? 0;
  for (const v of data) {
    const dev = Math.abs(v - m);
    if (dev > maxDeviation) {
      maxDeviation = dev;
      outlierValue = v;
    }
  }

  const G = maxDeviation / sd;
  const n = data.length;

  // Approximate critical value using t-distribution (alpha=0.05, two-sided)
  // Grubbs critical = ((n-1) / sqrt(n)) * sqrt(t² / (n - 2 + t²))
  // For small samples, use tabulated approximations
  const tCritSquared = getCriticalTSquared(n);
  const critical = ((n - 1) / Math.sqrt(n)) * Math.sqrt(tCritSquared / (n - 2 + tCritSquared));

  return { outlier: outlierValue, statistic: G, isSignificant: G > critical };
}

/** Approximate t² critical values for Grubbs test (alpha=0.05, two-sided) */
function getCriticalTSquared(n: number): number {
  // t²(alpha/(2n), n-2) — approximate values for common sample sizes
  const table: Record<number, number> = {
    3: 12.706 ** 2,
    4: 6.97,
    5: 5.59,
    6: 4.77,
    7: 4.3,
    8: 3.93,
    9: 3.69,
    10: 3.5,
    12: 3.22,
    15: 2.97,
    20: 2.71,
    30: 2.46,
  };
  if (table[n] !== undefined) return table[n];
  // Interpolate for unlisted sizes
  const keys = Object.keys(table)
    .map(Number)
    .sort((a, b) => a - b);
  if (n < (keys[0] ?? 3)) return table[keys[0] ?? 3] ?? 170;
  if (n > (keys[keys.length - 1] ?? 30)) return 2.3;
  for (let i = 0; i < keys.length - 1; i++) {
    const lo = keys[i] ?? 3;
    const hi = keys[i + 1] ?? 30;
    if (n >= lo && n <= hi) {
      const ratio = (n - lo) / (hi - lo);
      return (table[lo] ?? 0) + ratio * ((table[hi] ?? 0) - (table[lo] ?? 0));
    }
  }
  return 2.5;
}

/**
 * Dixon's Q Test for outliers in small samples (3-30 observations).
 * Q = |suspected - nearest| / range. Compare to critical values.
 */
export function dixonTest(data: number[]): DixonResult {
  if (data.length < 3) {
    return { outlier: data[0] ?? 0, qRatio: 0, isSignificant: false };
  }

  const sorted = [...data].sort((a, b) => a - b);
  const n = sorted.length;
  const range = (sorted[n - 1] ?? 0) - (sorted[0] ?? 0);

  if (range === 0) return { outlier: sorted[0] ?? 0, qRatio: 0, isSignificant: false };

  // Test both ends
  const qLow = ((sorted[1] ?? 0) - (sorted[0] ?? 0)) / range;
  const qHigh = ((sorted[n - 1] ?? 0) - (sorted[n - 2] ?? 0)) / range;

  const isHighOutlier = qHigh >= qLow;
  const q = isHighOutlier ? qHigh : qLow;
  const outlier = isHighOutlier ? (sorted[n - 1] ?? 0) : (sorted[0] ?? 0);

  // Critical values at alpha = 0.05
  const criticals: Record<number, number> = {
    3: 0.941,
    4: 0.765,
    5: 0.642,
    6: 0.56,
    7: 0.507,
    8: 0.468,
    9: 0.437,
    10: 0.412,
    12: 0.376,
    15: 0.338,
    20: 0.3,
    25: 0.277,
    30: 0.26,
  };

  let critical = 0.26;
  const keys = Object.keys(criticals)
    .map(Number)
    .sort((a, b) => a - b);
  for (const k of keys) {
    if (n <= k) {
      critical = criticals[k] ?? 0.26;
      break;
    }
  }

  return { outlier, qRatio: q, isSignificant: q > critical };
}

/**
 * Hampel Filter: sliding window median filter that replaces outliers.
 * Outlier = point where |x - median(window)| > threshold × MAD(window).
 * Returns cleaned series + outlier indices.
 */
export function hampelFilter(data: number[], windowSize = 3, threshold = 3): HampelResult {
  const cleaned = [...data];
  const outlierIndices: number[] = [];

  for (let i = 0; i < data.length; i++) {
    const start = Math.max(0, i - windowSize);
    const end = Math.min(data.length, i + windowSize + 1);
    const window = data.slice(start, end);

    const med = median(window);
    const mad = median(window.map((v) => Math.abs(v - med)));

    if (mad > 0 && Math.abs((data[i] ?? 0) - med) > threshold * mad * 1.4826) {
      cleaned[i] = med;
      outlierIndices.push(i);
    }
  }

  return { cleaned, outlierIndices };
}
