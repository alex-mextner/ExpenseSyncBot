/** Trend analysis: Linear Regression, CUSUM, RSI, MACD, ROC, Momentum, Polynomial/Rolling/Robust Regression, EWMA Control Charts, Change Point Detection */

import { emaArray } from './moving-averages';
import type {
  ChangePointResult,
  CusumResult,
  EwmaControlResult,
  LinearRegressionResult,
  MacdResult,
  RsiResult,
} from './types';

/**
 * Linear Regression (OLS) on time series.
 * x = 0,1,2,...,n-1 (month index). Returns slope, intercept, R², forecast for next period.
 */
export function linearRegression(data: number[]): LinearRegressionResult {
  const n = data.length;
  if (n < 2) {
    const v = data[0] ?? 0;
    return { slope: 0, intercept: v, r2: 0, forecast: v, monthlyChange: 0 };
  }

  let sumX = 0;
  let sumY = 0;
  let sumXY = 0;
  let sumX2 = 0;
  for (let i = 0; i < n; i++) {
    const y = data[i] ?? 0;
    sumX += i;
    sumY += y;
    sumXY += i * y;
    sumX2 += i * i;
  }

  const denom = n * sumX2 - sumX * sumX;
  if (denom === 0) {
    const avg = sumY / n;
    return { slope: 0, intercept: avg, r2: 0, forecast: avg, monthlyChange: 0 };
  }

  const slope = (n * sumXY - sumX * sumY) / denom;
  const intercept = (sumY - slope * sumX) / n;

  // R² = (correlation coefficient)²
  const ssRes = data.reduce((s, y, i) => s + (y - (intercept + slope * i)) ** 2, 0);
  const meanY = sumY / n;
  const ssTot = data.reduce((s, y) => s + (y - meanY) ** 2, 0);
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return {
    slope,
    intercept,
    r2,
    forecast: intercept + slope * n,
    monthlyChange: slope,
  };
}

/**
 * CUSUM (Cumulative Sum Control Chart).
 * Detects sustained shifts in spending level vs target (e.g., budget or historical mean).
 * Distinguishes "one outlier" from "spending systemically increased".
 */
export function cusum(data: number[], target?: number, threshold?: number): CusumResult {
  if (data.length === 0) return { values: [], shiftDetected: false, shiftIndex: -1 };

  const t = target ?? data.reduce((s, v) => s + v, 0) / data.length;
  const sd = Math.sqrt(data.reduce((s, v) => s + (v - t) ** 2, 0) / data.length);
  const h = threshold ?? sd * 4;

  const values: number[] = [];
  let cumSum = 0;
  let shiftIndex = -1;

  for (let i = 0; i < data.length; i++) {
    cumSum = Math.max(0, cumSum + (data[i] ?? 0) - t);
    values.push(cumSum);
    if (cumSum > h && shiftIndex === -1) {
      shiftIndex = i;
    }
  }

  return { values, shiftDetected: shiftIndex >= 0, shiftIndex };
}

/**
 * RSI (Relative Strength Index) adapted for spending.
 * Measures proportion of "up" months vs "down" months.
 * RSI > 70 = spending consistently rising. RSI < 30 = consistently falling.
 */
export function rsi(data: number[], period = 6): RsiResult {
  if (data.length < 2) return { value: 50, signal: 'neutral' };

  const changes: number[] = [];
  for (let i = 1; i < data.length; i++) {
    changes.push((data[i] ?? 0) - (data[i - 1] ?? 0));
  }

  const window = changes.slice(-period);
  let avgGain = 0;
  let avgLoss = 0;

  for (const c of window) {
    if (c > 0) avgGain += c;
    else avgLoss += Math.abs(c);
  }

  avgGain /= period;
  avgLoss /= period;

  const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
  const value = 100 - 100 / (1 + rs);

  const signal = value > 70 ? 'overbought' : value < 30 ? 'oversold' : 'neutral';
  return { value, signal };
}

/**
 * MACD (Moving Average Convergence Divergence) adapted for spending.
 * Fast EMA(3) - Slow EMA(6), signal = EMA(3) of MACD.
 * Crossover = change in spending trend direction.
 */
export function macd(data: number[], fastPeriod = 3, slowPeriod = 6, signalPeriod = 3): MacdResult {
  if (data.length < slowPeriod) {
    return { macd: 0, signal: 0, histogram: 0, crossover: 'none' };
  }

  const fastEma = emaArray(data, fastPeriod);
  const slowEma = emaArray(data, slowPeriod);

  const macdLine = fastEma.map((f, i) => f - (slowEma[i] ?? 0));
  const signalLine = emaArray(macdLine, signalPeriod);

  const macdValue = macdLine[macdLine.length - 1] ?? 0;
  const signalValue = signalLine[signalLine.length - 1] ?? 0;
  const histogram = macdValue - signalValue;

  // Detect crossover
  let crossover: 'bullish' | 'bearish' | 'none' = 'none';
  if (macdLine.length >= 2 && signalLine.length >= 2) {
    const prevMacd = macdLine[macdLine.length - 2] ?? 0;
    const prevSignal = signalLine[signalLine.length - 2] ?? 0;
    if (prevMacd <= prevSignal && macdValue > signalValue) crossover = 'bullish';
    else if (prevMacd >= prevSignal && macdValue < signalValue) crossover = 'bearish';
  }

  return { macd: macdValue, signal: signalValue, histogram, crossover };
}

/**
 * Rate of Change (ROC): percentage change over N periods.
 * ROC > 30% = significant spending increase worth alerting.
 */
export function roc(data: number[], period = 1): number {
  if (data.length <= period) return 0;
  const current = data[data.length - 1] ?? 0;
  const prev = data[data.length - 1 - period] ?? 0;
  return prev !== 0 ? ((current - prev) / Math.abs(prev)) * 100 : 0;
}

/**
 * Momentum: absolute change over N periods.
 * Shows direction and magnitude of spending change in currency units.
 */
export function momentum(data: number[], period = 3): number {
  if (data.length <= period) return 0;
  return (data[data.length - 1] ?? 0) - (data[data.length - 1 - period] ?? 0);
}

/**
 * Polynomial Regression (degree 2 — quadratic).
 * Detects accelerating/decelerating spending trends.
 * Returns coefficients and forecast. Uses for visualization, not extrapolation.
 */
export function polynomialRegression(
  data: number[],
  degree = 2,
): { coefficients: number[]; forecast: number; r2: number } {
  const n = data.length;
  if (n < degree + 1) {
    return {
      coefficients: [data[data.length - 1] ?? 0],
      forecast: data[data.length - 1] ?? 0,
      r2: 0,
    };
  }

  // Build Vandermonde matrix and solve via normal equations
  const maxDeg = Math.min(degree, 2); // Cap at quadratic
  const cols = maxDeg + 1;

  // X^T X matrix
  const xtx: number[][] = Array.from({ length: cols }, () => Array.from({ length: cols }, () => 0));
  const xty: number[] = Array.from({ length: cols }, () => 0);

  for (let i = 0; i < n; i++) {
    const y = data[i] ?? 0;
    for (let j = 0; j < cols; j++) {
      xty[j] = (xty[j] ?? 0) + y * i ** j;
      const row = xtx[j];
      if (row) {
        for (let k = 0; k < cols; k++) {
          row[k] = (row[k] ?? 0) + i ** (j + k);
        }
      }
    }
  }

  // Solve via Gaussian elimination
  const coefficients = solveLinearSystem(xtx, xty);

  // Forecast
  let forecast = 0;
  for (let j = 0; j < coefficients.length; j++) {
    forecast += (coefficients[j] ?? 0) * n ** j;
  }

  // R²
  const meanY = data.reduce((s, v) => s + v, 0) / n;
  let ssRes = 0;
  let ssTot = 0;
  for (let i = 0; i < n; i++) {
    let predicted = 0;
    for (let j = 0; j < coefficients.length; j++) predicted += (coefficients[j] ?? 0) * i ** j;
    ssRes += ((data[i] ?? 0) - predicted) ** 2;
    ssTot += ((data[i] ?? 0) - meanY) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : 0;

  return { coefficients, forecast, r2 };
}

/** Gaussian elimination for small systems */
function solveLinearSystem(matrix: number[][], rhs: number[]): number[] {
  const n = rhs.length;
  const aug: number[][] = matrix.map((row, i) => [...row, rhs[i] ?? 0]);

  const getCell = (r: number, c: number) => aug[r]?.[c] ?? 0;
  const setCell = (r: number, c: number, v: number) => {
    const row = aug[r];
    if (row) row[c] = v;
  };

  for (let col = 0; col < n; col++) {
    // Partial pivoting
    let maxRow = col;
    for (let row = col + 1; row < n; row++) {
      if (Math.abs(getCell(row, col)) > Math.abs(getCell(maxRow, col))) maxRow = row;
    }
    const temp = aug[col];
    aug[col] = aug[maxRow] ?? [];
    aug[maxRow] = temp ?? [];

    const pivot = getCell(col, col);
    if (Math.abs(pivot) < 1e-12) continue;

    for (let j = col; j <= n; j++) setCell(col, j, getCell(col, j) / pivot);

    for (let row = 0; row < n; row++) {
      if (row === col) continue;
      const factor = getCell(row, col);
      for (let j = col; j <= n; j++) setCell(row, j, getCell(row, j) - factor * getCell(col, j));
    }
  }

  return aug.map((row) => row[n] ?? 0);
}

/**
 * Rolling Regression: linear regression in a sliding window.
 * Returns slope for each window position — shows how local trend evolves.
 */
export function rollingRegression(
  data: number[],
  windowSize = 6,
): { slopes: number[]; currentSlope: number } {
  const slopes: number[] = [];

  for (let i = windowSize - 1; i < data.length; i++) {
    const window = data.slice(i - windowSize + 1, i + 1);
    const result = linearRegression(window);
    slopes.push(result.slope);
  }

  return { slopes, currentSlope: slopes[slopes.length - 1] ?? 0 };
}

/**
 * Robust Regression (LAD — Least Absolute Deviations) via iteratively reweighted least squares.
 * Resistant to outliers — one car repair won't skew the trend.
 */
export function robustRegression(
  data: number[],
  iterations = 10,
): { slope: number; intercept: number; forecast: number } {
  const n = data.length;
  if (n < 2) {
    const v = data[0] ?? 0;
    return { slope: 0, intercept: v, forecast: v };
  }

  // Start with OLS
  let { slope, intercept } = linearRegression(data);
  const weights = Array.from({ length: n }, () => 1);

  for (let iter = 0; iter < iterations; iter++) {
    // Compute residuals and weights (Huber weight function)
    const residuals = data.map((y, i) => (y ?? 0) - (intercept + slope * i));
    const medResidual = sortedMedian(residuals.map(Math.abs));
    const c = 1.345 * (medResidual || 1);

    for (let i = 0; i < n; i++) {
      const r = Math.abs(residuals[i] ?? 0);
      weights[i] = r <= c ? 1 : c / r;
    }

    // Weighted least squares
    let swx = 0;
    let swy = 0;
    let swx2 = 0;
    let swxy = 0;
    let sw = 0;

    for (let i = 0; i < n; i++) {
      const w = weights[i] ?? 1;
      const y = data[i] ?? 0;
      sw += w;
      swx += w * i;
      swy += w * y;
      swx2 += w * i * i;
      swxy += w * i * y;
    }

    const denom = sw * swx2 - swx * swx;
    if (Math.abs(denom) < 1e-12) break;

    slope = (sw * swxy - swx * swy) / denom;
    intercept = (swy - slope * swx) / sw;
  }

  return { slope, intercept, forecast: intercept + slope * n };
}

function sortedMedian(data: number[]): number {
  const sorted = [...data].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 !== 0
    ? (sorted[mid] ?? 0)
    : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

/**
 * EWMA Control Chart: detects small sustained shifts in spending level.
 * Lambda = 0.2–0.3 typical. Out of control = outside ±L × σ limits.
 */
export function ewmaControl(data: number[], lambda = 0.25, L = 3): EwmaControlResult {
  if (data.length === 0) return { value: 0, ucl: 0, lcl: 0, outOfControl: false };

  const mean = data.reduce((s, v) => s + v, 0) / data.length;
  const variance = data.reduce((s, v) => s + (v - mean) ** 2, 0) / data.length;
  const sigma = Math.sqrt(variance);

  let ewma = mean;
  for (const v of data) {
    ewma = lambda * v + (1 - lambda) * ewma;
  }

  // Control limits widen with number of observations (converge to steady-state)
  const n = data.length;
  const factor = Math.sqrt((lambda / (2 - lambda)) * (1 - (1 - lambda) ** (2 * n)));
  const ucl = mean + L * sigma * factor;
  const lcl = mean - L * sigma * factor;

  return { value: ewma, ucl, lcl, outOfControl: ewma > ucl || ewma < lcl };
}

/**
 * Change Point Detection (simplified PELT-like algorithm).
 * Finds points where the mean level of spending shifts significantly.
 * Uses binary segmentation with cost = sum of squared residuals from segment mean.
 */
export function changePointDetection(
  data: number[],
  minSegmentSize = 3,
  penalty?: number,
): ChangePointResult {
  const n = data.length;
  if (n < minSegmentSize * 2) {
    return {
      changePoints: [],
      segments: [{ start: 0, end: n - 1, mean: data.reduce((s, v) => s + v, 0) / n }],
    };
  }

  const pen = penalty ?? 2 * Math.log(n) * segmentVariance(data, 0, n);

  const changePoints: number[] = [];
  findChangePoints(data, 0, n - 1, minSegmentSize, pen, changePoints);
  changePoints.sort((a, b) => a - b);

  // Build segments
  const boundaries = [0, ...changePoints, n];
  const segments: Array<{ start: number; end: number; mean: number }> = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i] ?? 0;
    const end = (boundaries[i + 1] ?? n) - 1;
    const slice = data.slice(start, end + 1);
    const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
    segments.push({ start, end, mean });
  }

  return { changePoints, segments };
}

function segmentVariance(data: number[], start: number, end: number): number {
  const slice = data.slice(start, end);
  if (slice.length < 2) return 0;
  const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
  return slice.reduce((s, v) => s + (v - mean) ** 2, 0) / slice.length;
}

function segmentCost(data: number[], start: number, end: number): number {
  const slice = data.slice(start, end);
  if (slice.length === 0) return 0;
  const mean = slice.reduce((s, v) => s + v, 0) / slice.length;
  return slice.reduce((s, v) => s + (v - mean) ** 2, 0);
}

function findChangePoints(
  data: number[],
  start: number,
  end: number,
  minSize: number,
  penalty: number,
  result: number[],
): void {
  if (end - start + 1 < minSize * 2) return;

  const totalCost = segmentCost(data, start, end + 1);
  let bestGain = 0;
  let bestPoint = -1;

  for (let t = start + minSize; t <= end - minSize + 1; t++) {
    const leftCost = segmentCost(data, start, t);
    const rightCost = segmentCost(data, t, end + 1);
    const gain = totalCost - leftCost - rightCost;
    if (gain > bestGain) {
      bestGain = gain;
      bestPoint = t;
    }
  }

  if (bestGain > penalty && bestPoint >= 0) {
    result.push(bestPoint);
    findChangePoints(data, start, bestPoint - 1, minSize, penalty, result);
    findChangePoints(data, bestPoint, end, minSize, penalty, result);
  }
}
