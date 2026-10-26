/**
 * Backtest engine for scripts/backtest-qualitative.ts.
 *
 * Replays every (month, check-day, category) point twice:
 *   - Old: raw production behavior (fires every checkpoint, static thresholds, linear projection)
 *   - Hybrid: all improvements (activity gate, escalation-only, dynamic thresholds, routing, TA signals)
 * and collects the resulting alerts.
 */

import { analyzeCategory } from '../../src/services/analytics/ta/analyzer';
import {
  buildCategoryProfiles,
  passesActivityGate,
  projectCategory,
} from '../../src/services/analytics/forecast-core';
import type { CategoryProfile, IntervalProfile } from '../../src/services/analytics/types';
import {
  buildCumulativeProfiles,
  CHECK_DAYS,
  type CumulativeProfile,
  type DailyExpense,
} from './backtest-shared';
import {
  type Alert,
  type AlertKind,
  bootstrapRange,
  type CategoryConfig,
  classifySeverity,
  classifySeverityDynamic,
  computeQualitativeMetrics,
  DAYS_PER_MONTH,
  type ExtendedMetrics,
  oldProjection,
  SEVERITY_ORDER,
  type Severity,
} from './backtest-qualitative-metrics';
import { printLine } from './print-line';

// ═══════════════════════════════════════════════════════════════
// Interval-based cycle detection (refueling, salon, subscriptions)
// ═══════════════════════════════════════════════════════════════

/** Absolute day number of an expense on the synthetic month grid */
function absoluteDay(e: DailyExpense, daysPerMonth: number): number {
  return e.month * daysPerMonth + e.day;
}

/** Day gaps between consecutive expenses, ignoring same-day and >90-day gaps */
function collectIntervals(sorted: DailyExpense[], daysPerMonth: number): number[] {
  const intervals: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const days = absoluteDay(sorted[i]!, daysPerMonth) - absoluteDay(sorted[i - 1]!, daysPerMonth);
    if (days <= 0 || days > 90) continue;
    intervals.push(days);
  }
  return intervals;
}

function toIntervalProfile(intervals: number[], amounts: number[]): IntervalProfile {
  const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
  const variance = intervals.reduce((s, v) => s + (v - avgInterval) ** 2, 0) / intervals.length;
  const stddev = Math.sqrt(variance);
  const intervalCv = avgInterval > 0 ? stddev / avgInterval : 999;
  const avgAmount = amounts.reduce((s, v) => s + v, 0) / amounts.length;

  return {
    avgInterval: Math.round(avgInterval * 100) / 100,
    intervalCv: Math.round(intervalCv * 1000) / 1000,
    avgAmount: Math.round(avgAmount * 100) / 100,
    isStable: intervalCv < 0.4 && avgInterval >= 5,
  };
}

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
    catExpenses.sort((a, b) => absoluteDay(a, daysPerMonth) - absoluteDay(b, daysPerMonth));

    const intervals = collectIntervals(catExpenses, daysPerMonth);
    if (intervals.length < 3) continue;

    profiles.set(
      category,
      toIntervalProfile(
        intervals,
        catExpenses.map((e) => e.amount),
      ),
    );
  }

  return profiles;
}

// ═══════════════════════════════════════════════════════════════
// Per-month budget lookup (for real data)
// ═══════════════════════════════════════════════════════════════

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
// Backtest state
// ═══════════════════════════════════════════════════════════════

export interface QualitativeResult {
  old: { alerts: Alert[]; metrics: ExtendedMetrics };
  hybrid: { alerts: Alert[]; metrics: ExtendedMetrics };
  categories: CategoryConfig[];
  months: number;
}

type TrendDirection = 'rising' | 'falling' | 'stable';
type ConfidenceRange = { low: number; high: number };

/** State carried across the whole backtest run */
interface EngineState {
  oldAlerts: Alert[];
  hybridAlerts: Alert[];
  /** Hybrid: severity-only escalation tracking (reset every month) */
  hybridMaxSev: Map<string, number>;
  /** Cooldowns / fire-once markers keyed by alert family and category-month */
  lastFiredDay: Map<string, number>;
  cumulativeProfiles: Map<string, CumulativeProfile>;
  /** TA trend direction from previous month (for trend reversal detection) */
  prevMonthTrendDirection: Map<string, TrendDirection>;
}

/** Per-month data derived from the expense history */
interface MonthData {
  month: number;
  monthExpenses: DailyExpense[];
  actualTotals: Record<string, number>;
  monthlyHistoryByCat: Map<string, number[]>;
  profiles: Map<string, CategoryProfile>;
  intervalProfiles: Map<string, IntervalProfile>;
}

/** Everything known about one (month, check-day, category) point */
interface CheckContext {
  month: number;
  day: number;
  cat: CategoryConfig;
  budget: number;
  actual: number;
  spentSoFar: number;
  txCount: number;
  dayExpenses: DailyExpense[];
  daysRemaining: number;
  overshootPercent: number;
  wasCorrect: boolean;
  profile: CategoryProfile | null;
  history: number[];
  catKey: string;
  monthExpenses: DailyExpense[];
}

const COOLDOWN_DAYS = 7;
const NEVER_FIRED = -999;

/** True when the cooldown family has not fired within the last COOLDOWN_DAYS */
function cooldownElapsed(state: EngineState, key: string, day: number): boolean {
  return day - (state.lastFiredDay.get(key) ?? NEVER_FIRED) >= COOLDOWN_DAYS;
}

function sumAmounts(expenses: DailyExpense[]): number {
  return expenses.reduce((s, e) => s + e.amount, 0);
}

function classifyKind(spent: number, budget: number): AlertKind {
  return spent >= budget ? 'factual' : 'prognostic';
}

function makeAlert(
  ctx: CheckContext,
  severity: Severity,
  projected: number,
  kind: AlertKind,
  confidenceRange?: ConfidenceRange,
): Alert {
  return {
    month: ctx.month,
    day: ctx.day,
    category: ctx.cat.name,
    severity,
    kind,
    projected: Math.round(projected),
    budget: ctx.budget,
    actualMonthEnd: Math.round(ctx.actual),
    daysRemaining: ctx.daysRemaining,
    wasCorrect: ctx.wasCorrect,
    overshootPercent: ctx.overshootPercent,
    ...(confidenceRange ? { confidenceRange } : {}),
  };
}

/** Informational (non-budget-classified) alert: always a warning with no overshoot */
function makeSignalAlert(
  ctx: CheckContext,
  kind: AlertKind,
  projected: number,
  wasCorrect: boolean,
  severity: Severity = 'warning',
  overshootPercent = 0,
): Alert {
  return {
    month: ctx.month,
    day: ctx.day,
    category: ctx.cat.name,
    severity,
    kind,
    projected,
    budget: ctx.budget,
    actualMonthEnd: Math.round(ctx.actual),
    daysRemaining: DAYS_PER_MONTH - ctx.day,
    wasCorrect,
    overshootPercent,
  };
}

// ═══════════════════════════════════════════════════════════════
// Month and check-point preparation
// ═══════════════════════════════════════════════════════════════

function computeActualTotals(
  monthExpenses: DailyExpense[],
  categories: CategoryConfig[],
): Record<string, number> {
  const actualTotals: Record<string, number> = {};
  for (const cat of categories) {
    actualTotals[cat.name] = sumAmounts(monthExpenses.filter((e) => e.category === cat.name));
  }
  return actualTotals;
}

/** Historical monthly totals per category (all months strictly before `month`) */
function buildMonthlyHistory(
  expenses: DailyExpense[],
  month: number,
): {
  historyRows: { category: string; month: string; monthly_total: number; tx_count: number }[];
  monthlyHistoryByCat: Map<string, number[]>;
} {
  const historyRows: { category: string; month: string; monthly_total: number; tx_count: number }[] = [];
  const monthlyHistoryByCat = new Map<string, number[]>();

  for (let m = 0; m < month; m++) {
    const catTotals: Record<string, { total: number; count: number }> = {};
    for (const e of expenses.filter((x) => x.month === m)) {
      if (!catTotals[e.category]) catTotals[e.category] = { total: 0, count: 0 };
      const ct = catTotals[e.category];
      if (ct) {
        ct.total += e.amount;
        ct.count++;
      }
    }
    for (const [cat, data] of Object.entries(catTotals)) {
      historyRows.push({ category: cat, month: `m-${m}`, monthly_total: data.total, tx_count: data.count });
      const arr = monthlyHistoryByCat.get(cat) ?? [];
      arr.push(data.total);
      monthlyHistoryByCat.set(cat, arr);
    }
  }

  return { historyRows, monthlyHistoryByCat };
}

function prepareMonth(expenses: DailyExpense[], categories: CategoryConfig[], month: number): MonthData {
  const monthExpenses = expenses.filter((e) => e.month === month);
  const { historyRows, monthlyHistoryByCat } = buildMonthlyHistory(expenses, month);
  return {
    month,
    monthExpenses,
    actualTotals: computeActualTotals(monthExpenses, categories),
    monthlyHistoryByCat,
    profiles: buildCategoryProfiles(historyRows),
    // Interval profiles from raw historical expenses
    intervalProfiles: buildIntervalProfilesFromExpenses(expenses, month, DAYS_PER_MONTH),
  };
}

function buildCheckContext(
  data: MonthData,
  cat: CategoryConfig,
  day: number,
  budgetByMonth: Map<string, number> | null,
): CheckContext {
  const { month, monthExpenses } = data;
  const dayExpenses = monthExpenses.filter((e) => e.category === cat.name && e.day <= day);
  const actual = data.actualTotals[cat.name] ?? 0;
  const budget = getBudget(budgetByMonth, cat.name, month, cat.budget);
  return {
    month,
    day,
    cat,
    budget,
    actual,
    spentSoFar: sumAmounts(dayExpenses),
    txCount: dayExpenses.length,
    dayExpenses,
    daysRemaining: DAYS_PER_MONTH - day,
    overshootPercent: budget > 0 ? ((actual - budget) / budget) * 100 : 0,
    wasCorrect: budget > 0 ? actual > budget : true,
    profile: data.profiles.get(cat.name) ?? null,
    history: data.monthlyHistoryByCat.get(cat.name) ?? [],
    catKey: `${month}:${cat.name}`,
    monthExpenses,
  };
}

// ═══════════════════════════════════════════════════════════════
// Budget=0 handling and Old algorithm
// ═══════════════════════════════════════════════════════════════

/** Budget=0: recommend a budget at most once per week per category-month */
function processNoBudget(ctx: CheckContext, state: EngineState): void {
  // NaN-safe: written as a negated positive comparison, synthetic data can yield NaN amounts
  if (!(ctx.spentSoFar > 0)) return;
  if (!cooldownElapsed(state, ctx.catKey, ctx.day)) return;

  state.lastFiredDay.set(ctx.catKey, ctx.day);
  const noBudgetAlert: Alert = {
    month: ctx.month,
    day: ctx.day,
    category: ctx.cat.name,
    severity: 'warning',
    kind: 'no_budget',
    projected: ctx.spentSoFar,
    budget: 0,
    actualMonthEnd: Math.round(ctx.actual),
    daysRemaining: ctx.daysRemaining,
    wasCorrect: true,
    overshootPercent: 0,
  };
  state.oldAlerts.push(noBudgetAlert);
  state.hybridAlerts.push(noBudgetAlert);
}

/** Old: naive linear, static thresholds, fires EVERY check-day */
function processOld(ctx: CheckContext, state: EngineState): void {
  const oldProj = oldProjection(ctx.spentSoFar, ctx.day, DAYS_PER_MONTH);
  const oldSev = classifySeverity(ctx.spentSoFar, oldProj, ctx.budget);
  if (oldSev === 'none') return;

  const oldKind = classifyKind(ctx.spentSoFar, ctx.budget);
  if (process.env['DEBUG_OLD'] && oldKind === 'prognostic' && (oldSev === 'critical' || oldSev === 'exceeded')) {
    const correct = ctx.actual > ctx.budget;
    printLine(`OLD PROG ${correct ? 'TP' : 'FP'}: ${ctx.cat.name} m${ctx.month} d${ctx.day} spent=${ctx.spentSoFar.toFixed(0)} proj=${oldProj.toFixed(0)} budget=${ctx.budget} actual=${ctx.actual.toFixed(0)}`,);
  }
  state.oldAlerts.push(makeAlert(ctx, oldSev, oldProj, oldKind));
}

// ═══════════════════════════════════════════════════════════════
// Hybrid algorithm
// ═══════════════════════════════════════════════════════════════

/** Unstable pattern: only factual alerts, max once per 7 days */
function processUnstableHybrid(ctx: CheckContext, state: EngineState): void {
  if (!(ctx.spentSoFar >= ctx.budget)) return;

  const key = `unstable:${ctx.catKey}`;
  if (!cooldownElapsed(state, key, ctx.day)) return;

  state.lastFiredDay.set(key, ctx.day);
  state.hybridAlerts.push(makeAlert(ctx, 'exceeded', ctx.spentSoFar, 'factual'));
}

/** Days since last transaction in this category this month (day itself when none) */
function daysSinceLastTransaction(ctx: CheckContext): number {
  const lastTxDay = ctx.dayExpenses.length > 0 ? Math.max(...ctx.dayExpenses.map((e) => e.day)) : 0;
  return lastTxDay > 0 ? ctx.day - lastTxDay : ctx.day;
}

/**
 * Hybrid severity alert with severity-only escalation.
 * Returns false when the alert was suppressed for a chronic overspender, which also
 * suppresses all other hybrid signals for this check point.
 */
function emitSeverityAlert(
  ctx: CheckContext,
  state: EngineState,
  intProfile: IntervalProfile | undefined,
): boolean {
  const { profile, spentSoFar, day, budget } = ctx;
  const hasActivity = passesActivityGate(ctx.txCount, day, DAYS_PER_MONTH, profile);
  const hybridProj = hasActivity
    ? projectCategory(spentSoFar, day, DAYS_PER_MONTH, profile, daysSinceLastTransaction(ctx), intProfile)
    : spentSoFar;
  const hybridSev = classifySeverityDynamic(spentSoFar, hybridProj, budget, profile?.cv ?? 0);
  if (hybridSev === 'none') return true;

  const prev = state.hybridMaxSev.get(ctx.catKey) ?? 0;
  const cur = SEVERITY_ORDER[hybridSev];
  if (cur <= prev) return true;

  const kind = classifyKind(spentSoFar, budget);
  // Suppress prognostic alerts when normal spending exceeds budget (chronic overspender)
  const normExceedsBudget = profile !== null && profile.ema > budget;
  if (kind === 'prognostic' && normExceedsBudget) return false;

  state.hybridMaxSev.set(ctx.catKey, cur);
  const range = kind === 'prognostic' && ctx.history.length >= 3 ? bootstrapRange(ctx.history) : undefined;
  state.hybridAlerts.push(makeAlert(ctx, hybridSev, hybridProj, kind, range));
  return true;
}

/**
 * Norm anomaly: spending pace significantly above historical average.
 * Independent of budget — fires even for categories without budget.
 */
function emitNormAnomaly(ctx: CheckContext, state: EngineState): void {
  const { profile, spentSoFar, day } = ctx;
  if (!profile || !(profile.ema > 0 && spentSoFar > 0)) return;

  const monthProgress = day / DAYS_PER_MONTH;
  const expectedByNow = profile.ema * monthProgress;
  const paceRatio = spentSoFar / expectedByNow;
  const normAnomalyKey = `norm:${ctx.catKey}`;

  // Fire if pace ≥ 1.5x norm AND haven't fired in last 7 days for this cat-month
  if (!(paceRatio >= 1.5 && cooldownElapsed(state, normAnomalyKey, day))) return;

  state.lastFiredDay.set(normAnomalyKey, day);
  state.hybridAlerts.push(
    makeSignalAlert(
      ctx,
      'norm_anomaly',
      Math.round(spentSoFar / monthProgress),
      ctx.actual > profile.ema * 1.3, // TP if month-end actually above norm
      paceRatio >= 3 ? 'critical' : 'warning',
      Math.round((paceRatio - 1) * 100),
    ),
  );
}

/** Spent so far in this category up to (and including) the given day */
function spentUpToDay(ctx: CheckContext, upToDay: number): number {
  return sumAmounts(ctx.monthExpenses.filter((e) => e.category === ctx.cat.name && e.day <= upToDay));
}

/**
 * Velocity spike: day-over-day spending acceleration.
 * Max once per category per month.
 */
function emitVelocitySpike(ctx: CheckContext, state: EngineState): void {
  const { spentSoFar, day } = ctx;
  if (!(spentSoFar > 20)) return;

  const velocityKey = `velocity:${ctx.catKey}`;
  if (state.lastFiredDay.has(velocityKey)) return;

  const cpIndex = CHECK_DAYS.indexOf(day);
  if (cpIndex <= 0) return;

  const prevDay = CHECK_DAYS[cpIndex - 1]!;
  const prevSpent = spentUpToDay(ctx, prevDay);
  const paceToday = (spentSoFar - prevSpent) / (day - prevDay);
  const pacePrev = prevDay > 0 ? prevSpent / prevDay : 0;
  if (!(pacePrev > 0 && paceToday > pacePrev * 1.5)) return;

  state.lastFiredDay.set(velocityKey, day);
  state.hybridAlerts.push(
    makeSignalAlert(
      ctx,
      'velocity_spike',
      Math.round((spentSoFar / day) * DAYS_PER_MONTH),
      ctx.actual > (ctx.profile?.ema ?? ctx.budget),
    ),
  );
}

/** TA anomaly: multi-method anomaly detection (max once per category per month) */
function emitTaAnomaly(ctx: CheckContext, state: EngineState): void {
  if (ctx.history.length < 3) return;

  const taAnomalyKey = `ta_anomaly:${ctx.catKey}`;
  if (state.lastFiredDay.has(taAnomalyKey)) return;

  const ta = analyzeCategory(ctx.cat.name, ctx.history, { currentMonthSpent: ctx.spentSoFar });
  if (!(ta.anomaly.anomalyCount >= 2)) return;

  state.lastFiredDay.set(taAnomalyKey, ctx.day);
  state.hybridAlerts.push(
    makeSignalAlert(
      ctx,
      'ta_anomaly',
      Math.round(ta.forecasts.ensemble),
      ctx.actual > (ctx.profile?.ema ?? ctx.budget) * 1.3,
    ),
  );
}

function isTrendReversal(prev: TrendDirection | undefined, current: TrendDirection): boolean {
  return (prev === 'rising' && current === 'falling') || (prev === 'falling' && current === 'rising');
}

/** TA trend change: trend reversal detection (max once per category per month) */
function emitTaTrendChange(ctx: CheckContext, state: EngineState): void {
  if (ctx.history.length < 3) return;

  const taTrendKey = `ta_trend:${ctx.catKey}`;
  if (state.lastFiredDay.has(taTrendKey)) return;

  const ta = analyzeCategory(ctx.cat.name, ctx.history);
  const prevDirection = state.prevMonthTrendDirection.get(ctx.cat.name);
  if (prevDirection === undefined || !(ta.trend.confidence >= 0.6)) return;
  if (!isTrendReversal(prevDirection, ta.trend.direction)) return;

  const emaOrZero = ctx.profile?.ema ?? 0;
  state.lastFiredDay.set(taTrendKey, ctx.day);
  state.hybridAlerts.push(
    makeSignalAlert(
      ctx,
      'ta_trend_change',
      Math.round(ta.forecasts.ensemble),
      ta.trend.direction === 'rising' ? ctx.actual > emaOrZero : ctx.actual < emaOrZero,
    ),
  );
}

/** Hybrid: all improvements + severity-only escalation */
function processHybrid(ctx: CheckContext, state: EngineState, data: MonthData): void {
  const cumProfile = state.cumulativeProfiles.get(ctx.cat.name) ?? null;
  const isUnstable = cumProfile !== null && !cumProfile.isStable && (ctx.profile?.monthsOfData ?? 0) >= 3;
  if (isUnstable) {
    processUnstableHybrid(ctx, state);
    return;
  }

  if (!emitSeverityAlert(ctx, state, data.intervalProfiles.get(ctx.cat.name))) return;
  emitNormAnomaly(ctx, state);
  emitVelocitySpike(ctx, state);
  emitTaAnomaly(ctx, state);
  emitTaTrendChange(ctx, state);
}

function processCheckPoint(
  ctx: CheckContext,
  state: EngineState,
  data: MonthData,
): void {
  if (ctx.budget <= 0) {
    processNoBudget(ctx, state);
    return;
  }
  processOld(ctx, state);
  processHybrid(ctx, state, data);
}

/** Update trend directions for next month */
function updateTrendDirections(
  categories: CategoryConfig[],
  data: MonthData,
  state: EngineState,
): void {
  for (const cat of categories) {
    const catHistory = data.monthlyHistoryByCat.get(cat.name) ?? [];
    if (catHistory.length >= 3) {
      const ta = analyzeCategory(cat.name, catHistory);
      state.prevMonthTrendDirection.set(cat.name, ta.trend.direction);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// Backtest engine
// ═══════════════════════════════════════════════════════════════

export function runQualitativeBacktest(
  expenses: DailyExpense[],
  categories: CategoryConfig[],
  months: number,
  budgetByMonth?: Map<string, number>,
): QualitativeResult {
  const budgetedCategories = categories.filter((c) => c.budget > 0);
  const totalCategoryMonths = months * budgetedCategories.length;

  const state: EngineState = {
    oldAlerts: [],
    hybridAlerts: [],
    hybridMaxSev: new Map(),
    lastFiredDay: new Map(),
    cumulativeProfiles: buildCumulativeProfiles(expenses),
    prevMonthTrendDirection: new Map(),
  };

  for (let month = 0; month < months; month++) {
    const data = prepareMonth(expenses, categories, month);

    // Reset severity tracking per month
    state.hybridMaxSev.clear();

    for (const day of CHECK_DAYS) {
      for (const cat of categories) {
        processCheckPoint(buildCheckContext(data, cat, day, budgetByMonth ?? null), state, data);
      }
    }

    updateTrendDirections(categories, data, state);
  }

  return {
    old: {
      alerts: state.oldAlerts,
      metrics: computeQualitativeMetrics(state.oldAlerts, totalCategoryMonths, months),
    },
    hybrid: {
      alerts: state.hybridAlerts,
      metrics: computeQualitativeMetrics(state.hybridAlerts, totalCategoryMonths, months),
    },
    categories,
    months,
  };
}
