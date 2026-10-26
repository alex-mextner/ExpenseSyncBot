/**
 * Quantitative backtest: old (raw production) vs hybrid (all improvements).
 *
 * Old algorithm = raw production behavior:
 *   - Fires EVERY checkpoint when status is warning/critical/exceeded (no escalation)
 *   - Static thresholds (0.85 warning, 1.0 critical)
 *   - Naive linear projection always
 *
 * Hybrid = ALL improvements:
 *   - Activity gate (min 3 tx)
 *   - Severity-only escalation (fires only if severity INCREASES vs previous highest)
 *   - Dynamic CV-based warning threshold
 *   - Syntetos-Boylan demand classification routing
 *   - TSB fading demand for intermittent categories
 *   - Weighted ensemble when TA history available
 *   - Cumulative spending profiles for stable categories
 *
 * Alerts split into FACTUAL (spent >= budget) and PROGNOSTIC (projected > budget, spent < budget).
 *
 * Run: bun scripts/backtest-forecast.ts
 *      bun scripts/backtest-forecast.ts --real --group-id=1 --db=path/to/expenses.db
 */

import { Database } from 'bun:sqlite';
import type { CurrencyCode } from '../src/config/constants';
import {
  buildCategoryProfiles,
  passesActivityGate,
  projectCategory,
} from '../src/services/analytics/forecast-core';
import type { CategoryProfile, IntervalProfile } from '../src/services/analytics/types';
import { convertCurrency } from '../src/services/currency/converter';
import { printReport } from './lib/backtest-forecast-report';
import {
  type AccuracyPoint,
  type AlertEvent,
  type AlertKind,
  type BacktestResult,
  type CategoryConfig,
  DAYS_PER_MONTH,
  type Status,
} from './lib/backtest-forecast-types';
import {
  buildBudgetLookup,
  buildCumulativeProfiles,
  CHECK_DAYS,
  type CumulativeProfile,
  type DailyExpense,
  normalizeMonth,
} from './lib/backtest-shared';
import { printLine } from './lib/print-line';

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
    // Sort by absolute day (month * daysPerMonth + day)
    catExpenses.sort((a, b) => (a.month * daysPerMonth + a.day) - (b.month * daysPerMonth + b.day));

    const intervals: number[] = [];
    for (let i = 1; i < catExpenses.length; i++) {
      const prev = catExpenses[i - 1]!;
      const curr = catExpenses[i]!;
      const days = (curr.month * daysPerMonth + curr.day) - (prev.month * daysPerMonth + prev.day);
      // Filter out outlier gaps (>90 days) and same-day transactions
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
// Spending simulation
// ═══════════════════════════════════════════════════════════════

const CATEGORIES: CategoryConfig[] = [
  { name: 'Еда', monthlyAvg: 300, monthlyStddev: 40, avgTxPerMonth: 25, budget: 400 },
  { name: 'Транспорт', monthlyAvg: 80, monthlyStddev: 20, avgTxPerMonth: 15, budget: 120 },
  { name: 'Машина', monthlyAvg: 100, monthlyStddev: 30, avgTxPerMonth: 2, budget: 150 },
  { name: 'Подписки', monthlyAvg: 50, monthlyStddev: 5, avgTxPerMonth: 3, budget: 60 },
  { name: 'Развлечения', monthlyAvg: 120, monthlyStddev: 80, avgTxPerMonth: 4, budget: 200 },
  { name: 'Здоровье', monthlyAvg: 40, monthlyStddev: 50, avgTxPerMonth: 1, budget: 100 },
  { name: 'Кофе', monthlyAvg: 15, monthlyStddev: 10, avgTxPerMonth: 5, budget: 0 },
];

const SYNTH_MONTHS = 12;

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
    for (const cat of CATEGORIES) {
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
// Old algorithm: naive linear extrapolation, static thresholds,
// fires EVERY check-day (no escalation suppression)
// ═══════════════════════════════════════════════════════════════

function oldProjection(currentSpent: number, daysElapsed: number, daysInMonth: number): number {
  if (daysElapsed <= 0) return 0;
  return (currentSpent / daysElapsed) * daysInMonth;
}

const SEVERITY_ORDER: Record<Status, number> = {
  on_track: 0,
  warning: 1,
  critical: 2,
  exceeded: 3,
};

function oldStatus(spent: number, projected: number, budget: number): Status {
  if (spent >= budget) return 'exceeded';
  if (projected > budget) return 'critical';
  if (projected > budget * 0.85) return 'warning';
  return 'on_track';
}

/** Dynamic threshold: CV=0 -> 85%, CV=0.5 -> 90%, CV>=1 -> 95% */
function hybridStatus(spent: number, projected: number, budget: number, cv: number): Status {
  if (spent >= budget) return 'exceeded';
  if (projected > budget) return 'critical';
  const warningThreshold = 0.85 + 0.1 * Math.min(1, cv);
  if (projected > budget * warningThreshold) return 'warning';
  return 'on_track';
}

// ═══════════════════════════════════════════════════════════════
// Bootstrap confidence range
// ═══════════════════════════════════════════════════════════════

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
// Backtesting engine
// ═══════════════════════════════════════════════════════════════

/** Minimum days between repeated alerts of the same cooldown key (no_budget, unstable, norm, ...). */
const ALERT_COOLDOWN_DAYS = 7;
const NEVER_FIRED_DAY = -999;

/** Mutable accumulators shared across the whole backtest run. */
interface BacktestState {
  oldAlerts: AlertEvent[];
  hybridAlerts: AlertEvent[];
  accuracy: AccuracyPoint[];
  totalCheckDays: number;
  /** Hybrid severity-only escalation tracking (reset per month) */
  hybridMaxSeverity: Map<string, number>;
  /** Last day a cooldown-limited alert fired, keyed by alert family + category-month */
  lastAlertDay: Map<string, number>;
}

/** Everything that is fixed for one simulated month. */
interface MonthContext {
  month: number;
  daysPerMonth: number;
  budgetByMonth: Map<string, number> | null;
  monthExpenses: DailyExpense[];
  actualTotals: Record<string, number>;
  profiles: Map<string, CategoryProfile>;
  monthlyHistoryByCat: Map<string, number[]>;
  intervalProfiles: Map<string, IntervalProfile>;
  cumulativeProfiles: Map<string, CumulativeProfile>;
}

/** Everything known about one category on one check-day. */
interface CheckpointContext {
  month: MonthContext;
  day: number;
  cat: CategoryConfig;
  catKey: string;
  budget: number;
  actual: number;
  actualExceeds: boolean;
  catExpenses: DailyExpense[];
  spentSoFar: number;
  txCount: number;
  daysSinceLastTx: number;
  profile: CategoryProfile | null;
}

function classifyKind(spent: number, budget: number): AlertKind {
  return spent >= budget ? 'factual' : 'prognostic';
}

/** Sum of amounts of one category's expenses up to and including `day`. */
function spentThroughDay(catExpenses: DailyExpense[], day: number): number {
  return catExpenses.filter((e) => e.day <= day).reduce((s, e) => s + e.amount, 0);
}

/** Returns true (and records `day`) when the cooldown for `key` has elapsed. */
function claimAlertSlot(state: BacktestState, key: string, day: number): boolean {
  const lastDay = state.lastAlertDay.get(key) ?? NEVER_FIRED_DAY;
  if (day - lastDay < ALERT_COOLDOWN_DAYS) return false;
  state.lastAlertDay.set(key, day);
  return true;
}

interface AlertFields {
  status: Status;
  kind: AlertKind;
  projected: number;
  budget: number;
  wasCorrect: boolean;
  confidenceRange?: { low: number; high: number } | undefined;
}

function makeAlert(cp: CheckpointContext, fields: AlertFields): AlertEvent {
  const { confidenceRange, ...rest } = fields;
  return {
    month: cp.month.month,
    day: cp.day,
    category: cp.cat.name,
    ...rest,
    actualMonthEnd: Math.round(cp.actual),
    daysRemaining: cp.month.daysPerMonth - cp.day,
    ...(confidenceRange ? { confidenceRange } : {}),
  };
}

/** Per-category month-end totals for the month's expenses. */
function computeActualTotals(
  monthExpenses: DailyExpense[],
  categories: CategoryConfig[],
): Record<string, number> {
  const actualTotals: Record<string, number> = {};
  for (const cat of categories) {
    actualTotals[cat.name] = monthExpenses
      .filter((e) => e.category === cat.name)
      .reduce((s, e) => s + e.amount, 0);
  }
  return actualTotals;
}

/** Monthly totals of months 0..month-1, as profile-builder rows and per-category series. */
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
      historyRows.push({
        category: cat,
        month: `2025-${String(m + 1).padStart(2, '0')}`,
        monthly_total: data.total,
        tx_count: data.count,
      });
      const arr = monthlyHistoryByCat.get(cat) ?? [];
      arr.push(data.total);
      monthlyHistoryByCat.set(cat, arr);
    }
  }
  return { historyRows, monthlyHistoryByCat };
}

function buildMonthContext(
  expenses: DailyExpense[],
  categories: CategoryConfig[],
  month: number,
  daysPerMonth: number,
  budgetByMonth: Map<string, number> | null,
  cumulativeProfiles: Map<string, CumulativeProfile>,
): MonthContext {
  const monthExpenses = expenses.filter((e) => e.month === month);
  const { historyRows, monthlyHistoryByCat } = buildMonthlyHistory(expenses, month);
  return {
    month,
    daysPerMonth,
    budgetByMonth,
    monthExpenses,
    actualTotals: computeActualTotals(monthExpenses, categories),
    profiles: buildCategoryProfiles(historyRows),
    monthlyHistoryByCat,
    // Interval profiles from raw historical expenses
    intervalProfiles: buildIntervalProfilesFromExpenses(expenses, month, daysPerMonth),
    cumulativeProfiles,
  };
}

function buildCheckpoint(mc: MonthContext, cat: CategoryConfig, day: number): CheckpointContext {
  const catExpenses = mc.monthExpenses.filter((e) => e.category === cat.name);
  const dayExpenses = catExpenses.filter((e) => e.day <= day);
  const budget = getBudget(mc.budgetByMonth, cat.name, mc.month, cat.budget);
  const actual = mc.actualTotals[cat.name] ?? 0;

  // Days since last transaction in this category this month
  const lastTxDay = dayExpenses.length > 0 ? Math.max(...dayExpenses.map((e) => e.day)) : 0;

  return {
    month: mc,
    day,
    cat,
    catKey: `${mc.month}:${cat.name}`,
    budget,
    actual,
    actualExceeds: actual > budget,
    catExpenses,
    spentSoFar: dayExpenses.reduce((s, e) => s + e.amount, 0),
    txCount: dayExpenses.length,
    daysSinceLastTx: lastTxDay > 0 ? day - lastTxDay : day,
    profile: mc.profiles.get(cat.name) ?? null,
  };
}

/** Budget=0 categories: one recommendation alert (shared by both algorithms) at most once per 7 days. */
function recordNoBudgetAlert(state: BacktestState, cp: CheckpointContext): void {
  const hasSpending = cp.spentSoFar > 0;
  if (!hasSpending) return;
  if (!claimAlertSlot(state, cp.catKey, cp.day)) return;
  const noBudgetAlert = makeAlert(cp, {
    status: 'warning',
    kind: 'no_budget',
    projected: cp.spentSoFar,
    budget: 0,
    wasCorrect: true,
  });
  state.oldAlerts.push(noBudgetAlert);
  state.hybridAlerts.push(noBudgetAlert);
}

/** Old algorithm: fires EVERY check-day, no escalation suppression. Returns its projection. */
function recordOldAlert(state: BacktestState, cp: CheckpointContext): number {
  const oldProj = oldProjection(cp.spentSoFar, cp.day, cp.month.daysPerMonth);
  const oldSt = oldStatus(cp.spentSoFar, oldProj, cp.budget);
  if (oldSt !== 'on_track') {
    state.oldAlerts.push(
      makeAlert(cp, {
        status: oldSt,
        kind: classifyKind(cp.spentSoFar, cp.budget),
        projected: Math.round(oldProj),
        budget: cp.budget,
        wasCorrect: cp.actualExceeds,
      }),
    );
  }
  return oldProj;
}

/** Unstable cumulative pattern: only factual exceedances, max once per 7 days. */
function recordUnstableFactualAlert(state: BacktestState, cp: CheckpointContext): void {
  const budgetReached = cp.spentSoFar >= cp.budget;
  if (!budgetReached) return;
  if (!claimAlertSlot(state, `unstable:${cp.catKey}`, cp.day)) return;
  state.hybridAlerts.push(
    makeAlert(cp, {
      status: 'exceeded',
      kind: 'factual',
      projected: cp.spentSoFar,
      budget: cp.budget,
      wasCorrect: cp.actualExceeds,
    }),
  );
}

/**
 * Hybrid projection + dynamic threshold + severity-only escalation (fires only if severity
 * increases vs previous highest). Returns the hybrid projection, or null when a suppressed
 * chronic-overspender prognostic alert short-circuits the rest of the checkpoint.
 */
function recordHybridEscalationAlert(state: BacktestState, cp: CheckpointContext): number | null {
  const { profile, spentSoFar, budget, day } = cp;
  const { daysPerMonth } = cp.month;
  const hasActivity = passesActivityGate(cp.txCount, day, daysPerMonth, profile);
  const intProfile = cp.month.intervalProfiles.get(cp.cat.name) ?? undefined;
  const hybridProj = hasActivity
    ? projectCategory(spentSoFar, day, daysPerMonth, profile, cp.daysSinceLastTx, intProfile)
    : spentSoFar;

  const hybSt = hybridStatus(spentSoFar, hybridProj, budget, profile?.cv ?? 0);
  if (hybSt === 'on_track') return hybridProj;

  const prevSev = state.hybridMaxSeverity.get(cp.catKey) ?? 0;
  const curSev = SEVERITY_ORDER[hybSt];
  // Severity-only escalation: fire only if severity increased
  if (curSev <= prevSev) return hybridProj;

  const kind = classifyKind(spentSoFar, budget);
  // Suppress prognostic alerts for chronic overspenders (normal spending exceeds budget) — only factual alerts pass
  const normExceedsBudget = profile !== null && profile.ema > budget;
  if (kind === 'prognostic' && normExceedsBudget) return null;
  state.hybridMaxSeverity.set(cp.catKey, curSev);

  // Bootstrap range for prognostic alerts with enough history
  const history = cp.month.monthlyHistoryByCat.get(cp.cat.name) ?? [];
  const range = kind === 'prognostic' && history.length >= 3 ? bootstrapRange(history) : undefined;
  state.hybridAlerts.push(
    makeAlert(cp, {
      status: hybSt,
      kind,
      projected: Math.round(hybridProj),
      budget,
      wasCorrect: cp.actualExceeds,
      confidenceRange: range,
    }),
  );
  return hybridProj;
}

/** Hybrid alerts for one checkpoint; returns the hybrid projection for MAPE tracking (null = skip rest). */
function recordHybridAlert(state: BacktestState, cp: CheckpointContext): number | null {
  const cumProfile = cp.month.cumulativeProfiles.get(cp.cat.name) ?? null;
  const isUnstable = cumProfile !== null && !cumProfile.isStable && (cp.profile?.monthsOfData ?? 0) >= 3;
  if (!isUnstable) return recordHybridEscalationAlert(state, cp);

  recordUnstableFactualAlert(state, cp);
  return cp.spentSoFar; // For MAPE tracking
}

/**
 * Norm anomaly: spending pace significantly above historical average.
 * Independent of budget — fires even for categories without budget.
 */
function recordNormAnomalyAlert(state: BacktestState, cp: CheckpointContext): void {
  const { profile, spentSoFar, day } = cp;
  const hasNormBaseline = profile && profile.ema > 0 && spentSoFar > 0;
  if (!hasNormBaseline) return;

  const monthProgress = day / cp.month.daysPerMonth;
  const expectedByNow = profile.ema * monthProgress;
  const paceRatio = spentSoFar / expectedByNow;

  // Fire if pace >= 1.5x norm AND haven't fired in last 7 days for this cat-month
  const isPaceSpike = paceRatio >= 1.5 && claimAlertSlot(state, `norm:${cp.catKey}`, day);
  if (!isPaceSpike) return;
  state.hybridAlerts.push(
    makeAlert(cp, {
      status: paceRatio >= 3 ? 'critical' : 'warning',
      kind: 'norm_anomaly',
      projected: Math.round(spentSoFar / monthProgress),
      budget: cp.budget,
      wasCorrect: cp.actual > profile.ema * 1.3, // TP if month-end actually above norm
    }),
  );
}

/**
 * Velocity spike: day-over-day spending acceleration.
 * Only for Hybrid, max once per category per month.
 */
function recordVelocitySpikeAlert(state: BacktestState, cp: CheckpointContext): void {
  const { spentSoFar, day } = cp;
  const isMaterialSpending = spentSoFar > 20;
  if (!isMaterialSpending) return;
  const velocityKey = `velocity:${cp.catKey}`;
  if (state.lastAlertDay.has(velocityKey)) return;

  // Find previous checkpoint's spent
  const cpIndex = CHECK_DAYS.indexOf(day);
  if (cpIndex <= 0) return;
  const prevDay = CHECK_DAYS[cpIndex - 1]!;
  const prevSpent = spentThroughDay(cp.catExpenses, prevDay);
  const paceToday = (spentSoFar - prevSpent) / (day - prevDay);
  const pacePrev = prevDay > 0 ? prevSpent / prevDay : 0;
  const isAccelerating = pacePrev > 0 && paceToday > pacePrev * 1.5;
  if (!isAccelerating) return;

  state.lastAlertDay.set(velocityKey, day);
  state.hybridAlerts.push(
    makeAlert(cp, {
      status: 'warning',
      kind: 'velocity_spike',
      projected: Math.round((spentSoFar / day) * cp.month.daysPerMonth),
      budget: cp.budget,
      wasCorrect: cp.actual > (cp.profile?.ema ?? cp.budget),
    }),
  );
}

function runCheckpoint(state: BacktestState, mc: MonthContext, cat: CategoryConfig, day: number): void {
  const cp = buildCheckpoint(mc, cat, day);

  if (cp.budget <= 0) {
    recordNoBudgetAlert(state, cp);
    return;
  }

  const oldProj = recordOldAlert(state, cp);
  const hybridProj = recordHybridAlert(state, cp);
  if (hybridProj === null) return;

  recordNormAnomalyAlert(state, cp);
  recordVelocitySpikeAlert(state, cp);

  // Track MAPE at checkpoints
  if (cp.actual > 0) {
    state.accuracy.push({
      day,
      oldError: Math.abs(oldProj - cp.actual) / cp.actual,
      hybridError: Math.abs(hybridProj - cp.actual) / cp.actual,
    });
  }
}

function runBacktest(
  expenses: DailyExpense[],
  categories: CategoryConfig[],
  months: number,
  daysPerMonth: number,
  budgetByMonth?: Map<string, number>,
): BacktestResult {
  const state: BacktestState = {
    oldAlerts: [],
    hybridAlerts: [],
    accuracy: [],
    totalCheckDays: 0,
    hybridMaxSeverity: new Map(),
    lastAlertDay: new Map(),
  };

  // Build cumulative profiles from all expenses (history perspective shifts per month)
  const cumulativeProfiles = buildCumulativeProfiles(expenses);

  for (let month = 0; month < months; month++) {
    const mc = buildMonthContext(
      expenses,
      categories,
      month,
      daysPerMonth,
      budgetByMonth ?? null,
      cumulativeProfiles,
    );

    // Reset hybrid severity tracking per month
    state.hybridMaxSeverity.clear();

    for (const day of CHECK_DAYS) {
      state.totalCheckDays++;
      for (const cat of categories) {
        runCheckpoint(state, mc, cat, day);
      }
    }
  }

  return {
    oldAlerts: state.oldAlerts,
    hybridAlerts: state.hybridAlerts,
    accuracy: state.accuracy,
    totalCheckDays: state.totalCheckDays,
  };
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
    if (!latestBudget.has(b.category))
      latestBudget.set(b.category, convertCurrency(b.limit_amount, b.currency as CurrencyCode, 'EUR'));
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

  printLine(`Loading real data from ${dbPath} for group ${groupId}...\n`);
  const { expenses, categories, months, budgetByMonth } = loadRealData(dbPath, groupId);
  printLine(`Loaded ${expenses.length} expenses, ${categories.length} categories, ${months} months\n`);

  const result = runBacktest(expenses, categories, months, DAYS_PER_MONTH, budgetByMonth);
  printReport(result, categories, months);
} else {
  printLine('Generating spending data with 5 random seeds...\n');
  printLine('Tip: use --real --group-id=N --db=path/to/expenses.db for real data\n');

  const seeds = [42, 137, 256, 1001, 7777];
  let allOldAlerts: AlertEvent[] = [];
  let allHybridAlerts: AlertEvent[] = [];
  let allAccuracy: AccuracyPoint[] = [];
  let totalCheckDays = 0;

  for (const seed of seeds) {
    const data = generateSpendingData(seed);
    const result = runBacktest(data, CATEGORIES, SYNTH_MONTHS, DAYS_PER_MONTH);
    allOldAlerts = allOldAlerts.concat(result.oldAlerts);
    allHybridAlerts = allHybridAlerts.concat(result.hybridAlerts);
    allAccuracy = allAccuracy.concat(result.accuracy);
    totalCheckDays += result.totalCheckDays;
  }

  printReport(
    { oldAlerts: allOldAlerts, hybridAlerts: allHybridAlerts, accuracy: allAccuracy, totalCheckDays },
    CATEGORIES,
    SYNTH_MONTHS * seeds.length,
  );
}
