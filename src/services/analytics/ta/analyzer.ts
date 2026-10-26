/**
 * High-level TA analyzer: runs all applicable methods on a category's monthly spending history
 * and returns a unified analysis result. This is the main integration point for SpendingAnalytics.
 */

import { iqrMethod, modifiedZScore, zScore } from './anomaly';
import {
  croston,
  crostonTSB,
  holt,
  holtWinters,
  medianForecast,
  quantileForecast,
  theta,
} from './forecasting';
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

type Forecasts = CategoryTaAnalysis['forecasts'];
type Volatility = CategoryTaAnalysis['volatility'];
type Anomaly = CategoryTaAnalysis['anomaly'];
type Trend = CategoryTaAnalysis['trend'];

/**
 * Croston/TSB for intermittent data (>30% zero months).
 * TSB handles fading demand better — use it when the last observation is zero.
 */
function intermittentForecast(data: number[]): CrostonResult | null {
  const n = data.length;
  const zeroMonths = data.filter((v) => v === 0).length;
  const isIntermittent = zeroMonths > n * 0.3;
  if (!isIntermittent) return null;
  const lastIsZero = (data[n - 1] ?? 0) === 0;
  return lastIsZero ? crostonTSB(data) : croston(data);
}

/**
 * Ensemble forecast: mean of the individual forecasts after trimming the top/bottom 20%
 * so a single extreme method cannot dominate.
 */
function trimmedEnsemble(forecastValues: number[], fallback: number): number {
  const sortedForecasts = [...forecastValues].sort((a, b) => a - b);
  const trimCount = Math.floor(sortedForecasts.length * 0.2);
  const trimmed = sortedForecasts.slice(trimCount, sortedForecasts.length - trimCount);
  return trimmed.length > 0 ? trimmed.reduce((s, v) => s + v, 0) / trimmed.length : fallback;
}

function analyzeForecasts(data: number[], seasonalPeriod: number): Forecasts {
  const n = data.length;
  const sma3 = sma(data, Math.min(3, n)).value;
  const wma3 = wma(data, Math.min(3, n)).value;
  const kamaResult = kama(data, Math.min(10, n));
  const medianVal = medianForecast(data, Math.min(6, n));
  const holtResult = holt(data);
  const thetaResult = theta(data);
  const quantiles = quantileForecast(data);
  const crostonResult = intermittentForecast(data);

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

  return {
    sma3,
    wma3,
    kama: kamaResult.value,
    median: medianVal,
    holt: holtResult,
    theta: thetaResult,
    quantiles,
    croston: crostonResult,
    holtWinters: hwResult,
    ensemble: trimmedEnsemble(forecastValues, sma3),
  };
}

function analyzeVolatility(data: number[]): Volatility {
  const window = Math.min(6, data.length);
  return {
    bollingerBands: bollingerBands(data, window),
    atr: atr(data, window),
    keltner: keltnerChannels(data, window, window),
    donchian: donchianChannels(data, window),
    historicalVol: historicalVolatility(data, window),
    maEnvelopes: maEnvelopes(data, window),
    percentiles: percentileBands(data),
  };
}

/** Anomaly detection: current month vs history; flagged when at least two methods agree. */
function analyzeAnomaly(currentSpent: number, data: number[]): Anomaly {
  const zScoreResult = zScore(currentSpent, data);
  const modZScore = modifiedZScore(currentSpent, data);
  const iqrResult = iqrMethod(currentSpent, data);
  const anomalyCount = [zScoreResult.isAnomaly, modZScore.isAnomaly, iqrResult.isOutlier].filter(
    Boolean,
  ).length;
  return {
    zScore: zScoreResult,
    modifiedZScore: modZScore,
    iqr: iqrResult,
    isAnomaly: anomalyCount >= 2,
    anomalyCount,
  };
}

type SignalVote = 'up' | 'down' | 'none';

function vote(isUp: boolean, isDown: boolean): SignalVote {
  if (isUp) return 'up';
  if (isDown) return 'down';
  return 'none';
}

interface TrendIndicators {
  regression: LinearRegressionResult;
  rsiResult: RsiResult;
  macdResult: MacdResult;
  roc1: number;
  hurst: HurstResult;
}

/** Direction consensus: each indicator votes up/down; direction needs a margin of 2 votes. */
function trendConsensus(indicators: TrendIndicators): {
  direction: Trend['direction'];
  confidence: number;
} {
  const { regression, rsiResult, macdResult, roc1, hurst } = indicators;
  const isTrending = hurst.type === 'trending';
  const votes: SignalVote[] = [
    vote(regression.slope > 0, regression.slope < 0),
    vote(rsiResult.signal === 'overbought', rsiResult.signal === 'oversold'),
    vote(macdResult.crossover === 'bullish', macdResult.crossover === 'bearish'),
    vote(roc1 > 10, roc1 < -10),
    vote(isTrending && regression.slope > 0, isTrending && regression.slope < 0),
  ];
  const upSignals = votes.filter((v) => v === 'up').length;
  const downSignals = votes.filter((v) => v === 'down').length;

  const totalSignals = upSignals + downSignals;
  let direction: Trend['direction'] = 'stable';
  if (upSignals > downSignals + 1) direction = 'rising';
  else if (downSignals > upSignals + 1) direction = 'falling';
  const confidence = totalSignals > 0 ? Math.max(upSignals, downSignals) / totalSignals : 0;
  return { direction, confidence };
}

function analyzeTrend(data: number[]): Trend {
  const n = data.length;
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
  const { direction, confidence } = trendConsensus({
    regression,
    rsiResult,
    macdResult,
    roc1,
    hurst,
  });

  return {
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
  };
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

  return {
    category,
    monthsOfData: n,
    currentMonthSpent: currentSpent,
    forecasts: analyzeForecasts(data, seasonalPeriod),
    volatility: analyzeVolatility(data),
    anomaly: analyzeAnomaly(currentSpent, data),
    trend: analyzeTrend(data),
  };
}
