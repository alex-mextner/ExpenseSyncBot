/**
 * Report rendering for scripts/backtest-forecast.ts: alert statistics (signal quality,
 * precision, MAPE, ...) and the console comparison tables for old vs hybrid algorithms.
 */

import {
  type AccuracyPoint,
  type AlertEvent,
  type AlertKind,
  type BacktestResult,
  type CategoryConfig,
  DAYS_PER_MONTH,
  type Status,
} from './backtest-forecast-types';
import { CHECK_DAYS } from './backtest-shared';

interface AlertStats {
  totalRaw: number;
  factual: number;
  prognostic: number;
  noBudget: number;
  normAnomaly: number;
  velocitySpike: number;
  prognosticTP: number;
  prognosticFP: number;
  prognosticPrecision: number;
  alertDaysPerMonth: number;
  usefulAlertRate: number;
  avgDetectionDay: number;
  signalQuality: number;
  rangeCoverage: number;
  byCat: Record<string, { tp: number; fp: number; total: number }>;
}

/** Safe division: `fallback` when the denominator is not positive. */
function ratio(numerator: number, denominator: number, fallback: number): number {
  return denominator > 0 ? numerator / denominator : fallback;
}

/** Keep the first alert per category-month. */
function dedupeByCategoryMonth(alerts: AlertEvent[]): AlertEvent[] {
  const unique = new Map<string, AlertEvent>();
  for (const a of alerts) {
    const key = `${a.month}:${a.category}`;
    if (!unique.has(key)) unique.set(key, a);
  }
  return [...unique.values()];
}

/** No-budget, norm-anomaly and velocity-spike alerts are informational, not budget alerts. */
function isInformationalKind(kind: AlertKind): boolean {
  return kind === 'no_budget' || kind === 'norm_anomaly' || kind === 'velocity_spike';
}

/** Severity implied by the actual month-end total vs budget. */
function actualSeverity(a: AlertEvent): Status {
  if (a.actualMonthEnd >= a.budget * 1.15) return 'exceeded';
  if (a.actualMonthEnd >= a.budget) return 'critical';
  if (a.actualMonthEnd >= a.budget * 0.85) return 'warning';
  return 'on_track';
}

/** Neighbouring severity levels that earn half credit when predicted instead of the actual one. */
const ADJACENT_SEVERITIES: ReadonlyArray<readonly [Status, Status]> = [
  ['warning', 'critical'],
  ['critical', 'warning'],
  ['critical', 'exceeded'],
  ['exceeded', 'critical'],
];

/** 1 for exact severity match, 0.5 for an adjacent level, 0 otherwise. */
function severityMatchScore(a: AlertEvent): number {
  const actual = actualSeverity(a);
  if (a.status === actual) return 1;
  const isAdjacent = ADJACENT_SEVERITIES.some(([predicted, real]) => a.status === predicted && actual === real);
  return isAdjacent ? 0.5 : 0;
}

function computeSeverityAccuracy(deduped: AlertEvent[]): number {
  let severityMatches = 0;
  for (const a of deduped) severityMatches += severityMatchScore(a);
  return ratio(severityMatches, deduped.length, 1);
}

/** % of prognostic TP alerts whose confidence range covered the actual */
function computeRangeCoverage(progTPs: AlertEvent[]): number {
  const progTPsWithRange = progTPs.filter((a) => a.confidenceRange);
  const coveredByRange = progTPsWithRange.filter(
    (a) => a.actualMonthEnd >= a.confidenceRange!.low && a.actualMonthEnd <= a.confidenceRange!.high,
  );
  return ratio(coveredByRange.length, progTPsWithRange.length, 0);
}

function computeByCategory(progDeduped: AlertEvent[]): AlertStats['byCat'] {
  const byCat: AlertStats['byCat'] = {};
  for (const a of progDeduped) {
    if (!byCat[a.category]) byCat[a.category] = { tp: 0, fp: 0, total: 0 };
    byCat[a.category]!.total++;
    if (a.wasCorrect) byCat[a.category]!.tp++;
    else byCat[a.category]!.fp++;
  }
  return byCat;
}

interface SignalComponents {
  progPrecision: number;
  actionabilityRate: number;
  timelinessScore: number;
  fpPenalty: number;
  severityAccuracy: number;
  densityPenalty: number;
  fatiguePenalty: number;
}

function weighSignalQuality(c: SignalComponents): number {
  return (
    0.25 * c.progPrecision +
    0.15 * c.actionabilityRate +
    0.10 * c.timelinessScore +
    0.15 * c.fpPenalty +
    0.10 * c.severityAccuracy +
    0.10 * c.densityPenalty +
    0.15 * c.fatiguePenalty
  );
}

function computeStats(alerts: AlertEvent[], totalMonths: number, totalCatMonths: number): AlertStats {
  const factualAlerts = alerts.filter((a) => a.kind === 'factual');
  // Only critical/exceeded prognostic alerts count as predictions.
  // Warning = "approaching limit" (info), not "will exceed" (prediction).
  const prognosticAlerts = alerts.filter(
    (a) => a.kind === 'prognostic' && (a.status === 'critical' || a.status === 'exceeded') && a.day > 5,
  );
  const noBudgetAlerts = alerts.filter((a) => a.kind === 'no_budget');
  const normAnomalyAlerts = alerts.filter((a) => a.kind === 'norm_anomaly');
  const velocitySpikeAlerts = alerts.filter((a) => a.kind === 'velocity_spike');

  // Prognostic precision: deduplicate by category-month (first alert per cat-month)
  const progDeduped = dedupeByCategoryMonth(prognosticAlerts);
  const progTPs = progDeduped.filter((a) => a.wasCorrect);
  const progFPs = progDeduped.filter((a) => !a.wasCorrect);
  // No prognostic alerts = neutral (0.5), not "all wrong" (0)
  const progPrecision = ratio(progTPs.length, progDeduped.length, 0.5);

  // Deduplicate all non-informational alerts by category-month
  const deduped = dedupeByCategoryMonth(alerts.filter((a) => !isInformationalKind(a.kind)));
  const alertDensity = ratio(deduped.length, totalCatMonths, 0);

  // Alert days per month: fraction of months where at least one alert fires
  const monthsWithAlerts = new Set(alerts.filter((a) => a.kind !== 'no_budget').map((a) => a.month));
  const alertDaysPerMonth = ratio(monthsWithAlerts.size, totalMonths, 0);

  // Useful alert rate: prognostic + daysRemaining > 5
  const usefulAlerts = prognosticAlerts.filter((a) => a.daysRemaining > 5);
  const usefulAlertRate = ratio(usefulAlerts.length, alerts.length, 0);

  // Avg detection day for TPs
  const avgDetectionDay = ratio(progTPs.reduce((s, a) => s + a.day, 0), progTPs.length, 0);

  // Actionability: only prognostic TPs with enough time to react
  const actionableProgTPs = progTPs.filter((a) => a.daysRemaining > 5);
  const actionabilityRate = ratio(actionableProgTPs.length, progTPs.length, 1);

  // Timeliness: earlier correct prognostic alerts score higher
  const timelinessScore = ratio(
    progTPs.reduce((s, a) => s + a.daysRemaining / DAYS_PER_MONTH, 0),
    progTPs.length,
    0,
  );

  // FP penalty: penalize if >10% of category-months have false positive prognoses
  const fpPenalty = Math.max(0, 1 - progFPs.length / Math.max(1, totalCatMonths * 0.1));

  // Alert fatigue penalty: >5 alerts/month = fatigue, users stop reading
  const budgetAlertCount = alerts.length - noBudgetAlerts.length - normAnomalyAlerts.length - velocitySpikeAlerts.length;
  const alertsPerMonth = ratio(budgetAlertCount, totalMonths, 0);
  const fatiguePenalty = Math.max(0, 1 - alertsPerMonth / 10); // 0 alerts=1.0, 10/month=0, 20/month=0

  const signalQuality = weighSignalQuality({
    progPrecision,
    actionabilityRate,
    timelinessScore,
    fpPenalty,
    severityAccuracy: computeSeverityAccuracy(deduped),
    densityPenalty: Math.max(0, 1 - alertDensity * 2),
    fatiguePenalty,
  });

  return {
    totalRaw: alerts.length,
    factual: factualAlerts.length,
    prognostic: prognosticAlerts.length,
    noBudget: noBudgetAlerts.length,
    normAnomaly: normAnomalyAlerts.length,
    velocitySpike: velocitySpikeAlerts.length,
    prognosticTP: progTPs.length,
    prognosticFP: progFPs.length,
    prognosticPrecision: progPrecision,
    alertDaysPerMonth,
    usefulAlertRate,
    avgDetectionDay,
    signalQuality,
    rangeCoverage: computeRangeCoverage(progTPs),
    byCat: computeByCategory(progDeduped),
  };
}

type NumericStatKey = Exclude<keyof AlertStats, 'byCat'>;

/** One row of the comparison table: label + how to render the stat for a column. */
interface StatRow {
  label: string;
  format: (stats: AlertStats) => string;
}

const count = (key: NumericStatKey) => (s: AlertStats) => String(s[key]);
const percent1 = (key: NumericStatKey) => (s: AlertStats) => `${(s[key] * 100).toFixed(1)}%`;
const fixed1 = (key: NumericStatKey) => (s: AlertStats) => s[key].toFixed(1);
const fixed3 = (key: NumericStatKey) => (s: AlertStats) => s[key].toFixed(3);

const STAT_TABLE_SEPARATOR = '├──────────────────────────────┼──────────────┼────────────────┤';

/** Comparison table sections; a separator line is printed before each section. */
const STAT_TABLE_SECTIONS: StatRow[][] = [
  [
    { label: 'Total alerts shown', format: count('totalRaw') },
    { label: '  Factual (spent>=budget)', format: count('factual') },
    { label: '  Prognostic (projected)', format: count('prognostic') },
    { label: '  No-budget recommendations', format: count('noBudget') },
    { label: '  Norm anomaly', format: count('normAnomaly') },
    { label: '  Velocity spike', format: count('velocitySpike') },
  ],
  [
    { label: 'Prognostic TP', format: count('prognosticTP') },
    { label: 'Prognostic FP', format: count('prognosticFP') },
    { label: 'Prognostic precision', format: percent1('prognosticPrecision') },
  ],
  [
    { label: 'Signal quality (0-1)', format: fixed3('signalQuality') },
    { label: 'Range coverage', format: percent1('rangeCoverage') },
  ],
  [
    { label: 'Alert days / month', format: percent1('alertDaysPerMonth') },
    { label: 'Useful alert rate', format: percent1('usefulAlertRate') },
    { label: 'Avg TP detection day', format: fixed1('avgDetectionDay') },
  ],
];

function printStatTable(oldStats: AlertStats, hybridStats: AlertStats): void {
  console.log('┌──────────────────────────────┬──────────────┬────────────────┐');
  console.log('│ Метрика                      │ Old (prod)   │ Hybrid         │');
  for (const section of STAT_TABLE_SECTIONS) {
    console.log(STAT_TABLE_SEPARATOR);
    for (const row of section) {
      console.log(
        `│ ${row.label.padEnd(28)} │ ${row.format(oldStats).padStart(12)} │ ${row.format(hybridStats).padStart(14)} │`,
      );
    }
  }
  console.log('└──────────────────────────────┴──────────────┴────────────────┘\n');
}

/** Percentage reduction from `before` to `after`; 0 when there was nothing to reduce. */
function reductionPercent(before: number, after: number): number {
  return before > 0 ? ((before - after) / before) * 100 : 0;
}

function printNoiseReduction(oldStats: AlertStats, hybridStats: AlertStats): void {
  if (oldStats.totalRaw > 0) {
    const showReduction = reductionPercent(oldStats.totalRaw, hybridStats.totalRaw);
    console.log(
      `→ Показов пользователю: ${oldStats.totalRaw} → ${hybridStats.totalRaw} (−${showReduction.toFixed(0)}%)`,
    );
  }
  if (oldStats.prognosticFP > 0) {
    const fpReduction = reductionPercent(oldStats.prognosticFP, hybridStats.prognosticFP);
    console.log(
      `→ Ложных прогнозов: ${oldStats.prognosticFP} → ${hybridStats.prognosticFP} (−${fpReduction.toFixed(0)}%)`,
    );
  }
}

function printCategoryTable(
  categories: CategoryConfig[],
  oldStats: AlertStats,
  hybridStats: AlertStats,
): void {
  console.log('\n┌───────────────────────────────────────────────────────────────────┐');
  console.log('│ ПО КАТЕГОРИЯМ (prognostic alerts: TP / FP)                       │');
  console.log('├──────────────┬───────────────────┬────────────────────────────────┤');
  console.log('│ Категория    │ Old (TP / FP)     │ Hybrid (TP / FP)              │');
  console.log('├──────────────┼───────────────────┼────────────────────────────────┤');

  for (const cat of categories) {
    if (cat.budget <= 0) continue;
    const oldCat = oldStats.byCat[cat.name] ?? { tp: 0, fp: 0, total: 0 };
    const hybridCat = hybridStats.byCat[cat.name] ?? { tp: 0, fp: 0, total: 0 };
    const label = cat.name.padEnd(12);
    console.log(`│ ${label} │ ${`${oldCat.tp} / ${oldCat.fp}`.padStart(17)} │ ${`${hybridCat.tp} / ${hybridCat.fp}`.padStart(30)} │`);
  }
  console.log('└──────────────┴───────────────────┴────────────────────────────────┘\n');
}

function printNoBudgetSummary(result: BacktestResult, categories: CategoryConfig[], months: number): void {
  const noBudgetCats = categories.filter((c) => c.budget <= 0);
  if (noBudgetCats.length === 0) return;

  const noBudgetHybridAlerts = result.hybridAlerts.filter((a) => a.kind === 'no_budget');
  console.log(`Budget recommendation alerts (budget=0 categories): ${noBudgetHybridAlerts.length}`);
  for (const cat of noBudgetCats) {
    const catAlerts = noBudgetHybridAlerts.filter((a) => a.category === cat.name);
    console.log(`  ${cat.name}: ${catAlerts.length} alerts across ${months} months`);
  }
  console.log('');
}

/** Prints MAPE per checkpoint day and returns the overall MAPE (percent) for both algorithms. */
function printMapeTable(accuracy: AccuracyPoint[]): { overallOldMAPE: number; overallHybridMAPE: number } {
  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│ ТОЧНОСТЬ ПРОГНОЗА (MAPE — средняя абсолютная ошибка %) │');
  console.log('├────────────────────────┬──────────────┬────────────────┤');
  console.log('│ День месяца            │ Old (linear) │ Hybrid         │');
  console.log('├────────────────────────┼──────────────┼────────────────┤');

  let totalOldError = 0;
  let totalHybridError = 0;
  let totalCount = 0;

  for (const cp of CHECK_DAYS) {
    const points = accuracy.filter((a) => a.day === cp);
    if (points.length === 0) continue;
    const oldMAPE = (points.reduce((s, p) => s + p.oldError, 0) / points.length) * 100;
    const hybridMAPE = (points.reduce((s, p) => s + p.hybridError, 0) / points.length) * 100;
    totalOldError += points.reduce((s, p) => s + p.oldError, 0);
    totalHybridError += points.reduce((s, p) => s + p.hybridError, 0);
    totalCount += points.length;
    console.log(`│ Day ${String(cp).padEnd(18)} │ ${oldMAPE.toFixed(1).padStart(11)}% │ ${hybridMAPE.toFixed(1).padStart(13)}% │`);
  }

  const overallOldMAPE = totalCount > 0 ? (totalOldError / totalCount) * 100 : 0;
  const overallHybridMAPE = totalCount > 0 ? (totalHybridError / totalCount) * 100 : 0;
  console.log('├────────────────────────┼──────────────┼────────────────┤');
  console.log(`│ Overall MAPE           │ ${overallOldMAPE.toFixed(1).padStart(11)}% │ ${overallHybridMAPE.toFixed(1).padStart(13)}% │`);
  console.log('└────────────────────────┴──────────────┴────────────────┘\n');

  return { overallOldMAPE, overallHybridMAPE };
}

function printVerdict(
  oldStats: AlertStats,
  hybridStats: AlertStats,
  overallOldMAPE: number,
  overallHybridMAPE: number,
): void {
  console.log('══════════════════════════════');
  console.log('  ВЕРДИКТ');
  console.log('══════════════════════════════\n');

  const mapeChange = overallOldMAPE > 0 ? ((overallOldMAPE - overallHybridMAPE) / overallOldMAPE * 100) : 0;
  const totalReduction = reductionPercent(oldStats.totalRaw, hybridStats.totalRaw);

  console.log(`Signal Quality: Old=${oldStats.signalQuality.toFixed(3)} → Hybrid=${hybridStats.signalQuality.toFixed(3)}`);
  console.log(`Prognostic precision: ${(oldStats.prognosticPrecision * 100).toFixed(0)}% → ${(hybridStats.prognosticPrecision * 100).toFixed(0)}%`);
  console.log(`Total alerts: ${oldStats.totalRaw} → ${hybridStats.totalRaw} (−${totalReduction.toFixed(0)}%)`);
  console.log(`Useful alert rate: ${(oldStats.usefulAlertRate * 100).toFixed(0)}% → ${(hybridStats.usefulAlertRate * 100).toFixed(0)}%`);
  console.log(`Range coverage: ${(oldStats.rangeCoverage * 100).toFixed(0)}% → ${(hybridStats.rangeCoverage * 100).toFixed(0)}%`);
  console.log(`MAPE: ${mapeChange > 0 ? '−' : '+'}${Math.abs(mapeChange).toFixed(0)}% (${overallOldMAPE.toFixed(1)}% → ${overallHybridMAPE.toFixed(1)}%)`);
}

export function printReport(
  result: BacktestResult,
  categories: CategoryConfig[],
  months: number,
) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BACKTEST: Old (raw production) vs Hybrid (all improvements)');
  console.log(`  ${months} months × ${categories.length} categories × ${DAYS_PER_MONTH} days`);
  console.log('═══════════════════════════════════════════════════════════\n');

  const budgetedCats = categories.filter((c) => c.budget > 0);
  const totalCatMonths = months * budgetedCats.length;
  const oldStats = computeStats(result.oldAlerts, months, totalCatMonths);
  const hybridStats = computeStats(result.hybridAlerts, months, totalCatMonths);

  printStatTable(oldStats, hybridStats);
  printNoiseReduction(oldStats, hybridStats);
  printCategoryTable(categories, oldStats, hybridStats);
  printNoBudgetSummary(result, categories, months);
  const { overallOldMAPE, overallHybridMAPE } = printMapeTable(result.accuracy);
  printVerdict(oldStats, hybridStats, overallOldMAPE, overallHybridMAPE);
}
