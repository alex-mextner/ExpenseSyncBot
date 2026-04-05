/** Volatility indicators: Bollinger Bands, ATR, Keltner, Donchian, Historical Volatility, MA Envelopes, EWMA Variance */

import { emaArray } from './moving-averages';
import type { BollingerBandsResult, ChannelResult, DonchianResult } from './types';

/** Standard deviation of an array */
function stddev(data: number[]): number {
  if (data.length < 2) return 0;
  const mean = data.reduce((s, v) => s + v, 0) / data.length;
  const variance = data.reduce((s, v) => s + (v - mean) ** 2, 0) / data.length;
  return Math.sqrt(variance);
}

/**
 * Bollinger Bands: SMA ± multiplier × σ.
 * Upper band = dynamic anomaly threshold. Bandwidth measures squeeze.
 */
export function bollingerBands(data: number[], period = 6, multiplier = 2): BollingerBandsResult {
  if (data.length < period) {
    const last = data[data.length - 1] ?? 0;
    return { upper: last, middle: last, lower: last, bandwidth: 0, percentB: 0.5 };
  }

  const window = data.slice(-period);
  const middle = window.reduce((s, v) => s + v, 0) / window.length;
  const sd = stddev(window);

  const upper = middle + multiplier * sd;
  const lower = middle - multiplier * sd;
  const bandwidth = middle > 0 ? (upper - lower) / middle : 0;
  const current = data[data.length - 1] ?? 0;
  const range = upper - lower;
  const percentB = range > 0 ? (current - lower) / range : 0.5;

  return { upper, middle, lower, bandwidth, percentB };
}

/**
 * Average True Range — adapted for budget: mean absolute deviation of monthly amounts.
 * Measures typical month-to-month variation magnitude.
 */
export function atr(data: number[], period = 6): number {
  if (data.length < 2) return 0;

  const trueRanges: number[] = [];
  for (let i = 1; i < data.length; i++) {
    trueRanges.push(Math.abs((data[i] ?? 0) - (data[i - 1] ?? 0)));
  }

  const window = trueRanges.slice(-period);
  return window.reduce((s, v) => s + v, 0) / window.length;
}

/**
 * Keltner Channels: EMA ± multiplier × ATR.
 * Less sensitive to single outliers than Bollinger Bands.
 */
export function keltnerChannels(
  data: number[],
  emaPeriod = 6,
  atrPeriod = 6,
  multiplier = 1.5,
): ChannelResult {
  const emaSeries = emaArray(data, emaPeriod);
  const middle = emaSeries[emaSeries.length - 1] ?? 0;
  const atrValue = atr(data, atrPeriod);
  return {
    upper: middle + multiplier * atrValue,
    middle,
    lower: middle - multiplier * atrValue,
  };
}

/**
 * Donchian Channels: highest high / lowest low over N periods.
 * Simple breakout detection — new record spending triggers alert.
 */
export function donchianChannels(data: number[], period = 6): DonchianResult {
  const window = data.slice(-period);
  if (window.length === 0) {
    return { upper: 0, lower: 0, middle: 0, isBreakoutHigh: false, isBreakoutLow: false };
  }

  const upper = Math.max(...window);
  const lower = Math.min(...window);
  const middle = (upper + lower) / 2;
  const current = data[data.length - 1] ?? 0;

  return {
    upper,
    lower,
    middle,
    isBreakoutHigh: current >= upper && data.length > period,
    isBreakoutLow: current <= lower && data.length > period,
  };
}

/**
 * Historical Volatility: σ of log-returns.
 * Measures how unpredictable a category's spending changes are.
 */
export function historicalVolatility(data: number[], period = 6): number {
  if (data.length < 2) return 0;

  const logReturns: number[] = [];
  for (let i = 1; i < data.length; i++) {
    const prev = data[i - 1] ?? 1;
    const curr = data[i] ?? 1;
    if (prev > 0 && curr > 0) {
      logReturns.push(Math.log(curr / prev));
    }
  }

  const window = logReturns.slice(-period);
  return stddev(window);
}

/**
 * Moving Average Envelopes: EMA ± fixed percentage.
 * Simpler than Bollinger — no σ computation needed.
 */
export function maEnvelopes(data: number[], period = 6, percentBand = 0.2): ChannelResult {
  const emaSeries = emaArray(data, period);
  const middle = emaSeries[emaSeries.length - 1] ?? 0;
  return {
    upper: middle * (1 + percentBand),
    middle,
    lower: middle * (1 - percentBand),
  };
}

/**
 * Exponentially Weighted Moving Variance — recent deviations weigh more.
 * Adaptive bandwidth: if spending becomes less predictable, variance rises quickly.
 */
export function ewmaVariance(data: number[], lambda = 0.94): number {
  if (data.length < 2) return 0;

  const mean = data.reduce((s, v) => s + v, 0) / data.length;
  let variance = (data[0] ?? 0 - mean) ** 2;

  for (let i = 1; i < data.length; i++) {
    const deviation = ((data[i] ?? 0) - mean) ** 2;
    variance = lambda * variance + (1 - lambda) * deviation;
  }

  return variance;
}
