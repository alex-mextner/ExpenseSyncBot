/**
 * Qualitative backtest: measures actionability, timeliness, signal/noise quality,
 * severity accuracy, and alert density for old (naive) vs new (EMA) vs TA-enhanced forecasting.
 *
 * Unlike the quantitative backtest (precision, FP count, MAPE), this tool evaluates
 * whether alerts are *useful* to a human:
 *   - Can the user act on the alert? (enough days remaining)
 *   - Was the alert timely? (earlier correct alerts > late ones)
 *   - Is the alert density manageable? (too many alerts = ignored)
 *   - Does severity match the actual outcome?
 *   - Which categories are noisy?
 *   - Overall signal quality (combined 0-1 metric)
 *
 * Run: bun scripts/backtest-qualitative.ts
 */

import { Database } from 'bun:sqlite';
import { analyzeCategory } from '../src/services/analytics/ta/analyzer';
import type { QualitativeMetrics } from '../src/services/analytics/ta/types';

// ═══════════════════════════════════════════════════════════════
// Inlined projection functions (avoid env var dependency)
// ═══════════════════════════════════════════════════════════════

interface CategoryProfile {
  ema: number;
  cv: number;
  monthsOfData: number;
}

function buildCategoryProfiles(
  historyRows: { category: string; month: string; monthly_total: number; tx_count: number }[],
): Map<string, CategoryProfile> {
  const byCategory = new Map<string, number[]>();
  for (const row of historyRows) {
    let totals = byCategory.get(row.category);
    if (!totals) {
      totals = [];
      byCategory.set(row.category, totals);
    }
    totals.push(row.monthly_total);
  }

  const profiles = new Map<string, CategoryProfile>();
  for (const [category, totals] of byCategory) {
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
    profiles.set(category, { ema: Math.round(ema * 100) / 100, cv: Math.round(cv * 1000) / 1000, monthsOfData: n });
  }
  return profiles;
}

function projectCategoryEma(
  currentSpent: number,
  daysElapsed: number,
  daysInMonth: number,
  profile: CategoryProfile | null,
): number {
  if (daysElapsed <= 0) return currentSpent;
  if (!profile) return currentSpent;
  const monthProgress = daysElapsed / daysInMonth;
  const alpha = Math.min(1, monthProgress * monthProgress * (1 + profile.cv));
  const historyBased = Math.max(currentSpent, profile.ema);
  const paceBased = (currentSpent / daysElapsed) * daysInMonth;
  return Math.round((alpha * paceBased + (1 - alpha) * historyBased) * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════
// Spending simulation (same as quantitative backtest)
// ═══════════════════════════════════════════════════════════════

interface CategoryConfig {
  name: string;
  monthlyAvg: number;
  monthlyStddev: number;
  avgTxPerMonth: number;
  budget: number;
}

const CATEGORIES: CategoryConfig[] = [
  { name: 'Еда', monthlyAvg: 300, monthlyStddev: 40, avgTxPerMonth: 25, budget: 400 },
  { name: 'Транспорт', monthlyAvg: 80, monthlyStddev: 20, avgTxPerMonth: 15, budget: 120 },
  { name: 'Машина', monthlyAvg: 100, monthlyStddev: 30, avgTxPerMonth: 2, budget: 150 },
  { name: 'Подписки', monthlyAvg: 50, monthlyStddev: 5, avgTxPerMonth: 3, budget: 60 },
  { name: 'Развлечения', monthlyAvg: 120, monthlyStddev: 80, avgTxPerMonth: 4, budget: 200 },
  { name: 'Здоровье', monthlyAvg: 40, monthlyStddev: 50, avgTxPerMonth: 1, budget: 100 },
];

const MONTHS = 12;
const DAYS_PER_MONTH = 30;

interface DailyExpense {
  day: number;
  month: number;
  category: string;
  amount: number;
}

function generateSpendingData(seed: number): DailyExpense[] {
  let state = seed;
  const rand = () => {
    state = (state * 1664525 + 1013904223) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  const normalR = (mean: number, std: number) => {
    const u1 = rand();
    const u2 = rand();
    const z = Math.sqrt(-2 * Math.log(u1 + 0.0001)) * Math.cos(2 * Math.PI * u2);
    return Math.max(0, mean + std * z);
  };

  const expenses: DailyExpense[] = [];
  for (let month = 0; month < MONTHS; month++) {
    for (const cat of CATEGORIES) {
      const monthlyTarget = normalR(cat.monthlyAvg, cat.monthlyStddev);
      const txCount = Math.max(1, Math.round(normalR(cat.avgTxPerMonth, cat.avgTxPerMonth * 0.3)));
      const amountPerTx = monthlyTarget / txCount;
      for (let i = 0; i < txCount; i++) {
        const day = Math.max(1, Math.min(DAYS_PER_MONTH, Math.ceil(rand() * DAYS_PER_MONTH)));
        const amount = Math.max(1, normalR(amountPerTx, amountPerTx * 0.3));
        expenses.push({ day, month, category: cat.name, amount: Math.round(amount * 100) / 100 });
      }
    }
  }
  return expenses;
}

// ═══════════════════════════════════════════════════════════════
// Alert types and severity classification
// ═══════════════════════════════════════════════════════════════

type Severity = 'none' | 'warning' | 'critical' | 'exceeded';

interface Alert {
  month: number;
  day: number;
  category: string;
  severity: Severity;
  projected: number;
  budget: number;
  actualMonthEnd: number;
  daysRemaining: number;
  /** Was the actual month-end total above budget? */
  wasCorrect: boolean;
  /** How much did actual exceed budget (negative = under budget) */
  overshootPercent: number;
}

function classifySeverity(spent: number, projected: number, budget: number): Severity {
  if (spent >= budget) return 'exceeded';
  if (projected > budget) return 'critical';
  if (projected > budget * 0.85) return 'warning';
  return 'none';
}

/** Map actual outcome to expected severity for accuracy measurement */
function actualSeverity(actual: number, budget: number): Severity {
  if (actual >= budget * 1.15) return 'exceeded';
  if (actual >= budget) return 'critical';
  if (actual >= budget * 0.85) return 'warning';
  return 'none';
}

// ═══════════════════════════════════════════════════════════════
// Three forecasting algorithms
// ═══════════════════════════════════════════════════════════════

function oldProjection(currentSpent: number, daysElapsed: number, daysInMonth: number): number {
  if (daysElapsed <= 0) return 0;
  return (currentSpent / daysElapsed) * daysInMonth;
}

function emaProjection(
  currentSpent: number,
  daysElapsed: number,
  daysInMonth: number,
  profile: CategoryProfile | null,
): number {
  return projectCategoryEma(currentSpent, daysElapsed, daysInMonth, profile);
}

function taProjection(
  currentSpent: number,
  daysElapsed: number,
  daysInMonth: number,
  monthlyHistory: number[],
): number {
  if (daysElapsed <= 0 || monthlyHistory.length < 3) {
    return oldProjection(currentSpent, daysElapsed, daysInMonth);
  }

  const ta = analyzeCategory('_backtest', monthlyHistory, { currentMonthSpent: currentSpent });
  const monthProgress = daysElapsed / daysInMonth;

  // Use ensemble forecast from TA, blend with pace-based using month progress
  const paceBased = (currentSpent / daysElapsed) * daysInMonth;
  const ensembleForecast = ta.forecasts.ensemble;

  // Early month: trust TA ensemble more; late month: trust pace more
  const alpha = monthProgress * monthProgress;
  let projected = alpha * paceBased + (1 - alpha) * ensembleForecast;

  // If Bollinger %B > 0.8, the category is running hot — bias upward
  if (ta.volatility.bollingerBands.percentB > 0.8) {
    projected = Math.max(projected, paceBased);
  }

  // If anomaly detected by ≥2 methods, use the higher of pace vs ensemble
  if (ta.anomaly.anomalyCount >= 2) {
    projected = Math.max(projected, paceBased, ensembleForecast);
  }

  // Never project less than what's already spent
  return Math.max(currentSpent, Math.round(projected * 100) / 100);
}

// ═══════════════════════════════════════════════════════════════
// Qualitative metrics computation
// ═══════════════════════════════════════════════════════════════

function computeQualitativeMetrics(
  alerts: Alert[],
  totalCategoryMonths: number,
): QualitativeMetrics {
  // Deduplicate: keep first alert per category per month (earliest detection)
  const unique = new Map<string, Alert>();
  for (const a of alerts) {
    const key = `${a.month}:${a.category}`;
    if (!unique.has(key)) unique.set(key, a);
  }
  const deduped = [...unique.values()];

  // 1. Actionability: % of alerts where daysRemaining > 5
  const actionableAlerts = deduped.filter((a) => a.daysRemaining > 5);
  const actionabilityRate = deduped.length > 0 ? actionableAlerts.length / deduped.length : 1;

  // 2. Timeliness: weighted score for TPs — earlier detection = higher score
  // Score = (daysRemaining / DAYS_PER_MONTH) for each TP, averaged
  const truePositives = deduped.filter((a) => a.wasCorrect);
  const timelinessScore =
    truePositives.length > 0
      ? truePositives.reduce((s, a) => s + a.daysRemaining / DAYS_PER_MONTH, 0) /
        truePositives.length
      : 0;

  // 3. Alert density: unique alerts per category per month
  const alertDensity = totalCategoryMonths > 0 ? deduped.length / totalCategoryMonths : 0;

  // 4. Severity accuracy: % of alerts where predicted severity ≈ actual severity
  // "Match" = same severity, or adjacent (warning↔critical counts as half-match)
  let severityMatches = 0;
  for (const a of deduped) {
    const actual = actualSeverity(a.actualMonthEnd, a.budget);
    if (a.severity === actual) {
      severityMatches += 1;
    } else if (
      (a.severity === 'warning' && actual === 'critical') ||
      (a.severity === 'critical' && actual === 'warning') ||
      (a.severity === 'critical' && actual === 'exceeded') ||
      (a.severity === 'exceeded' && actual === 'critical')
    ) {
      severityMatches += 0.5;
    }
  }
  const severityAccuracy = deduped.length > 0 ? severityMatches / deduped.length : 1;

  // 5. Noisy categories: >50% of alerts are FP
  const byCat = new Map<string, { tp: number; fp: number }>();
  for (const a of deduped) {
    const entry = byCat.get(a.category) ?? { tp: 0, fp: 0 };
    if (a.wasCorrect) entry.tp++;
    else entry.fp++;
    byCat.set(a.category, entry);
  }
  const noisyCategories: string[] = [];
  for (const [cat, counts] of byCat) {
    const total = counts.tp + counts.fp;
    if (total >= 2 && counts.fp / total > 0.5) {
      noisyCategories.push(cat);
    }
  }

  // 6. Signal quality: combined metric (0-1)
  // Weighted: actionability 20%, timeliness 25%, precision 25%, severity accuracy 15%, density penalty 15%
  const precision = deduped.length > 0 ? truePositives.length / deduped.length : 1;
  const densityPenalty = Math.max(0, 1 - alertDensity * 2); // penalty if >0.5 alerts per cat-month
  const signalQuality =
    0.2 * actionabilityRate +
    0.25 * timelinessScore +
    0.25 * precision +
    0.15 * severityAccuracy +
    0.15 * densityPenalty;

  return {
    actionabilityRate,
    timelinessScore,
    alertDensity,
    severityAccuracy,
    noisyCategories,
    signalQuality,
  };
}

// ═══════════════════════════════════════════════════════════════
// Backtest engine
// ═══════════════════════════════════════════════════════════════

interface QualitativeResult {
  old: { alerts: Alert[]; metrics: QualitativeMetrics };
  ema: { alerts: Alert[]; metrics: QualitativeMetrics };
  ta: { alerts: Alert[]; metrics: QualitativeMetrics };
}

function runQualitativeBacktest(expenses: DailyExpense[]): QualitativeResult {
  const oldAlerts: Alert[] = [];
  const emaAlerts: Alert[] = [];
  const taAlerts: Alert[] = [];

  const totalCategoryMonths = MONTHS * CATEGORIES.length;

  for (let month = 0; month < MONTHS; month++) {
    const monthExpenses = expenses.filter((e) => e.month === month);

    // Actual month-end totals
    const actualTotals: Record<string, number> = {};
    for (const cat of CATEGORIES) {
      actualTotals[cat.name] = monthExpenses
        .filter((e) => e.category === cat.name)
        .reduce((s, e) => s + e.amount, 0);
    }

    // Build historical profiles (months 0..month-1)
    const historyRows: { category: string; month: string; monthly_total: number; tx_count: number }[] = [];
    const monthlyHistoryByCat = new Map<string, number[]>();

    for (let m = 0; m < month; m++) {
      const mExpenses = expenses.filter((e) => e.month === m);
      const catTotals: Record<string, { total: number; count: number }> = {};
      for (const e of mExpenses) {
        if (!catTotals[e.category]) catTotals[e.category] = { total: 0, count: 0 };
        const ct = catTotals[e.category];
        if (ct) {
          ct.total += e.amount;
          ct.count++;
        }
      }
      for (const [cat, data] of Object.entries(catTotals)) {
        historyRows.push({
          category: cat,
          month: `2025-${String(m + 1).padStart(2, '0')}`,
          monthly_total: data.total,
          tx_count: data.count,
        });
        const arr = monthlyHistoryByCat.get(cat) ?? [];
        arr.push(data.total);
        monthlyHistoryByCat.set(cat, arr);
      }
    }

    const profiles = buildCategoryProfiles(historyRows);

    // Simulate check days (every 5 days — realistic for daily advice trigger)
    const checkDays = [5, 10, 15, 20, 25];

    for (const day of checkDays) {
      for (const cat of CATEGORIES) {
        const spentSoFar = monthExpenses
          .filter((e) => e.category === cat.name && e.day <= day)
          .reduce((s, e) => s + e.amount, 0);

        const actual = actualTotals[cat.name] ?? 0;
        const daysRemaining = DAYS_PER_MONTH - day;
        const overshootPercent = cat.budget > 0 ? ((actual - cat.budget) / cat.budget) * 100 : 0;
        const wasCorrect = actual > cat.budget;

        // Old: naive linear
        const oldProj = oldProjection(spentSoFar, day, DAYS_PER_MONTH);
        const oldSev = classifySeverity(spentSoFar, oldProj, cat.budget);
        if (oldSev !== 'none') {
          oldAlerts.push({
            month, day, category: cat.name, severity: oldSev,
            projected: Math.round(oldProj), budget: cat.budget,
            actualMonthEnd: Math.round(actual), daysRemaining, wasCorrect, overshootPercent,
          });
        }

        // EMA-based
        const emaProj = emaProjection(spentSoFar, day, DAYS_PER_MONTH, profiles.get(cat.name) ?? null);
        const emaSev = classifySeverity(spentSoFar, emaProj, cat.budget);
        if (emaSev !== 'none') {
          emaAlerts.push({
            month, day, category: cat.name, severity: emaSev,
            projected: Math.round(emaProj), budget: cat.budget,
            actualMonthEnd: Math.round(actual), daysRemaining, wasCorrect, overshootPercent,
          });
        }

        // TA-enhanced
        const history = monthlyHistoryByCat.get(cat.name) ?? [];
        const taProj = taProjection(spentSoFar, day, DAYS_PER_MONTH, history);
        const taSev = classifySeverity(spentSoFar, taProj, cat.budget);
        if (taSev !== 'none') {
          taAlerts.push({
            month, day, category: cat.name, severity: taSev,
            projected: Math.round(taProj), budget: cat.budget,
            actualMonthEnd: Math.round(actual), daysRemaining, wasCorrect, overshootPercent,
          });
        }
      }
    }
  }

  return {
    old: { alerts: oldAlerts, metrics: computeQualitativeMetrics(oldAlerts, totalCategoryMonths) },
    ema: { alerts: emaAlerts, metrics: computeQualitativeMetrics(emaAlerts, totalCategoryMonths) },
    ta: { alerts: taAlerts, metrics: computeQualitativeMetrics(taAlerts, totalCategoryMonths) },
  };
}

// ═══════════════════════════════════════════════════════════════
// Report
// ═══════════════════════════════════════════════════════════════

function pad(s: string, width: number): string {
  return s.padStart(width);
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

function printQualitativeReport(result: QualitativeResult): void {
  const { old, ema, ta } = result;

  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  КАЧЕСТВЕННЫЙ БЭКТЕСТ: Old (linear) vs EMA vs TA-enhanced');
  console.log(`  ${MONTHS} months × ${CATEGORIES.length} categories × ${DAYS_PER_MONTH} days`);
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // Main metrics table
  console.log('┌──────────────────────────┬──────────────┬──────────────┬──────────────┐');
  console.log('│ Метрика                  │ Old (linear) │ New (EMA)    │ TA-enhanced  │');
  console.log('├──────────────────────────┼──────────────┼──────────────┼──────────────┤');

  const rows: [string, string, string, string][] = [
    [
      'Actionability (>5 дней)',
      pct(old.metrics.actionabilityRate),
      pct(ema.metrics.actionabilityRate),
      pct(ta.metrics.actionabilityRate),
    ],
    [
      'Timeliness (TP ранность)',
      pct(old.metrics.timelinessScore),
      pct(ema.metrics.timelinessScore),
      pct(ta.metrics.timelinessScore),
    ],
    [
      'Alert density (на кат/мес)',
      old.metrics.alertDensity.toFixed(3),
      ema.metrics.alertDensity.toFixed(3),
      ta.metrics.alertDensity.toFixed(3),
    ],
    [
      'Severity accuracy',
      pct(old.metrics.severityAccuracy),
      pct(ema.metrics.severityAccuracy),
      pct(ta.metrics.severityAccuracy),
    ],
    [
      'Signal quality (0-1)',
      old.metrics.signalQuality.toFixed(3),
      ema.metrics.signalQuality.toFixed(3),
      ta.metrics.signalQuality.toFixed(3),
    ],
  ];

  for (const [label, v1, v2, v3] of rows) {
    console.log(
      `│ ${label.padEnd(24)} │ ${pad(v1, 12)} │ ${pad(v2, 12)} │ ${pad(v3, 12)} │`,
    );
  }
  console.log('└──────────────────────────┴──────────────┴──────────────┴──────────────┘\n');

  // Noisy categories
  console.log('Зашумлённые категории (>50% FP):');
  console.log(`  Old:  ${old.metrics.noisyCategories.join(', ') || '—'}`);
  console.log(`  EMA:  ${ema.metrics.noisyCategories.join(', ') || '—'}`);
  console.log(`  TA:   ${ta.metrics.noisyCategories.join(', ') || '—'}`);

  // Precision breakdown
  console.log('\n┌──────────────────────────┬──────────────┬──────────────┬──────────────┐');
  console.log('│ Precision breakdown      │ Old (linear) │ New (EMA)    │ TA-enhanced  │');
  console.log('├──────────────────────────┼──────────────┼──────────────┼──────────────┤');

  const algResults = [
    { label: 'Old (linear)', alerts: old.alerts },
    { label: 'New (EMA)', alerts: ema.alerts },
    { label: 'TA-enhanced', alerts: ta.alerts },
  ];

  const precisionData = algResults.map((alg) => {
    const unique = new Map<string, Alert>();
    for (const a of alg.alerts) {
      const key = `${a.month}:${a.category}`;
      if (!unique.has(key)) unique.set(key, a);
    }
    const deduped = [...unique.values()];
    return {
      total: deduped.length,
      tp: deduped.filter((a) => a.wasCorrect).length,
      fp: deduped.filter((a) => !a.wasCorrect).length,
      precision: deduped.length > 0 ? deduped.filter((a) => a.wasCorrect).length / deduped.length : 0,
    };
  });

  const pRows: [string, string, string, string][] = [
    ['Unique alerts', String(precisionData[0]?.total ?? 0), String(precisionData[1]?.total ?? 0), String(precisionData[2]?.total ?? 0)],
    ['True positives', String(precisionData[0]?.tp ?? 0), String(precisionData[1]?.tp ?? 0), String(precisionData[2]?.tp ?? 0)],
    ['False positives', String(precisionData[0]?.fp ?? 0), String(precisionData[1]?.fp ?? 0), String(precisionData[2]?.fp ?? 0)],
    ['Precision', pct(precisionData[0]?.precision ?? 0), pct(precisionData[1]?.precision ?? 0), pct(precisionData[2]?.precision ?? 0)],
  ];

  for (const [label, v1, v2, v3] of pRows) {
    console.log(
      `│ ${label.padEnd(24)} │ ${pad(v1, 12)} │ ${pad(v2, 12)} │ ${pad(v3, 12)} │`,
    );
  }
  console.log('└──────────────────────────┴──────────────┴──────────────┴──────────────┘');

  // Per-category detail
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('  ПО КАТЕГОРИЯМ (TA-enhanced детализация)');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  for (const cat of CATEGORIES) {
    const catAlerts = ta.alerts.filter((a) => a.category === cat.name);
    const unique = new Map<string, Alert>();
    for (const a of catAlerts) {
      const key = `${a.month}:${a.category}`;
      if (!unique.has(key)) unique.set(key, a);
    }
    const deduped = [...unique.values()];
    const tp = deduped.filter((a) => a.wasCorrect);
    const fp = deduped.filter((a) => !a.wasCorrect);

    const actionable = deduped.filter((a) => a.daysRemaining > 5).length;
    const avgDetectionDay = tp.length > 0 ? tp.reduce((s, a) => s + a.day, 0) / tp.length : 0;

    console.log(
      `${cat.name} (budget ${cat.budget}, avg ${cat.monthlyAvg}±${cat.monthlyStddev}):`,
    );
    console.log(
      `  TP: ${tp.length}, FP: ${fp.length}, Precision: ${pct(deduped.length > 0 ? tp.length / deduped.length : 0)}`,
    );
    console.log(
      `  Actionable: ${actionable}/${deduped.length}, Avg TP detection day: ${avgDetectionDay.toFixed(0)}`,
    );

    // Show each FP with context
    if (fp.length > 0) {
      console.log('  False positives:');
      for (const a of fp) {
        console.log(
          `    Мес ${a.month + 1} день ${a.day}: прогноз ${a.projected}, бюджет ${a.budget}, факт ${a.actualMonthEnd} (${a.overshootPercent > 0 ? '+' : ''}${a.overshootPercent.toFixed(0)}%)`,
        );
      }
    }

    // Show late TPs (detection day > 20)
    const lateTp = tp.filter((a) => a.day > 20);
    if (lateTp.length > 0) {
      console.log('  Late true positives (день > 20):');
      for (const a of lateTp) {
        console.log(
          `    Мес ${a.month + 1} день ${a.day}: прогноз ${a.projected}, факт ${a.actualMonthEnd}`,
        );
      }
    }

    console.log('');
  }

  // Verdict
  console.log('═══════════════════════════════════════════════════════════════════════════════');
  console.log('  ВЕРДИКТ');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  const sqOld = old.metrics.signalQuality;
  const sqEma = ema.metrics.signalQuality;
  const sqTa = ta.metrics.signalQuality;
  const best = sqTa >= sqEma && sqTa >= sqOld ? 'TA' : sqEma >= sqOld ? 'EMA' : 'Old';

  console.log(`Signal Quality: Old=${sqOld.toFixed(3)} → EMA=${sqEma.toFixed(3)} → TA=${sqTa.toFixed(3)}`);
  console.log(`Best algorithm: ${best}`);

  const improvementVsOld = sqOld > 0 ? ((sqTa - sqOld) / sqOld * 100).toFixed(1) : 'N/A';
  const improvementVsEma = sqEma > 0 ? ((sqTa - sqEma) / sqEma * 100).toFixed(1) : 'N/A';
  console.log(`TA improvement: +${improvementVsOld}% vs Old, +${improvementVsEma}% vs EMA`);

  console.log(`\nActionability: ${pct(old.metrics.actionabilityRate)} → ${pct(ema.metrics.actionabilityRate)} → ${pct(ta.metrics.actionabilityRate)}`);
  console.log(`Timeliness: ${pct(old.metrics.timelinessScore)} → ${pct(ema.metrics.timelinessScore)} → ${pct(ta.metrics.timelinessScore)}`);
  console.log(`Severity accuracy: ${pct(old.metrics.severityAccuracy)} → ${pct(ema.metrics.severityAccuracy)} → ${pct(ta.metrics.severityAccuracy)}`);
  console.log(`Noise reduction: ${old.metrics.noisyCategories.length} → ${ema.metrics.noisyCategories.length} → ${ta.metrics.noisyCategories.length} noisy categories`);
}

// ═══════════════════════════════════════════════════════════════
// Real-data mode: load from SQLite database
// ═══════════════════════════════════════════════════════════════

/**
 * Load real historical data from SQLite and convert to DailyExpense[] format.
 * Each month is numbered 0..N-1, days are 1-based within month.
 * Budgets are loaded from the database for the most recent month.
 */
function loadRealData(dbPath: string, groupId: number): {
  expenses: DailyExpense[];
  categories: CategoryConfig[];
  months: number;
} {
  const db = new Database(dbPath, { readonly: true });

  // Get all expenses for the group, ordered by date
  const rows = db.query<
    { date: string; category: string; eur_amount: number },
    [number]
  >('SELECT date, category, eur_amount FROM expenses WHERE group_id = ? ORDER BY date ASC').all(groupId);

  if (rows.length === 0) {
    console.error(`No expenses found for group ${groupId} in ${dbPath}`);
    process.exit(1);
  }

  // Get budgets for the most recent month
  const budgetRows = db.query<
    { category: string; limit_amount: number; currency: string },
    [number]
  >(`SELECT category, limit_amount, currency FROM budgets WHERE group_id = ? ORDER BY month DESC`).all(groupId);

  const budgetMap = new Map<string, number>();
  for (const b of budgetRows) {
    if (!budgetMap.has(b.category)) {
      budgetMap.set(b.category, b.limit_amount);
    }
  }

  db.close();

  // Compute monthly indices and build data
  const monthSet = new Set<string>();
  const categoryStats = new Map<string, { total: number; count: number; txCount: number }>();

  for (const row of rows) {
    const monthKey = row.date.substring(0, 7);
    monthSet.add(monthKey);
    const stats = categoryStats.get(row.category) ?? { total: 0, count: 0, txCount: 0 };
    stats.total += row.eur_amount;
    stats.count++;
    categoryStats.set(row.category, stats);
  }

  const sortedMonths = [...monthSet].sort();
  const monthIndex = new Map<string, number>();
  for (let i = 0; i < sortedMonths.length; i++) {
    monthIndex.set(sortedMonths[i] ?? '', i);
  }

  const expenses: DailyExpense[] = rows.map((row) => ({
    day: Math.max(1, Math.min(30, Number.parseInt(row.date.substring(8, 10)))),
    month: monthIndex.get(row.date.substring(0, 7)) ?? 0,
    category: row.category,
    amount: row.eur_amount,
  }));

  // Build category configs with real stats and budget
  const categories: CategoryConfig[] = [];
  const numMonths = sortedMonths.length;
  for (const [cat, stats] of categoryStats) {
    const monthlyAvg = stats.total / numMonths;
    const monthlyTotals: number[] = [];
    for (const m of sortedMonths) {
      const mTotal = rows
        .filter((r) => r.date.startsWith(m) && r.category === cat)
        .reduce((s, r) => s + r.eur_amount, 0);
      monthlyTotals.push(mTotal);
    }
    const variance = monthlyTotals.reduce((s, v) => s + (v - monthlyAvg) ** 2, 0) / numMonths;
    categories.push({
      name: cat,
      monthlyAvg: Math.round(monthlyAvg),
      monthlyStddev: Math.round(Math.sqrt(variance)),
      avgTxPerMonth: Math.round(stats.count / numMonths),
      budget: budgetMap.get(cat) ?? Math.round(monthlyAvg * 1.3),
    });
  }

  return { expenses, categories, months: numMonths };
}

// ═══════════════════════════════════════════════════════════════
// Run
// ═══════════════════════════════════════════════════════════════

const args = process.argv.slice(2);
const isRealMode = args.includes('--real');
const groupIdArg = args.find((a) => a.startsWith('--group-id='));
const dbPathArg = args.find((a) => a.startsWith('--db='));

if (isRealMode) {
  const groupId = groupIdArg ? Number.parseInt(groupIdArg.split('=')[1] ?? '1') : 1;
  const dbPath = dbPathArg ? dbPathArg.split('=')[1] ?? './data/expenses.db' : './data/expenses.db';

  console.log(`Loading real data from ${dbPath} for group ${groupId}...\n`);
  const { expenses, categories, months } = loadRealData(dbPath, groupId);
  console.log(`Loaded ${expenses.length} expenses, ${categories.length} categories, ${months} months\n`);

  // Override globals for the real-data run
  const realCATEGORIES = categories;
  const realMONTHS = months;

  // Run backtest on real data
  const oldAlerts: Alert[] = [];
  const emaAlerts: Alert[] = [];
  const taAlerts: Alert[] = [];

  for (let month = 0; month < realMONTHS; month++) {
    const monthExpenses = expenses.filter((e) => e.month === month);
    const actualTotals: Record<string, number> = {};
    for (const cat of realCATEGORIES) {
      actualTotals[cat.name] = monthExpenses
        .filter((e) => e.category === cat.name)
        .reduce((s, e) => s + e.amount, 0);
    }

    const historyRows: { category: string; month: string; monthly_total: number; tx_count: number }[] = [];
    const monthlyHistoryByCat = new Map<string, number[]>();
    for (let m = 0; m < month; m++) {
      const mExpenses = expenses.filter((e) => e.month === m);
      const catTotals: Record<string, { total: number; count: number }> = {};
      for (const e of mExpenses) {
        if (!catTotals[e.category]) catTotals[e.category] = { total: 0, count: 0 };
        const ct = catTotals[e.category];
        if (ct) { ct.total += e.amount; ct.count++; }
      }
      for (const [cat, data] of Object.entries(catTotals)) {
        historyRows.push({ category: cat, month: `m-${m}`, monthly_total: data.total, tx_count: data.count });
        const arr = monthlyHistoryByCat.get(cat) ?? [];
        arr.push(data.total);
        monthlyHistoryByCat.set(cat, arr);
      }
    }

    const profiles = buildCategoryProfiles(historyRows);
    const checkDays = [5, 10, 15, 20, 25];

    for (const day of checkDays) {
      for (const cat of realCATEGORIES) {
        const spentSoFar = monthExpenses
          .filter((e) => e.category === cat.name && e.day <= day)
          .reduce((s, e) => s + e.amount, 0);
        const actual = actualTotals[cat.name] ?? 0;
        const daysRemaining = DAYS_PER_MONTH - day;
        const overshootPercent = cat.budget > 0 ? ((actual - cat.budget) / cat.budget) * 100 : 0;
        const wasCorrect = actual > cat.budget;

        const oldProj = oldProjection(spentSoFar, day, DAYS_PER_MONTH);
        const oldSev = classifySeverity(spentSoFar, oldProj, cat.budget);
        if (oldSev !== 'none') {
          oldAlerts.push({ month, day, category: cat.name, severity: oldSev, projected: Math.round(oldProj), budget: cat.budget, actualMonthEnd: Math.round(actual), daysRemaining, wasCorrect, overshootPercent });
        }

        const emaProj = emaProjection(spentSoFar, day, DAYS_PER_MONTH, profiles.get(cat.name) ?? null);
        const emaSev = classifySeverity(spentSoFar, emaProj, cat.budget);
        if (emaSev !== 'none') {
          emaAlerts.push({ month, day, category: cat.name, severity: emaSev, projected: Math.round(emaProj), budget: cat.budget, actualMonthEnd: Math.round(actual), daysRemaining, wasCorrect, overshootPercent });
        }

        const history = monthlyHistoryByCat.get(cat.name) ?? [];
        const taProj = taProjection(spentSoFar, day, DAYS_PER_MONTH, history);
        const taSev = classifySeverity(spentSoFar, taProj, cat.budget);
        if (taSev !== 'none') {
          taAlerts.push({ month, day, category: cat.name, severity: taSev, projected: Math.round(taProj), budget: cat.budget, actualMonthEnd: Math.round(actual), daysRemaining, wasCorrect, overshootPercent });
        }
      }
    }
  }

  const totalCatMonths = realMONTHS * realCATEGORIES.length;
  printQualitativeReport({
    old: { alerts: oldAlerts, metrics: computeQualitativeMetrics(oldAlerts, totalCatMonths) },
    ema: { alerts: emaAlerts, metrics: computeQualitativeMetrics(emaAlerts, totalCatMonths) },
    ta: { alerts: taAlerts, metrics: computeQualitativeMetrics(taAlerts, totalCatMonths) },
  });
} else {
  // Simulated mode (default)
  console.log('Generating spending data with 5 random seeds...\n');
  console.log('Tip: use --real --group-id=N --db=path/to/expenses.db for real data\n');

  const seeds = [42, 137, 256, 1001, 7777];
  let allOld: Alert[] = [];
  let allEma: Alert[] = [];
  let allTa: Alert[] = [];

  for (const seed of seeds) {
    console.log(`  Seed ${seed}...`);
    const data = generateSpendingData(seed);
    const result = runQualitativeBacktest(data);
    allOld = allOld.concat(result.old.alerts);
    allEma = allEma.concat(result.ema.alerts);
    allTa = allTa.concat(result.ta.alerts);
  }

  const totalCategoryMonths = seeds.length * MONTHS * CATEGORIES.length;
  console.log('');

  printQualitativeReport({
    old: { alerts: allOld, metrics: computeQualitativeMetrics(allOld, totalCategoryMonths) },
    ema: { alerts: allEma, metrics: computeQualitativeMetrics(allEma, totalCategoryMonths) },
    ta: { alerts: allTa, metrics: computeQualitativeMetrics(allTa, totalCategoryMonths) },
  });
}
