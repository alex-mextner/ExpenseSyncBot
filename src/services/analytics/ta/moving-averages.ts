/** Moving average methods: SMA, WMA, KAMA, DEMA, TEMA, Hull, ZLEMA, Triangular */

import type { KamaResult, MovingAverageResult } from './types';

/** Simple Moving Average over last `period` values */
export function sma(data: number[], period: number): MovingAverageResult {
  const series: number[] = [];
  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      series.push(Number.NaN);
      continue;
    }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += data[j] ?? 0;
    series.push(sum / period);
  }
  const value = series[series.length - 1] ?? 0;
  return { value: Number.isNaN(value) ? 0 : value, series };
}

/** Weighted Moving Average — linearly increasing weights (newest = highest) */
export function wma(data: number[], period: number): MovingAverageResult {
  const series: number[] = [];
  const weightSum = (period * (period + 1)) / 2;

  for (let i = 0; i < data.length; i++) {
    if (i < period - 1) {
      series.push(Number.NaN);
      continue;
    }
    let sum = 0;
    for (let j = 0; j < period; j++) {
      sum += (data[i - period + 1 + j] ?? 0) * (j + 1);
    }
    series.push(sum / weightSum);
  }
  const value = series[series.length - 1] ?? 0;
  return { value: Number.isNaN(value) ? 0 : value, series };
}

/** EMA helper — returns full series */
export function emaArray(data: number[], period: number): number[] {
  if (data.length === 0) return [];
  const alpha = 2 / (period + 1);
  const result: number[] = [data[0] ?? 0];
  for (let i = 1; i < data.length; i++) {
    result.push(alpha * (data[i] ?? 0) + (1 - alpha) * (result[i - 1] ?? 0));
  }
  return result;
}

/**
 * Kaufman Adaptive Moving Average — adapts smoothing speed to market efficiency.
 * Fast period = 2, slow period = 30 (standard). Efficiency ratio determines blend.
 */
export function kama(data: number[], period = 10): KamaResult {
  if (data.length < period + 1) {
    return { value: data[data.length - 1] ?? 0, series: [...data], efficiencyRatio: 0 };
  }

  const fastSC = 2 / (2 + 1);
  const slowSC = 2 / (30 + 1);
  const series: number[] = [];

  for (let i = 0; i < period; i++) series.push(data[i] ?? 0);

  let lastER = 0;
  for (let i = period; i < data.length; i++) {
    const direction = Math.abs((data[i] ?? 0) - (data[i - period] ?? 0));
    let volatility = 0;
    for (let j = i - period + 1; j <= i; j++) {
      volatility += Math.abs((data[j] ?? 0) - (data[j - 1] ?? 0));
    }
    const er = volatility > 0 ? direction / volatility : 0;
    lastER = er;

    const sc = (er * (fastSC - slowSC) + slowSC) ** 2;
    const prev = series[series.length - 1] ?? 0;
    series.push(prev + sc * ((data[i] ?? 0) - prev));
  }

  return {
    value: series[series.length - 1] ?? 0,
    series,
    efficiencyRatio: lastER,
  };
}

/** Double Exponential Moving Average — reduces lag vs EMA */
export function dema(data: number[], period: number): MovingAverageResult {
  const ema1 = emaArray(data, period);
  const ema2 = emaArray(ema1, period);
  const series = ema1.map((v, i) => 2 * v - (ema2[i] ?? 0));
  return { value: series[series.length - 1] ?? 0, series };
}

/** Triple Exponential Moving Average — even less lag */
export function tema(data: number[], period: number): MovingAverageResult {
  const ema1 = emaArray(data, period);
  const ema2 = emaArray(ema1, period);
  const ema3 = emaArray(ema2, period);
  const series = ema1.map((v, i) => 3 * v - 3 * (ema2[i] ?? 0) + (ema3[i] ?? 0));
  return { value: series[series.length - 1] ?? 0, series };
}

/** Hull Moving Average — fast with minimal lag, uses WMA and sqrt(period) */
export function hullMa(data: number[], period: number): MovingAverageResult {
  const halfPeriod = Math.max(1, Math.floor(period / 2));
  const sqrtPeriod = Math.max(1, Math.round(Math.sqrt(period)));

  const wma1 = wma(data, halfPeriod);
  const wma2 = wma(data, period);

  const diff = wma1.series.map((v, i) => {
    const w2 = wma2.series[i];
    if (Number.isNaN(v) || w2 === undefined || Number.isNaN(w2)) return Number.NaN;
    return 2 * v - w2;
  });

  const validDiff = diff.filter((v) => !Number.isNaN(v));
  const hullResult = wma(validDiff, sqrtPeriod);
  return { value: hullResult.value, series: hullResult.series };
}

/** Zero-Lag EMA — compensates for EMA lag by adding momentum term */
export function zlema(data: number[], period: number): MovingAverageResult {
  const lag = Math.floor((period - 1) / 2);
  const adjusted: number[] = [];
  for (let i = 0; i < data.length; i++) {
    const prev = data[i - lag];
    adjusted.push((data[i] ?? 0) + ((data[i] ?? 0) - (prev ?? data[i] ?? 0)));
  }
  const series = emaArray(adjusted, period);
  return { value: series[series.length - 1] ?? 0, series };
}

/** Triangular Moving Average — double-smoothed SMA for extra smoothness */
export function triangularMa(data: number[], period: number): MovingAverageResult {
  const halfPeriod = Math.ceil((period + 1) / 2);
  const sma1 = sma(data, halfPeriod);
  const validValues = sma1.series.filter((v) => !Number.isNaN(v));
  const sma2 = sma(validValues, halfPeriod);
  return { value: sma2.value, series: sma2.series };
}
