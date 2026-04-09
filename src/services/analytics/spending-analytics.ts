/** Spending analytics — computes financial snapshots with trends, anomalies, and budget burn rates */
import {
  differenceInDays,
  format,
  getDaysInMonth,
  parseISO,
  startOfMonth,
  subDays,
  subMonths,
} from 'date-fns';
import { BASE_CURRENCY, type CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import { convertCurrency } from '../currency/converter';
import type { CategoryTaAnalysis } from './ta/analyzer';

import { analyzeCategory } from './ta/analyzer';
import { categoryCorrelation } from './ta/pattern';
import type { CorrelationResult } from './ta/types';
import type {
  BudgetBurnRate,
  BudgetUtilization,
  CategoryAnomaly,
  CategoryChange,
  CategoryProfile,
  CategoryProjection,
  DayOfWeekPattern,
  FinancialSnapshot,
  IntervalProfile,
  MonthlyProjection,
  SpendingStreak,
  SpendingTrend,
  SpendingVelocity,
  TechnicalAnalysis,
} from './types';

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/** Number of historical months to look back for category profiles */
const HISTORY_MONTHS = 6;

/**
 * Build per-category statistical profiles from monthly history.
 *
 * For each category computes:
 * - EMA (exponential moving average) of monthly totals — weights recent months more
 * - CV (coefficient of variation = stddev / mean) — measures spending regularity
 * - Average transaction count per month
 */
export function buildCategoryProfiles(
  historyRows: { category: string; month: string; monthly_total: number; tx_count: number }[],
): Map<string, CategoryProfile> {
  // Group rows by category (rows arrive sorted by category, month from SQL ORDER BY)
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

    // EMA: α = 2/(N+1), applied chronologically (oldest first)
    const alpha = 2 / (n + 1);
    let ema = totals[0] ?? 0;
    for (let i = 1; i < n; i++) {
      ema = alpha * (totals[i] ?? 0) + (1 - alpha) * ema;
    }

    // Mean and stddev for CV
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

/** Max gap between transactions (days) before treating as an outlier in interval computation */
const MAX_INTERVAL_DAYS = 90;

/** Minimum number of valid intervals to compute an interval profile */
const MIN_INTERVALS = 3;

/** CV threshold below which an interval profile is considered stable */
const INTERVAL_CV_THRESHOLD = 0.4;

/**
 * Build per-category interval profiles from raw transaction-level data.
 *
 * Detects cycle-based spending patterns (e.g., car refueling every ~21 days,
 * salon every ~6 weeks) by analyzing intervals between consecutive transactions.
 * Categories with stable intervals get a profile used for more accurate projection.
 */
export function buildIntervalProfiles(
  transactions: { date: string; category: string; amount: number }[],
): Map<string, IntervalProfile> {
  // Group by category
  const byCategory = new Map<string, { date: string; amount: number }[]>();
  for (const tx of transactions) {
    const arr = byCategory.get(tx.category) ?? [];
    arr.push({ date: tx.date, amount: tx.amount });
    byCategory.set(tx.category, arr);
  }

  const profiles = new Map<string, IntervalProfile>();

  for (const [category, txList] of byCategory) {
    // Sort by date ascending
    txList.sort((a, b) => a.date.localeCompare(b.date));

    // Compute intervals between consecutive transactions
    const intervals: number[] = [];
    const amounts: number[] = [];
    for (let i = 1; i < txList.length; i++) {
      const days = differenceInDays(parseISO(txList[i]!.date), parseISO(txList[i - 1]!.date));
      // Filter out outlier gaps (e.g., category not used for 3+ months)
      if (days > MAX_INTERVAL_DAYS) continue;
      // Filter out same-day transactions (multiple items on one receipt)
      if (days <= 0) continue;
      intervals.push(days);
    }

    if (intervals.length < MIN_INTERVALS) continue;

    // Collect amounts for avg computation (all transactions, not just interval-paired)
    for (const tx of txList) {
      amounts.push(tx.amount);
    }

    const avgInterval = intervals.reduce((s, v) => s + v, 0) / intervals.length;
    const variance = intervals.reduce((s, v) => s + (v - avgInterval) ** 2, 0) / intervals.length;
    const stddev = Math.sqrt(variance);
    const intervalCv = avgInterval > 0 ? stddev / avgInterval : 999;

    const avgAmount = amounts.reduce((s, v) => s + v, 0) / amounts.length;

    profiles.set(category, {
      avgInterval: Math.round(avgInterval * 100) / 100,
      intervalCv: Math.round(intervalCv * 1000) / 1000,
      avgAmount: Math.round(avgAmount * 100) / 100,
      // Only for low-frequency categories (≥5 day intervals): refueling, salon, etc.
      // High-frequency (daily groceries) should use monthly EMA, not interval-based.
      isStable: intervalCv < INTERVAL_CV_THRESHOLD && avgInterval >= 5,
    });
  }

  return profiles;
}

/**
 * Activity gate: skip projection if not enough transactions this month.
 *
 * Two-tier gate:
 * - Sparse categories (avgTx < 5/month): need at least 2 tx (prevents one-off false alarms)
 * - Frequent categories (avgTx ≥ 5): need at least 30% of expected tx by this day
 *   (not 100% — avoids gate being too strict due to outlier high-tx months)
 */
export function passesActivityGate(
  txCountThisMonth: number,
  daysElapsed: number,
  daysInMonth: number,
  profile: CategoryProfile | null,
): boolean {
  if (txCountThisMonth === 0) return false;

  if (!profile) return txCountThisMonth >= 2;

  if (profile.avgTxPerMonth < 5) {
    // Sparse: just need 2+ tx to confirm the category is active this month
    return txCountThisMonth >= 2;
  }

  // Frequent: need 30% of expected tx by this point in the month
  const monthProgress = daysElapsed / daysInMonth;
  const expectedTxSoFar = profile.avgTxPerMonth * monthProgress;
  return txCountThisMonth >= Math.max(2, Math.ceil(expectedTxSoFar * 0.3));
}

/**
 * Syntetos-Boylan demand pattern classification.
 * Routes category to the right forecasting algorithm.
 *
 * ADI (Average Demand Interval) = 1 / (1 - zeroMonthRatio)
 * CV² = cv² (squared coefficient of variation)
 *
 * | | ADI < 1.32 | ADI ≥ 1.32 |
 * |---|---|---|
 * | CV² < 0.49 | Smooth → EMA/Holt | Intermittent → Croston SBA |
 * | CV² ≥ 0.49 | Erratic → Median | Lumpy → Quantile P75 |
 */
type DemandPattern = 'smooth' | 'intermittent' | 'erratic' | 'lumpy';

function classifyDemandPattern(profile: CategoryProfile): DemandPattern {
  const adi = profile.zeroMonthRatio > 0 ? 1 / (1 - profile.zeroMonthRatio) : 1;
  const cv2 = profile.cv * profile.cv;

  if (adi >= 1.32 && cv2 >= 0.49) return 'lumpy';
  if (adi >= 1.32) return 'intermittent';
  if (cv2 >= 0.49) return 'erratic';
  return 'smooth';
}

/**
 * Hybrid category projection using Syntetos-Boylan demand classification.
 *
 * Routing:
 * - Stable interval profile → interval-based cycle projection (highest priority)
 * - No history or < 3 months → return currentSpent (not enough data)
 * - Stalled (no tx in last 5+ days after mid-month) → return currentSpent
 * - Smooth → EMA-based blend with CV-adjusted pace trust
 * - Intermittent/Lumpy → Croston-style with activity probability
 * - Erratic → pace-only (no history anchor)
 *
 * daysSinceLastTx: how many days since the last transaction in this category this month.
 * Used for stall detection — if spending stopped, don't extrapolate.
 *
 * intervalProfile: if provided and stable, uses interval-based projection
 * (count expected remaining fills * avg fill amount) instead of S-B routing.
 */
export function projectCategory(
  currentSpent: number,
  daysElapsed: number,
  daysInMonth: number,
  profile: CategoryProfile | null,
  daysSinceLastTx?: number,
  intervalProfile?: IntervalProfile,
): number {
  if (daysElapsed <= 0) return currentSpent;

  const monthProgress = daysElapsed / daysInMonth;

  // Stall detection: if no transactions in 5+ days and we're past 1/3 of month,
  // spending in this category has likely stopped — don't extrapolate
  if (daysSinceLastTx !== undefined && daysSinceLastTx >= 5 && monthProgress > 0.33) {
    return currentSpent;
  }

  // Interval-based cycle projection: more precise for periodic categories
  // (refueling, salon, subscriptions) where monthly total depends on cycle alignment
  if (intervalProfile?.isStable) {
    const daysRemaining = daysInMonth - daysElapsed;
    const daysSinceLast = daysSinceLastTx ?? 0;
    // Time until next expected fill: remaining interval from last tx
    const timeToNextFill = Math.max(0, intervalProfile.avgInterval - daysSinceLast);
    const expectedMoreFills =
      timeToNextFill <= daysRemaining
        ? 1 + Math.floor((daysRemaining - timeToNextFill) / intervalProfile.avgInterval)
        : 0;
    const projected = currentSpent + expectedMoreFills * intervalProfile.avgAmount;
    return Math.max(currentSpent, Math.round(projected * 100) / 100);
  }

  if (!profile || profile.monthsOfData < 3) return currentSpent;

  const pattern = classifyDemandPattern(profile);

  // Lumpy: practically unforecastable (high CV + many zero months) → only factual alerts
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

  if (pattern === 'erratic') {
    const paceBased = (currentSpent / daysElapsed) * daysInMonth;
    return Math.max(currentSpent, Math.round(paceBased * 100) / 100);
  }

  // Smooth: standard EMA blend with CV-adjusted pace trust
  const alpha = Math.min(1, monthProgress * monthProgress * (1 + profile.cv));
  const historyBased = Math.max(currentSpent, profile.ema);
  const paceBased = (currentSpent / daysElapsed) * daysInMonth;
  const projected = alpha * paceBased + (1 - alpha) * historyBased;
  return Math.round(projected * 100) / 100;
}

/**
 * SpendingAnalytics - computes financial metrics from expense data
 * All methods are synchronous (bun:sqlite is synchronous)
 * Uses parameterized dates from JS, not SQLite date('now'), for timezone safety
 */
export class SpendingAnalytics {
  /**
   * Main entry point: compute full financial snapshot for a group
   */
  getFinancialSnapshot(groupId: number): FinancialSnapshot {
    const now = new Date();
    const today = format(now, 'yyyy-MM-dd');
    const currentMonthStr = format(now, 'yyyy-MM');
    const currentMonthStart = format(startOfMonth(now), 'yyyy-MM-dd');

    // Compute category profiles once — used by both burnRates and projection
    const profiles = this.getCategoryProfiles(groupId, now);

    return {
      burnRates: this.computeBurnRates(
        groupId,
        now,
        currentMonthStr,
        currentMonthStart,
        today,
        profiles,
      ),
      weekTrend: this.computeWeekOverWeek(groupId, today),
      monthTrend: this.computeMonthOverMonth(groupId, now, currentMonthStart, today),
      anomalies: this.computeAnomalies(groupId, now, currentMonthStart, today),
      dayOfWeekPatterns: this.computeDayPatterns(groupId, today),
      velocity: this.computeVelocity(groupId, today),
      budgetUtilization: this.computeBudgetUtilization(
        groupId,
        currentMonthStr,
        currentMonthStart,
        today,
      ),
      streak: this.computeStreak(groupId, today),
      projection: this.computeProjection(
        groupId,
        now,
        currentMonthStr,
        currentMonthStart,
        today,
        profiles,
      ),
      technicalAnalysis: this.computeTechnicalAnalysis(groupId, now, currentMonthStart, today),
    };
  }

  /**
   * Budget burn rate per category
   * Thresholds cascade top-down: exceeded > critical > warning > on_track
   */
  protected computeBurnRates(
    groupId: number,
    now: Date,
    currentMonth: string,
    monthStart: string,
    today: string,
    profiles?: Map<string, CategoryProfile>,
  ): BudgetBurnRate[] {
    const budgets = database.budgets.getAllBudgetsForMonth(groupId, currentMonth);
    if (budgets.length === 0) return [];

    const categoryTotals = database.expenses.getCategoryTotals(groupId, monthStart, today);
    const categorySpentEur: Record<string, number> = {};
    const categoryTxCount: Record<string, number> = {};
    for (const ct of categoryTotals) {
      categorySpentEur[ct.category] = ct.total;
      categoryTxCount[ct.category] = ct.tx_count;
    }

    const categoryProfiles = profiles ?? this.getCategoryProfiles(groupId, now);

    const dayOfMonth = now.getDate();
    const daysInMonth = getDaysInMonth(now);
    const daysElapsed = dayOfMonth; // 1-indexed: day 1 = 1 day elapsed
    const daysRemaining = daysInMonth - daysElapsed;

    const results: BudgetBurnRate[] = [];

    for (const budget of budgets) {
      // Skip zero-budget categories — no meaningful projection possible
      if (budget.limit_amount <= 0) continue;
      const currency = budget.currency as CurrencyCode;
      const spentEur = categorySpentEur[budget.category] || 0;
      const txCount = categoryTxCount[budget.category] || 0;
      // Convert EUR spent to budget currency for comparison
      const spent = convertCurrency(spentEur, BASE_CURRENCY, currency);

      const dailyBurnRate = daysElapsed > 0 ? Math.round((spent / daysElapsed) * 100) / 100 : 0;

      // Profile is in EUR — convert EMA to budget currency for projection
      const profileEur = categoryProfiles.get(budget.category) ?? null;
      const profile: CategoryProfile | null = profileEur
        ? {
            ...profileEur,
            ema: convertCurrency(profileEur.ema, BASE_CURRENCY, currency),
          }
        : null;

      // Activity gate: skip projection if not enough transactions
      const hasEnoughActivity = passesActivityGate(txCount, daysElapsed, daysInMonth, profile);
      const projectedTotal = hasEnoughActivity
        ? projectCategory(spent, daysElapsed, daysInMonth, profile)
        : spent;

      const projectedOvershoot = projectedTotal - budget.limit_amount;
      const runwayDays =
        dailyBurnRate > 0 ? (budget.limit_amount - spent) / dailyBurnRate : Infinity;

      // Dynamic warning threshold: volatile categories need higher projection before warning
      // CV=0 → 85%, CV=0.5 → 90%, CV≥1.0 → 95%
      const cv = profileEur?.cv ?? 0;
      const warningThreshold = 0.85 + 0.1 * Math.min(1, cv);

      // If historical norm (EMA) exceeds budget, projection-based alerts are meaningless —
      // the category chronically overspends, so every projection > budget is expected, not a signal.
      // Only factual exceedance (spent >= budget) should trigger alerts in this case.
      const normExceedsBudget = profile && profile.ema > budget.limit_amount;

      // Determine status: cascade top-down
      let status: BudgetBurnRate['status'];
      if (spent >= budget.limit_amount) {
        status = 'exceeded';
      } else if (!normExceedsBudget && projectedTotal > budget.limit_amount) {
        status = 'critical';
      } else if (!normExceedsBudget && projectedTotal > budget.limit_amount * warningThreshold) {
        status = 'warning';
      } else {
        status = 'on_track';
      }

      results.push({
        category: budget.category,
        budget_limit: budget.limit_amount,
        spent,
        currency,
        days_elapsed: daysElapsed,
        days_remaining: daysRemaining,
        daily_burn_rate: Math.round(dailyBurnRate * 100) / 100,
        projected_total: Math.round(projectedTotal * 100) / 100,
        projected_overshoot: Math.round(projectedOvershoot * 100) / 100,
        runway_days: runwayDays === Infinity ? 999 : Math.round(runwayDays * 10) / 10,
        status,
      });
    }

    return results;
  }

  /**
   * Fetch monthly history and build per-category statistical profiles.
   * Uses HISTORY_MONTHS of data, excluding the current month.
   */
  protected getCategoryProfiles(groupId: number, now: Date): Map<string, CategoryProfile> {
    const historyStart = format(subMonths(startOfMonth(now), HISTORY_MONTHS), 'yyyy-MM-dd');
    const currentMonthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const historyRows = database.expenses.getMonthlyHistoryByCategory(
      groupId,
      historyStart,
      currentMonthStart,
    );
    return buildCategoryProfiles(historyRows);
  }

  /**
   * Week-over-week comparison (last 7 days vs previous 7 days)
   */
  protected computeWeekOverWeek(groupId: number, today: string): SpendingTrend {
    const rows = database.expenses.getWeekOverWeekData(groupId, today);

    const currentByCategory: Record<string, number> = {};
    const previousByCategory: Record<string, number> = {};
    let currentTotal = 0;
    let previousTotal = 0;

    for (const row of rows) {
      if (row.period === 'current_week') {
        currentByCategory[row.category] = (currentByCategory[row.category] || 0) + row.total;
        currentTotal += row.total;
      } else if (row.period === 'previous_week') {
        previousByCategory[row.category] = (previousByCategory[row.category] || 0) + row.total;
        previousTotal += row.total;
      }
    }

    const changePercent =
      previousTotal > 0
        ? ((currentTotal - previousTotal) / previousTotal) * 100
        : currentTotal > 0
          ? 100
          : 0;

    const allCategories = new Set([
      ...Object.keys(currentByCategory),
      ...Object.keys(previousByCategory),
    ]);
    const categoryChanges: CategoryChange[] = [];

    for (const category of allCategories) {
      const current = currentByCategory[category] || 0;
      const previous = previousByCategory[category] || 0;
      const catChange =
        previous > 0 ? ((current - previous) / previous) * 100 : current > 0 ? 100 : 0;
      categoryChanges.push({
        category,
        current: Math.round(current * 100) / 100,
        previous: Math.round(previous * 100) / 100,
        change_percent: Math.round(catChange * 10) / 10,
      });
    }

    // Sort by absolute change descending
    categoryChanges.sort((a, b) => Math.abs(b.change_percent) - Math.abs(a.change_percent));

    return {
      period: 'week',
      current_total: Math.round(currentTotal * 100) / 100,
      previous_total: Math.round(previousTotal * 100) / 100,
      change_percent: Math.round(changePercent * 10) / 10,
      direction: Math.abs(changePercent) <= 5 ? 'stable' : changePercent > 0 ? 'up' : 'down',
      category_changes: categoryChanges.slice(0, 10),
    };
  }

  /**
   * Month-over-month comparison (proportional: first N days of current month vs first N days of previous month)
   */
  protected computeMonthOverMonth(
    groupId: number,
    now: Date,
    currentMonthStart: string,
    today: string,
  ): SpendingTrend {
    const dayOfMonth = now.getDate();
    const prevMonth = subMonths(now, 1);
    const prevMonthStart = format(startOfMonth(prevMonth), 'yyyy-MM-dd');
    // Same day in previous month for proportional comparison
    const prevMonthDaysInMonth = getDaysInMonth(prevMonth);
    const prevMonthDay = Math.min(dayOfMonth, prevMonthDaysInMonth);
    const prevMonthSameDay = `${format(prevMonth, 'yyyy-MM')}-${String(prevMonthDay).padStart(2, '0')}`;

    const rows = database.expenses.getMonthOverMonthData(
      groupId,
      currentMonthStart,
      today,
      prevMonthStart,
      prevMonthSameDay,
    );

    let currentTotal = 0;
    let previousTotal = 0;
    const categoryChanges: CategoryChange[] = [];

    for (const row of rows) {
      currentTotal += row.current_month;
      previousTotal += row.previous_month;

      const catChange =
        row.previous_month > 0
          ? ((row.current_month - row.previous_month) / row.previous_month) * 100
          : row.current_month > 0
            ? 100
            : 0;

      if (row.current_month > 0 || row.previous_month > 0) {
        categoryChanges.push({
          category: row.category,
          current: Math.round(row.current_month * 100) / 100,
          previous: Math.round(row.previous_month * 100) / 100,
          change_percent: Math.round(catChange * 10) / 10,
        });
      }
    }

    const changePercent =
      previousTotal > 0
        ? ((currentTotal - previousTotal) / previousTotal) * 100
        : currentTotal > 0
          ? 100
          : 0;

    categoryChanges.sort((a, b) => Math.abs(b.change_percent) - Math.abs(a.change_percent));

    return {
      period: 'month',
      current_total: Math.round(currentTotal * 100) / 100,
      previous_total: Math.round(previousTotal * 100) / 100,
      change_percent: Math.round(changePercent * 10) / 10,
      direction: Math.abs(changePercent) <= 5 ? 'stable' : changePercent > 0 ? 'up' : 'down',
      category_changes: categoryChanges.slice(0, 10),
    };
  }

  /**
   * Category anomaly detection: current month vs 3-month average
   * Deviation > 1.5x = anomaly
   */
  protected computeAnomalies(
    groupId: number,
    now: Date,
    currentMonthStart: string,
    today: string,
  ): CategoryAnomaly[] {
    // Get current month category totals
    const currentTotals = database.expenses.getCategoryTotals(groupId, currentMonthStart, today);
    const currentMap: Record<string, number> = {};
    for (const ct of currentTotals) {
      currentMap[ct.category] = ct.total;
    }

    // Get 3 months of historical data (excluding current month)
    const threeMonthsAgo = subMonths(startOfMonth(now), 3);
    const historyStart = format(threeMonthsAgo, 'yyyy-MM-dd');

    const historyRows = database.expenses.getMonthlyHistoryByCategory(
      groupId,
      historyStart,
      currentMonthStart,
    );

    // Compute average per category over the history months
    const categoryHistory: Record<string, { total: number; months: number }> = {};
    for (const row of historyRows) {
      if (!categoryHistory[row.category]) {
        categoryHistory[row.category] = { total: 0, months: 0 };
      }
      const entry = categoryHistory[row.category];
      if (entry) {
        entry.total += row.monthly_total;
        entry.months += 1;
      }
    }

    const anomalies: CategoryAnomaly[] = [];

    for (const [category, currentTotal] of Object.entries(currentMap)) {
      const history = categoryHistory[category];
      if (!history || history.months === 0) continue;

      const avg3Month = history.total / history.months;
      if (avg3Month <= 0) continue;

      const deviationRatio = currentTotal / avg3Month;

      if (deviationRatio >= 1.3) {
        let severity: CategoryAnomaly['severity'];
        if (deviationRatio >= 2.5) {
          severity = 'extreme';
        } else if (deviationRatio >= 1.5) {
          severity = 'significant';
        } else {
          severity = 'mild';
        }

        anomalies.push({
          category,
          current_month_total: Math.round(currentTotal * 100) / 100,
          avg_3_month: Math.round(avg3Month * 100) / 100,
          deviation_ratio: Math.round(deviationRatio * 100) / 100,
          severity,
        });
      }
    }

    // Sort by deviation ratio descending
    anomalies.sort((a, b) => b.deviation_ratio - a.deviation_ratio);

    return anomalies;
  }

  /**
   * Day-of-week spending patterns (last 90 days)
   */
  protected computeDayPatterns(groupId: number, today: string): DayOfWeekPattern[] {
    const startDate = format(subDays(new Date(today), 90), 'yyyy-MM-dd');

    const stats = database.expenses.getDayOfWeekStats(groupId, startDate, today);
    const topCats = database.expenses.getDayOfWeekTopCategories(groupId, startDate, today);

    if (stats.length === 0) return [];

    // Build top category map
    const topCategoryMap: Record<number, string> = {};
    for (const tc of topCats) {
      topCategoryMap[tc.dow] = tc.category;
    }

    // Compute overall average daily spend
    const totalSpend = stats.reduce((sum, s) => sum + s.total, 0);
    const totalUniqueDays = stats.reduce((sum, s) => sum + s.unique_days, 0);
    const overallDailyAvg = totalUniqueDays > 0 ? totalSpend / totalUniqueDays : 0;

    const patterns: DayOfWeekPattern[] = [];

    for (const stat of stats) {
      const avgDailySpend = stat.unique_days > 0 ? stat.total / stat.unique_days : 0;
      const vsAverage = overallDailyAvg > 0 ? (avgDailySpend / overallDailyAvg) * 100 : 0;

      patterns.push({
        day_of_week: stat.dow,
        day_name: DAY_NAMES[stat.dow] || 'Unknown',
        avg_daily_spend: Math.round(avgDailySpend * 100) / 100,
        total_transactions: stat.tx_count,
        vs_average_percent: Math.round(vsAverage * 10) / 10,
        top_category: topCategoryMap[stat.dow] || 'N/A',
      });
    }

    return patterns.sort((a, b) => a.day_of_week - b.day_of_week);
  }

  /**
   * Spending velocity: last 7 days vs previous 7 days
   * Divide by fixed window size (7), not active_days
   */
  protected computeVelocity(groupId: number, today: string): SpendingVelocity {
    const rows = database.expenses.getVelocityData(groupId, today);

    let recentTotal = 0;
    let earlierTotal = 0;

    for (const row of rows) {
      if (row.period === 'recent') {
        recentTotal = row.total;
      } else if (row.period === 'earlier') {
        earlierTotal = row.total;
      }
    }

    // Fixed window size: 7 days
    const period1DailyAvg = earlierTotal / 7;
    const period2DailyAvg = recentTotal / 7;

    const acceleration =
      period1DailyAvg > 0
        ? ((period2DailyAvg - period1DailyAvg) / period1DailyAvg) * 100
        : period2DailyAvg > 0
          ? 100
          : 0;

    let trend: SpendingVelocity['trend'];
    if (Math.abs(acceleration) <= 10) {
      trend = 'stable';
    } else if (acceleration > 0) {
      trend = 'accelerating';
    } else {
      trend = 'decelerating';
    }

    return {
      period_1_daily_avg: Math.round(period1DailyAvg * 100) / 100,
      period_2_daily_avg: Math.round(period2DailyAvg * 100) / 100,
      acceleration: Math.round(acceleration * 10) / 10,
      trend,
    };
  }

  /**
   * Budget utilization rate (total budget vs total spent)
   */
  protected computeBudgetUtilization(
    groupId: number,
    currentMonth: string,
    monthStart: string,
    today: string,
  ): BudgetUtilization | null {
    const budgets = database.budgets.getAllBudgetsForMonth(groupId, currentMonth);
    if (budgets.length === 0) return null;

    // Sum all budgets in EUR
    let totalBudgetEur = 0;
    for (const budget of budgets) {
      const limitEur = convertCurrency(
        budget.limit_amount,
        budget.currency as CurrencyCode,
        BASE_CURRENCY,
      );
      totalBudgetEur += limitEur;
    }

    const totalSpentEur = database.expenses.getTotalEurForRange(groupId, monthStart, today);

    const remaining = totalBudgetEur - totalSpentEur;
    const utilizationPercent = totalBudgetEur > 0 ? (totalSpentEur / totalBudgetEur) * 100 : 0;
    const remainingPercent = totalBudgetEur > 0 ? (remaining / totalBudgetEur) * 100 : 0;

    return {
      total_budget: Math.round(totalBudgetEur * 100) / 100,
      total_spent: Math.round(totalSpentEur * 100) / 100,
      remaining: Math.round(remaining * 100) / 100,
      utilization_percent: Math.round(utilizationPercent * 10) / 10,
      remaining_percent: Math.round(remainingPercent * 10) / 10,
    };
  }

  /**
   * Spending streak: consecutive days above/below average
   * Days without expenses break the streak
   */
  protected computeStreak(groupId: number, today: string): SpendingStreak {
    const startDate = format(subDays(new Date(today), 30), 'yyyy-MM-dd');
    const dailyTotals = database.expenses.getDailyTotals(groupId, startDate, today);

    if (dailyTotals.length === 0) {
      return {
        current_streak_days: 0,
        streak_type: 'no_spending',
        avg_daily_during_streak: 0,
        overall_daily_average: 0,
      };
    }

    // Overall average
    const totalSpend = dailyTotals.reduce((sum, d) => sum + d.total, 0);
    const overallDailyAvg = totalSpend / dailyTotals.length;

    // Build a map of date -> total
    const dailyMap: Record<string, number> = {};
    for (const d of dailyTotals) {
      dailyMap[d.date] = d.total;
    }

    // Walk backwards from today
    let streakDays = 0;
    let streakSum = 0;
    let streakType: SpendingStreak['streak_type'] = 'no_spending';
    let currentDate = new Date(today);

    for (let i = 0; i < 30; i++) {
      const dateStr = format(currentDate, 'yyyy-MM-dd');
      const dayTotal = dailyMap[dateStr];

      if (dayTotal === undefined) {
        // No spending this day - breaks streak
        if (streakDays === 0) {
          streakType = 'no_spending';
        }
        break;
      }

      if (streakDays === 0) {
        // First day - determine streak type
        streakType = dayTotal > overallDailyAvg ? 'above_average' : 'below_average';
        streakDays = 1;
        streakSum = dayTotal;
      } else {
        // Check if continues same streak
        const isAbove = dayTotal > overallDailyAvg;
        if (
          (streakType === 'above_average' && isAbove) ||
          (streakType === 'below_average' && !isAbove)
        ) {
          streakDays++;
          streakSum += dayTotal;
        } else {
          break;
        }
      }

      currentDate = subDays(currentDate, 1);
    }

    return {
      current_streak_days: streakDays,
      streak_type: streakType,
      avg_daily_during_streak:
        streakDays > 0 ? Math.round((streakSum / streakDays) * 100) / 100 : 0,
      overall_daily_average: Math.round(overallDailyAvg * 100) / 100,
    };
  }

  /**
   * Monthly projection with confidence level
   * confidence: 'low' if days_elapsed < 7
   */
  protected computeProjection(
    groupId: number,
    now: Date,
    currentMonth: string,
    monthStart: string,
    today: string,
    profiles?: Map<string, CategoryProfile>,
  ): MonthlyProjection | null {
    const daysElapsed = now.getDate();
    const daysInMonth = getDaysInMonth(now);

    if (daysElapsed === 0) return null;

    const currentTotal = database.expenses.getTotalEurForRange(groupId, monthStart, today);
    if (currentTotal === 0 && daysElapsed < 3) return null;

    // Build aggregate profile across all categories for overall projection
    const categoryProfiles = profiles ?? this.getCategoryProfiles(groupId, now);
    const profileValues = [...categoryProfiles.values()];
    const aggregateEma = profileValues.reduce((s, p) => s + p.ema, 0);

    // Fix #2: compute real weighted CV from category profiles instead of hardcoded 0.5
    const totalEma = aggregateEma || 1;
    const weightedCv = profileValues.reduce((s, p) => s + p.cv * (p.ema / totalEma), 0);

    const overallProfile: CategoryProfile | null =
      categoryProfiles.size > 0
        ? {
            ema: aggregateEma,
            cv: Math.round(weightedCv * 1000) / 1000,
            monthsOfData: Math.max(...profileValues.map((p) => p.monthsOfData)),
            avgTxPerMonth: profileValues.reduce((s, p) => s + p.avgTxPerMonth, 0),
            zeroMonthRatio: 0,
          }
        : null;
    const projectedTotal = projectCategory(currentTotal, daysElapsed, daysInMonth, overallProfile);

    // Get last month total for comparison
    const prevMonth = subMonths(now, 1);
    const prevMonthStart = format(startOfMonth(prevMonth), 'yyyy-MM-dd');
    const prevMonthEnd = format(
      new Date(prevMonth.getFullYear(), prevMonth.getMonth() + 1, 0),
      'yyyy-MM-dd',
    );
    const lastMonthTotal = database.expenses.getTotalEurForRange(
      groupId,
      prevMonthStart,
      prevMonthEnd,
    );

    const projectedVsLastMonth = lastMonthTotal > 0 ? (projectedTotal / lastMonthTotal) * 100 : 0;

    // Confidence
    let confidence: MonthlyProjection['confidence'];
    if (daysElapsed < 7) {
      confidence = 'low';
    } else if (daysElapsed >= 20) {
      confidence = 'high';
    } else {
      confidence = 'medium';
    }

    // Category projections
    const currentCatTotals = database.expenses.getCategoryTotals(groupId, monthStart, today);
    const budgets = database.budgets.getAllBudgetsForMonth(groupId, currentMonth);
    const budgetMap: Record<string, { limit: number; currency: string }> = {};
    for (const b of budgets) {
      budgetMap[b.category] = { limit: b.limit_amount, currency: b.currency };
    }

    const categoryProjections: CategoryProjection[] = [];
    for (const cat of currentCatTotals) {
      const catProfile = categoryProfiles.get(cat.category) ?? null;
      const catProjected = projectCategory(cat.total, daysElapsed, daysInMonth, catProfile);
      const budget = budgetMap[cat.category];

      let budgetLimitEur: number | null = null;
      let willExceed = false;
      if (budget) {
        budgetLimitEur = convertCurrency(
          budget.limit,
          budget.currency as CurrencyCode,
          BASE_CURRENCY,
        );
        willExceed = catProjected > budgetLimitEur;
      }

      categoryProjections.push({
        category: cat.category,
        current: Math.round(cat.total * 100) / 100,
        projected: Math.round(catProjected * 100) / 100,
        budget_limit: budgetLimitEur !== null ? Math.round(budgetLimitEur * 100) / 100 : null,
        will_exceed: willExceed,
      });
    }

    // Sort by projected descending
    categoryProjections.sort((a, b) => b.projected - a.projected);

    return {
      days_elapsed: daysElapsed,
      days_in_month: daysInMonth,
      current_total: Math.round(currentTotal * 100) / 100,
      projected_total: Math.round(projectedTotal * 100) / 100,
      projected_vs_last_month: Math.round(projectedVsLastMonth * 10) / 10,
      confidence,
      category_projections: categoryProjections.slice(0, 15),
    };
  }
  /**
   * Technical analysis: run 47 TA methods per category on monthly history.
   * Returns per-category analysis + cross-category correlations.
   */
  protected computeTechnicalAnalysis(
    groupId: number,
    now: Date,
    currentMonthStart: string,
    today: string,
  ): TechnicalAnalysis | null {
    // Use 12 months of history for TA (more than the 6 used for profiles)
    const historyStart = format(subMonths(startOfMonth(now), 12), 'yyyy-MM-dd');
    const historyRows = database.expenses.getMonthlyHistoryByCategory(
      groupId,
      historyStart,
      currentMonthStart,
    );

    if (historyRows.length === 0) return null;

    // Group history by category → monthly totals array
    const categoryMonthlyTotals = new Map<string, number[]>();
    for (const row of historyRows) {
      let totals = categoryMonthlyTotals.get(row.category);
      if (!totals) {
        totals = [];
        categoryMonthlyTotals.set(row.category, totals);
      }
      totals.push(row.monthly_total);
    }

    // Get current month spending per category for anomaly detection
    const currentTotals = database.expenses.getCategoryTotals(groupId, currentMonthStart, today);
    const currentByCategory = new Map<string, number>();
    for (const row of currentTotals) {
      currentByCategory.set(row.category, row.total);
    }

    // Run TA analysis per category
    const categories: CategoryTaAnalysis[] = [];
    for (const [category, monthlyTotals] of categoryMonthlyTotals) {
      if (monthlyTotals.length < 2) continue;
      const analysis = analyzeCategory(category, monthlyTotals, {
        currentMonthSpent: currentByCategory.get(category) ?? 0,
      });
      categories.push(analysis);
    }

    // Cross-category correlations
    const correlations: CorrelationResult[] = categoryCorrelation(categoryMonthlyTotals);

    return { categories, correlations };
  }
}

// Singleton instance
export const spendingAnalytics = new SpendingAnalytics();
