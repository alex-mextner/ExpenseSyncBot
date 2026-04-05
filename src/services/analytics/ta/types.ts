/** Type definitions for technical analysis methods applied to personal budget forecasting */

// ═══════════════════════════════════════════════════════════════
// Moving Averages
// ═══════════════════════════════════════════════════════════════

export interface MovingAverageResult {
  /** Current smoothed value */
  value: number;
  /** Full series of smoothed values (same length as input when possible) */
  series: number[];
}

export interface KamaResult extends MovingAverageResult {
  /** Efficiency ratio (0 = choppy, 1 = trending) */
  efficiencyRatio: number;
}

// ═══════════════════════════════════════════════════════════════
// Volatility
// ═══════════════════════════════════════════════════════════════

export interface BollingerBandsResult {
  upper: number;
  middle: number;
  lower: number;
  /** Bandwidth: (upper - lower) / middle — squeeze detection */
  bandwidth: number;
  /** %B: (value - lower) / (upper - lower) — position within bands */
  percentB: number;
}

export interface ChannelResult {
  upper: number;
  middle: number;
  lower: number;
}

export interface DonchianResult {
  upper: number;
  lower: number;
  middle: number;
  /** True if latest value is a new high */
  isBreakoutHigh: boolean;
  /** True if latest value is a new low */
  isBreakoutLow: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Anomaly Detection
// ═══════════════════════════════════════════════════════════════

export interface ZScoreResult {
  zScore: number;
  isAnomaly: boolean;
  /** 'high' if above threshold, 'low' if below, null if normal */
  direction: 'high' | 'low' | null;
}

export interface IqrResult {
  q1: number;
  q3: number;
  iqr: number;
  lowerBound: number;
  upperBound: number;
  isOutlier: boolean;
}

export interface GrubbsResult {
  /** The suspected outlier value */
  outlier: number;
  /** Grubbs test statistic */
  statistic: number;
  /** Whether it exceeds the critical value */
  isSignificant: boolean;
}

export interface DixonResult {
  /** The suspected outlier value */
  outlier: number;
  /** Dixon Q ratio */
  qRatio: number;
  /** Whether it exceeds the critical threshold */
  isSignificant: boolean;
}

export interface HampelResult {
  /** Cleaned series with outliers replaced by median */
  cleaned: number[];
  /** Indices of detected outliers */
  outlierIndices: number[];
}

// ═══════════════════════════════════════════════════════════════
// Trend Analysis
// ═══════════════════════════════════════════════════════════════

export interface LinearRegressionResult {
  slope: number;
  intercept: number;
  /** Coefficient of determination (0-1, how well line fits) */
  r2: number;
  /** Predicted next value */
  forecast: number;
  /** Monthly change in absolute units */
  monthlyChange: number;
}

export interface CusumResult {
  /** Cumulative sum values */
  values: number[];
  /** Whether a shift has been detected (last value exceeds threshold) */
  shiftDetected: boolean;
  /** Index where shift was first detected, or -1 */
  shiftIndex: number;
}

export interface RsiResult {
  /** RSI value 0-100 */
  value: number;
  /** 'overbought' (>70), 'oversold' (<30), 'neutral' */
  signal: 'overbought' | 'oversold' | 'neutral';
}

export interface MacdResult {
  /** MACD line (fast EMA - slow EMA) */
  macd: number;
  /** Signal line (EMA of MACD) */
  signal: number;
  /** Histogram (MACD - signal) */
  histogram: number;
  /** Crossover direction: bullish (MACD crosses above signal), bearish, or none */
  crossover: 'bullish' | 'bearish' | 'none';
}

export interface ChangePointResult {
  /** Detected change point indices */
  changePoints: number[];
  /** Segments with their mean levels */
  segments: Array<{ start: number; end: number; mean: number }>;
}

export interface EwmaControlResult {
  /** EWMA value */
  value: number;
  /** Upper control limit */
  ucl: number;
  /** Lower control limit */
  lcl: number;
  /** Whether current value is out of control */
  outOfControl: boolean;
}

// ═══════════════════════════════════════════════════════════════
// Forecasting
// ═══════════════════════════════════════════════════════════════

export interface HoltWintersResult {
  /** Forecast for next period */
  forecast: number;
  /** Level component */
  level: number;
  /** Trend component */
  trend: number;
  /** Seasonal factors (length = seasonalPeriod) */
  seasonal: number[];
}

export interface HoltResult {
  /** Forecast for next period */
  forecast: number;
  level: number;
  trend: number;
}

export interface QuantileResult {
  p50: number;
  p75: number;
  p90: number;
  p95: number;
}

export interface CrostonResult {
  /** Expected amount per period (accounting for intermittency) */
  forecast: number;
  /** Expected non-zero amount */
  expectedAmount: number;
  /** Expected interval between non-zero periods */
  expectedInterval: number;
}

export interface ThetaResult {
  /** Forecast for next period */
  forecast: number;
}

export interface KnnResult {
  /** Forecast based on K nearest neighbors */
  forecast: number;
  /** Indices of the K nearest neighbors used */
  neighborIndices: number[];
}

// ═══════════════════════════════════════════════════════════════
// Pattern Detection
// ═══════════════════════════════════════════════════════════════

export interface StlResult {
  trend: number[];
  seasonal: number[];
  residual: number[];
}

export interface DayOfMonthProfile {
  /** Cumulative percentage of monthly spending by day (index 0 = day 1) */
  cumulativeProfile: number[];
  /** Expected percentage spent by given day */
  expectedByDay: (day: number) => number;
}

export interface PercentileBands {
  p10: number;
  p25: number;
  p50: number;
  p75: number;
  p90: number;
}

export interface CorrelationResult {
  /** Category pair */
  category1: string;
  category2: string;
  /** Pearson correlation coefficient (-1 to 1) */
  correlation: number;
  /** Strength interpretation */
  strength:
    | 'strong_positive'
    | 'moderate_positive'
    | 'weak'
    | 'moderate_negative'
    | 'strong_negative';
}

export interface HurstResult {
  /** Hurst exponent (0-1) */
  value: number;
  /** Interpretation */
  type: 'trending' | 'random_walk' | 'mean_reverting';
}

export interface PivotPointResult {
  pivot: number;
  resistance1: number;
  resistance2: number;
  support1: number;
  support2: number;
}

export interface LoessPoint {
  x: number;
  y: number;
}

// ═══════════════════════════════════════════════════════════════
// Qualitative Backtest
// ═══════════════════════════════════════════════════════════════

export interface QualitativeMetrics {
  /** Actionability: % of alerts where user has time to act (>5 days remaining) */
  actionabilityRate: number;
  /** Weighted TP score: earlier correct alerts score higher */
  timelinessScore: number;
  /** Alert density: avg alerts per category per month (lower = less noise) */
  alertDensity: number;
  /** Severity accuracy: % of alerts where severity matches actual outcome */
  severityAccuracy: number;
  /** Category noise: categories where >50% alerts are FP */
  noisyCategories: string[];
  /** Signal quality: combined metric (0-1, higher = better) */
  signalQuality: number;
}
