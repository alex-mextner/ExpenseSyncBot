/**
 * High-level TA analyzer: runs all applicable methods on a category's monthly spending history
 * and returns a unified analysis result. This is the main integration point for SpendingAnalytics.
 */

import { iqrMethod, modifiedZScore, zScore } from './anomaly';
import { croston, holt, holtWinters, medianForecast, quantileForecast, theta } from './forecasting';
import { kama, sma, wma } from './moving-averages';
import { hurstExponent, percentileBands, pivotPoints } from './pattern';
import {
  changePointDetection,
  cusum,
  ewmaControl,
  linearRegression,
  macd,
  momentum,
  roc,
  rsi,
} from './trend';
import type {
  BollingerBandsResult,
  ChannelResult,
  CrostonResult,
  CusumResult,
  DonchianResult,
  HoltResult,
  HoltWintersResult,
  HurstResult,
  IqrResult,
  LinearRegressionResult,
  MacdResult,
  PercentileBands,
  PivotPointResult,
  QuantileResult,
  RsiResult,
  ThetaResult,
  ZScoreResult,
} from './types';
import {
  atr,
  bollingerBands,
  donchianChannels,
  historicalVolatility,
  keltnerChannels,
  maEnvelopes,
} from './volatility';

/** Comprehensive TA analysis result for a single category */
export interface CategoryTaAnalysis {
  category: string;
  monthsOfData: number;
  /** Current month's actual spending so far (EUR) */
  currentMonthSpent: number;

  // Forecasting (multiple methods for ensemble)
  forecasts: {
    sma3: number;
    wma3: number;
    kama: number;
    median: number;
    holt: HoltResult;
    theta: ThetaResult;
    quantiles: QuantileResult;
    /** Croston — only meaningful for intermittent categories */
    croston: CrostonResult | null;
    /** Holt-Winters — only with 24+ months of data */
    holtWinters: HoltWintersResult | null;
    /** Ensemble: weighted average of applicable forecasts */
    ensemble: number;
  };

  // Volatility
  volatility: {
    bollingerBands: BollingerBandsResult;
    atr: number;
    keltner: ChannelResult;
    donchian: DonchianResult;
    historicalVol: number;
    maEnvelopes: ChannelResult;
    percentiles: PercentileBands;
  };

  // Anomaly (for current month's spending)
  anomaly: {
    zScore: ZScoreResult;
    modifiedZScore: ZScoreResult;
    iqr: IqrResult;
    /** Is current spending anomalous by any method? */
    isAnomaly: boolean;
    /** How many methods flag it as anomalous (0-3) */
    anomalyCount: number;
  };

  // Trend
  trend: {
    regression: LinearRegressionResult;
    cusum: CusumResult;
    rsi: RsiResult;
    macd: MacdResult;
    roc1: number;
    roc3: number;
    momentum3: number;
    ewmaControl: { outOfControl: boolean; value: number };
    changePoints: number[];
    hurst: HurstResult;
    pivotPoints: PivotPointResult;
    /** Summary: is spending trending up, down, or stable? */
    direction: 'rising' | 'falling' | 'stable';
    /** Trend confidence based on how many indicators agree */
    confidence: number;
  };
}

/** Options for category analysis */
interface AnalyzeOptions {
  /** Current month's spending so far (for anomaly detection) */
  currentMonthSpent?: number;
  /** Seasonal period for Holt-Winters (default 12) */
  seasonalPeriod?: number;
}

/**
 * Run full TA analysis on a single category's monthly spending history.
 * @param category Category name
 * @param monthlyTotals Array of monthly spending totals (chronological, oldest first)
 * @param options Additional parameters
 */
export function analyzeCategory(
  category: string,
  monthlyTotals: number[],
  options: AnalyzeOptions = {},
): CategoryTaAnalysis {
  const data = monthlyTotals;
  const n = data.length;
  const currentSpent = options.currentMonthSpent ?? data[n - 1] ?? 0;
  const seasonalPeriod = options.seasonalPeriod ?? 12;

  // === Forecasting ===
  const sma3 = sma(data, Math.min(3, n)).value;
  const wma3 = wma(data, Math.min(3, n)).value;
  const kamaResult = kama(data, Math.min(10, n));
  const medianVal = medianForecast(data, Math.min(6, n));
  const holtResult = holt(data);
  const thetaResult = theta(data);
  const quantiles = quantileForecast(data);

  // Croston only for intermittent data (>30% zero months)
  const zeroMonths = data.filter((v) => v === 0).length;
  const crostonResult = zeroMonths > n * 0.3 ? croston(data) : null;

  // Holt-Winters only with enough seasonal data
  const hwResult = n >= seasonalPeriod * 2 ? holtWinters(data, seasonalPeriod) : null;

  // Ensemble forecast: weighted average of available methods
  const forecastValues = [
    sma3,
    wma3,
    kamaResult.value,
    medianVal,
    holtResult.forecast,
    thetaResult.forecast,
  ];
  if (hwResult) forecastValues.push(hwResult.forecast);
  if (crostonResult) forecastValues.push(crostonResult.forecast);

  // Remove extreme outliers from ensemble (trim top/bottom 20%)
  const sortedForecasts = [...forecastValues].sort((a, b) => a - b);
  const trimCount = Math.floor(sortedForecasts.length * 0.2);
  const trimmed = sortedForecasts.slice(trimCount, sortedForecasts.length - trimCount);
  const ensemble = trimmed.length > 0 ? trimmed.reduce((s, v) => s + v, 0) / trimmed.length : sma3;

  // === Volatility ===
  const bb = bollingerBands(data, Math.min(6, n));
  const atrVal = atr(data, Math.min(6, n));
  const keltner = keltnerChannels(data, Math.min(6, n), Math.min(6, n));
  const donchian = donchianChannels(data, Math.min(6, n));
  const histVol = historicalVolatility(data, Math.min(6, n));
  const envelopes = maEnvelopes(data, Math.min(6, n));
  const pctBands = percentileBands(data);

  // === Anomaly (current month vs history) ===
  const zScoreResult = zScore(currentSpent, data);
  const modZScore = modifiedZScore(currentSpent, data);
  const iqrResult = iqrMethod(currentSpent, data);
  const anomalyCount = [zScoreResult.isAnomaly, modZScore.isAnomaly, iqrResult.isOutlier].filter(
    Boolean,
  ).length;

  // === Trend ===
  const regression = linearRegression(data);
  const cusumResult = cusum(data);
  const rsiResult = rsi(data, Math.min(6, n));
  const macdResult = macd(data);
  const roc1 = roc(data, 1);
  const roc3 = roc(data, Math.min(3, n - 1));
  const mom3 = momentum(data, Math.min(3, n - 1));
  const ewma = ewmaControl(data);
  const cpResult = changePointDetection(data);
  const hurst = hurstExponent(data);
  const pivot = pivotPoints(data, Math.min(6, n));

  // Trend direction consensus
  let upSignals = 0;
  let downSignals = 0;
  if (regression.slope > 0) upSignals++;
  else if (regression.slope < 0) downSignals++;
  if (rsiResult.signal === 'overbought') upSignals++;
  else if (rsiResult.signal === 'oversold') downSignals++;
  if (macdResult.crossover === 'bullish') upSignals++;
  else if (macdResult.crossover === 'bearish') downSignals++;
  if (roc1 > 10) upSignals++;
  else if (roc1 < -10) downSignals++;
  if (hurst.type === 'trending' && regression.slope > 0) upSignals++;
  else if (hurst.type === 'trending' && regression.slope < 0) downSignals++;

  const totalSignals = upSignals + downSignals;
  const direction =
    upSignals > downSignals + 1 ? 'rising' : downSignals > upSignals + 1 ? 'falling' : 'stable';
  const confidence = totalSignals > 0 ? Math.max(upSignals, downSignals) / totalSignals : 0;

  return {
    category,
    monthsOfData: n,
    currentMonthSpent: currentSpent,
    forecasts: {
      sma3,
      wma3,
      kama: kamaResult.value,
      median: medianVal,
      holt: holtResult,
      theta: thetaResult,
      quantiles,
      croston: crostonResult,
      holtWinters: hwResult,
      ensemble,
    },
    volatility: {
      bollingerBands: bb,
      atr: atrVal,
      keltner,
      donchian,
      historicalVol: histVol,
      maEnvelopes: envelopes,
      percentiles: pctBands,
    },
    anomaly: {
      zScore: zScoreResult,
      modifiedZScore: modZScore,
      iqr: iqrResult,
      isAnomaly: anomalyCount >= 2,
      anomalyCount,
    },
    trend: {
      regression,
      cusum: cusumResult,
      rsi: rsiResult,
      macd: macdResult,
      roc1,
      roc3,
      momentum3: mom3,
      ewmaControl: { outOfControl: ewma.outOfControl, value: ewma.value },
      changePoints: cpResult.changePoints,
      hurst,
      pivotPoints: pivot,
      direction,
      confidence,
    },
  };
}
