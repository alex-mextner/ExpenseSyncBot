/** Smart advice trigger logic — decides when to send proactive financial insights to groups */
import { format, startOfMonth } from 'date-fns';
import { database } from '../../database';
import { computeOverallSeverity } from './formatters';
import { spendingAnalytics } from './spending-analytics';
import type { AdviceTier, FinancialSnapshot, TriggerResult } from './types';

/**
 * Per-tier cooldowns stored in memory (reset on bot restart — that's fine)
 */
interface GroupCooldown {
  last_quick_at: number;
  last_alert_at: number;
}

const cooldowns = new Map<number, GroupCooldown>();

const QUICK_COOLDOWN_MS = 4 * 60 * 60 * 1000; // 4 hours
const ALERT_COOLDOWN_MS = 1 * 60 * 60 * 1000; // 1 hour
const MAX_AUTO_ADVICE_PER_DAY = 3;

/** Everything a trigger predicate needs; computed once per checkSmartTriggers call. */
interface TriggerContext {
  groupId: number;
  now: Date;
  today: string;
  monthStart: string;
  snap: FinancialSnapshot;
}

type TriggerPredicate = (ctx: TriggerContext) => TriggerResult | null;

/** Monthly topic dedup plus per-tier cooldown: the gate every trigger candidate must pass. */
function canFire(ctx: TriggerContext, topic: string, tier: AdviceTier): boolean {
  if (database.adviceLogs.hasTopicThisMonth(ctx.groupId, topic, ctx.monthStart)) return false;
  return canSendAdvice(ctx.groupId, tier);
}

// Trigger 1: Budget threshold crossing (>80%, >100%).
// Projection-based triggers (warning/critical burn rate) rely on linear
// extrapolation — one lumpy expense early in the month (e.g. car repair on
// day 2) explodes the projection and produces a false "critical" alert.
// The spec (docs/specs/2026-03-09-smart-advice.md, review note #10) gates
// these triggers on the projection's confidence level: when
// `days_elapsed < 7` the projection is marked `'low'` and must NOT fire
// automatic alerts. `exceeded` is a fact (spent >= limit), not a projection,
// so it stays unconditional.
function budgetThresholdTrigger(ctx: TriggerContext): TriggerResult | null {
  const { snap } = ctx;
  const projectionConfident = snap.projection != null && snap.projection.confidence !== 'low';

  for (const br of snap.burnRates) {
    // Skip projection-based alerts in the first 5 days — projections are too
    // unreliable with so little data. `exceeded` is handled by checkBudgetLimit.
    if (br.days_elapsed < 5) continue;
    if (!(br.status === 'critical' || br.status === 'warning')) continue;
    if (!(br.budget_limit > 0 && projectionConfident)) continue;

    const threshold = br.status === 'critical' ? '100' : '80';
    const topic = `budget_threshold:${br.category}:${threshold}`;
    if (!canFire(ctx, topic, 'alert')) continue;
    return {
      type: 'budget_threshold',
      tier: 'alert',
      topic,
      data: {
        category: br.category,
        projected: br.projected_total,
        limit: br.budget_limit,
        currency: br.currency,
      },
    };
  }
  return null;
}

// Trigger 2: Category anomaly (> 1.5x average)
function categoryAnomalyTrigger(ctx: TriggerContext): TriggerResult | null {
  for (const anomaly of ctx.snap.anomalies) {
    if (anomaly.severity !== 'significant' && anomaly.severity !== 'extreme') continue;

    const topic = `anomaly:${anomaly.category}`;
    if (!canFire(ctx, topic, 'alert')) continue;
    return {
      type: 'anomaly',
      tier: 'alert',
      topic,
      data: {
        category: anomaly.category,
        current: anomaly.current_month_total,
        average: anomaly.avg_3_month,
        ratio: anomaly.deviation_ratio,
      },
    };
  }
  return null;
}

// Trigger 2b: TA anomaly (multi-method consensus)
function technicalAnomalyTrigger(ctx: TriggerContext): TriggerResult | null {
  if (!ctx.snap.technicalAnalysis) return null;

  for (const cat of ctx.snap.technicalAnalysis.categories) {
    if (!(cat.anomaly.isAnomaly && cat.anomaly.anomalyCount >= 2)) continue;

    const topic = `ta_anomaly:${cat.category}`;
    if (!canFire(ctx, topic, 'alert')) continue;
    return {
      type: 'ta_anomaly',
      tier: 'alert',
      topic,
      data: {
        category: cat.category,
        anomaly_count: cat.anomaly.anomalyCount,
        z_score: cat.anomaly.zScore.zScore,
        direction: cat.anomaly.zScore.direction,
      },
    };
  }
  return null;
}

// Trigger 2c: TA trend change (MACD crossover + high confidence)
function technicalTrendChangeTrigger(ctx: TriggerContext): TriggerResult | null {
  if (!ctx.snap.technicalAnalysis) return null;

  for (const cat of ctx.snap.technicalAnalysis.categories) {
    const isConfidentRise =
      cat.trend.macd.crossover === 'bullish' &&
      cat.trend.direction === 'rising' &&
      cat.trend.confidence >= 0.6;
    if (!isConfidentRise) continue;

    const topic = `ta_trend_change:${cat.category}:rising`;
    if (!canFire(ctx, topic, 'quick')) continue;
    return {
      type: 'ta_trend_change',
      tier: 'quick',
      topic,
      data: {
        category: cat.category,
        direction: 'rising',
        confidence: cat.trend.confidence,
        ensemble_forecast: cat.forecasts.ensemble,
        macd_crossover: cat.trend.macd.crossover,
      },
    };
  }
  return null;
}

// Trigger 3: Velocity spike (acceleration > 50%)
function velocitySpikeTrigger(ctx: TriggerContext): TriggerResult | null {
  const { velocity } = ctx.snap;
  if (!(velocity.trend === 'accelerating' && velocity.acceleration > 50)) return null;

  const topic = 'velocity_spike';
  // Check cooldown via advice_log (max once per 7 days)
  const recentVelocityAlerts = database.adviceLogs
    .getRecent(ctx.groupId, 20)
    .filter((a) => a.topic === topic);
  const lastVelocityAlert = recentVelocityAlerts[0];
  const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

  // `!(t < cutoff)` (not `t >= cutoff`): an unparseable created_at (NaN) must suppress the alert.
  if (lastVelocityAlert && !(new Date(lastVelocityAlert.created_at).getTime() < sevenDaysAgo)) {
    return null;
  }
  if (!canSendAdvice(ctx.groupId, 'quick')) return null;

  return {
    type: 'velocity_spike',
    tier: 'quick',
    topic,
    data: {
      acceleration: velocity.acceleration,
      recent_avg: velocity.period_2_daily_avg,
      earlier_avg: velocity.period_1_daily_avg,
    },
  };
}

// Trigger 4: Weekly check (Monday)
function weeklyCheckTrigger(ctx: TriggerContext): TriggerResult | null {
  if (ctx.now.getDay() !== 1) return null;

  const topic = `weekly_check:${format(ctx.now, 'yyyy-ww')}`;
  if (!canFire(ctx, topic, 'quick')) return null;

  const severity = computeOverallSeverity(ctx.snap);
  return {
    type: 'weekly_check',
    tier: 'quick',
    topic,
    data: { severity, weekday: 'Monday' },
  };
}

// Trigger 5: First expense of the month
function firstExpenseOfMonthTrigger(ctx: TriggerContext): TriggerResult | null {
  if (ctx.now.getDate() > 3) return null;

  const currentMonthStart = format(startOfMonth(ctx.now), 'yyyy-MM-dd');
  const expenseCount = database.expenses.getCountForRange(
    ctx.groupId,
    currentMonthStart,
    ctx.today,
  );
  if (expenseCount !== 1) return null;

  const topic = `first_expense:${format(ctx.now, 'yyyy-MM')}`;
  if (!canFire(ctx, topic, 'quick')) return null;
  return {
    type: 'first_expense_of_month',
    tier: 'quick',
    topic,
    data: { month: format(ctx.now, 'yyyy-MM') },
  };
}

// Trigger 6: Recurring expense missed
function recurringMissedTrigger(ctx: TriggerContext): TriggerResult | null {
  const overduePatterns = database.recurringPatterns.findOverdue(ctx.groupId, ctx.today);
  const firstOverdue = overduePatterns[0];
  if (!firstOverdue) return null;

  const topic = `recurring_missed:${firstOverdue.category}:${firstOverdue.next_expected_date}`;
  if (!canFire(ctx, topic, 'quick')) return null;
  return {
    type: 'recurring_missed',
    tier: 'quick',
    topic,
    data: {
      category: firstOverdue.category,
      expected_amount: firstOverdue.expected_amount,
      currency: firstOverdue.currency,
      next_expected_date: firstOverdue.next_expected_date,
      overdue_count: overduePatterns.length,
    },
  };
}

// Trigger 7: Pending bank transactions need review
// Only nag when the group actually receives bank confirmation cards. With cards
// off (the default), debits are still stored as 'pending' but there is no in-chat
// path to confirm them, so a "N pending transactions" reminder points at something
// the user deliberately chose not to be bothered by and cannot act on.
function pendingBankTransactionsTrigger(ctx: TriggerContext): TriggerResult | null {
  const group = database.groups.findById(ctx.groupId);
  if (!group?.bank_cards_enabled) return null;

  const pendingConnections = database.bankConnections.findActiveByGroupId(ctx.groupId);
  let totalPending = 0;
  for (const conn of pendingConnections) {
    totalPending += database.bankTransactions.findPendingByConnectionId(conn.id).length;
  }
  if (totalPending <= 0) return null;

  // Embed today's date to allow daily reminders (unlike other triggers which use monthly dedup)
  const topic = `pending_bank_transactions:${ctx.today}`;
  if (!canFire(ctx, topic, 'quick')) return null;
  return {
    type: 'pending_bank_transactions',
    tier: 'quick',
    topic,
    data: { count: totalPending },
  };
}

// Priority order: budget_threshold > anomaly > velocity_spike > weekly_check > first_expense_of_month
const TRIGGERS_BY_PRIORITY: readonly TriggerPredicate[] = [
  budgetThresholdTrigger,
  categoryAnomalyTrigger,
  technicalAnomalyTrigger,
  technicalTrendChangeTrigger,
  velocitySpikeTrigger,
  weeklyCheckTrigger,
  firstExpenseOfMonthTrigger,
  recurringMissedTrigger,
  pendingBankTransactionsTrigger,
];

/**
 * Check if any smart trigger should fire for a group
 * Called after expense addition or @ask interaction
 * Returns null if no trigger should fire, or TriggerResult with tier and topic
 */
export function checkSmartTriggers(
  groupId: number,
  snapshot?: FinancialSnapshot,
): TriggerResult | null {
  const now = new Date();
  const today = format(now, 'yyyy-MM-dd');

  // Max auto advice per day
  const todayCount = database.adviceLogs.countToday(groupId, today);
  if (todayCount >= MAX_AUTO_ADVICE_PER_DAY) {
    return null;
  }

  // Compute snapshot if not provided
  const snap = snapshot || spendingAnalytics.getFinancialSnapshot(groupId);
  const monthStart = `${format(startOfMonth(now), 'yyyy-MM-dd')}T00:00:00`;
  const ctx: TriggerContext = { groupId, now, today, monthStart, snap };

  for (const trigger of TRIGGERS_BY_PRIORITY) {
    const result = trigger(ctx);
    if (result) return result;
  }
  return null;
}

/**
 * Check per-tier cooldown
 * - quick: 4 hours
 * - alert: 1 hour
 * - deep: no cooldown (always manual)
 */
function canSendAdvice(groupId: number, tier: AdviceTier): boolean {
  if (tier === 'deep') return true;

  const now = Date.now();
  const cd = cooldowns.get(groupId);

  if (!cd) return true;

  if (tier === 'quick') {
    return now - cd.last_quick_at >= QUICK_COOLDOWN_MS;
  }

  if (tier === 'alert') {
    return now - cd.last_alert_at >= ALERT_COOLDOWN_MS;
  }

  return true;
}

/**
 * Record that advice was sent (updates in-memory cooldown)
 */
export function recordAdviceSent(groupId: number, tier: AdviceTier): void {
  const now = Date.now();
  const cd = cooldowns.get(groupId) || { last_quick_at: 0, last_alert_at: 0 };

  if (tier === 'quick') {
    cd.last_quick_at = now;
  } else if (tier === 'alert') {
    cd.last_alert_at = now;
  }

  cooldowns.set(groupId, cd);
}
