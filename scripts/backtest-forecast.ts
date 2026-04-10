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

// ═══════════════════════════════════════════════════════════════
// Inlined types and functions (avoid importing full module tree)
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

/** Activity gate: skip projection if not enough transactions this month */
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
  /** Average fraction of monthly total spent by each checkpoint day */
  fractionsByDay: Map<number, number>;
  /** Whether the profile is stable enough (CV < 0.3 at most checkpoints) */
  isStable: boolean;
}

const CHECK_DAYS = [5, 10, 15, 20, 25];

/** Build cumulative spending profile from historical daily expenses */
function buildCumulativeProfiles(
  expenses: DailyExpense[],
): Map<string, CumulativeProfile> {
  const profiles = new Map<string, CumulativeProfile>();

  // Group expenses by category
  const byCategory = new Map<string, DailyExpense[]>();
  for (const e of expenses) {
    const arr = byCategory.get(e.category) ?? [];
    arr.push(e);
    byCategory.set(e.category, arr);
  }

  for (const [category, catExpenses] of byCategory) {
    // Build per-month cumulative fractions at each checkpoint
    const monthFractions = new Map<number, number[]>(); // checkDay -> fraction[]
    for (const cp of CHECK_DAYS) {
      monthFractions.set(cp, []);
    }

    const monthsWithData = new Set<number>();
    for (const e of catExpenses) monthsWithData.add(e.month);

    if (monthsWithData.size < 3) continue; // Need >= 3 months

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

    // Compute average fractions and check stability
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

    // Stable if CV < 0.3 at most (>= 3 out of 5) checkpoints
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
  const projected = alpha * paceBased + (1 - alpha) * historyBased;
  return Math.round(projected * 100) / 100;
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

type Status = 'on_track' | 'warning' | 'critical' | 'exceeded';
type AlertKind = 'factual' | 'prognostic' | 'no_budget' | 'norm_anomaly' | 'velocity_spike';

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
// Alert event with kind classification
// ═══════════════════════════════════════════════════════════════

interface AlertEvent {
  month: number;
  day: number;
  category: string;
  status: Status;
  kind: AlertKind;
  projected: number;
  budget: number;
  actualMonthEnd: number;
  wasCorrect: boolean;
  daysRemaining: number;
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
  // Organize: category → sorted list of { normalizedMonth, amount in EUR }
  const byCat = new Map<string, { month: string; amount: number }[]>();
  for (const b of budgetRows) {
    const norm = normalizeMonth(b.month);
    const arr = byCat.get(b.category) ?? [];
    arr.push({ month: norm, amount: toEur(b.limit_amount, b.currency) });
    byCat.set(b.category, arr);
  }
  // Sort each category's budgets by month ascending
  for (const arr of byCat.values()) {
    arr.sort((a, b) => a.month.localeCompare(b.month));
  }

  const lookup = new Map<string, number>();
  for (let i = 0; i < sortedMonths.length; i++) {
    const ym = sortedMonths[i]!;
    for (const [cat, budgets] of byCat) {
      // Find exact match or closest previous month's budget
      let bestAmount: number | null = null;
      for (const entry of budgets) {
        if (entry.month <= ym) bestAmount = entry.amount;
        else break; // budgets sorted ascending, no need to continue
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
// Backtesting engine
// ═══════════════════════════════════════════════════════════════

interface AccuracyPoint {
  day: number;
  oldError: number;
  hybridError: number;
}

interface BacktestResult {
  oldAlerts: AlertEvent[];
  hybridAlerts: AlertEvent[];
  accuracy: AccuracyPoint[];
  totalCheckDays: number;
}

function runBacktest(
  expenses: DailyExpense[],
  categories: CategoryConfig[],
  months: number,
  daysPerMonth: number,
  budgetByMonth?: Map<string, number>,
): BacktestResult {
  const oldAlerts: AlertEvent[] = [];
  const hybridAlerts: AlertEvent[] = [];
  const accuracy: AccuracyPoint[] = [];
  let totalCheckDays = 0;

  // Hybrid: severity-only escalation tracking
  const hybridMaxSeverity = new Map<string, number>();

  // No-budget alert cooldown: track last no_budget alert day per category-month
  const noBudgetLastDay = new Map<string, number>();

  // Build cumulative profiles from all expenses (history perspective shifts per month)
  const cumulativeProfiles = buildCumulativeProfiles(expenses);

  for (let month = 0; month < months; month++) {
    const monthExpenses = expenses.filter((e) => e.month === month);

    // Actual month-end totals
    const actualTotals: Record<string, number> = {};
    for (const cat of categories) {
      actualTotals[cat.name] = monthExpenses
        .filter((e) => e.category === cat.name)
        .reduce((s, e) => s + e.amount, 0);
    }

    // Build profiles from months 0..month-1
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

    const profiles = buildCategoryProfiles(historyRows);

    // Interval profiles from raw historical expenses
    const intervalProfiles = buildIntervalProfilesFromExpenses(expenses, month, daysPerMonth);

    // Reset hybrid severity tracking per month
    hybridMaxSeverity.clear();

    for (const day of CHECK_DAYS) {
      totalCheckDays++;

      for (const cat of categories) {
        const dayExpenses = monthExpenses.filter((e) => e.category === cat.name && e.day <= day);
        const spentSoFar = dayExpenses.reduce((s, e) => s + e.amount, 0);
        const txCount = dayExpenses.length;
        const actual = actualTotals[cat.name] ?? 0;
        const budget = getBudget(budgetByMonth ?? null, cat.name, month, cat.budget);
        const actualExceeds = actual > budget;
        const daysRemaining = daysPerMonth - day;
        const catKey = `${month}:${cat.name}`;
        const profile = profiles.get(cat.name) ?? null;

        // Budget=0 handling
        if (budget <= 0) {
          if (spentSoFar > 0) {
            const lastDay = noBudgetLastDay.get(catKey) ?? -999;
            // Max once per 7 days (every other checkpoint in 5/10/15/20/25 scheme)
            if (day - lastDay >= 7) {
              noBudgetLastDay.set(catKey, day);
              // Both algorithms produce the same no_budget alert
              const noBudgetAlert: AlertEvent = {
                month, day, category: cat.name, status: 'warning',
                kind: 'no_budget', projected: spentSoFar, budget: 0,
                actualMonthEnd: Math.round(actual), wasCorrect: true,
                daysRemaining,
              };
              oldAlerts.push(noBudgetAlert);
              hybridAlerts.push(noBudgetAlert);
            }
          }
          continue;
        }

        // Classify alert kind
        const classifyKind = (spent: number, bgt: number): AlertKind =>
          spent >= bgt ? 'factual' : 'prognostic';

        // ── Old algorithm: fires EVERY check-day, no escalation suppression ──
        const oldProj = oldProjection(spentSoFar, day, daysPerMonth);
        const oldSt = oldStatus(spentSoFar, oldProj, budget);

        if (oldSt !== 'on_track') {
          oldAlerts.push({
            month, day, category: cat.name, status: oldSt,
            kind: classifyKind(spentSoFar, budget),
            projected: Math.round(oldProj), budget,
            actualMonthEnd: Math.round(actual), wasCorrect: actualExceeds,
            daysRemaining,
          });
        }

        // ── Hybrid: activity gate + hybrid projection + dynamic threshold + severity escalation ──
        const cv = profile?.cv ?? 0;
        const hasActivity = passesActivityGate(txCount, day, daysPerMonth, profile);
        const history = monthlyHistoryByCat.get(cat.name) ?? [];
        const cumProfile = cumulativeProfiles.get(cat.name) ?? null;
        const intProfile = intervalProfiles.get(cat.name) ?? undefined;

        // Compute days since last transaction in this category this month
        const lastTxDay = dayExpenses.length > 0
          ? Math.max(...dayExpenses.map((e) => e.day))
          : 0;
        const daysSinceLastTx = lastTxDay > 0 ? day - lastTxDay : day;

        // For unstable cumulative profiles, only report factual exceedances (max once per 7 days)
        const isUnstable = cumProfile !== null && !cumProfile.isStable && (profile?.monthsOfData ?? 0) >= 3;

        // Suppress prognostic alerts when normal spending exceeds budget (chronic overspender)
        const normExceedsBudget = profile !== null && profile.ema > budget;

        let hybridProj: number;
        if (isUnstable) {
          // Unstable pattern: only factual alerts
          if (spentSoFar >= budget) {
            const lastFact = noBudgetLastDay.get(`unstable:${catKey}`) ?? -999;
            if (day - lastFact >= 7) {
              noBudgetLastDay.set(`unstable:${catKey}`, day);
              hybridAlerts.push({
                month, day, category: cat.name, status: 'exceeded',
                kind: 'factual', projected: spentSoFar, budget,
                actualMonthEnd: Math.round(actual), wasCorrect: actualExceeds,
                daysRemaining,
              });
            }
          }
          hybridProj = spentSoFar; // For MAPE tracking
        } else {
          hybridProj = hasActivity
            ? hybridProjection(spentSoFar, day, daysPerMonth, profile, daysSinceLastTx, intProfile)
            : spentSoFar;

          const hybSt = hybridStatus(spentSoFar, hybridProj, budget, cv);

          if (hybSt !== 'on_track') {
            const prevSev = hybridMaxSeverity.get(catKey) ?? 0;
            const curSev = SEVERITY_ORDER[hybSt];
            // Severity-only escalation: fire only if severity increased
            if (curSev > prevSev) {
              const kind = classifyKind(spentSoFar, budget);
              // Suppress prognostic alerts for chronic overspenders — only factual alerts pass
              if (kind === 'prognostic' && normExceedsBudget) continue;
              hybridMaxSeverity.set(catKey, curSev);
              // Compute bootstrap range for prognostic alerts with enough history
              const range = kind === 'prognostic' && history.length >= 3
                ? bootstrapRange(history)
                : undefined;
              hybridAlerts.push({
                month, day, category: cat.name, status: hybSt,
                kind, projected: Math.round(hybridProj), budget,
                actualMonthEnd: Math.round(actual), wasCorrect: actualExceeds,
                daysRemaining,
                ...(range ? { confidenceRange: range } : {}),
              });
            }
          }
        }

        // Norm anomaly: spending pace significantly above historical average
        // Independent of budget — fires even for categories without budget
        if (profile && profile.ema > 0 && spentSoFar > 0) {
          const monthProgress = day / daysPerMonth;
          const expectedByNow = profile.ema * monthProgress;
          const paceRatio = spentSoFar / expectedByNow;
          const normAnomalyKey = `norm:${catKey}`;
          const lastNormDay = noBudgetLastDay.get(normAnomalyKey) ?? -999;

          // Fire if pace >= 1.5x norm AND haven't fired in last 7 days for this cat-month
          if (paceRatio >= 1.5 && (day - lastNormDay >= 7)) {
            noBudgetLastDay.set(normAnomalyKey, day);
            const anomalyStatus: Status = paceRatio >= 3 ? 'critical' : 'warning';
            hybridAlerts.push({
              month, day, category: cat.name, status: anomalyStatus,
              kind: 'norm_anomaly',
              projected: Math.round(spentSoFar / monthProgress),
              budget, actualMonthEnd: Math.round(actual),
              wasCorrect: actual > profile.ema * 1.3, // TP if month-end actually above norm
              daysRemaining: daysPerMonth - day,
            });
          }
        }

        // Velocity spike: day-over-day spending acceleration
        // Only for Hybrid, max once per category per month
        if (spentSoFar > 20) {
          const velocityKey = `velocity:${catKey}`;
          const alreadyFired = noBudgetLastDay.has(velocityKey);
          if (!alreadyFired) {
            // Find previous checkpoint's spent
            const cpIndex = CHECK_DAYS.indexOf(day);
            if (cpIndex > 0) {
              const prevDay = CHECK_DAYS[cpIndex - 1]!;
              const prevSpent = monthExpenses
                .filter((e) => e.category === cat.name && e.day <= prevDay)
                .reduce((s, e) => s + e.amount, 0);
              const paceToday = (spentSoFar - prevSpent) / (day - prevDay);
              const pacePrev = prevDay > 0 ? prevSpent / prevDay : 0;
              if (pacePrev > 0 && paceToday > pacePrev * 1.5) {
                noBudgetLastDay.set(velocityKey, day);
                hybridAlerts.push({
                  month, day, category: cat.name, status: 'warning',
                  kind: 'velocity_spike',
                  projected: Math.round((spentSoFar / day) * daysPerMonth),
                  budget, actualMonthEnd: Math.round(actual),
                  wasCorrect: actual > (profile?.ema ?? budget),
                  daysRemaining: daysPerMonth - day,
                });
              }
            }
          }
        }

        // Track MAPE at checkpoints
        if (actual > 0) {
          accuracy.push({
            day,
            oldError: Math.abs(oldProj - actual) / actual,
            hybridError: Math.abs(hybridProj - actual) / actual,
          });
        }
      }
    }
  }

  return { oldAlerts, hybridAlerts, accuracy, totalCheckDays };
}

// ═══════════════════════════════════════════════════════════════
// Report
// ═══════════════════════════════════════════════════════════════

interface AlertStats {
  totalRaw: number;
  factual: number;
  prognostic: number;
  noBudget: number;
  normAnomaly: number;
  velocitySpike: number;
  prognosticTP: number;
  prognosticFP: number;
  prognosticPrecision: number;
  alertDaysPerMonth: number;
  usefulAlertRate: number;
  avgDetectionDay: number;
  signalQuality: number;
  rangeCoverage: number;
  byCat: Record<string, { tp: number; fp: number; total: number }>;
}

function computeStats(alerts: AlertEvent[], totalMonths: number, totalCatMonths: number): AlertStats {
  const factualAlerts = alerts.filter((a) => a.kind === 'factual');
  // Only critical/exceeded prognostic alerts count as predictions.
  // Warning = "approaching limit" (info), not "will exceed" (prediction).
  const prognosticAlerts = alerts.filter(
    (a) => a.kind === 'prognostic' && (a.status === 'critical' || a.status === 'exceeded') && a.day > 5,
  );
  const noBudgetAlerts = alerts.filter((a) => a.kind === 'no_budget');
  const normAnomalyAlerts = alerts.filter((a) => a.kind === 'norm_anomaly');
  const velocitySpikeAlerts = alerts.filter((a) => a.kind === 'velocity_spike');

  // Prognostic precision: deduplicate by category-month (first alert per cat-month)
  const progUnique = new Map<string, AlertEvent>();
  for (const a of prognosticAlerts) {
    const key = `${a.month}:${a.category}`;
    if (!progUnique.has(key)) progUnique.set(key, a);
  }
  const progDeduped = [...progUnique.values()];
  const progTP = progDeduped.filter((a) => a.wasCorrect).length;
  const progFP = progDeduped.filter((a) => !a.wasCorrect).length;
  // No prognostic alerts = neutral (0.5), not "all wrong" (0)
  const progPrecision = progDeduped.length > 0 ? progTP / progDeduped.length : 0.5;

  // Deduplicate all non-informational alerts by category-month
  const allUnique = new Map<string, AlertEvent>();
  for (const a of alerts) {
    if (a.kind === 'no_budget' || a.kind === 'norm_anomaly' || a.kind === 'velocity_spike') continue;
    const key = `${a.month}:${a.category}`;
    if (!allUnique.has(key)) allUnique.set(key, a);
  }
  const deduped = [...allUnique.values()];
  const alertDensity = totalCatMonths > 0 ? deduped.length / totalCatMonths : 0;

  // Alert days per month: fraction of months where at least one alert fires
  const monthsWithAlerts = new Set<number>();
  for (const a of alerts) {
    if (a.kind !== 'no_budget') monthsWithAlerts.add(a.month);
  }
  const alertDaysPerMonth = totalMonths > 0 ? monthsWithAlerts.size / totalMonths : 0;

  // Useful alert rate: prognostic + daysRemaining > 5
  const usefulAlerts = prognosticAlerts.filter((a) => a.daysRemaining > 5);
  const usefulAlertRate = alerts.length > 0 ? usefulAlerts.length / alerts.length : 0;

  // Avg detection day for TPs
  const progTPs = progDeduped.filter((a) => a.wasCorrect);
  const progFPs = progDeduped.filter((a) => !a.wasCorrect);
  const tpDays = progTPs.map((a) => a.day);
  const avgDetectionDay = tpDays.length > 0 ? tpDays.reduce((s, d) => s + d, 0) / tpDays.length : 0;

  // Actionability: only prognostic TPs with enough time to react
  const actionableProgTPs = progTPs.filter((a) => a.daysRemaining > 5);
  const actionabilityRate = progTPs.length > 0 ? actionableProgTPs.length / progTPs.length : 1;

  // Timeliness: earlier correct prognostic alerts score higher
  const timelinessScore = progTPs.length > 0
    ? progTPs.reduce((s, a) => s + a.daysRemaining / DAYS_PER_MONTH, 0) / progTPs.length
    : 0;

  // FP penalty: penalize if >10% of category-months have false positive prognoses
  const fpPenalty = Math.max(0, 1 - progFPs.length / Math.max(1, totalCatMonths * 0.1));

  // Severity accuracy
  let severityMatches = 0;
  for (const a of deduped) {
    const actualSev = a.actualMonthEnd >= a.budget * 1.15 ? 'exceeded'
      : a.actualMonthEnd >= a.budget ? 'critical'
      : a.actualMonthEnd >= a.budget * 0.85 ? 'warning'
      : 'on_track';
    if (a.status === actualSev) severityMatches += 1;
    else if (
      (a.status === 'warning' && actualSev === 'critical') ||
      (a.status === 'critical' && actualSev === 'warning') ||
      (a.status === 'critical' && actualSev === 'exceeded') ||
      (a.status === 'exceeded' && actualSev === 'critical')
    ) severityMatches += 0.5;
  }
  const severityAccuracy = deduped.length > 0 ? severityMatches / deduped.length : 1;

  // Alert fatigue penalty: >5 alerts/month = fatigue, users stop reading
  const alertsPerMonth = totalMonths > 0 ? (alerts.length - noBudgetAlerts.length - normAnomalyAlerts.length - velocitySpikeAlerts.length) / totalMonths : 0;
  const fatiguePenalty = Math.max(0, 1 - alertsPerMonth / 10); // 0 alerts=1.0, 10/month=0, 20/month=0

  // Signal quality composite
  const densityPenalty = Math.max(0, 1 - alertDensity * 2);
  const signalQuality =
    0.25 * progPrecision +
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

  // By category
  const byCat: Record<string, { tp: number; fp: number; total: number }> = {};
  for (const a of progDeduped) {
    if (!byCat[a.category]) byCat[a.category] = { tp: 0, fp: 0, total: 0 };
    byCat[a.category]!.total++;
    if (a.wasCorrect) byCat[a.category]!.tp++;
    else byCat[a.category]!.fp++;
  }

  return {
    totalRaw: alerts.length,
    factual: factualAlerts.length,
    prognostic: prognosticAlerts.length,
    noBudget: noBudgetAlerts.length,
    normAnomaly: normAnomalyAlerts.length,
    velocitySpike: velocitySpikeAlerts.length,
    prognosticTP: progTP,
    prognosticFP: progFP,
    prognosticPrecision: progPrecision,
    alertDaysPerMonth,
    usefulAlertRate,
    avgDetectionDay,
    signalQuality,
    rangeCoverage,
    byCat,
  };
}

function printReport(
  result: BacktestResult,
  categories: CategoryConfig[],
  months: number,
) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BACKTEST: Old (raw production) vs Hybrid (all improvements)');
  console.log(`  ${months} months × ${categories.length} categories × ${DAYS_PER_MONTH} days`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const budgetedCats = categories.filter((c) => c.budget > 0);
  const totalCatMonths = months * budgetedCats.length;
  const oldStats = computeStats(result.oldAlerts, months, totalCatMonths);
  const hybridStats = computeStats(result.hybridAlerts, months, totalCatMonths);

  // Main comparison table
  console.log('┌──────────────────────────────┬──────────────┬────────────────┐');
  console.log('│ Метрика                      │ Old (prod)   │ Hybrid         │');
  console.log('├──────────────────────────────┼──────────────┼────────────────┤');
  console.log(`│ Total alerts shown           │ ${String(oldStats.totalRaw).padStart(12)} │ ${String(hybridStats.totalRaw).padStart(14)} │`);
  console.log(`│   Factual (spent>=budget)    │ ${String(oldStats.factual).padStart(12)} │ ${String(hybridStats.factual).padStart(14)} │`);
  console.log(`│   Prognostic (projected)     │ ${String(oldStats.prognostic).padStart(12)} │ ${String(hybridStats.prognostic).padStart(14)} │`);
  console.log(`│   No-budget recommendations  │ ${String(oldStats.noBudget).padStart(12)} │ ${String(hybridStats.noBudget).padStart(14)} │`);
  console.log(`│   Norm anomaly               │ ${String(oldStats.normAnomaly).padStart(12)} │ ${String(hybridStats.normAnomaly).padStart(14)} │`);
  console.log(`│   Velocity spike             │ ${String(oldStats.velocitySpike).padStart(12)} │ ${String(hybridStats.velocitySpike).padStart(14)} │`);
  console.log('├──────────────────────────────┼──────────────┼────────────────┤');
  console.log(`│ Prognostic TP                │ ${String(oldStats.prognosticTP).padStart(12)} │ ${String(hybridStats.prognosticTP).padStart(14)} │`);
  console.log(`│ Prognostic FP                │ ${String(oldStats.prognosticFP).padStart(12)} │ ${String(hybridStats.prognosticFP).padStart(14)} │`);
  console.log(`│ Prognostic precision         │ ${(oldStats.prognosticPrecision * 100).toFixed(1).padStart(11)}% │ ${(hybridStats.prognosticPrecision * 100).toFixed(1).padStart(13)}% │`);
  console.log('├──────────────────────────────┼──────────────┼────────────────┤');
  console.log(`│ Signal quality (0-1)         │ ${oldStats.signalQuality.toFixed(3).padStart(12)} │ ${hybridStats.signalQuality.toFixed(3).padStart(14)} │`);
  console.log(`│ Range coverage               │ ${(oldStats.rangeCoverage * 100).toFixed(1).padStart(11)}% │ ${(hybridStats.rangeCoverage * 100).toFixed(1).padStart(13)}% │`);
  console.log('├──────────────────────────────┼──────────────┼────────────────┤');
  console.log(`│ Alert days / month           │ ${(oldStats.alertDaysPerMonth * 100).toFixed(1).padStart(11)}% │ ${(hybridStats.alertDaysPerMonth * 100).toFixed(1).padStart(13)}% │`);
  console.log(`│ Useful alert rate            │ ${(oldStats.usefulAlertRate * 100).toFixed(1).padStart(11)}% │ ${(hybridStats.usefulAlertRate * 100).toFixed(1).padStart(13)}% │`);
  console.log(`│ Avg TP detection day         │ ${oldStats.avgDetectionDay.toFixed(1).padStart(12)} │ ${hybridStats.avgDetectionDay.toFixed(1).padStart(14)} │`);
  console.log('└──────────────────────────────┴──────────────┴────────────────┘\n');

  // Noise reduction summary
  if (oldStats.totalRaw > 0) {
    const showReduction = ((oldStats.totalRaw - hybridStats.totalRaw) / oldStats.totalRaw * 100);
    console.log(`→ Показов пользователю: ${oldStats.totalRaw} → ${hybridStats.totalRaw} (−${showReduction.toFixed(0)}%)`);
  }
  if (oldStats.prognosticFP > 0) {
    const fpReduction = ((oldStats.prognosticFP - hybridStats.prognosticFP) / oldStats.prognosticFP * 100);
    console.log(`→ Ложных прогнозов: ${oldStats.prognosticFP} → ${hybridStats.prognosticFP} (−${fpReduction.toFixed(0)}%)`);
  }

  // By category (prognostic only)
  console.log('\n┌───────────────────────────────────────────────────────────────────┐');
  console.log('│ ПО КАТЕГОРИЯМ (prognostic alerts: TP / FP)                       │');
  console.log('├──────────────┬───────────────────┬────────────────────────────────┤');
  console.log('│ Категория    │ Old (TP / FP)     │ Hybrid (TP / FP)              │');
  console.log('├──────────────┼───────────────────┼────────────────────────────────┤');

  for (const cat of categories) {
    if (cat.budget <= 0) continue;
    const oldCat = oldStats.byCat[cat.name] ?? { tp: 0, fp: 0, total: 0 };
    const hybridCat = hybridStats.byCat[cat.name] ?? { tp: 0, fp: 0, total: 0 };
    const label = cat.name.padEnd(12);
    console.log(`│ ${label} │ ${`${oldCat.tp} / ${oldCat.fp}`.padStart(17)} │ ${`${hybridCat.tp} / ${hybridCat.fp}`.padStart(30)} │`);
  }
  console.log('└──────────────┴───────────────────┴────────────────────────────────┘\n');

  // No-budget recommendation summary
  const noBudgetCats = categories.filter((c) => c.budget <= 0);
  if (noBudgetCats.length > 0) {
    const noBudgetHybridAlerts = result.hybridAlerts.filter((a) => a.kind === 'no_budget');
    console.log(`Budget recommendation alerts (budget=0 categories): ${noBudgetHybridAlerts.length}`);
    for (const cat of noBudgetCats) {
      const catAlerts = noBudgetHybridAlerts.filter((a) => a.category === cat.name);
      console.log(`  ${cat.name}: ${catAlerts.length} alerts across ${months} months`);
    }
    console.log('');
  }

  // MAPE by checkpoint day
  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│ ТОЧНОСТЬ ПРОГНОЗА (MAPE — средняя абсолютная ошибка %) │');
  console.log('├────────────────────────┬──────────────┬────────────────┤');
  console.log('│ День месяца            │ Old (linear) │ Hybrid         │');
  console.log('├────────────────────────┼──────────────┼────────────────┤');

  let totalOldError = 0;
  let totalHybridError = 0;
  let totalCount = 0;

  for (const cp of CHECK_DAYS) {
    const points = result.accuracy.filter((a) => a.day === cp);
    if (points.length === 0) continue;
    const oldMAPE = (points.reduce((s, p) => s + p.oldError, 0) / points.length) * 100;
    const hybridMAPE = (points.reduce((s, p) => s + p.hybridError, 0) / points.length) * 100;
    totalOldError += points.reduce((s, p) => s + p.oldError, 0);
    totalHybridError += points.reduce((s, p) => s + p.hybridError, 0);
    totalCount += points.length;
    console.log(`│ Day ${String(cp).padEnd(18)} │ ${oldMAPE.toFixed(1).padStart(11)}% │ ${hybridMAPE.toFixed(1).padStart(13)}% │`);
  }

  const overallOldMAPE = totalCount > 0 ? (totalOldError / totalCount) * 100 : 0;
  const overallHybridMAPE = totalCount > 0 ? (totalHybridError / totalCount) * 100 : 0;
  console.log('├────────────────────────┼──────────────┼────────────────┤');
  console.log(`│ Overall MAPE           │ ${overallOldMAPE.toFixed(1).padStart(11)}% │ ${overallHybridMAPE.toFixed(1).padStart(13)}% │`);
  console.log('└────────────────────────┴──────────────┴────────────────┘\n');

  // Verdict
  console.log('══════════════════════════════');
  console.log('  ВЕРДИКТ');
  console.log('══════════════════════════════\n');

  const mapeChange = overallOldMAPE > 0 ? ((overallOldMAPE - overallHybridMAPE) / overallOldMAPE * 100) : 0;

  console.log(`Signal Quality: Old=${oldStats.signalQuality.toFixed(3)} → Hybrid=${hybridStats.signalQuality.toFixed(3)}`);
  console.log(`Prognostic precision: ${(oldStats.prognosticPrecision * 100).toFixed(0)}% → ${(hybridStats.prognosticPrecision * 100).toFixed(0)}%`);
  console.log(`Total alerts: ${oldStats.totalRaw} → ${hybridStats.totalRaw} (−${oldStats.totalRaw > 0 ? ((oldStats.totalRaw - hybridStats.totalRaw) / oldStats.totalRaw * 100).toFixed(0) : 0}%)`);
  console.log(`Useful alert rate: ${(oldStats.usefulAlertRate * 100).toFixed(0)}% → ${(hybridStats.usefulAlertRate * 100).toFixed(0)}%`);
  console.log(`Range coverage: ${(oldStats.rangeCoverage * 100).toFixed(0)}% → ${(hybridStats.rangeCoverage * 100).toFixed(0)}%`);
  console.log(`MAPE: ${mapeChange > 0 ? '−' : '+'}${Math.abs(mapeChange).toFixed(0)}% (${overallOldMAPE.toFixed(1)}% → ${overallHybridMAPE.toFixed(1)}%)`);
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

  const result = runBacktest(expenses, categories, months, DAYS_PER_MONTH, budgetByMonth);
  printReport(result, categories, months);
} else {
  console.log('Generating spending data with 5 random seeds...\n');
  console.log('Tip: use --real --group-id=N --db=path/to/expenses.db for real data\n');

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
