/**
 * get_technical_analysis tool: renders the TA snapshot (trend, forecast, volatility, anomaly and
 * momentum signals, category correlations) as plain-language Russian text. TA snapshot amounts are
 * EUR; every figure is converted to the group's default currency before it reaches the model.
 */
import { getDaysInMonth } from 'date-fns';
import { BASE_CURRENCY, type CurrencyCode } from '../../../config/constants';
import { database } from '../../../database';
import { spendingAnalytics } from '../../analytics/spending-analytics';
import type { CategoryTaAnalysis } from '../../analytics/ta/analyzer';
import type { CorrelationResult } from '../../analytics/ta/types';
import { convertCurrency, formatAmount } from '../../currency/converter';
import type { AgentContext, ToolResult } from '../types';

/** Formats an EUR amount in the group's default currency. */
type FormatEur = (eurAmount: number) => string;

const MAX_CORRELATIONS = 10;

function trendDirectionRu(direction: CategoryTaAnalysis['trend']['direction']): string {
  if (direction === 'rising') return 'растут';
  if (direction === 'falling') return 'снижаются';
  return 'стабильны';
}

function correlationStrengthRu(strength: CorrelationResult['strength']): string {
  if (strength === 'strong_positive' || strength === 'strong_negative') return 'сильная';
  if (strength === 'moderate_positive' || strength === 'moderate_negative') return 'заметная';
  return 'слабая';
}

/** Title, current-month pace, history forecast, trend and the normal corridor. */
function overviewLines(cat: CategoryTaAnalysis, fmt: FormatEur): string[] {
  const confidencePct = Math.round(cat.trend.confidence * 100);
  const q = cat.forecasts.quantiles;
  const bb = cat.volatility.bollingerBands;

  // Current month pace: extrapolate current spending to end of month
  const now = new Date();
  const dayOfMonth = now.getDate();
  const daysInMonth = getDaysInMonth(now);
  const paceProjectionEur = dayOfMonth > 0 ? (cat.currentMonthSpent / dayOfMonth) * daysInMonth : 0;

  return [
    `## ${cat.category} (данные за ${cat.monthsOfData} мес.)`,
    `Текущий месяц: потрачено ${fmt(cat.currentMonthSpent)} за ${dayOfMonth} из ${daysInMonth} дней`,
    `Темп текущего месяца: если так пойдёт дальше → ~${fmt(paceProjectionEur)} к концу месяца`,
    `Прогноз по истории: ~${fmt(cat.forecasts.ensemble)}`,
    `Тренд: расходы ${trendDirectionRu(cat.trend.direction)} (уверенность ${confidencePct}%)`,
    `Обычный коридор: ${fmt(bb.lower)}–${fmt(bb.upper)}, в худшем случае до ${fmt(q.p95)}`,
  ];
}

/** Monthly change direction (Holt trend) and the anomaly warning for the current month. */
function changeLines(cat: CategoryTaAnalysis, fmt: FormatEur): string[] {
  const lines: string[] = [];
  const holtTrend = cat.forecasts.holt.trend;
  if (holtTrend !== 0) {
    const changeDir = holtTrend > 0 ? 'растут' : 'снижаются';
    lines.push(`Динамика: расходы ${changeDir} примерно на ${fmt(Math.abs(holtTrend))}/мес.`);
  }

  if (cat.anomaly.isAnomaly) {
    const severity = Math.abs(cat.anomaly.zScore.zScore) > 3 ? 'сильно' : 'заметно';
    lines.push(`⚠️ Необычный расход: текущий месяц ${severity} выбивается из нормы`);
  }
  return lines;
}

/** Momentum signals: MACD crossover and RSI extremes, in user terms. */
function momentumLines(cat: CategoryTaAnalysis): string[] {
  const lines: string[] = [];
  if (cat.trend.macd.crossover === 'bullish') {
    lines.push('📈 Расходы начали расти после периода снижения');
  } else if (cat.trend.macd.crossover === 'bearish') {
    lines.push('📉 Расходы начали снижаться после периода роста');
  }

  // Unusually high/low spending (RSI in user terms)
  if (cat.trend.rsi.signal === 'overbought') {
    lines.push(
      '🔴 Траты непривычно высокие уже несколько месяцев — стоит проверить, не появились ли лишние расходы',
    );
  } else if (cat.trend.rsi.signal === 'oversold') {
    lines.push('🟢 Траты непривычно низкие — возможно, что-то откладывается и потом придёт разом');
  }
  return lines;
}

/** Predictability (Hurst) and regime changes (change points), in user terms. */
function characterLines(cat: CategoryTaAnalysis): string[] {
  const lines: string[] = [];
  if (cat.trend.hurst.type === 'trending') {
    lines.push('Характер расходов: стабильный, скорее всего продолжат в том же направлении');
  } else if (cat.trend.hurst.type === 'mean_reverting') {
    lines.push('Характер расходов: после всплесков обычно возвращаются к привычному уровню');
  } else {
    lines.push('Характер расходов: меняются хаотично, сложно предсказать');
  }

  if (cat.trend.changePoints.length > 0) {
    lines.push(`За историю было ${cat.trend.changePoints.length} резких смен уровня трат`);
  }
  return lines;
}

/** Typical bounds (pivot points), intermittent spending (Croston) and record high (Donchian). */
function boundsLines(cat: CategoryTaAnalysis, fmt: FormatEur): string[] {
  const pp = cat.trend.pivotPoints;
  const lines = [
    `Типичный минимум ~${fmt(pp.support1)}, типичный максимум ~${fmt(pp.resistance1)}`,
  ];

  const croston = cat.forecasts.croston;
  if (croston) {
    lines.push(
      `Нерегулярные расходы: ~${fmt(croston.expectedAmount)} примерно раз в ${croston.expectedInterval.toFixed(1)} мес.`,
    );
  }

  if (cat.volatility.donchian.isBreakoutHigh) {
    lines.push('🚨 Расходы достигли исторического максимума!');
  }
  return lines;
}

function describeCategory(cat: CategoryTaAnalysis, fmt: FormatEur): string {
  return [
    ...overviewLines(cat, fmt),
    ...changeLines(cat, fmt),
    ...momentumLines(cat),
    ...characterLines(cat),
    ...boundsLines(cat, fmt),
  ].join('\n');
}

function describeCorrelations(correlations: CorrelationResult[]): string {
  const lines = ['## Связи между категориями'];
  for (const corr of correlations.slice(0, MAX_CORRELATIONS)) {
    const direction = corr.correlation > 0 ? 'растут вместе' : 'одна растёт — другая падает';
    lines.push(
      `${corr.category1} ↔ ${corr.category2}: ${direction} (${correlationStrengthRu(corr.strength)} связь)`,
    );
  }
  return lines.join('\n');
}

export function executeGetTechnicalAnalysis(
  input: Record<string, unknown>,
  ctx: AgentContext,
): ToolResult {
  const snapshot = spendingAnalytics.getFinancialSnapshot(ctx.groupId);

  if (!snapshot.technicalAnalysis) {
    return {
      success: true,
      output: 'Недостаточно данных для технического анализа (нужно ≥3 месяцев истории).',
    };
  }

  const group = database.groups.findById(ctx.groupId);
  const displayCurrency: CurrencyCode = group?.default_currency ?? BASE_CURRENCY;
  // TA snapshot amounts are stored in EUR (eur_amount aggregations).
  // Convert + format each number for the user's default currency so the AI
  // surfaces meaningful figures instead of leaking raw EUR.
  const fmt: FormatEur = (eurAmount) =>
    formatAmount(convertCurrency(eurAmount, BASE_CURRENCY, displayCurrency), displayCurrency);

  const ta = snapshot.technicalAnalysis;
  const categoryFilter = input['category'] as string | undefined;

  const categories = categoryFilter
    ? ta.categories.filter((c) => c.category.toLowerCase() === categoryFilter.toLowerCase())
    : ta.categories;

  if (categories.length === 0) {
    return {
      success: true,
      output: categoryFilter
        ? `Нет данных для категории "${categoryFilter}". Доступные: ${ta.categories.map((c) => c.category).join(', ')}`
        : 'Нет категорий с достаточной историей для анализа.',
    };
  }

  const sections = categories.map((cat) => describeCategory(cat, fmt));
  if (ta.correlations.length > 0) {
    sections.push(describeCorrelations(ta.correlations));
  }

  return { success: true, output: sections.join('\n\n') };
}
