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

  // Priority order: budget_threshold > anomaly > velocity_spike > weekly_check > first_expense_of_month

  // === Trigger 1: Budget threshold crossing (>80%, >100%) ===
  for (const br of snap.burnRates) {
    // Skip projection-based alerts (critical/warning) in the first 5 days —
    // projections are too unreliable with so little data. Only fire if actually exceeded.
    if (br.status !== 'exceeded' && br.days_elapsed < 5) continue;

    if (br.status === 'exceeded' && br.budget_limit > 0) {
      const topic = `budget_threshold:${br.category}:exceeded`;
      if (!database.adviceLogs.hasTopicThisMonth(groupId, topic, monthStart)) {
        if (canSendAdvice(groupId, 'alert')) {
          return {
            type: 'budget_threshold',
            tier: 'alert',
            topic,
            data: {
              category: br.category,
              spent: br.spent,
              limit: br.budget_limit,
              currency: br.currency,
            },
          };
        }
      }
    } else if ((br.status === 'critical' || br.status === 'warning') && br.budget_limit > 0) {
      const threshold = br.status === 'critical' ? '100' : '80';
      const topic = `budget_threshold:${br.category}:${threshold}`;
      if (!database.adviceLogs.hasTopicThisMonth(groupId, topic, monthStart)) {
        if (canSendAdvice(groupId, 'alert')) {
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
      }
    }
  }

  // === Trigger 2: Category anomaly (> 1.5x average) ===
  for (const anomaly of snap.anomalies) {
    if (anomaly.severity === 'significant' || anomaly.severity === 'extreme') {
      const topic = `anomaly:${anomaly.category}`;
      if (!database.adviceLogs.hasTopicThisMonth(groupId, topic, monthStart)) {
        if (canSendAdvice(groupId, 'alert')) {
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
      }
    }
  }

  // === Trigger 3: Velocity spike (acceleration > 50%) ===
  if (snap.velocity.trend === 'accelerating' && snap.velocity.acceleration > 50) {
    const topic = 'velocity_spike';
    // Check cooldown via advice_log (max once per 7 days)
    const recentVelocityAlerts = database.adviceLogs
      .getRecent(groupId, 20)
      .filter((a) => a.topic === topic);
    const lastVelocityAlert = recentVelocityAlerts[0];
    const sevenDaysAgo = Date.now() - 7 * 24 * 60 * 60 * 1000;

    if (!lastVelocityAlert || new Date(lastVelocityAlert.created_at).getTime() < sevenDaysAgo) {
      if (canSendAdvice(groupId, 'quick')) {
        return {
          type: 'velocity_spike',
          tier: 'quick',
          topic,
          data: {
            acceleration: snap.velocity.acceleration,
            recent_avg: snap.velocity.period_2_daily_avg,
            earlier_avg: snap.velocity.period_1_daily_avg,
          },
        };
      }
    }
  }

  // === Trigger 4: Weekly check (Monday) ===
  if (now.getDay() === 1) {
    // Monday
    const topic = `weekly_check:${format(now, 'yyyy-ww')}`;
    if (!database.adviceLogs.hasTopicThisMonth(groupId, topic, monthStart)) {
      if (canSendAdvice(groupId, 'quick')) {
        const severity = computeOverallSeverity(snap);
        return {
          type: 'weekly_check',
          tier: 'quick',
          topic,
          data: { severity, weekday: 'Monday' },
        };
      }
    }
  }

  // === Trigger 5: First expense of the month ===
  if (now.getDate() <= 3) {
    const currentMonthStart = format(startOfMonth(now), 'yyyy-MM-dd');
    const expenseCount = database.expenses.getCountForRange(groupId, currentMonthStart, today);
    if (expenseCount === 1) {
      const topic = `first_expense:${format(now, 'yyyy-MM')}`;
      if (!database.adviceLogs.hasTopicThisMonth(groupId, topic, monthStart)) {
        if (canSendAdvice(groupId, 'quick')) {
          return {
            type: 'first_expense_of_month',
            tier: 'quick',
            topic,
            data: { month: format(now, 'yyyy-MM') },
          };
        }
      }
    }
  }

  // === Trigger 6: Recurring expense missed ===
  const overduePatterns = database.recurringPatterns.findOverdue(groupId, today);
  const firstOverdue = overduePatterns[0];
  if (firstOverdue) {
    const topic = `recurring_missed:${firstOverdue.category}:${firstOverdue.next_expected_date}`;
    if (!database.adviceLogs.hasTopicThisMonth(groupId, topic, monthStart)) {
      if (canSendAdvice(groupId, 'quick')) {
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
    }
  }

  // === Trigger 7: Pending bank transactions need review ===
  const pendingConnections = database.bankConnections.findActiveByGroupId(groupId);
  let totalPending = 0;
  for (const conn of pendingConnections) {
    totalPending += database.bankTransactions.findPendingByConnectionId(conn.id).length;
  }
  if (totalPending > 0) {
    // Embed today's date to allow daily reminders (unlike other triggers which use monthly dedup)
    const topic = `pending_bank_transactions:${today}`;
    if (!database.adviceLogs.hasTopicThisMonth(groupId, topic, monthStart)) {
      if (canSendAdvice(groupId, 'quick')) {
        return {
          type: 'pending_bank_transactions',
          tier: 'quick',
          topic,
          data: { count: totalPending },
        };
      }
    }
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
