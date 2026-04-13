/** Pattern detection: STL decomposition, Day-of-month profile, Percentile Bands, Category Correlation, Hurst Exponent, Pivot Points, Loess/Lowess */

import type {
  CorrelationResult,
  DayOfMonthProfile,
  HurstResult,
  LoessPoint,
  PercentileBands,
  PivotPointResult,
  StlResult,
} from './types';

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
 * Simplified STL Decomposition: Trend + Seasonal + Residual.
 * Uses moving average for trend, then extracts seasonal pattern.
 * Full STL requires LOESS (implemented below), but this simplified version
 * works well for monthly budget data with period=12.
 */
export function stlDecomposition(data: number[], seasonalPeriod = 12): StlResult {
  const n = data.length;
  if (n < seasonalPeriod) {
    return { trend: [...data], seasonal: Array(n).fill(0), residual: Array(n).fill(0) };
  }

  // Step 1: Extract trend using centered moving average
  const halfWindow = Math.floor(seasonalPeriod / 2);
  const trend: number[] = [];
  for (let i = 0; i < n; i++) {
    if (i < halfWindow || i >= n - halfWindow) {
      trend.push(data[i] ?? 0);
    } else {
      let sum = 0;
      for (let j = i - halfWindow; j <= i + halfWindow; j++) sum += data[j] ?? 0;
      trend.push(sum / (2 * halfWindow + 1));
    }
  }

  // Step 2: Detrend
  const detrended = data.map((v, i) => v - (trend[i] ?? 0));

  // Step 3: Average detrended values for each seasonal position
  const seasonalAvg: number[] = Array(seasonalPeriod).fill(0);
  const seasonalCount: number[] = Array(seasonalPeriod).fill(0);
  for (let i = 0; i < n; i++) {
    const idx = i % seasonalPeriod;
    seasonalAvg[idx] = (seasonalAvg[idx] ?? 0) + (detrended[i] ?? 0);
    seasonalCount[idx] = (seasonalCount[idx] ?? 0) + 1;
  }
  for (let i = 0; i < seasonalPeriod; i++) {
    seasonalAvg[i] =
      (seasonalCount[i] ?? 1) > 0 ? (seasonalAvg[i] ?? 0) / (seasonalCount[i] ?? 1) : 0;
  }

  // Center seasonal component (mean = 0)
  const seasonalMean = seasonalAvg.reduce((s, v) => s + v, 0) / seasonalPeriod;
  const centeredSeasonal = seasonalAvg.map((v) => v - seasonalMean);

  // Step 4: Build full seasonal and residual
  const seasonal = Array.from({ length: n }, (_, i) => centeredSeasonal[i % seasonalPeriod] ?? 0);
  const residual = data.map((v, i) => v - (trend[i] ?? 0) - (seasonal[i] ?? 0));

  return { trend, seasonal, residual };
}

/**
 * Day-of-month spending profile: cumulative % of monthly spending by day.
 * Used for improved run-rate: "by day 15 you usually spend 50%, but you've spent 60%".
 * @param dailyExpenses Array of { day: number (1-31), amount: number } for multiple months
 * @param daysInMonth Number of days in the target month
 */
export function dayOfMonthProfile(
  dailyExpenses: Array<{ day: number; amount: number }>,
  daysInMonth = 30,
): DayOfMonthProfile {
  // Accumulate spending per day across all months
  const dayTotals: number[] = Array(daysInMonth).fill(0);
  let totalAmount = 0;

  for (const exp of dailyExpenses) {
    const idx = Math.min(exp.day - 1, daysInMonth - 1);
    if (idx >= 0) {
      dayTotals[idx] = (dayTotals[idx] ?? 0) + exp.amount;
      totalAmount += exp.amount;
    }
  }

  // Cumulative profile
  const cumulativeProfile: number[] = [];
  let cumulative = 0;
  for (let i = 0; i < daysInMonth; i++) {
    cumulative += dayTotals[i] ?? 0;
    cumulativeProfile.push(totalAmount > 0 ? cumulative / totalAmount : (i + 1) / daysInMonth);
  }

  return {
    cumulativeProfile,
    expectedByDay: (day: number) => {
      const idx = Math.max(0, Math.min(day - 1, daysInMonth - 1));
      return cumulativeProfile[idx] ?? day / daysInMonth;
    },
  };
}

/**
 * Percentile Bands: empirical P10, P25, P50, P75, P90 from historical data.
 * No normality assumption — works for right-skewed spending.
 */
export function percentileBands(data: number[]): PercentileBands {
  if (data.length === 0) return { p10: 0, p25: 0, p50: 0, p75: 0, p90: 0 };

  const sorted = [...data].sort((a, b) => a - b);
  return {
    p10: quantile(sorted, 0.1),
    p25: quantile(sorted, 0.25),
    p50: quantile(sorted, 0.5),
    p75: quantile(sorted, 0.75),
    p90: quantile(sorted, 0.9),
  };
}

/**
 * Category Correlation: Pearson correlation between monthly spending of two categories.
 * Finds linked categories: "when restaurant spending rises, grocery spending falls" (r = -0.6).
 * @param allCategoryData Map of category name → monthly totals array
 * @param minCorrelation Minimum |r| to report (default 0.4)
 */
export function categoryCorrelation(
  allCategoryData: Map<string, number[]>,
  minCorrelation = 0.4,
): CorrelationResult[] {
  const categories = [...allCategoryData.keys()];
  const results: CorrelationResult[] = [];

  for (let i = 0; i < categories.length; i++) {
    for (let j = i + 1; j < categories.length; j++) {
      const cat1 = categories[i];
      const cat2 = categories[j];
      if (!cat1 || !cat2) continue;
      const data1 = allCategoryData.get(cat1) ?? [];
      const data2 = allCategoryData.get(cat2) ?? [];

      // Align lengths
      const len = Math.min(data1.length, data2.length);
      if (len < 3) continue;

      const x = data1.slice(-len);
      const y = data2.slice(-len);

      const r = pearsonCorrelation(x, y);
      if (Math.abs(r) < minCorrelation) continue;

      let strength: CorrelationResult['strength'];
      if (r > 0.7) strength = 'strong_positive';
      else if (r > 0.4) strength = 'moderate_positive';
      else if (r > -0.4) strength = 'weak';
      else if (r > -0.7) strength = 'moderate_negative';
      else strength = 'strong_negative';

      results.push({ category1: cat1, category2: cat2, correlation: r, strength });
    }
  }

  return results.sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 2) return 0;

  const meanX = x.reduce((s, v) => s + v, 0) / n;
  const meanY = y.reduce((s, v) => s + v, 0) / n;

  let sumXY = 0;
  let sumX2 = 0;
  let sumY2 = 0;

  for (let i = 0; i < n; i++) {
    const dx = (x[i] ?? 0) - meanX;
    const dy = (y[i] ?? 0) - meanY;
    sumXY += dx * dy;
    sumX2 += dx * dx;
    sumY2 += dy * dy;
  }

  const denom = Math.sqrt(sumX2 * sumY2);
  return denom > 0 ? sumXY / denom : 0;
}

/**
 * Hurst Exponent: measures long-term memory of a time series.
 * H > 0.5 = trending (spending keeps rising). H ≈ 0.5 = random walk. H < 0.5 = mean-reverting.
 * Uses R/S (rescaled range) method.
 */
export function hurstExponent(data: number[]): HurstResult {
  if (data.length < 8) return { value: 0.5, type: 'random_walk' };

  const n = data.length;
  const sizes = [4, 8, 16, 32, 64].filter((s) => s <= n / 2);
  if (sizes.length < 2) return { value: 0.5, type: 'random_walk' };

  const logRS: number[] = [];
  const logN: number[] = [];

  for (const size of sizes) {
    const rsValues: number[] = [];
    const numBlocks = Math.floor(n / size);

    for (let b = 0; b < numBlocks; b++) {
      const block = data.slice(b * size, (b + 1) * size);
      const mean = block.reduce((s, v) => s + v, 0) / block.length;

      // Cumulative deviation from mean
      const cumDev: number[] = [];
      let cumSum = 0;
      for (const v of block) {
        cumSum += v - mean;
        cumDev.push(cumSum);
      }

      const R = Math.max(...cumDev) - Math.min(...cumDev);
      const S = Math.sqrt(block.reduce((s, v) => s + (v - mean) ** 2, 0) / block.length);
      if (S > 0) rsValues.push(R / S);
    }

    if (rsValues.length > 0) {
      const avgRS = rsValues.reduce((s, v) => s + v, 0) / rsValues.length;
      if (avgRS > 0) {
        logRS.push(Math.log(avgRS));
        logN.push(Math.log(size));
      }
    }
  }

  if (logN.length < 2) return { value: 0.5, type: 'random_walk' };

  // Linear regression of log(R/S) vs log(n) → slope = Hurst exponent
  const meanLogN = logN.reduce((s, v) => s + v, 0) / logN.length;
  const meanLogRS = logRS.reduce((s, v) => s + v, 0) / logRS.length;

  let num = 0;
  let den = 0;
  for (let i = 0; i < logN.length; i++) {
    const dx = (logN[i] ?? 0) - meanLogN;
    const dy = (logRS[i] ?? 0) - meanLogRS;
    num += dx * dy;
    den += dx * dx;
  }

  const H = den > 0 ? Math.max(0, Math.min(1, num / den)) : 0.5;

  const type = H > 0.6 ? 'trending' : H < 0.4 ? 'mean_reverting' : 'random_walk';
  return { value: H, type };
}

/**
 * Pivot Points: support/resistance levels based on previous period's high, low, close.
 * Adapted: high = max monthly spending, low = min, close = last month.
 * R1 breach = spending approaching historical ceiling.
 */
export function pivotPoints(data: number[], period = 6): PivotPointResult {
  const window = data.slice(-period);
  if (window.length === 0)
    return { pivot: 0, resistance1: 0, resistance2: 0, support1: 0, support2: 0 };

  const high = Math.max(...window);
  const low = Math.min(...window);
  const close = window[window.length - 1] ?? 0;

  const pivot = (high + low + close) / 3;
  return {
    pivot,
    resistance1: 2 * pivot - low,
    resistance2: pivot + (high - low),
    support1: 2 * pivot - high,
    support2: pivot - (high - low),
  };
}

/**
 * LOESS/LOWESS: locally weighted polynomial regression.
 * Smooth nonlinear trend for visualization (not extrapolation).
 * @param bandwidth Fraction of data used for each local fit (0-1, default 0.5)
 */
export function loess(data: number[], bandwidth = 0.5): LoessPoint[] {
  const n = data.length;
  if (n < 3) return data.map((y, x) => ({ x, y }));

  const span = Math.max(3, Math.ceil(bandwidth * n));
  const result: LoessPoint[] = [];

  for (let i = 0; i < n; i++) {
    // Find nearest `span` points
    const distances: Array<{ idx: number; dist: number }> = [];
    for (let j = 0; j < n; j++) {
      distances.push({ idx: j, dist: Math.abs(i - j) });
    }
    distances.sort((a, b) => a.dist - b.dist);
    const neighbors = distances.slice(0, span);
    const maxDist = neighbors[neighbors.length - 1]?.dist ?? 1;

    // Tricube weight function
    const weights: number[] = [];
    for (const nb of neighbors) {
      const u = maxDist > 0 ? nb.dist / (maxDist + 0.001) : 0;
      weights.push(u < 1 ? (1 - u ** 3) ** 3 : 0);
    }

    // Weighted linear regression
    let swx = 0;
    let swy = 0;
    let swx2 = 0;
    let swxy = 0;
    let sw = 0;

    for (let k = 0; k < neighbors.length; k++) {
      const idx = neighbors[k]?.idx ?? 0;
      const w = weights[k] ?? 0;
      sw += w;
      swx += w * idx;
      swy += w * (data[idx] ?? 0);
      swx2 += w * idx * idx;
      swxy += w * idx * (data[idx] ?? 0);
    }

    const denom = sw * swx2 - swx * swx;
    let y: number;
    if (Math.abs(denom) < 1e-12) {
      y = sw > 0 ? swy / sw : (data[i] ?? 0);
    } else {
      const slope = (sw * swxy - swx * swy) / denom;
      const intercept = (swy - slope * swx) / sw;
      y = intercept + slope * i;
    }

    result.push({ x: i, y });
  }

  return result;
}
