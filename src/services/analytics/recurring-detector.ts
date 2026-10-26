/** Detects recurring expense patterns from expense history */
import { differenceInDays, format, subMonths } from 'date-fns';
import { database } from '../../database';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('recurring-detector');

/** Minimum occurrences to consider a pattern recurring */
const MIN_OCCURRENCES = 3;

/** Amount tolerance: expenses within ±20% are considered "similar" */
const AMOUNT_TOLERANCE = 0.2;

/** Monthly interval range: 25-35 days is considered "monthly" */
const MIN_MONTHLY_INTERVAL = 25;
const MAX_MONTHLY_INTERVAL = 35;

/** Months of history to analyze */
const HISTORY_MONTHS = 6;

export interface DetectedPattern {
  category: string;
  expectedAmount: number;
  currency: string;
  expectedDay: number;
  occurrences: number;
  lastDate: string;
}

interface ExpenseOccurrence {
  date: string;
  amount: number;
  currency: string;
}

/** Groups items by key, preserving first-seen key order and item order within a group. */
function groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key) || [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

/**
 * Detects recurring expense patterns from the last 6 months of history.
 * Groups expenses by category, finds similar-amount entries appearing at
 * roughly monthly intervals (25-35 days apart), and returns patterns
 * not already saved in the database.
 */
export function detectRecurringPatterns(groupId: number): DetectedPattern[] {
  const today = new Date();
  const startDate = format(subMonths(today, HISTORY_MONTHS), 'yyyy-MM-dd');
  const endDate = format(today, 'yyyy-MM-dd');

  const expenses = database.expenses.findByDateRange(groupId, startDate, endDate);

  if (expenses.length === 0) {
    return [];
  }

  // Group expenses by category
  const byCategory = groupBy(
    expenses.map((expense) => ({
      category: expense.category,
      occurrence: { date: expense.date, amount: expense.amount, currency: expense.currency },
    })),
    (row) => row.category,
  );

  const detected: DetectedPattern[] = [];

  for (const [category, rows] of byCategory) {
    const occurrences = rows.map((row) => row.occurrence);
    if (occurrences.length < MIN_OCCURRENCES) {
      continue;
    }

    // Group by currency, then find amount clusters
    for (const [currency, currencyOccurrences] of groupBy(occurrences, (occ) => occ.currency)) {
      for (const pattern of findMonthlyAmountClusters(currencyOccurrences)) {
        // Skip if already saved in the database
        const existing = database.recurringPatterns.findByGroupCategoryCurrency(
          groupId,
          category,
          currency,
        );
        if (existing) {
          continue;
        }

        detected.push({
          category,
          expectedAmount: pattern.medianAmount,
          currency,
          expectedDay: pattern.medianDay,
          occurrences: pattern.count,
          lastDate: pattern.lastDate,
        });
      }
    }
  }

  logger.info({ groupId, count: detected.length }, 'Detected recurring patterns');

  return detected;
}

interface AmountCluster {
  medianAmount: number;
  medianDay: number;
  count: number;
  lastDate: string;
}

/**
 * Finds clusters of similar-amount expenses that appear at monthly intervals.
 * Uses a simple greedy approach: sort by date, then check if consecutive
 * expenses with similar amounts have ~30-day gaps.
 */
function findMonthlyAmountClusters(occurrences: ExpenseOccurrence[]): AmountCluster[] {
  // Sort by date ascending
  const sorted = [...occurrences].sort((a, b) => a.date.localeCompare(b.date));

  const usedIndices = new Set<number>();
  const clusters: AmountCluster[] = [];

  for (const [i, anchor] of sorted.entries()) {
    if (usedIndices.has(i)) continue;

    const { members, memberIndices } = collectSimilarAmountMembers(sorted, i, anchor, usedIndices);

    if (members.length < MIN_OCCURRENCES) {
      continue;
    }

    // Check if the cluster has roughly monthly intervals
    if (!hasMonthlyIntervals(members.map((m) => m.date))) {
      continue;
    }

    // Mark indices as used
    for (const idx of memberIndices) {
      usedIndices.add(idx);
    }

    const cluster = summarizeCluster(members);
    if (cluster) clusters.push(cluster);
  }

  return clusters;
}

/**
 * Collects the anchor plus every later, not-yet-used occurrence whose amount is
 * within tolerance of the anchor's amount.
 */
function collectSimilarAmountMembers(
  sorted: ExpenseOccurrence[],
  anchorIndex: number,
  anchor: ExpenseOccurrence,
  usedIndices: Set<number>,
): { members: ExpenseOccurrence[]; memberIndices: number[] } {
  const members: ExpenseOccurrence[] = [anchor];
  const memberIndices: number[] = [anchorIndex];

  for (const [j, candidate] of sorted.entries()) {
    if (j <= anchorIndex || usedIndices.has(j)) continue;
    if (isAmountSimilar(anchor.amount, candidate.amount)) {
      members.push(candidate);
      memberIndices.push(j);
    }
  }
  return { members, memberIndices };
}

/** Median amount and median day-of-month of a date-sorted cluster. */
function summarizeCluster(members: ExpenseOccurrence[]): AmountCluster | null {
  const amounts = members.map((m) => m.amount);
  const days = members.map((m) => Number.parseInt(m.date.slice(8, 10), 10));
  const lastMember = members[members.length - 1];
  // members has >= MIN_OCCURRENCES entries, so lastMember is defined
  if (!lastMember) return null;

  return {
    medianAmount: median(amounts),
    medianDay: Math.round(median(days)),
    count: members.length,
    lastDate: lastMember.date,
  };
}

/**
 * Check if dates have roughly monthly intervals (25-35 days between consecutive entries)
 */
function hasMonthlyIntervals(sortedDates: string[]): boolean {
  if (sortedDates.length < MIN_OCCURRENCES) return false;

  let monthlyGaps = 0;
  let totalGaps = 0;
  let prevDate: string | undefined;

  for (const dateStr of sortedDates) {
    if (prevDate !== undefined) {
      const gap = differenceInDays(new Date(dateStr), new Date(prevDate));
      totalGaps++;

      if (gap >= MIN_MONTHLY_INTERVAL && gap <= MAX_MONTHLY_INTERVAL) {
        monthlyGaps++;
      }
    }
    prevDate = dateStr;
  }

  // At least 60% of gaps should be monthly
  return totalGaps > 0 && monthlyGaps / totalGaps >= 0.6;
}

/**
 * Check if two amounts are within +/-20% tolerance
 */
function isAmountSimilar(a: number, b: number): boolean {
  if (a === 0 && b === 0) return true;
  const reference = Math.max(Math.abs(a), Math.abs(b));
  return Math.abs(a - b) / reference <= AMOUNT_TOLERANCE;
}

/**
 * Compute median of a non-empty numeric array
 */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) {
    const left = sorted[mid - 1] ?? 0;
    const right = sorted[mid] ?? 0;
    return (left + right) / 2;
  }
  return sorted[mid] ?? 0;
}

/**
 * Compute the next expected date for a recurring pattern given last seen date and expected day
 */
export function computeNextExpectedDate(lastSeenDate: string, expectedDay: number): string {
  const lastDate = new Date(lastSeenDate);
  // Move to the next month
  let nextMonth = lastDate.getMonth() + 1;
  let nextYear = lastDate.getFullYear();
  if (nextMonth > 11) {
    nextMonth = 0;
    nextYear++;
  }

  // Clamp expected day to the number of days in next month
  const daysInNextMonth = new Date(nextYear, nextMonth + 1, 0).getDate();
  const day = Math.min(expectedDay, daysInNextMonth);

  const nextDate = new Date(nextYear, nextMonth, day);
  return format(nextDate, 'yyyy-MM-dd');
}
