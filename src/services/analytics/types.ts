/**
 * Financial analytics types for smart advice system
 */

// === Budget Burn Rate ===

export interface BudgetBurnRate {
  category: string;
  budget_limit: number;
  spent: number;
  currency: string;
  days_elapsed: number;
  days_remaining: number;
  daily_burn_rate: number;
  projected_total: number;
  projected_overshoot: number;
  runway_days: number;
  status: 'on_track' | 'warning' | 'critical' | 'exceeded';
}

// === Spending Trends ===

export interface SpendingTrend {
  period: 'week' | 'month';
  current_total: number;
  previous_total: number;
  change_percent: number;
  direction: 'up' | 'down' | 'stable';
  category_changes: CategoryChange[];
}

export interface CategoryChange {
  category: string;
  current: number;
  previous: number;
  change_percent: number;
}

// === Category Anomaly Detection ===

export interface CategoryAnomaly {
  category: string;
  current_month_total: number;
  avg_3_month: number;
  deviation_ratio: number;
  severity: 'mild' | 'significant' | 'extreme';
}

// === Day-of-Week Patterns ===

export interface DayOfWeekPattern {
  day_of_week: number; // 0=Sun, 6=Sat (SQLite strftime('%w') convention)
  day_name: string;
  avg_daily_spend: number;
  total_transactions: number;
  vs_average_percent: number;
  top_category: string;
}

// === Spending Velocity ===

export interface SpendingVelocity {
  period_1_daily_avg: number;
  period_2_daily_avg: number;
  acceleration: number;
  trend: 'accelerating' | 'decelerating' | 'stable';
}

// === Budget Utilization ===

export interface BudgetUtilization {
  total_budget: number;
  total_spent: number;
  remaining: number;
  utilization_percent: number;
  remaining_percent: number;
}

// === Spending Streak ===

export interface SpendingStreak {
  current_streak_days: number;
  streak_type: 'above_average' | 'below_average' | 'no_spending';
  avg_daily_during_streak: number;
  overall_daily_average: number;
}

// === Monthly Projection ===

export interface MonthlyProjection {
  days_elapsed: number;
  days_in_month: number;
  current_total: number;
  projected_total: number;
  projected_vs_last_month: number;
  confidence: 'low' | 'medium' | 'high';
  category_projections: CategoryProjection[];
}

export interface CategoryProjection {
  category: string;
  current: number;
  projected: number;
  budget_limit: number | null;
  will_exceed: boolean;
}

// === Financial Snapshot (aggregate) ===

export interface FinancialSnapshot {
  burnRates: BudgetBurnRate[];
  weekTrend: SpendingTrend;
  monthTrend: SpendingTrend;
  anomalies: CategoryAnomaly[];
  dayOfWeekPatterns: DayOfWeekPattern[];
  velocity: SpendingVelocity;
  budgetUtilization: BudgetUtilization | null;
  streak: SpendingStreak;
  projection: MonthlyProjection | null;
}

// === SQL result types ===

export interface CategoryTotal {
  category: string;
  total: number;
  tx_count: number;
}

export interface DailyTotal {
  date: string;
  total: number;
  tx_count: number;
}

export interface DayOfWeekStats {
  dow: number;
  tx_count: number;
  total: number;
  unique_days: number;
}

export interface DayOfWeekTopCategory {
  dow: number;
  category: string;
  cat_total: number;
}

export interface WeekPeriodRow {
  period: string;
  category: string;
  total: number;
}

export interface MonthComparisonRow {
  category: string;
  current_month: number;
  previous_month: number;
}

export interface VelocityRow {
  period: string;
  total: number;
  tx_count: number;
}

export interface MonthlyHistoryRow {
  category: string;
  month: string;
  monthly_total: number;
}

// === Advice tiers ===

export type AdviceTier = 'quick' | 'alert' | 'deep';

export type TriggerType =
  | 'budget_threshold'
  | 'anomaly'
  | 'velocity_spike'
  | 'weekly_check'
  | 'first_expense_of_month'
  | 'pending_bank_transactions'
  | 'manual';

export type OverallSeverity = 'good' | 'watch' | 'concern' | 'critical';

// === Advice log ===

export interface AdviceLog {
  id: number;
  group_id: number;
  tier: AdviceTier;
  trigger_type: string;
  trigger_data: string | null;
  topic: string | null;
  advice_text: string;
  created_at: string;
}

export interface CreateAdviceLogData {
  group_id: number;
  tier: AdviceTier;
  trigger_type: string;
  trigger_data?: string;
  topic?: string;
  advice_text: string;
}

// === Trigger result ===

export interface TriggerResult {
  type: TriggerType;
  tier: AdviceTier;
  topic: string;
  data: Record<string, unknown>;
}
