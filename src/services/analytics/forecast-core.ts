/**
 * Pure forecast functions — no env/DB dependencies.
 * Used by both production (spending-analytics.ts) and backtest scripts.
 */

import { differenceInDays, parseISO } from 'date-fns';
import { crostonTSB } from './ta/forecasting';
import type { CategoryProfile, IntervalProfile } from './types';

/** Max gap between transactions (days) before treating as an outlier in interval computation */
const MAX_INTERVAL_DAYS = 90;

/** Minimum number of valid intervals to compute an interval profile */
const MIN_INTERVALS = 3;

/** CV threshold below which an interval profile is considered stable */
const INTERVAL_CV_THRESHOLD = 0.4;

/**
 * Build per-category statistical profiles from monthly history.
 *
 * For each category computes:
 * - EMA (exponential moving average) of monthly totals — weights recent months more
 * - CV (coefficient of variation = stddev / mean) — measures spending regularity
 * - Average transaction count per month
 * - Zero month ratio (for Syntetos-Boylan demand classification)
 * - Monthly totals (for TSB/Croston forecasts)
 */
export function buildCategoryProfiles(
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
      monthlyTotals: [...totals],
    });
  }

  return profiles;
}

/**
 * Build per-category interval profiles from raw transaction-level data.
 *
 * Detects cycle-based spending patterns (e.g., car refueling every ~21 days,
 * salon every ~6 weeks) by analyzing intervals between consecutive transactions.
 */
export function buildIntervalProfiles(
  transactions: { date: string; category: string; amount: number }[],
): Map<string, IntervalProfile> {
  const byCategory = new Map<string, { date: string; amount: number }[]>();
  for (const tx of transactions) {
    const arr = byCategory.get(tx.category) ?? [];
    arr.push({ date: tx.date, amount: tx.amount });
    byCategory.set(tx.category, arr);
  }

  const profiles = new Map<string, IntervalProfile>();

  for (const [category, txList] of byCategory) {
    txList.sort((a, b) => a.date.localeCompare(b.date));

    const intervals: number[] = [];
    const amounts: number[] = [];
    for (let i = 1; i < txList.length; i++) {
      const curr = txList[i];
      const prev = txList[i - 1];
      if (!curr || !prev) continue;
      const days = differenceInDays(parseISO(curr.date), parseISO(prev.date));
      if (days > MAX_INTERVAL_DAYS) continue;
      if (days <= 0) continue;
      intervals.push(days);
    }

    if (intervals.length < MIN_INTERVALS) continue;

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
    return txCountThisMonth >= 2;
  }

  const monthProgress = daysElapsed / daysInMonth;
  const expectedTxSoFar = profile.avgTxPerMonth * monthProgress;
  return txCountThisMonth >= Math.max(2, Math.ceil(expectedTxSoFar * 0.3));
}

/**
 * Syntetos-Boylan demand pattern classification.
 *
 * | | ADI < 1.32 | ADI ≥ 1.32 |
 * |---|---|---|
 * | CV² < 0.49 | Smooth → EMA/Holt | Intermittent → Croston SBA |
 * | CV² ≥ 0.49 | Erratic → Median | Lumpy → Quantile P75 |
 */
export type DemandPattern = 'smooth' | 'intermittent' | 'erratic' | 'lumpy';

export function classifyDemandPattern(profile: CategoryProfile): DemandPattern {
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
 * - Stable interval profile → interval-based cycle projection
 * - No history or < 3 months → return currentSpent
 * - Stalled (no tx in 5+ days after 1/3 of month) → return currentSpent
 * - Smooth → EMA-based blend with CV-adjusted pace trust
 * - Intermittent → TSB (fading demand) with activity probability
 * - Erratic → pace-only (no history anchor, EMA unreliable)
 * - Lumpy → only factual alerts (unforecastable)
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

  // Stall detection
  if (daysSinceLastTx !== undefined && daysSinceLastTx >= 5 && monthProgress > 0.33) {
    return currentSpent;
  }

  // Interval-based cycle projection (highest priority)
  if (intervalProfile?.isStable) {
    const daysRemaining = daysInMonth - daysElapsed;
    const daysSinceLast = daysSinceLastTx ?? 0;
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

  // Lumpy: unforecastable → only factual alerts
  if (pattern === 'lumpy') return currentSpent;

  if (pattern === 'intermittent') {
    // TSB handles fading demand: if category stops being used, forecast decays to 0
    let expectedTotal: number;
    if (profile.monthlyTotals && profile.monthlyTotals.length > 0) {
      expectedTotal = crostonTSB(profile.monthlyTotals).forecast;
    } else {
      const activityProb = 1 - profile.zeroMonthRatio;
      expectedTotal = profile.ema * activityProb;
    }
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
