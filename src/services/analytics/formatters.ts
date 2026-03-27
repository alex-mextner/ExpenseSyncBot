import type { CurrencyCode } from '../../config/constants';
import { formatAmount } from '../currency/converter';
import type {
  BudgetBurnRate,
  BudgetUtilization,
  CategoryAnomaly,
  FinancialSnapshot,
  MonthlyProjection,
  OverallSeverity,
  SpendingStreak,
  SpendingTrend,
  SpendingVelocity,
} from './types';

/**
 * Format full financial snapshot into text for LLM prompt
 */
export function formatSnapshotForPrompt(snapshot: FinancialSnapshot): string {
  const sections: string[] = [];

  // Section 1: Budget Burn Rates
  if (snapshot.burnRates.length > 0) {
    sections.push(formatBurnRates(snapshot.burnRates));
  }

  // Section 2: Budget Utilization
  if (snapshot.budgetUtilization) {
    sections.push(formatBudgetUtilization(snapshot.budgetUtilization));
  }

  // Section 3: Trends
  sections.push(formatTrends(snapshot.weekTrend, snapshot.monthTrend));

  // Section 4: Anomalies (only if present)
  if (snapshot.anomalies.length > 0) {
    sections.push(formatAnomalies(snapshot.anomalies));
  }

  // Section 5: Projection
  if (snapshot.projection) {
    sections.push(formatProjection(snapshot.projection));
  }

  // Section 6: Velocity (only if not stable)
  if (snapshot.velocity.trend !== 'stable') {
    sections.push(formatVelocity(snapshot.velocity));
  }

  // Section 7: Streak (only if >= 3 days)
  if (snapshot.streak.current_streak_days >= 3) {
    sections.push(formatStreak(snapshot.streak));
  }

  return sections.join('\n\n');
}

/**
 * Compute overall severity from snapshot
 */
export function computeOverallSeverity(snapshot: FinancialSnapshot): OverallSeverity {
  // Critical: any budget exceeded or extreme anomaly
  const hasExceeded = snapshot.burnRates.some((br) => br.status === 'exceeded');
  const hasExtremeAnomaly = snapshot.anomalies.some((a) => a.severity === 'extreme');
  if (hasExceeded || hasExtremeAnomaly) return 'critical';

  // Concern: critical burn rate, significant anomalies, or utilization > 90%
  const hasCriticalBurn = snapshot.burnRates.some((br) => br.status === 'critical');
  const hasSignificantAnomaly = snapshot.anomalies.some((a) => a.severity === 'significant');
  const highUtilization =
    snapshot.budgetUtilization && snapshot.budgetUtilization.utilization_percent > 90;
  if (hasCriticalBurn || hasSignificantAnomaly || highUtilization) return 'concern';

  // Watch: warning burn rate, accelerating velocity, or mild anomalies
  const hasWarningBurn = snapshot.burnRates.some((br) => br.status === 'warning');
  const isAccelerating =
    snapshot.velocity.trend === 'accelerating' && snapshot.velocity.acceleration > 20;
  const hasMildAnomaly = snapshot.anomalies.some((a) => a.severity === 'mild');
  if (hasWarningBurn || isAccelerating || hasMildAnomaly) return 'watch';

  return 'good';
}

function formatBurnRates(burnRates: BudgetBurnRate[]): string {
  const lines = ['=== BURN RATE (скорость сжигания бюджета) ==='];

  for (const br of burnRates) {
    const percent = br.budget_limit > 0 ? ((br.spent / br.budget_limit) * 100).toFixed(0) : '0';
    const statusLabel =
      br.status === 'exceeded'
        ? 'ПРЕВЫШЕН'
        : br.status === 'critical'
          ? 'КРИТИЧНО'
          : br.status === 'warning'
            ? 'ВНИМАНИЕ'
            : 'ОК';

    const cur = br.currency as CurrencyCode;
    lines.push(
      `- ${br.category}: ТОЧНО ${formatAmount(br.spent, cur, true)} потрачено из ${formatAmount(br.budget_limit, cur, true)} (${percent}%). ` +
        `Темп: ${formatAmount(br.daily_burn_rate, cur, true)}/день. ` +
        `Прогноз к концу месяца: ${formatAmount(br.projected_total, cur, true)}. ` +
        `Запас: ${br.runway_days < 999 ? `${br.runway_days.toFixed(0)} дней` : '∞'}. ` +
        `[${statusLabel}]`,
    );
  }

  return lines.join('\n');
}

function formatBudgetUtilization(util: BudgetUtilization): string {
  const lines = ['=== ИСПОЛЬЗОВАНИЕ БЮДЖЕТА ==='];
  lines.push(`- Общий бюджет (EUR): ${formatAmount(util.total_budget, 'EUR', true)}`);
  lines.push(
    `- Потрачено: ${formatAmount(util.total_spent, 'EUR', true)} (${util.utilization_percent.toFixed(1)}%)`,
  );
  lines.push(
    `- Остаток: ${formatAmount(util.remaining, 'EUR', true)} (${util.remaining_percent.toFixed(1)}%)`,
  );

  if (util.utilization_percent > 100) {
    lines.push('- Статус: БЮДЖЕТ ПРЕВЫШЕН');
  } else if (util.utilization_percent > 90) {
    lines.push('- Статус: ПОЧТИ ИСЧЕРПАН');
  }

  return lines.join('\n');
}

function formatTrends(weekTrend: SpendingTrend, monthTrend: SpendingTrend): string {
  const lines = ['=== ТРЕНДЫ ==='];

  // Week
  const weekArrow = weekTrend.direction === 'up' ? '↑' : weekTrend.direction === 'down' ? '↓' : '→';
  lines.push(
    `- Неделя: ${weekArrow} ${weekTrend.change_percent > 0 ? '+' : ''}${weekTrend.change_percent.toFixed(1)}% ` +
      `(${formatAmount(weekTrend.current_total, 'EUR', true)} vs ${formatAmount(weekTrend.previous_total, 'EUR', true)} прошлая неделя)`,
  );

  // Top category changes for week
  const significantWeekChanges = weekTrend.category_changes
    .filter((c) => Math.abs(c.change_percent) > 20 && (c.current > 5 || c.previous > 5))
    .slice(0, 3);
  for (const c of significantWeekChanges) {
    lines.push(
      `  - ${c.category}: ${c.change_percent > 0 ? '+' : ''}${c.change_percent.toFixed(0)}% ` +
        `(${formatAmount(c.current, 'EUR', true)} vs ${formatAmount(c.previous, 'EUR', true)})`,
    );
  }

  // Month
  const monthArrow =
    monthTrend.direction === 'up' ? '↑' : monthTrend.direction === 'down' ? '↓' : '→';
  lines.push(
    `- Месяц (пропорциональное сравнение): ${monthArrow} ${monthTrend.change_percent > 0 ? '+' : ''}${monthTrend.change_percent.toFixed(1)}% ` +
      `(${formatAmount(monthTrend.current_total, 'EUR', true)} vs ${formatAmount(monthTrend.previous_total, 'EUR', true)} прошлый месяц)`,
  );

  return lines.join('\n');
}

function formatAnomalies(anomalies: CategoryAnomaly[]): string {
  const lines = ['=== АНОМАЛИИ ==='];

  for (const a of anomalies) {
    const severityLabel =
      a.severity === 'extreme' ? 'EXTREME' : a.severity === 'significant' ? 'SIGNIFICANT' : 'MILD';

    lines.push(
      `- ${a.category}: ${formatAmount(a.current_month_total, 'EUR', true)} за текущий месяц vs среднее ${formatAmount(a.avg_3_month, 'EUR', true)}/мес за 3 месяца. ` +
        `Отклонение: ${a.deviation_ratio.toFixed(2)}x (траты в ${a.deviation_ratio.toFixed(1)} раза выше среднего за 3 мес). [${severityLabel}]`,
    );
  }

  return lines.join('\n');
}

function formatProjection(projection: MonthlyProjection): string {
  const lines = ['=== ПРОГНОЗ НА КОНЕЦ МЕСЯЦА ==='];

  const confidenceLabel =
    projection.confidence === 'low'
      ? '(НИЗКАЯ ТОЧНОСТЬ, мало данных)'
      : projection.confidence === 'medium'
        ? '(средняя точность)'
        : '(высокая точность)';

  lines.push(`- День ${projection.days_elapsed}/${projection.days_in_month} ${confidenceLabel}`);
  lines.push(`- Текущая сумма: ${formatAmount(projection.current_total, 'EUR', true)}`);
  lines.push(`- Прогноз: ${formatAmount(projection.projected_total, 'EUR', true)}`);

  if (projection.projected_vs_last_month > 0) {
    lines.push(`- vs прошлый месяц: ${projection.projected_vs_last_month.toFixed(1)}%`);
  }

  // Categories that will exceed budget
  const exceeding = projection.category_projections.filter((cp) => cp.will_exceed);
  if (exceeding.length > 0) {
    lines.push('- Категории, которые превысят бюджет:');
    for (const cp of exceeding) {
      lines.push(
        `  - ${cp.category}: прогноз ${formatAmount(cp.projected, 'EUR', true)} при бюджете ${cp.budget_limit != null ? formatAmount(cp.budget_limit, 'EUR', true) : '—'}`,
      );
    }
  }

  return lines.join('\n');
}

function formatVelocity(velocity: SpendingVelocity): string {
  const lines = ['=== СКОРОСТЬ ТРАТ ==='];

  const trend = velocity.trend === 'accelerating' ? 'Ускорение' : 'Замедление';
  lines.push(
    `- ${trend}: ${velocity.acceleration > 0 ? '+' : ''}${velocity.acceleration.toFixed(1)}% ` +
      `(${formatAmount(velocity.period_2_daily_avg, 'EUR', true)}/день последние 7 дней vs ${formatAmount(velocity.period_1_daily_avg, 'EUR', true)}/день ранее)`,
  );

  return lines.join('\n');
}

function formatStreak(streak: SpendingStreak): string {
  const lines = ['=== СЕРИЯ ТРАТ ==='];

  const type = streak.streak_type === 'above_average' ? 'выше среднего' : 'ниже среднего';
  lines.push(`- ${streak.current_streak_days} дней подряд ${type}`);
  lines.push(
    `- Среднее в серии: ${formatAmount(streak.avg_daily_during_streak, 'EUR', true)}/день vs общее среднее ${formatAmount(streak.overall_daily_average, 'EUR', true)}/день`,
  );

  return lines.join('\n');
}
