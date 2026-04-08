/** Analytics formatters — converts financial snapshots into LLM-readable text for advice prompts */
import { BASE_CURRENCY, type CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import { convertCurrency, formatAmount } from '../currency/converter';
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
  TechnicalAnalysis,
} from './types';

/**
 * Format full financial snapshot into text for LLM prompt.
 * displayCurrency — group's default currency; all EUR amounts are converted for user context.
 */
export function formatSnapshotForPrompt(
  snapshot: FinancialSnapshot,
  groupId: number,
  displayCurrency: CurrencyCode = BASE_CURRENCY,
): string {
  const sections: string[] = [];

  // Section 1: Budget Burn Rates
  if (snapshot.burnRates.length > 0) {
    sections.push(formatBurnRates(snapshot.burnRates, displayCurrency));
  }

  // Section 2: Budget Utilization
  if (snapshot.budgetUtilization) {
    sections.push(formatBudgetUtilization(snapshot.budgetUtilization, displayCurrency));
  }

  // Section 3: Trends
  sections.push(formatTrends(snapshot.weekTrend, snapshot.monthTrend, displayCurrency));

  // Section 4: Anomalies (only if present)
  if (snapshot.anomalies.length > 0) {
    sections.push(formatAnomalies(snapshot.anomalies, displayCurrency));
  }

  // Section 5: Projection
  if (snapshot.projection) {
    sections.push(formatProjection(snapshot.projection, displayCurrency));
  }

  // Section 6: Velocity (only if not stable)
  if (snapshot.velocity.trend !== 'stable') {
    sections.push(formatVelocity(snapshot.velocity, displayCurrency));
  }

  // Section 7: Streak (only if >= 3 days)
  if (snapshot.streak.current_streak_days >= 3) {
    sections.push(formatStreak(snapshot.streak, displayCurrency));
  }

  // Section 8: Technical Analysis summary
  if (snapshot.technicalAnalysis) {
    sections.push(formatTechnicalAnalysis(snapshot.technicalAnalysis));
  }

  let result = sections.join('\n\n');

  // Add bank balances if any connections exist
  const bankAccounts = database.bankAccounts.findByGroupId(groupId);
  if (bankAccounts.length > 0) {
    const balanceLines = bankAccounts
      .map((a) => `${a.title}: ${a.balance.toFixed(2)} ${a.currency}`)
      .join('\n');
    result += `\n\n## Банковские балансы\n${balanceLines}`;
  }

  // Add recent confirmed bank transactions (last 20)
  const recentBankTxs = database.bankTransactions
    .findByGroupId(groupId, { status: 'confirmed' })
    .slice(0, 20);
  if (recentBankTxs.length > 0) {
    const txLines = recentBankTxs
      .map(
        (tx) =>
          `${tx.date} ${tx.amount} ${tx.currency} — ${tx.merchant_normalized ?? tx.merchant ?? '—'}`,
      )
      .join('\n');
    result += `\n\n## Подтверждённые банковские транзакции\n${txLines}`;
  }

  return result;
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

function formatBurnRates(burnRates: BudgetBurnRate[], displayCurrency: CurrencyCode): string {
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

    // br amounts are in br.currency; convert to displayCurrency for consistent AI context
    const budgetCur = br.currency as CurrencyCode;
    const cv = (v: number) => convertCurrency(v, budgetCur, displayCurrency);
    lines.push(
      `- ${br.category}: ТОЧНО ${formatAmount(cv(br.spent), displayCurrency, true)} потрачено из ${formatAmount(cv(br.budget_limit), displayCurrency, true)} (${percent}%). ` +
        `Темп: ${formatAmount(cv(br.daily_burn_rate), displayCurrency, true)}/день. ` +
        `Прогноз к концу месяца: ${formatAmount(cv(br.projected_total), displayCurrency, true)}. ` +
        `Запас: ${br.runway_days < 999 ? `${br.runway_days.toFixed(0)} дней` : '∞'}. ` +
        `[${statusLabel}]`,
    );
  }

  return lines.join('\n');
}

function formatBudgetUtilization(util: BudgetUtilization, displayCurrency: CurrencyCode): string {
  const lines = ['=== ИСПОЛЬЗОВАНИЕ БЮДЖЕТА ==='];
  const totalBudgetDisplay = convertCurrency(util.total_budget, BASE_CURRENCY, displayCurrency);
  const totalSpentDisplay = convertCurrency(util.total_spent, BASE_CURRENCY, displayCurrency);
  const remainingDisplay = convertCurrency(util.remaining, BASE_CURRENCY, displayCurrency);
  lines.push(`- Общий бюджет: ${formatAmount(totalBudgetDisplay, displayCurrency, true)}`);
  lines.push(
    `- Потрачено: ${formatAmount(totalSpentDisplay, displayCurrency, true)} (${util.utilization_percent.toFixed(1)}%)`,
  );
  lines.push(
    `- Остаток: ${formatAmount(remainingDisplay, displayCurrency, true)} (${util.remaining_percent.toFixed(1)}%)`,
  );

  if (util.utilization_percent > 100) {
    lines.push('- Статус: БЮДЖЕТ ПРЕВЫШЕН');
  } else if (util.utilization_percent > 90) {
    lines.push('- Статус: ПОЧТИ ИСЧЕРПАН');
  }

  return lines.join('\n');
}

function formatTrends(
  weekTrend: SpendingTrend,
  monthTrend: SpendingTrend,
  displayCurrency: CurrencyCode,
): string {
  const lines = ['=== ТРЕНДЫ ==='];
  const cv = (eur: number) => convertCurrency(eur, BASE_CURRENCY, displayCurrency);

  // Week
  const weekArrow = weekTrend.direction === 'up' ? '↑' : weekTrend.direction === 'down' ? '↓' : '→';
  lines.push(
    `- Неделя: ${weekArrow} ${weekTrend.change_percent > 0 ? '+' : ''}${weekTrend.change_percent.toFixed(1)}% ` +
      `(${formatAmount(cv(weekTrend.current_total), displayCurrency, true)} vs ${formatAmount(cv(weekTrend.previous_total), displayCurrency, true)} прошлая неделя)`,
  );

  // Top category changes for week
  const significantWeekChanges = weekTrend.category_changes
    .filter((c) => Math.abs(c.change_percent) > 20 && (c.current > 5 || c.previous > 5))
    .slice(0, 3);
  for (const c of significantWeekChanges) {
    lines.push(
      `  - ${c.category}: ${c.change_percent > 0 ? '+' : ''}${c.change_percent.toFixed(0)}% ` +
        `(${formatAmount(cv(c.current), displayCurrency, true)} vs ${formatAmount(cv(c.previous), displayCurrency, true)})`,
    );
  }

  // Month
  const monthArrow =
    monthTrend.direction === 'up' ? '↑' : monthTrend.direction === 'down' ? '↓' : '→';
  lines.push(
    `- Месяц (пропорциональное сравнение): ${monthArrow} ${monthTrend.change_percent > 0 ? '+' : ''}${monthTrend.change_percent.toFixed(1)}% ` +
      `(${formatAmount(cv(monthTrend.current_total), displayCurrency, true)} vs ${formatAmount(cv(monthTrend.previous_total), displayCurrency, true)} прошлый месяц)`,
  );

  return lines.join('\n');
}

function formatAnomalies(anomalies: CategoryAnomaly[], displayCurrency: CurrencyCode): string {
  const lines = ['=== АНОМАЛИИ ==='];

  for (const a of anomalies) {
    const severityLabel =
      a.severity === 'extreme' ? 'EXTREME' : a.severity === 'significant' ? 'SIGNIFICANT' : 'MILD';

    const currentDisplay = convertCurrency(a.current_month_total, BASE_CURRENCY, displayCurrency);
    const avgDisplay = convertCurrency(a.avg_3_month, BASE_CURRENCY, displayCurrency);
    lines.push(
      `- ${a.category}: ${formatAmount(currentDisplay, displayCurrency, true)} за текущий месяц vs среднее ${formatAmount(avgDisplay, displayCurrency, true)}/мес за 3 месяца. ` +
        `Отклонение: ${a.deviation_ratio.toFixed(2)}x (траты в ${a.deviation_ratio.toFixed(1)} раза выше среднего за 3 мес). [${severityLabel}]`,
    );
  }

  return lines.join('\n');
}

function formatProjection(projection: MonthlyProjection, displayCurrency: CurrencyCode): string {
  const lines = ['=== ПРОГНОЗ НА КОНЕЦ МЕСЯЦА ==='];
  const cv = (eur: number) => convertCurrency(eur, BASE_CURRENCY, displayCurrency);

  const confidenceLabel =
    projection.confidence === 'low'
      ? '(НИЗКАЯ ТОЧНОСТЬ, мало данных)'
      : projection.confidence === 'medium'
        ? '(средняя точность)'
        : '(высокая точность)';

  lines.push(`- День ${projection.days_elapsed}/${projection.days_in_month} ${confidenceLabel}`);
  lines.push(
    `- Текущая сумма: ${formatAmount(cv(projection.current_total), displayCurrency, true)}`,
  );
  lines.push(`- Прогноз: ${formatAmount(cv(projection.projected_total), displayCurrency, true)}`);

  if (projection.projected_vs_last_month > 0) {
    lines.push(`- vs прошлый месяц: ${projection.projected_vs_last_month.toFixed(1)}%`);
  }

  // Categories that will exceed budget
  const exceeding = projection.category_projections.filter((cp) => cp.will_exceed);
  if (exceeding.length > 0) {
    lines.push('- Категории, которые превысят бюджет:');
    for (const cp of exceeding) {
      lines.push(
        `  - ${cp.category}: прогноз ${formatAmount(cv(cp.projected), displayCurrency, true)} при бюджете ${cp.budget_limit != null ? formatAmount(cv(cp.budget_limit), displayCurrency, true) : '—'}`,
      );
    }
  }

  return lines.join('\n');
}

function formatVelocity(velocity: SpendingVelocity, displayCurrency: CurrencyCode): string {
  const lines = ['=== СКОРОСТЬ ТРАТ ==='];
  const cv = (eur: number) => convertCurrency(eur, BASE_CURRENCY, displayCurrency);

  const trend = velocity.trend === 'accelerating' ? 'Ускорение' : 'Замедление';
  lines.push(
    `- ${trend}: ${velocity.acceleration > 0 ? '+' : ''}${velocity.acceleration.toFixed(1)}% ` +
      `(${formatAmount(cv(velocity.period_2_daily_avg), displayCurrency, true)}/день последние 7 дней vs ${formatAmount(cv(velocity.period_1_daily_avg), displayCurrency, true)}/день ранее)`,
  );

  return lines.join('\n');
}

function formatStreak(streak: SpendingStreak, displayCurrency: CurrencyCode): string {
  const lines = ['=== СЕРИЯ ТРАТ ==='];
  const cv = (eur: number) => convertCurrency(eur, BASE_CURRENCY, displayCurrency);

  const type = streak.streak_type === 'above_average' ? 'выше среднего' : 'ниже среднего';
  lines.push(`- ${streak.current_streak_days} дней подряд ${type}`);
  lines.push(
    `- Среднее в серии: ${formatAmount(cv(streak.avg_daily_during_streak), displayCurrency, true)}/день vs общее среднее ${formatAmount(cv(streak.overall_daily_average), displayCurrency, true)}/день`,
  );

  return lines.join('\n');
}

/** Format technical analysis results for LLM context */
function formatTechnicalAnalysis(ta: TechnicalAnalysis): string {
  const lines = ['=== ТЕХНИЧЕСКИЙ АНАЛИЗ ==='];

  for (const cat of ta.categories) {
    const parts: string[] = [`<b>${cat.category}</b> (${cat.monthsOfData} мес)`];

    // Current month spending
    if (cat.currentMonthSpent > 0) {
      parts.push(`Текущий месяц: ${Math.round(cat.currentMonthSpent)}`);
    }

    // Trend direction
    const trendLabel =
      cat.trend.direction === 'rising'
        ? 'растёт'
        : cat.trend.direction === 'falling'
          ? 'падает'
          : 'стабильно';
    parts.push(`Тренд: ${trendLabel} (${Math.round(cat.trend.confidence * 100)}%)`);

    // Ensemble forecast
    parts.push(`Прогноз: ${Math.round(cat.forecasts.ensemble)}`);

    // Quantile range
    const q = cat.forecasts.quantiles;
    parts.push(`P50=${Math.round(q.p50)} P75=${Math.round(q.p75)} P90=${Math.round(q.p90)}`);

    // Bollinger position
    const bb = cat.volatility.bollingerBands;
    if (bb.percentB > 0.9) parts.push('выше полосы Боллинджера');
    else if (bb.percentB < 0.1) parts.push('ниже полосы Боллинджера');

    // Anomaly
    if (cat.anomaly.isAnomaly) {
      parts.push(`аномалия (${cat.anomaly.anomalyCount}/3)`);
    }

    // MACD crossover
    if (cat.trend.macd.crossover !== 'none') {
      parts.push(`MACD ${cat.trend.macd.crossover === 'bullish' ? 'рост' : 'снижение'}`);
    }

    // RSI extreme
    if (cat.trend.rsi.signal !== 'neutral') {
      parts.push(`RSI ${Math.round(cat.trend.rsi.value)}`);
    }

    // Change points
    if (cat.trend.changePoints.length > 0) {
      parts.push(`${cat.trend.changePoints.length} смен режима`);
    }

    // Hurst
    if (cat.trend.hurst.type !== 'random_walk') {
      parts.push(
        `Hurst ${cat.trend.hurst.value.toFixed(2)} ${cat.trend.hurst.type === 'trending' ? 'трендовая' : 'возвратная'}`,
      );
    }

    // Croston (intermittent)
    if (cat.forecasts.croston) {
      const cr = cat.forecasts.croston;
      parts.push(
        `Кростон: ~${Math.round(cr.expectedAmount)} / ${cr.expectedInterval.toFixed(1)} мес`,
      );
    }

    lines.push(`- ${parts.join('; ')}`);
  }

  // Category correlations
  if (ta.correlations.length > 0) {
    lines.push('');
    lines.push('Корреляции:');
    for (const corr of ta.correlations.slice(0, 5)) {
      const sign = corr.correlation > 0 ? '+' : '';
      lines.push(
        `- ${corr.category1} ↔ ${corr.category2}: r=${sign}${corr.correlation.toFixed(2)}`,
      );
    }
  }

  return lines.join('\n');
}
