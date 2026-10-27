/**
 * Alert model and qualitative-metric computation for scripts/backtest-qualitative.ts.
 *
 * Holds the pure pieces: severity classification, bootstrap ranges, alert types and
 * the signal-quality metrics computed from a list of simulated alerts.
 */

import type { QualitativeMetrics } from '../../src/services/analytics/ta/types';

export const DAYS_PER_MONTH = 30;

export interface CategoryConfig {
  name: string;
  monthlyAvg: number;
  monthlyStddev: number;
  avgTxPerMonth: number;
  budget: number;
}

// ═══════════════════════════════════════════════════════════════
// Alert types and severity classification
// ═══════════════════════════════════════════════════════════════

export type Severity = 'none' | 'warning' | 'critical' | 'exceeded';
export type AlertKind =
  | 'factual'
  | 'prognostic'
  | 'no_budget'
  | 'norm_anomaly'
  | 'velocity_spike'
  | 'ta_anomaly'
  | 'ta_trend_change';

export const SEVERITY_ORDER: Record<Severity, number> = { none: 0, warning: 1, critical: 2, exceeded: 3 };

export interface Alert {
  month: number;
  day: number;
  category: string;
  severity: Severity;
  kind: AlertKind;
  projected: number;
  budget: number;
  actualMonthEnd: number;
  daysRemaining: number;
  wasCorrect: boolean;
  overshootPercent: number;
  confidenceRange?: { low: number; high: number };
}

/** Bootstrap prediction interval via deterministic resampling of monthly totals */
export function bootstrapRange(monthlyTotals: number[], iterations = 200): { low: number; high: number } {
  let seed = monthlyTotals.reduce((s, v) => s + Math.round(v * 100), 0);
  const rand = () => {
    seed = (seed * 1664525 + 1013904223) & 0x7fffffff;
    return seed / 0x7fffffff;
  };

  const forecasts: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const sample = Array.from({ length: monthlyTotals.length }, () =>
      monthlyTotals[Math.floor(rand() * monthlyTotals.length)]!,
    );
    forecasts.push(sample.reduce((s, v) => s + v, 0) / sample.length);
  }
  forecasts.sort((a, b) => a - b);
  return {
    low: Math.round(forecasts[Math.floor(iterations * 0.1)]!),
    high: Math.round(forecasts[Math.floor(iterations * 0.9)]!),
  };
}

/** Old: static thresholds (0.85 warning, 1.0 critical) */
export function classifySeverity(spent: number, projected: number, budget: number): Severity {
  if (spent >= budget) return 'exceeded';
  if (projected > budget) return 'critical';
  if (projected > budget * 0.85) return 'warning';
  return 'none';
}

/** Hybrid: dynamic CV-based warning threshold */
export function classifySeverityDynamic(spent: number, projected: number, budget: number, cv: number): Severity {
  if (spent >= budget) return 'exceeded';
  if (projected > budget) return 'critical';
  const warningThreshold = 0.85 + 0.1 * Math.min(1, cv);
  if (projected > budget * warningThreshold) return 'warning';
  return 'none';
}

function actualSeverity(actual: number, budget: number): Severity {
  if (actual >= budget * 1.15) return 'exceeded';
  if (actual >= budget) return 'critical';
  if (actual >= budget * 0.85) return 'warning';
  return 'none';
}

/** Old: naive linear projection (no improvements) */
export function oldProjection(currentSpent: number, daysElapsed: number, daysInMonth: number): number {
  if (daysElapsed <= 0) return 0;
  return (currentSpent / daysElapsed) * daysInMonth;
}

// ═══════════════════════════════════════════════════════════════
// Qualitative metrics (extended with factual/prognostic split)
// ═══════════════════════════════════════════════════════════════

export interface ExtendedMetrics extends QualitativeMetrics {
  prognosticPrecision: number;
  fpPenalty: number;
  alertDaysPerMonth: number;
  usefulAlertRate: number;
  factualCount: number;
  prognosticCount: number;
  noBudgetCount: number;
  rangeCoverage: number;
}

/** Alert kinds that are informational and excluded from prognostic precision calculation */
const INFORMATIONAL_KINDS: AlertKind[] = ['no_budget', 'norm_anomaly', 'velocity_spike', 'ta_anomaly', 'ta_trend_change'];

/** Deduplicate by category-month (first alert per cat-month) */
export function dedupeByCategoryMonth(alerts: Alert[]): Alert[] {
  const unique = new Map<string, Alert>();
  for (const a of alerts) {
    const key = `${a.month}:${a.category}`;
    if (!unique.has(key)) unique.set(key, a);
  }
  return [...unique.values()];
}

/**
 * Only critical/exceeded prognostic = real prediction. Warning = info, not prediction.
 * Exclude day ≤ 5 alerts — linear extrapolation of 1-2 tx with 6x multiplier is noise, not prediction.
 */
function selectPrognosticAlerts(alerts: Alert[]): Alert[] {
  return alerts.filter(
    (a) => a.kind === 'prognostic' && (a.severity === 'critical' || a.severity === 'exceeded') && a.day > 5,
  );
}

/** Full credit for matching severity, half credit for adjacent severities */
function severityMatchScore(severity: Severity, actual: Severity): number {
  if (severity === actual) return 1;
  const adjacent =
    (severity === 'warning' && actual === 'critical') ||
    (severity === 'critical' && actual === 'warning') ||
    (severity === 'critical' && actual === 'exceeded') ||
    (severity === 'exceeded' && actual === 'critical');
  return adjacent ? 0.5 : 0;
}

function computeSeverityAccuracy(deduped: Alert[]): number {
  let severityMatches = 0;
  for (const a of deduped) {
    severityMatches += severityMatchScore(a.severity, actualSeverity(a.actualMonthEnd, a.budget));
  }
  return deduped.length > 0 ? severityMatches / deduped.length : 1;
}

/** Categories where more than half of (>=2) prognostic alerts were false positives */
function findNoisyCategories(progDeduped: Alert[]): string[] {
  const byCat = new Map<string, { tp: number; fp: number }>();
  for (const a of progDeduped) {
    const entry = byCat.get(a.category) ?? { tp: 0, fp: 0 };
    if (a.wasCorrect) entry.tp++;
    else entry.fp++;
    byCat.set(a.category, entry);
  }
  const noisyCategories: string[] = [];
  for (const [cat, counts] of byCat) {
    const total = counts.tp + counts.fp;
    if (total >= 2 && counts.fp / total > 0.5) noisyCategories.push(cat);
  }
  return noisyCategories;
}

/** Share of months that had at least one non-no_budget alert */
function computeAlertDaysPerMonth(alerts: Alert[], totalMonths: number): number {
  const monthsWithAlerts = new Set<number>();
  for (const a of alerts) {
    if (a.kind !== 'no_budget') monthsWithAlerts.add(a.month);
  }
  return totalMonths > 0 ? monthsWithAlerts.size / totalMonths : 0;
}

/** Alert fatigue penalty: >5 alerts/month = fatigue, users stop reading */
function computeFatiguePenalty(alerts: Alert[], totalMonths: number): number {
  const informationalCount = alerts.filter((a) => INFORMATIONAL_KINDS.includes(a.kind)).length;
  const alertsPerMonth = totalMonths > 0 ? (alerts.length - informationalCount) / totalMonths : 0;
  return Math.max(0, 1 - alertsPerMonth / 10);
}

/** Range coverage: % of prognostic TP alerts whose confidence range covered the actual */
function computeRangeCoverage(progTPs: Alert[]): number {
  const progTPsWithRange = progTPs.filter((a) => a.confidenceRange);
  const coveredByRange = progTPsWithRange.filter(
    (a) => a.actualMonthEnd >= a.confidenceRange!.low && a.actualMonthEnd <= a.confidenceRange!.high,
  );
  return progTPsWithRange.length > 0 ? coveredByRange.length / progTPsWithRange.length : 0;
}

/** Useful alert rate: prognostic + daysRemaining > 5 */
function computeUsefulAlertRate(alerts: Alert[], prognosticAlerts: Alert[]): number {
  const nonNoBudget = alerts.filter((a) => a.kind !== 'no_budget');
  const usefulAlerts = prognosticAlerts.filter((a) => a.daysRemaining > 5);
  return nonNoBudget.length > 0 ? usefulAlerts.length / nonNoBudget.length : 0;
}

interface SignalQualityInputs {
  prognosticPrecision: number;
  actionabilityRate: number;
  timelinessScore: number;
  fpPenalty: number;
  severityAccuracy: number;
  alertDensity: number;
  fatiguePenalty: number;
}

/** Signal quality composite */
function computeSignalQuality(inputs: SignalQualityInputs): number {
  const densityPenalty = Math.max(0, 1 - inputs.alertDensity * 2);
  return (
    0.25 * inputs.prognosticPrecision +
    0.15 * inputs.actionabilityRate +
    0.1 * inputs.timelinessScore +
    0.15 * inputs.fpPenalty +
    0.1 * inputs.severityAccuracy +
    0.1 * densityPenalty +
    0.15 * inputs.fatiguePenalty
  );
}

export function computeQualitativeMetrics(
  alerts: Alert[],
  totalCategoryMonths: number,
  totalMonths: number,
): ExtendedMetrics {
  const factualAlerts = alerts.filter((a) => a.kind === 'factual');
  const prognosticAlerts = selectPrognosticAlerts(alerts);
  const noBudgetAlerts = alerts.filter((a) => a.kind === 'no_budget');
  const deduped = dedupeByCategoryMonth(alerts.filter((a) => !INFORMATIONAL_KINDS.includes(a.kind)));

  // Prognostic precision
  const progDeduped = dedupeByCategoryMonth(prognosticAlerts);
  const progTPs = progDeduped.filter((a) => a.wasCorrect);
  const progFPs = progDeduped.filter((a) => !a.wasCorrect);
  const prognosticPrecision = progDeduped.length > 0 ? progTPs.length / progDeduped.length : 0.5;

  // Actionability: only prognostic TPs with enough time to react
  const actionableProgTPs = progTPs.filter((a) => a.daysRemaining > 5);
  const actionabilityRate = progTPs.length > 0 ? actionableProgTPs.length / progTPs.length : 1;

  // Timeliness: earlier correct prognostic alerts score higher (only prognostic TPs)
  const timelinessScore =
    progTPs.length > 0 ? progTPs.reduce((s, a) => s + a.daysRemaining / DAYS_PER_MONTH, 0) / progTPs.length : 0;

  // FP penalty: penalize if >10% of category-months have false positive prognoses
  const fpPenalty = Math.max(0, 1 - progFPs.length / Math.max(1, totalCategoryMonths * 0.1));

  const alertDensity = totalCategoryMonths > 0 ? deduped.length / totalCategoryMonths : 0;
  const severityAccuracy = computeSeverityAccuracy(deduped);

  const signalQuality = computeSignalQuality({
    prognosticPrecision,
    actionabilityRate,
    timelinessScore,
    fpPenalty,
    severityAccuracy,
    alertDensity,
    fatiguePenalty: computeFatiguePenalty(alerts, totalMonths),
  });

  return {
    actionabilityRate,
    timelinessScore,
    alertDensity,
    severityAccuracy,
    noisyCategories: findNoisyCategories(progDeduped),
    signalQuality,
    prognosticPrecision,
    fpPenalty,
    alertDaysPerMonth: computeAlertDaysPerMonth(alerts, totalMonths),
    usefulAlertRate: computeUsefulAlertRate(alerts, prognosticAlerts),
    factualCount: factualAlerts.length,
    prognosticCount: prognosticAlerts.length,
    noBudgetCount: noBudgetAlerts.length,
    rangeCoverage: computeRangeCoverage(progTPs),
  };
}
