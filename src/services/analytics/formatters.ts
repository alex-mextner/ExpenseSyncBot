/** Analytics formatters — converts financial snapshots into LLM-readable text for advice prompts */
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

    lines.push(
      `- ${br.category}: ТОЧНО ${br.spent.toFixed(2)} ${br.currency} потрачено из ${br.budget_limit.toFixed(2)} ${br.currency} (${percent}%). ` +
        `Темп: ${br.daily_burn_rate.toFixed(2)} ${br.currency}/день. ` +
        `Прогноз к концу месяца: ${br.projected_total.toFixed(2)} ${br.currency}. ` +
        `Запас: ${br.runway_days < 999 ? `${br.runway_days.toFixed(0)} дней` : '∞'}. ` +
        `[${statusLabel}]`,
    );
  }

  return lines.join('\n');
}

function formatBudgetUtilization(util: BudgetUtilization): string {
  const lines = ['=== ИСПОЛЬЗОВАНИЕ БЮДЖЕТА ==='];
  lines.push(`- Общий бюджет (EUR): ${util.total_budget.toFixed(2)}`);
  lines.push(
    `- Потрачено: ${util.total_spent.toFixed(2)} (${util.utilization_percent.toFixed(1)}%)`,
  );
  lines.push(`- Остаток: ${util.remaining.toFixed(2)} (${util.remaining_percent.toFixed(1)}%)`);

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
      `(€${weekTrend.current_total.toFixed(2)} vs €${weekTrend.previous_total.toFixed(2)} прошлая неделя)`,
  );

  // Top category changes for week
  const significantWeekChanges = weekTrend.category_changes
    .filter((c) => Math.abs(c.change_percent) > 20 && (c.current > 5 || c.previous > 5))
    .slice(0, 3);
  for (const c of significantWeekChanges) {
    lines.push(
      `  - ${c.category}: ${c.change_percent > 0 ? '+' : ''}${c.change_percent.toFixed(0)}% ` +
        `(€${c.current.toFixed(2)} vs €${c.previous.toFixed(2)})`,
    );
  }

  // Month
  const monthArrow =
    monthTrend.direction === 'up' ? '↑' : monthTrend.direction === 'down' ? '↓' : '→';
  lines.push(
    `- Месяц (пропорциональное сравнение): ${monthArrow} ${monthTrend.change_percent > 0 ? '+' : ''}${monthTrend.change_percent.toFixed(1)}% ` +
      `(€${monthTrend.current_total.toFixed(2)} vs €${monthTrend.previous_total.toFixed(2)} прошлый месяц)`,
  );

  return lines.join('\n');
}

function formatAnomalies(anomalies: CategoryAnomaly[]): string {
  const lines = ['=== АНОМАЛИИ ==='];

  for (const a of anomalies) {
    const severityLabel =
      a.severity === 'extreme' ? 'EXTREME' : a.severity === 'significant' ? 'SIGNIFICANT' : 'MILD';

    lines.push(
      `- ${a.category}: €${a.current_month_total.toFixed(2)} за текущий месяц vs среднее €${a.avg_3_month.toFixed(2)}/мес за 3 месяца. ` +
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
  lines.push(`- Текущая сумма: €${projection.current_total.toFixed(2)}`);
  lines.push(`- Прогноз: €${projection.projected_total.toFixed(2)}`);

  if (projection.projected_vs_last_month > 0) {
    lines.push(`- vs прошлый месяц: ${projection.projected_vs_last_month.toFixed(1)}%`);
  }

  // Categories that will exceed budget
  const exceeding = projection.category_projections.filter((cp) => cp.will_exceed);
  if (exceeding.length > 0) {
    lines.push('- Категории, которые превысят бюджет:');
    for (const cp of exceeding) {
      lines.push(
        `  - ${cp.category}: прогноз €${cp.projected.toFixed(2)} при бюджете €${cp.budget_limit?.toFixed(2)}`,
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
      `(€${velocity.period_2_daily_avg.toFixed(2)}/день последние 7 дней vs €${velocity.period_1_daily_avg.toFixed(2)}/день ранее)`,
  );

  return lines.join('\n');
}

function formatStreak(streak: SpendingStreak): string {
  const lines = ['=== СЕРИЯ ТРАТ ==='];

  const type = streak.streak_type === 'above_average' ? 'выше среднего' : 'ниже среднего';
  lines.push(`- ${streak.current_streak_days} дней подряд ${type}`);
  lines.push(
    `- Среднее в серии: €${streak.avg_daily_during_streak.toFixed(2)}/день vs общее среднее €${streak.overall_daily_average.toFixed(2)}/день`,
  );

  return lines.join('\n');
}
