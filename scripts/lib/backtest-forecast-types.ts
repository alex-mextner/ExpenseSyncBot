/**
 * Shared types and constants for scripts/backtest-forecast.ts and its report renderer.
 */

export interface CategoryConfig {
  name: string;
  monthlyAvg: number;
  monthlyStddev: number;
  avgTxPerMonth: number;
  budget: number;
}

export const DAYS_PER_MONTH = 30;

export type Status = 'on_track' | 'warning' | 'critical' | 'exceeded';
export type AlertKind = 'factual' | 'prognostic' | 'no_budget' | 'norm_anomaly' | 'velocity_spike';

export interface AlertEvent {
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

export interface AccuracyPoint {
  day: number;
  oldError: number;
  hybridError: number;
}

export interface BacktestResult {
  oldAlerts: AlertEvent[];
  hybridAlerts: AlertEvent[];
  accuracy: AccuracyPoint[];
  totalCheckDays: number;
}
