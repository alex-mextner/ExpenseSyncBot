/**
 * Qualitative backtest: measures actionability, timeliness, signal/noise quality,
 * severity accuracy, and alert density for old (raw production) vs hybrid (all improvements).
 *
 * Old algorithm = raw production behavior:
 *   - Fires EVERY checkpoint when status is warning/critical/exceeded (no escalation)
 *   - Static thresholds (0.85 warning, 1.0 critical)
 *   - Naive linear projection always
 *
 * Hybrid = ALL improvements:
 *   - Activity gate (min 3 tx)
 *   - Severity-only escalation (fires only if severity INCREASES)
 *   - Dynamic CV-based warning threshold
 *   - Syntetos-Boylan demand classification routing
 *   - TSB fading demand for intermittent categories
 *   - Weighted ensemble when TA history available
 *   - Cumulative spending profiles for stable categories
 *
 * Alerts split into FACTUAL and PROGNOSTIC with separate metrics.
 *
 * Run: bun scripts/backtest-qualitative.ts
 *      bun scripts/backtest-qualitative.ts --real --group-id=1 --db=path/to/expenses.db
 */

import { Database } from 'bun:sqlite';
import type { QualitativeMetrics } from '../src/services/analytics/ta/types';

// ═══════════════════════════════════════════════════════════════
// Inlined projection functions (avoid env var dependency)
// ═══════════════════════════════════════════════════════════════

interface CategoryProfile {
  ema: number;
  cv: number;
  monthsOfData: number;
  avgTxPerMonth: number;
  zeroMonthRatio: number;
}

interface IntervalProfile {
  avgInterval: number;
  intervalCv: number;
  avgAmount: number;
  isStable: boolean;
}

function buildCategoryProfiles(
  historyRows: { category: string; month: string; monthly_total: number; tx_count: number }[],
): Map<string, CategoryProfile> {
  const byCategory = new Map<string, { totals: number[]; txCounts: number[] }>();
  for (const row of historyRows) {
    let entry = byCategory.get(row.category);
    if (!entry) {
      entry = { totals: [], txCounts: [] };
      byCategory.set(row.category, entry);
    }
    entry.totals.push(row.monthly_total);
    entry.txCounts.push(row.tx_count);
  }

  const profiles = new Map<string, CategoryProfile>();
  for (const [category, { totals, txCounts }] of byCategory) {
    const n = totals.length;
    if (n === 0) continue;
    const alpha = 2 / (n + 1);
    let ema = totals[0] ?? 0;
    for (let i = 1; i < n; i++) {
      ema = alpha * (totals[i] ?? 0) + (1 - alpha) * ema;
    }
    const mean = totals.reduce((s, v) => s + v, 0) / n;
    const variance = totals.reduce((s, v) => s + (v - mean) ** 2, 0) / n;
    const stddev = Math.sqrt(variance);
    const cv = mean > 0 ? stddev / mean : 0;
    const totalTx = txCounts.reduce((s, v) => s + v, 0);
    const zeroMonths = totals.filter((v) => v === 0).length;
    profiles.set(category, {
      ema: Math.round(ema * 100) / 100,
      cv: Math.round(cv * 1000) / 1000,
      monthsOfData: n,
      avgTxPerMonth: Math.round((totalTx / n) * 10) / 10,
      zeroMonthRatio: Math.round((zeroMonths / n) * 100) / 100,
    });
  }
  return profiles;
}

function passesActivityGate(
  txCount: number,
  daysElapsed: number,
  daysInMonth: number,
  profile: CategoryProfile | null,
): boolean {
  if (txCount === 0) return false;
  if (!profile) return txCount >= 2;
  if (profile.avgTxPerMonth < 5) return txCount >= 2;
  const monthProgress = daysElapsed / daysInMonth;
  const expectedTxSoFar = profile.avgTxPerMonth * monthProgress;
  return txCount >= Math.max(2, Math.ceil(expectedTxSoFar * 0.3));
}

type DemandPattern = 'smooth' | 'intermittent' | 'erratic' | 'lumpy';

function classifyDemandPattern(profile: CategoryProfile): DemandPattern {
  const adi = profile.zeroMonthRatio > 0 ? 1 / (1 - profile.zeroMonthRatio) : 1;
  const cv2 = profile.cv * profile.cv;
  if (adi >= 1.32 && cv2 >= 0.49) return 'lumpy';
  if (adi >= 1.32) return 'intermittent';
  if (cv2 >= 0.49) return 'erratic';
  return 'smooth';
}

// ═══════════════════════════════════════════════════════════════
// Cumulative spending profiles (day-of-month based)
// ═══════════════════════════════════════════════════════════════

interface CumulativeProfile {
  fractionsByDay: Map<number, number>;
  isStable: boolean;
}

const CHECK_DAYS = [5, 10, 15, 20, 25];

function buildCumulativeProfiles(
  expenses: DailyExpense[],
): Map<string, CumulativeProfile> {
  const profiles = new Map<string, CumulativeProfile>();

  const byCategory = new Map<string, DailyExpense[]>();
  for (const e of expenses) {
    const arr = byCategory.get(e.category) ?? [];
    arr.push(e);
    byCategory.set(e.category, arr);
  }

  for (const [category, catExpenses] of byCategory) {
    const monthFractions = new Map<number, number[]>();
    for (const cp of CHECK_DAYS) {
      monthFractions.set(cp, []);
    }

    const monthsWithData = new Set<number>();
    for (const e of catExpenses) monthsWithData.add(e.month);

    if (monthsWithData.size < 3) continue;

    for (const m of monthsWithData) {
      const mExpenses = catExpenses.filter((e) => e.month === m);
      const monthTotal = mExpenses.reduce((s, e) => s + e.amount, 0);
      if (monthTotal <= 0) continue;

      for (const cp of CHECK_DAYS) {
        const spentByDay = mExpenses
          .filter((e) => e.day <= cp)
          .reduce((s, e) => s + e.amount, 0);
        const fraction = spentByDay / monthTotal;
        monthFractions.get(cp)?.push(fraction);
      }
    }

    const fractionsByDay = new Map<number, number>();
    let stableCount = 0;

    for (const cp of CHECK_DAYS) {
      const fractions = monthFractions.get(cp) ?? [];
      if (fractions.length < 3) continue;

      const mean = fractions.reduce((s, v) => s + v, 0) / fractions.length;
      const variance = fractions.reduce((s, v) => s + (v - mean) ** 2, 0) / fractions.length;
      const cv = mean > 0 ? Math.sqrt(variance) / mean : 999;

      fractionsByDay.set(cp, mean);
      if (cv < 0.3) stableCount++;
    }

    const isStable = stableCount >= 3;
    profiles.set(category, { fractionsByDay, isStable });
  }

  return profiles;
}

// ═══════════════════════════════════════════════════════════════
// Interval-based cycle detection (refueling, salon, subscriptions)
// ═══════════════════════════════════════════════════════════════

/** Build interval profiles from synthetic expense data using absolute day numbers */
function buildIntervalProfilesFromExpenses(
  expenses: DailyExpense[],
  currentMonth: number,
  daysPerMonth: number,
): Map<string, IntervalProfile> {
  const profiles = new Map<string, IntervalProfile>();

  // Only use expenses BEFORE currentMonth (historical only)
  const historical = expenses.filter((e) => e.month < currentMonth);

  // Group by category
  const byCategory = new Map<string, DailyExpense[]>();
  for (const e of historical) {
    const arr = byCategory.get(e.category) ?? [];
    arr.push(e);
    byCategory.set(e.category, arr);
  }

  for (const [category, catExpenses] of byCategory) {
    catExpenses.sort((a, b) => (a.month * daysPerMonth + a.day) - (b.month * daysPerMonth + b.day));

    const intervals: number[] = [];
    for (let i = 1; i < catExpenses.length; i++) {
      const prev = catExpenses[i - 1]!;
      const curr = catExpenses[i]!;
      const days = (curr.month * daysPerMonth + curr.day) - (prev.month * daysPerMonth + prev.day);
      if (days <= 0 || days > 90) continue;
      intervals.push(days);
    }

    if (intervals.length < 3) continue;

    const amounts = catExpenses.map((e) => e.amount);
    const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    const variance = intervals.reduce((s, v) => s + (v - avgInterval) ** 2, 0) / intervals.length;
    const stddev = Math.sqrt(variance);
    const intervalCv = avgInterval > 0 ? stddev / avgInterval : 999;
    const avgAmount = amounts.reduce((s, v) => s + v, 0) / amounts.length;

    profiles.set(category, {
      avgInterval: Math.round(avgInterval * 100) / 100,
      intervalCv: Math.round(intervalCv * 1000) / 1000,
      avgAmount: Math.round(avgAmount * 100) / 100,
      isStable: intervalCv < 0.4 && avgInterval >= 5,
    });
  }

  return profiles;
}

// ═══════════════════════════════════════════════════════════════
// Hybrid projection with all improvements
// ═══════════════════════════════════════════════════════════════

function hybridProjection(
  currentSpent: number,
  daysElapsed: number,
  daysInMonth: number,
  profile: CategoryProfile | null,
  daysSinceLastTx?: number,
  intervalProfile?: IntervalProfile,
): number {
  if (daysElapsed <= 0) return currentSpent;

  // Stall detection: spending stopped, don't extrapolate
  const monthProgress = daysElapsed / daysInMonth;
  if (daysSinceLastTx !== undefined && daysSinceLastTx >= 5 && monthProgress > 0.33) {
    return currentSpent;
  }

  // Interval-based cycle projection: highest priority for periodic categories
  if (intervalProfile?.isStable) {
    const daysRemaining = daysInMonth - daysElapsed;
    const daysSinceLast = daysSinceLastTx ?? 0;
    const timeToNextFill = Math.max(0, intervalProfile.avgInterval - daysSinceLast);
    const expectedMoreFills = timeToNextFill <= daysRemaining
      ? 1 + Math.floor((daysRemaining - timeToNextFill) / intervalProfile.avgInterval)
      : 0;
    const projected = currentSpent + expectedMoreFills * intervalProfile.avgAmount;
    return Math.max(currentSpent, Math.round(projected * 100) / 100);
  }

  // Cumulative profile: used for norm anomaly detection, NOT for projection.
  // Division by small fractions amplifies noise and causes false alerts.

  if (!profile || profile.monthsOfData < 3) return currentSpent;

  const pattern = classifyDemandPattern(profile);

  if (pattern === 'lumpy') return currentSpent;

  if (pattern === 'intermittent') {
    let activityProb = 1 - profile.zeroMonthRatio;
    if (monthProgress > 0.3 && currentSpent < profile.ema * 0.1) {
      activityProb *= monthProgress;
    }
    const expectedTotal = profile.ema * activityProb;
    const paceBased = (currentSpent / daysElapsed) * daysInMonth;
    const alpha = monthProgress * monthProgress;
    const projected = alpha * paceBased + (1 - alpha) * Math.max(currentSpent, expectedTotal);
    return Math.max(currentSpent, Math.round(projected * 100) / 100);
  }

  const paceBased = (currentSpent / daysElapsed) * daysInMonth;

  if (pattern === 'erratic') {
    return Math.max(currentSpent, Math.round(paceBased * 100) / 100);
  }

  const alpha = Math.min(1, monthProgress * monthProgress * (1 + profile.cv));
  const historyBased = Math.max(currentSpent, profile.ema);
  return Math.round((alpha * paceBased + (1 - alpha) * historyBased) * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════
// Spending simulation
// ═══════════════════════════════════════════════════════════════

interface CategoryConfig {
  name: string;
  monthlyAvg: number;
  monthlyStddev: number;
  avgTxPerMonth: number;
  budget: number;
}

const SYNTH_CATEGORIES: CategoryConfig[] = [
  { name: 'Еда', monthlyAvg: 300, monthlyStddev: 40, avgTxPerMonth: 25, budget: 400 },
  { name: 'Транспорт', monthlyAvg: 80, monthlyStddev: 20, avgTxPerMonth: 15, budget: 120 },
  { name: 'Машина', monthlyAvg: 100, monthlyStddev: 30, avgTxPerMonth: 2, budget: 150 },
  { name: 'Подписки', monthlyAvg: 50, monthlyStddev: 5, avgTxPerMonth: 3, budget: 60 },
  { name: 'Развлечения', monthlyAvg: 120, monthlyStddev: 80, avgTxPerMonth: 4, budget: 200 },
  { name: 'Здоровье', monthlyAvg: 40, monthlyStddev: 50, avgTxPerMonth: 1, budget: 100 },
  { name: 'Кофе', monthlyAvg: 15, monthlyStddev: 10, avgTxPerMonth: 5, budget: 0 },
];

const SYNTH_MONTHS = 12;
const DAYS_PER_MONTH = 30;

interface DailyExpense {
  day: number;
  month: number;
  category: string;
  amount: number;
}

function generateSpendingData(seed: number): DailyExpense[] {
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const normalR = (mean: number, std: number) => {
    const u1 = rand();
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1 + 0.0001)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, mean + std * z);
  };

  const expenses: DailyExpense[] = [];
  for (let month = 0; month < SYNTH_MONTHS; month++) {
    for (const cat of SYNTH_CATEGORIES) {
      const monthlyTarget = normalR(cat.monthlyAvg, cat.monthlyStddev);
      const txCount = Math.max(1, Math.round(normalR(cat.avgTxPerMonth, cat.avgTxPerMonth * 0.3)));
      const amountPerTx = monthlyTarget / txCount;
      for (let i = 0; i < txCount; i++) {
        const day = Math.max(1, Math.min(DAYS_PER_MONTH, Math.ceil(rand() * DAYS_PER_MONTH)));
        const amount = Math.max(1, normalR(amountPerTx, amountPerTx * 0.3));
        expenses.push({ day, month, category: cat.name, amount: Math.round(amount * 100) / 100 });
      }
    }
  }
  return expenses;
}

// ═══════════════════════════════════════════════════════════════
// Alert types and severity classification
// ═══════════════════════════════════════════════════════════════

type Severity = 'none' | 'warning' | 'critical' | 'exceeded';
type AlertKind = 'factual' | 'prognostic' | 'no_budget' | 'norm_anomaly';

const SEVERITY_ORDER: Record<Severity, number> = { none: 0, warning: 1, critical: 2, exceeded: 3 };

interface Alert {
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
function bootstrapRange(monthlyTotals: number[], iterations = 200): { low: number; high: number } {
  let seed = monthlyTotals.reduce((s, v) => s + Math.round(v * 100), 0);
  const rand = () => { seed = (seed * 1664525 + 1013904223) & 0x7fffffff; return seed / 0x7fffffff; };

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
function classifySeverity(spent: number, projected: number, budget: number): Severity {
  if (spent >= budget) return 'exceeded';
  if (projected > budget) return 'critical';
  if (projected > budget * 0.85) return 'warning';
  return 'none';
}

/** Hybrid: dynamic CV-based warning threshold */
function classifySeverityDynamic(spent: number, projected: number, budget: number, cv: number): Severity {
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

// ═══════════════════════════════════════════════════════════════
// Old: naive linear projection (no improvements)
// ═══════════════════════════════════════════════════════════════

function oldProjection(currentSpent: number, daysElapsed: number, daysInMonth: number): number {
  if (daysElapsed <= 0) return 0;
  return (currentSpent / daysElapsed) * daysInMonth;
}

// ═══════════════════════════════════════════════════════════════
// Qualitative metrics (extended with factual/prognostic split)
// ═══════════════════════════════════════════════════════════════

interface ExtendedMetrics extends QualitativeMetrics {
  prognosticPrecision: number;
  fpPenalty: number;
  alertDaysPerMonth: number;
  usefulAlertRate: number;
  factualCount: number;
  prognosticCount: number;
  noBudgetCount: number;
  rangeCoverage: number;
}

function computeQualitativeMetrics(
  alerts: Alert[],
  totalCategoryMonths: number,
  totalMonths: number,
): ExtendedMetrics {
  // Separate by kind
  const factualAlerts = alerts.filter((a) => a.kind === 'factual');
  // Only critical/exceeded prognostic = real prediction. Warning = info, not prediction.
  // Exclude day ≤ 5 alerts — linear extrapolation of 1-2 tx with 6x multiplier is noise, not prediction.
  const prognosticAlerts = alerts.filter(
    (a) => a.kind === 'prognostic' && (a.severity === 'critical' || a.severity === 'exceeded') && a.day > 5,
  );
  const noBudgetAlerts = alerts.filter((a) => a.kind === 'no_budget');
  // Deduplicate by category-month (first alert per cat-month)
  const unique = new Map<string, Alert>();
  for (const a of alerts) {
    if (a.kind === 'no_budget' || a.kind === 'norm_anomaly') continue;
    const key = `${a.month}:${a.category}`;
    if (!unique.has(key)) unique.set(key, a);
  }
  const deduped = [...unique.values()];

  // Prognostic precision
  const progUnique = new Map<string, Alert>();
  for (const a of prognosticAlerts) {
    const key = `${a.month}:${a.category}`;
    if (!progUnique.has(key)) progUnique.set(key, a);
  }
  const progDeduped = [...progUnique.values()];
  const progTP = progDeduped.filter((a) => a.wasCorrect).length;
  const prognosticPrecision = progDeduped.length > 0 ? progTP / progDeduped.length : 0.5;

  // Actionability: only prognostic TPs with enough time to react
  const progTPs = progDeduped.filter((a) => a.wasCorrect);
  const progFPs = progDeduped.filter((a) => !a.wasCorrect);
  const actionableProgTPs = progTPs.filter((a) => a.daysRemaining > 5);
  const actionabilityRate = progTPs.length > 0 ? actionableProgTPs.length / progTPs.length : 1;

  // Timeliness: earlier correct prognostic alerts score higher (only prognostic TPs)
  const timelinessScore =
    progTPs.length > 0
      ? progTPs.reduce((s, a) => s + a.daysRemaining / DAYS_PER_MONTH, 0) / progTPs.length
      : 0;

  // FP penalty: penalize if >10% of category-months have false positive prognoses
  const fpPenalty = Math.max(0, 1 - progFPs.length / Math.max(1, totalCategoryMonths * 0.1));

  // Alert density
  const alertDensity = totalCategoryMonths > 0 ? deduped.length / totalCategoryMonths : 0;

  // Alert days per month
  const monthsWithAlerts = new Set<number>();
  for (const a of alerts) {
    if (a.kind !== 'no_budget') monthsWithAlerts.add(a.month);
  }
  const alertDaysPerMonth = totalMonths > 0 ? monthsWithAlerts.size / totalMonths : 0;

  // Useful alert rate: prognostic + daysRemaining > 5
  const nonNoBudget = alerts.filter((a) => a.kind !== 'no_budget');
  const usefulAlerts = prognosticAlerts.filter((a) => a.daysRemaining > 5);
  const usefulAlertRate = nonNoBudget.length > 0 ? usefulAlerts.length / nonNoBudget.length : 0;

  // Severity accuracy
  let severityMatches = 0;
  for (const a of deduped) {
    const actual = actualSeverity(a.actualMonthEnd, a.budget);
    if (a.severity === actual) severityMatches += 1;
    else if (
      (a.severity === 'warning' && actual === 'critical') ||
      (a.severity === 'critical' && actual === 'warning') ||
      (a.severity === 'critical' && actual === 'exceeded') ||
      (a.severity === 'exceeded' && actual === 'critical')
    ) severityMatches += 0.5;
  }
  const severityAccuracy = deduped.length > 0 ? severityMatches / deduped.length : 1;

  // Noisy categories
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

  // Alert fatigue penalty: >5 alerts/month = fatigue, users stop reading
  const alertsPerMonth = totalMonths > 0
    ? (alerts.length - noBudgetAlerts.length) / totalMonths
    : 0;
  const fatiguePenalty = Math.max(0, 1 - alertsPerMonth / 10);

  // Signal quality composite
  const densityPenalty = Math.max(0, 1 - alertDensity * 2);
  const signalQuality =
    0.25 * prognosticPrecision +
    0.15 * actionabilityRate +
    0.10 * timelinessScore +
    0.15 * fpPenalty +
    0.10 * severityAccuracy +
    0.10 * densityPenalty +
    0.15 * fatiguePenalty;

  // Range coverage: % of prognostic TP alerts whose confidence range covered the actual
  const progTPsWithRange = progTPs.filter((a) => a.confidenceRange);
  const coveredByRange = progTPsWithRange.filter(
    (a) => a.actualMonthEnd >= a.confidenceRange!.low && a.actualMonthEnd <= a.confidenceRange!.high,
  );
  const rangeCoverage = progTPsWithRange.length > 0 ? coveredByRange.length / progTPsWithRange.length : 0;

  return {
    actionabilityRate,
    timelinessScore,
    alertDensity,
    severityAccuracy,
    noisyCategories,
    signalQuality,
    prognosticPrecision,
    fpPenalty,
    alertDaysPerMonth,
    usefulAlertRate,
    factualCount: factualAlerts.length,
    prognosticCount: prognosticAlerts.length,
    noBudgetCount: noBudgetAlerts.length,
    rangeCoverage,
  };
}

// ═══════════════════════════════════════════════════════════════
// Per-month budget lookup (for real data)
// ═══════════════════════════════════════════════════════════════

/** Normalize inconsistent month formats ('2026-3' → '2026-03') to YYYY-MM */
function normalizeMonth(raw: string): string {
  return raw.replace(/-(\d)$/, '-0$1');
}

/** Hardcoded EUR exchange rates for backtest scripts (avoids importing production converter) */
const EUR_RATES: Record<string, number> = {
  EUR: 1,
  USD: 0.92,
  RSD: 0.0085,
  RUB: 0.0095,
  GBP: 1.17,
};

/** Convert an amount in any supported currency to EUR */
function toEur(amount: number, currency: string): number {
  const rate = EUR_RATES[currency] ?? EUR_RATES[currency.toUpperCase()] ?? 1;
  return Math.round(amount * rate * 100) / 100;
}

/**
 * Build a per-month budget lookup from DB rows.
 * Key: "monthIndex:category" → budget amount in EUR.
 * For months without an explicit budget, falls back to the closest previous month's budget.
 */
function buildBudgetLookup(
  budgetRows: { category: string; limit_amount: number; currency: string; month: string }[],
  sortedMonths: string[],
): Map<string, number> {
  const byCat = new Map<string, { month: string; amount: number }[]>();
  for (const b of budgetRows) {
    const norm = normalizeMonth(b.month);
    const arr = byCat.get(b.category) ?? [];
    arr.push({ month: norm, amount: toEur(b.limit_amount, b.currency) });
    byCat.set(b.category, arr);
  }
  for (const arr of byCat.values()) {
    arr.sort((a, b) => a.month.localeCompare(b.month));
  }

  const lookup = new Map<string, number>();
  for (let i = 0; i < sortedMonths.length; i++) {
    const ym = sortedMonths[i]!;
    for (const [cat, budgets] of byCat) {
      let bestAmount: number | null = null;
      for (const entry of budgets) {
        if (entry.month <= ym) bestAmount = entry.amount;
        else break;
      }
      if (bestAmount !== null) {
        lookup.set(`${i}:${cat}`, bestAmount);
      }
    }
  }
  return lookup;
}

/** Resolve budget for a category in a specific month. Falls back to cat.budget (synthetic/fallback). */
function getBudget(
  budgetByMonth: Map<string, number> | null,
  category: string,
  monthIndex: number,
  fallback: number,
): number {
  if (!budgetByMonth) return fallback;
  return budgetByMonth.get(`${monthIndex}:${category}`) ?? fallback;
}

// ═══════════════════════════════════════════════════════════════
// Backtest engine
// ═══════════════════════════════════════════════════════════════

interface QualitativeResult {
  old: { alerts: Alert[]; metrics: ExtendedMetrics };
  hybrid: { alerts: Alert[]; metrics: ExtendedMetrics };
  categories: CategoryConfig[];
  months: number;
}

function runQualitativeBacktest(
  expenses: DailyExpense[],
  categories: CategoryConfig[],
  months: number,
  budgetByMonth?: Map<string, number>,
): QualitativeResult {
  const oldAlerts: Alert[] = [];
  const hybridAlerts: Alert[] = [];
  const budgetedCategories = categories.filter((c) => c.budget > 0);
  const totalCategoryMonths = months * budgetedCategories.length;

  // Hybrid: severity-only escalation tracking
  const hybridMaxSev = new Map<string, number>();

  // No-budget cooldown
  const noBudgetLastDay = new Map<string, number>();

  // Cumulative profiles
  const cumulativeProfiles = buildCumulativeProfiles(expenses);

  for (let month = 0; month < months; month++) {
    const monthExpenses = expenses.filter((e) => e.month === month);

    const actualTotals: Record<string, number> = {};
    for (const cat of categories) {
      actualTotals[cat.name] = monthExpenses
        .filter((e) => e.category === cat.name)
        .reduce((s, e) => s + e.amount, 0);
    }

    const historyRows: { category: string; month: string; monthly_total: number; tx_count: number }[] = [];
    const monthlyHistoryByCat = new Map<string, number[]>();

    for (let m = 0; m < month; m++) {
      const mExpenses = expenses.filter((e) => e.month === m);
      const catTotals: Record<string, { total: number; count: number }> = {};
      for (const e of mExpenses) {
        if (!catTotals[e.category]) catTotals[e.category] = { total: 0, count: 0 };
        const ct = catTotals[e.category];
        if (ct) { ct.total += e.amount; ct.count++; }
      }
      for (const [cat, data] of Object.entries(catTotals)) {
        historyRows.push({ category: cat, month: `m-${m}`, monthly_total: data.total, tx_count: data.count });
        const arr = monthlyHistoryByCat.get(cat) ?? [];
        arr.push(data.total);
        monthlyHistoryByCat.set(cat, arr);
      }
    }

    const profiles = buildCategoryProfiles(historyRows);

    // Interval profiles from raw historical expenses
    const intervalProfiles = buildIntervalProfilesFromExpenses(expenses, month, DAYS_PER_MONTH);

    // Reset severity tracking per month
    hybridMaxSev.clear();

    for (const day of CHECK_DAYS) {
      for (const cat of categories) {
        const dayExpenses = monthExpenses.filter((e) => e.category === cat.name && e.day <= day);
        const spentSoFar = dayExpenses.reduce((s, e) => s + e.amount, 0);
        const txCount = dayExpenses.length;
        const actual = actualTotals[cat.name] ?? 0;
        const budget = getBudget(budgetByMonth ?? null, cat.name, month, cat.budget);
        const daysRemaining = DAYS_PER_MONTH - day;
        const overshootPercent = budget > 0 ? ((actual - budget) / budget) * 100 : 0;
        const wasCorrect = budget > 0 ? actual > budget : true;
        const profile = profiles.get(cat.name) ?? null;
        const catKey = `${month}:${cat.name}`;

        // Budget=0 handling
        if (budget <= 0) {
          if (spentSoFar > 0) {
            const lastDay = noBudgetLastDay.get(catKey) ?? -999;
            if (day - lastDay >= 7) {
              noBudgetLastDay.set(catKey, day);
              const noBudgetAlert: Alert = {
                month, day, category: cat.name, severity: 'warning',
                kind: 'no_budget', projected: spentSoFar, budget: 0,
                actualMonthEnd: Math.round(actual), daysRemaining,
                wasCorrect: true, overshootPercent: 0,
              };
              oldAlerts.push(noBudgetAlert);
              hybridAlerts.push(noBudgetAlert);
            }
          }
          continue;
        }

        const classifyKind = (spent: number, bgt: number): AlertKind =>
          spent >= bgt ? 'factual' : 'prognostic';

        const makeAlert = (
          severity: Severity, projected: number, kind: AlertKind,
          confidenceRange?: { low: number; high: number },
        ): Alert => ({
          month, day, category: cat.name, severity, kind,
          projected: Math.round(projected),
          budget, actualMonthEnd: Math.round(actual),
          daysRemaining, wasCorrect, overshootPercent,
          ...(confidenceRange ? { confidenceRange } : {}),
        });

        // ── Old: naive linear, static thresholds, fires EVERY check-day ──
        const oldProj = oldProjection(spentSoFar, day, DAYS_PER_MONTH);
        const oldSev = classifySeverity(spentSoFar, oldProj, budget);
        if (oldSev !== 'none') {
          const oldKind = classifyKind(spentSoFar, budget);
          if (process.env['DEBUG_OLD'] && oldKind === 'prognostic' && (oldSev === 'critical' || oldSev === 'exceeded')) {
            const correct = actual > budget;
            console.log(`OLD PROG ${correct?'TP':'FP'}: ${cat.name} m${month} d${day} spent=${spentSoFar.toFixed(0)} proj=${oldProj.toFixed(0)} budget=${budget} actual=${actual.toFixed(0)}`);
          }
          oldAlerts.push(makeAlert(oldSev, oldProj, oldKind));
        }

        // ── Hybrid: all improvements + severity-only escalation ──
        const cv = profile?.cv ?? 0;
        const hasActivity = passesActivityGate(txCount, day, DAYS_PER_MONTH, profile);
        const history = monthlyHistoryByCat.get(cat.name) ?? [];
        const cumProfile = cumulativeProfiles.get(cat.name) ?? null;
        const intProfile = intervalProfiles.get(cat.name) ?? undefined;

        // Compute days since last transaction in this category this month
        const lastTxDay = dayExpenses.length > 0
          ? Math.max(...dayExpenses.map((e) => e.day))
          : 0;
        const daysSinceLastTx = lastTxDay > 0 ? day - lastTxDay : day;

        const isUnstable = cumProfile !== null && !cumProfile.isStable && (profile?.monthsOfData ?? 0) >= 3;

        // Suppress prognostic alerts when normal spending exceeds budget (chronic overspender)
        const normExceedsBudget = profile !== null && profile.ema > budget;

        if (isUnstable) {
          // Unstable pattern: only factual alerts, max once per 7 days
          if (spentSoFar >= budget) {
            const lastFact = noBudgetLastDay.get(`unstable:${catKey}`) ?? -999;
            if (day - lastFact >= 7) {
              noBudgetLastDay.set(`unstable:${catKey}`, day);
              hybridAlerts.push(makeAlert('exceeded', spentSoFar, 'factual'));
            }
          }
        } else {
          const hybridProj = hasActivity
            ? hybridProjection(spentSoFar, day, DAYS_PER_MONTH, profile, daysSinceLastTx, intProfile)
            : spentSoFar;
          const hybridSev = classifySeverityDynamic(spentSoFar, hybridProj, budget, cv);

          if (hybridSev !== 'none') {
            const prev = hybridMaxSev.get(catKey) ?? 0;
            const cur = SEVERITY_ORDER[hybridSev];
            if (cur > prev) {
              const kind = classifyKind(spentSoFar, budget);
              if (kind === 'prognostic' && normExceedsBudget) continue;
              hybridMaxSev.set(catKey, cur);
              const range = kind === 'prognostic' && history.length >= 3
                ? bootstrapRange(history)
                : undefined;
              hybridAlerts.push(makeAlert(hybridSev, hybridProj, kind, range));
            }
          }

          // Norm anomaly: spending pace significantly above historical average
          // Independent of budget — fires even for categories without budget
          if (profile && profile.ema > 0 && spentSoFar > 0) {
            const monthProgress = day / DAYS_PER_MONTH;
            const expectedByNow = profile.ema * monthProgress;
            const paceRatio = spentSoFar / expectedByNow;
            const normAnomalyKey = `norm:${catKey}`;
            const lastNormDay = noBudgetLastDay.get(normAnomalyKey) ?? -999;

            // Fire if pace ≥ 1.5x norm AND haven't fired in last 7 days for this cat-month
            if (paceRatio >= 1.5 && (day - lastNormDay >= 7)) {
              noBudgetLastDay.set(normAnomalyKey, day);
              const anomalySev: Severity = paceRatio >= 3 ? 'critical' : paceRatio >= 2 ? 'warning' : 'warning';
              hybridAlerts.push({
                month, day, category: cat.name, severity: anomalySev,
                kind: 'norm_anomaly',
                projected: Math.round(spentSoFar / monthProgress),
                budget, actualMonthEnd: Math.round(actual),
                daysRemaining: DAYS_PER_MONTH - day,
                wasCorrect: actual > profile.ema * 1.3, // TP if month-end actually above norm
                overshootPercent: Math.round((paceRatio - 1) * 100),
              });
            }
          }
        }
      }
    }
  }

  return {
    old: { alerts: oldAlerts, metrics: computeQualitativeMetrics(oldAlerts, totalCategoryMonths, months) },
    hybrid: { alerts: hybridAlerts, metrics: computeQualitativeMetrics(hybridAlerts, totalCategoryMonths, months) },
    categories,
    months,
  };
}

// ═══════════════════════════════════════════════════════════════
// Report
// ═══════════════════════════════════════════════════════════════

function pad(s: string, width: number): string { return s.padStart(width); }
function pct(v: number): string { return `${(v * 100).toFixed(1)}%`; }

function printQualitativeReport(result: QualitativeResult): void {
  const { old, hybrid, categories, months } = result;

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  КАЧЕСТВЕННЫЙ БЭКТЕСТ: Old (raw production) vs Hybrid (all improvements)');
  console.log(`  ${months} months × ${categories.length} categories × ${DAYS_PER_MONTH} days`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // Main qualitative metrics
  console.log('┌──────────────────────────────┬──────────────┬──────────────┐');
  console.log('│ Метрика                      │ Old (prod)   │ Hybrid       │');
  console.log('├──────────────────────────────┼──────────────┼──────────────┤');

  const rows: [string, string, string][] = [
    ['Prognostic precision (30%)', pct(old.metrics.prognosticPrecision), pct(hybrid.metrics.prognosticPrecision)],
    ['Actionability progTP (20%)', pct(old.metrics.actionabilityRate), pct(hybrid.metrics.actionabilityRate)],
    ['Timeliness progTP (15%)', pct(old.metrics.timelinessScore), pct(hybrid.metrics.timelinessScore)],
    ['FP penalty (15%)', old.metrics.fpPenalty.toFixed(3), hybrid.metrics.fpPenalty.toFixed(3)],
    ['Severity accuracy (10%)', pct(old.metrics.severityAccuracy), pct(hybrid.metrics.severityAccuracy)],
    ['Density penalty (10%)', (Math.max(0, 1 - old.metrics.alertDensity * 2)).toFixed(3), (Math.max(0, 1 - hybrid.metrics.alertDensity * 2)).toFixed(3)],
    ['Signal quality (0-1)', old.metrics.signalQuality.toFixed(3), hybrid.metrics.signalQuality.toFixed(3)],
    ['Range coverage', pct(old.metrics.rangeCoverage), pct(hybrid.metrics.rangeCoverage)],
  ];

  for (const [label, v1, v2] of rows) {
    console.log(`│ ${label.padEnd(28)} │ ${pad(v1, 12)} │ ${pad(v2, 12)} │`);
  }
  console.log('└──────────────────────────────┴──────────────┴──────────────┘\n');

  // Factual vs Prognostic split
  console.log('┌──────────────────────────────┬──────────────┬──────────────┐');
  console.log('│ Alert breakdown              │ Old (prod)   │ Hybrid       │');
  console.log('├──────────────────────────────┼──────────────┼──────────────┤');

  const splitRows: [string, string, string][] = [
    ['Total alerts shown', String(old.alerts.length), String(hybrid.alerts.length)],
    ['  Factual (spent>=budget)', String(old.metrics.factualCount), String(hybrid.metrics.factualCount)],
    ['  Prognostic (projected)', String(old.metrics.prognosticCount), String(hybrid.metrics.prognosticCount)],
    ['  Norm anomaly', String(old.alerts.filter(a => a.kind === 'norm_anomaly').length), String(hybrid.alerts.filter(a => a.kind === 'norm_anomaly').length)],
    ['  No-budget recommendations', String(old.metrics.noBudgetCount), String(hybrid.metrics.noBudgetCount)],
    ['Prognostic precision', pct(old.metrics.prognosticPrecision), pct(hybrid.metrics.prognosticPrecision)],
    ['Alert days / month', pct(old.metrics.alertDaysPerMonth), pct(hybrid.metrics.alertDaysPerMonth)],
    ['Useful alert rate', pct(old.metrics.usefulAlertRate), pct(hybrid.metrics.usefulAlertRate)],
  ];

  for (const [label, v1, v2] of splitRows) {
    console.log(`│ ${label.padEnd(28)} │ ${pad(v1, 12)} │ ${pad(v2, 12)} │`);
  }
  console.log('└──────────────────────────────┴──────────────┴──────────────┘\n');

  // Noisy categories
  console.log('Зашумлённые категории (>50% prognostic FP):');
  console.log(`  Old:    ${old.metrics.noisyCategories.join(', ') || '—'}`);
  console.log(`  Hybrid: ${hybrid.metrics.noisyCategories.join(', ') || '—'}`);

  // Per-category detail (hybrid)
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('  ПО КАТЕГОРИЯМ (Hybrid детализация)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  for (const cat of categories) {
    const catAlerts = hybrid.alerts.filter((a) => a.category === cat.name && a.kind !== 'no_budget');
    if (catAlerts.length === 0 && cat.budget > 0) continue;

    // No-budget category summary
    if (cat.budget <= 0) {
      const noBudgetAlerts = hybrid.alerts.filter((a) => a.category === cat.name && a.kind === 'no_budget');
      if (noBudgetAlerts.length > 0) {
        console.log(`${cat.name} (budget=0, avg ${cat.monthlyAvg}±${cat.monthlyStddev}):`);
        console.log(`  Budget recommendation alerts: ${noBudgetAlerts.length}`);
        console.log('');
      }
      continue;
    }

    const unique = new Map<string, Alert>();
    for (const a of catAlerts) {
      const key = `${a.month}:${a.category}`;
      if (!unique.has(key)) unique.set(key, a);
    }
    const deduped = [...unique.values()];
    if (deduped.length === 0) continue;

    const factual = deduped.filter((a) => a.kind === 'factual');
    const prognostic = deduped.filter((a) => a.kind === 'prognostic');
    const progTP = prognostic.filter((a) => a.wasCorrect);
    const progFP = prognostic.filter((a) => !a.wasCorrect);
    const actionable = deduped.filter((a) => a.daysRemaining > 5).length;
    const avgDetectionDay = progTP.length > 0 ? progTP.reduce((s, a) => s + a.day, 0) / progTP.length : 0;

    console.log(`${cat.name} (budget ${cat.budget}, avg ${cat.monthlyAvg}±${cat.monthlyStddev}):`);
    console.log(`  Factual: ${factual.length}, Prognostic TP: ${progTP.length}, Prognostic FP: ${progFP.length}`);
    console.log(`  Prognostic precision: ${pct(prognostic.length > 0 ? progTP.length / prognostic.length : 0)}`);
    console.log(`  Actionable: ${actionable}/${deduped.length}, Avg prognostic TP day: ${avgDetectionDay.toFixed(0)}`);

    if (progFP.length > 0) {
      console.log('  False prognostic alerts:');
      for (const a of progFP) {
        const rangeStr = a.confidenceRange ? ` (${a.confidenceRange.low}-${a.confidenceRange.high})` : '';
        console.log(`    Мес ${a.month + 1} день ${a.day}: прогноз ${a.projected}${rangeStr}, бюджет ${a.budget}, факт ${a.actualMonthEnd} (${a.overshootPercent > 0 ? '+' : ''}${a.overshootPercent.toFixed(0)}%)`);
      }
    }

    const lateTP = progTP.filter((a) => a.day > 20);
    if (lateTP.length > 0) {
      console.log('  Late true positives (день > 20):');
      for (const a of lateTP) {
        const rangeStr = a.confidenceRange ? ` (${a.confidenceRange.low}-${a.confidenceRange.high})` : '';
        console.log(`    Мес ${a.month + 1} день ${a.day}: прогноз ${a.projected}${rangeStr}, факт ${a.actualMonthEnd}`);
      }
    }
    console.log('');
  }

  // Verdict
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  ВЕРДИКТ');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  const sqOld = old.metrics.signalQuality;
  const sqHybrid = hybrid.metrics.signalQuality;
  const best = sqHybrid >= sqOld ? 'Hybrid' : 'Old';

  console.log(`Signal Quality: Old=${sqOld.toFixed(3)} → Hybrid=${sqHybrid.toFixed(3)}`);
  console.log(`Best algorithm: ${best}`);

  const improvementVsOld = sqOld > 0 ? ((sqHybrid - sqOld) / sqOld * 100).toFixed(1) : 'N/A';
  console.log(`Hybrid vs Old: ${Number(improvementVsOld) > 0 ? '+' : ''}${improvementVsOld}%`);

  const showReduction = old.alerts.length > 0
    ? ((old.alerts.length - hybrid.alerts.length) / old.alerts.length * 100)
    : 0;
  console.log(`Alerts shown: Old=${old.alerts.length} → Hybrid=${hybrid.alerts.length} (−${showReduction.toFixed(0)}%)`);

  console.log(`\nPrognostic precision: ${pct(old.metrics.prognosticPrecision)} → ${pct(hybrid.metrics.prognosticPrecision)}`);
  console.log(`Actionability: ${pct(old.metrics.actionabilityRate)} → ${pct(hybrid.metrics.actionabilityRate)}`);
  console.log(`FP penalty: ${old.metrics.fpPenalty.toFixed(3)} → ${hybrid.metrics.fpPenalty.toFixed(3)}`);
  console.log(`Severity accuracy: ${pct(old.metrics.severityAccuracy)} → ${pct(hybrid.metrics.severityAccuracy)}`);
  console.log(`Useful alert rate: ${pct(old.metrics.usefulAlertRate)} → ${pct(hybrid.metrics.usefulAlertRate)}`);
  console.log(`Range coverage: ${pct(old.metrics.rangeCoverage)} → ${pct(hybrid.metrics.rangeCoverage)}`);
  console.log(`Noise: ${old.metrics.noisyCategories.length} → ${hybrid.metrics.noisyCategories.length} noisy categories`);
}

// ═══════════════════════════════════════════════════════════════
// Real-data loader
// ═══════════════════════════════════════════════════════════════

function loadRealData(dbPath: string, groupId: number): {
  expenses: DailyExpense[];
  categories: CategoryConfig[];
  months: number;
  budgetByMonth: Map<string, number>;
} {
  const db = new Database(dbPath, { readonly: true });

  const rows = db.query<
    { date: string; category: string; eur_amount: number },
    [number]
  >('SELECT date, category, eur_amount FROM expenses WHERE group_id = ? ORDER BY date ASC').all(groupId);

  if (rows.length === 0) {
    console.error(`No expenses found for group ${groupId} in ${dbPath}`);
    process.exit(1);
  }

  const budgetRows = db.query<
    { category: string; limit_amount: number; currency: string; month: string },
    [number]
  >('SELECT category, limit_amount, currency, month FROM budgets WHERE group_id = ?').all(groupId);

  db.close();

  const monthSet = new Set<string>();
  const categoryStats = new Map<string, { total: number; count: number }>();

  for (const row of rows) {
    const monthKey = row.date.substring(0, 7);
    monthSet.add(monthKey);
    const stats = categoryStats.get(row.category) ?? { total: 0, count: 0 };
    stats.total += row.eur_amount;
    stats.count++;
    categoryStats.set(row.category, stats);
  }

  const sortedMonths = [...monthSet].sort();
  const monthIndex = new Map<string, number>();
  for (let i = 0; i < sortedMonths.length; i++) {
    monthIndex.set(sortedMonths[i] ?? '', i);
  }

  // Build per-month budget lookup
  const budgetByMonth = buildBudgetLookup(budgetRows, sortedMonths);

  // Compute latest budget per category (for CategoryConfig.budget fallback in reports)
  const latestBudget = new Map<string, number>();
  const sortedBudgetRows = [...budgetRows].sort((a, b) => {
    const na = normalizeMonth(a.month);
    const nb = normalizeMonth(b.month);
    return nb.localeCompare(na);
  });
  for (const b of sortedBudgetRows) {
    if (!latestBudget.has(b.category)) latestBudget.set(b.category, toEur(b.limit_amount, b.currency));
  }

  const expenses: DailyExpense[] = rows.map((row) => ({
    day: Math.max(1, Math.min(30, Number.parseInt(row.date.substring(8, 10)))),
    month: monthIndex.get(row.date.substring(0, 7)) ?? 0,
    category: row.category,
    amount: row.eur_amount,
  }));

  const numMonths = sortedMonths.length;
  const categories: CategoryConfig[] = [];
  for (const [cat, stats] of categoryStats) {
    const monthlyAvg = stats.total / numMonths;
    const monthlyTotals: number[] = [];
    for (const m of sortedMonths) {
      const mTotal = rows
        .filter((r) => r.date.startsWith(m) && r.category === cat)
        .reduce((s, r) => s + r.eur_amount, 0);
      monthlyTotals.push(mTotal);
    }
    const variance = monthlyTotals.reduce((s, v) => s + (v - monthlyAvg) ** 2, 0) / numMonths;
    categories.push({
      name: cat,
      monthlyAvg: Math.round(monthlyAvg),
      monthlyStddev: Math.round(Math.sqrt(variance)),
      avgTxPerMonth: Math.round(stats.count / numMonths),
      budget: latestBudget.get(cat) ?? Math.round(monthlyAvg * 1.3),
    });
  }

  return { expenses, categories, months: numMonths, budgetByMonth };
}

// ═══════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const isRealMode = args.includes('--real');
const groupIdArg = args.find((a) => a.startsWith('--group-id='));
const dbPathArg = args.find((a) => a.startsWith('--db='));

if (isRealMode) {
  const groupId = groupIdArg ? Number.parseInt(groupIdArg.split('=')[1] ?? '1') : 1;
  const dbPath = dbPathArg ? dbPathArg.split('=')[1] ?? './data/expenses.db' : './data/expenses.db';

  console.log(`Loading real data from ${dbPath} for group ${groupId}...\n`);
  const { expenses, categories, months, budgetByMonth } = loadRealData(dbPath, groupId);
  console.log(`Loaded ${expenses.length} expenses, ${categories.length} categories, ${months} months\n`);

  const result = runQualitativeBacktest(expenses, categories, months, budgetByMonth);
  printQualitativeReport(result);
} else {
  console.log('Generating spending data with 5 random seeds...\n');
  console.log('Tip: use --real --group-id=N --db=path/to/expenses.db for real data\n');

  const seeds = [42, 137, 256, 1001, 7777];
  let allOldAlerts: Alert[] = [];
  let allHybridAlerts: Alert[] = [];

  for (const seed of seeds) {
    console.log(`  Seed ${seed}...`);
    const data = generateSpendingData(seed);
    const result = runQualitativeBacktest(data, SYNTH_CATEGORIES, SYNTH_MONTHS);
    allOldAlerts = allOldAlerts.concat(result.old.alerts);
    allHybridAlerts = allHybridAlerts.concat(result.hybrid.alerts);
  }

  console.log('');

  const budgetedCats = SYNTH_CATEGORIES.filter((c) => c.budget > 0);
  const totalCatMonths = SYNTH_MONTHS * budgetedCats.length * seeds.length;
  const totalMonths = SYNTH_MONTHS * seeds.length;
  printQualitativeReport({
    old: { alerts: allOldAlerts, metrics: computeQualitativeMetrics(allOldAlerts, totalCatMonths, totalMonths) },
    hybrid: { alerts: allHybridAlerts, metrics: computeQualitativeMetrics(allHybridAlerts, totalCatMonths, totalMonths) },
    categories: SYNTH_CATEGORIES,
    months: SYNTH_MONTHS * seeds.length,
  });
}
