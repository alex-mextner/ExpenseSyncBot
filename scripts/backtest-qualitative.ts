/**
 * Qualitative backtest: measures actionability, timeliness, signal/noise quality,
 * severity accuracy, and alert density for old (raw production) vs hybrid (all improvements).
 *
 * Old algorithm = raw production behavior:
 *   - Fires EVERY checkpoint when status is warning/critical/exceeded (no escalation)
 *   - Static thresholds (0.85 warning, 1.0 critical)
 *   - Naive linear projection always
 *
 * Hybrid = ALL improvements:
 *   - Activity gate (min 3 tx)
 *   - Severity-only escalation (fires only if severity INCREASES)
 *   - Dynamic CV-based warning threshold
 *   - Syntetos-Boylan demand classification routing
 *   - TSB fading demand for intermittent categories
 *   - Weighted ensemble when TA history available
 *   - Cumulative spending profiles for stable categories
 *
 * Alerts split into FACTUAL and PROGNOSTIC with separate metrics.
 *
 * Run: bun scripts/backtest-qualitative.ts
 *      bun scripts/backtest-qualitative.ts --real --group-id=1 --db=path/to/expenses.db
 */

import { Database } from 'bun:sqlite';
import type { CurrencyCode } from '../src/config/constants';
import { convertCurrency } from '../src/services/currency/converter';
import { buildBudgetLookup, type DailyExpense, normalizeMonth } from './lib/backtest-shared';
import { runQualitativeBacktest, type QualitativeResult } from './lib/backtest-qualitative-engine';
import {
  type Alert,
  type AlertKind,
  type CategoryConfig,
  computeQualitativeMetrics,
  DAYS_PER_MONTH,
  dedupeByCategoryMonth,
  type ExtendedMetrics,
} from './lib/backtest-qualitative-metrics';

// ═══════════════════════════════════════════════════════════════
// Spending simulation
// ═══════════════════════════════════════════════════════════════


const SYNTH_CATEGORIES: CategoryConfig[] = [
  { name: 'Еда', monthlyAvg: 300, monthlyStddev: 40, avgTxPerMonth: 25, budget: 400 },
  { name: 'Транспорт', monthlyAvg: 80, monthlyStddev: 20, avgTxPerMonth: 15, budget: 120 },
  { name: 'Машина', monthlyAvg: 100, monthlyStddev: 30, avgTxPerMonth: 2, budget: 150 },
  { name: 'Подписки', monthlyAvg: 50, monthlyStddev: 5, avgTxPerMonth: 3, budget: 60 },
  { name: 'Развлечения', monthlyAvg: 120, monthlyStddev: 80, avgTxPerMonth: 4, budget: 200 },
  { name: 'Здоровье', monthlyAvg: 40, monthlyStddev: 50, avgTxPerMonth: 1, budget: 100 },
  { name: 'Кофе', monthlyAvg: 15, monthlyStddev: 10, avgTxPerMonth: 5, budget: 0 },
];

const SYNTH_MONTHS = 12;

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
  for (let month = 0; month < SYNTH_MONTHS; month++) {
    for (const cat of SYNTH_CATEGORIES) {
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
// Report
// ═══════════════════════════════════════════════════════════════

const HEAVY_RULE = '═══════════════════════════════════════════════════════════════════════════════';
const TABLE_TOP = '┌──────────────────────────────┬──────────────┬──────────────┐';
const TABLE_MID = '├──────────────────────────────┼──────────────┼──────────────┤';
const TABLE_BOTTOM = '└──────────────────────────────┴──────────────┴──────────────┘\n';

function pad(s: string, width: number): string { return s.padStart(width); }
function pct(v: number): string { return `${(v * 100).toFixed(1)}%`; }

type ReportRow = [label: string, old: string, hybrid: string];
type AlgorithmResult = QualitativeResult['old'];

function printTable(title: string, rows: ReportRow[]): void {
  console.log(TABLE_TOP);
  console.log(`│ ${title.padEnd(28)} │ Old (prod)   │ Hybrid       │`);
  console.log(TABLE_MID);
  for (const [label, v1, v2] of rows) {
    console.log(`│ ${label.padEnd(28)} │ ${pad(v1, 12)} │ ${pad(v2, 12)} │`);
  }
  console.log(TABLE_BOTTOM);
}

function printSectionTitle(title: string): void {
  console.log(HEAVY_RULE);
  console.log(`  ${title}`);
  console.log(`${HEAVY_RULE}\n`);
}

function densityPenalty(m: ExtendedMetrics): number {
  return Math.max(0, 1 - m.alertDensity * 2);
}

function countKind(r: AlgorithmResult, kind: AlertKind): string {
  return String(r.alerts.filter((a) => a.kind === kind).length);
}

function printMainMetrics(old: AlgorithmResult, hybrid: AlgorithmResult): void {
  const o = old.metrics;
  const h = hybrid.metrics;
  printTable('Метрика', [
    ['Prognostic precision (30%)', pct(o.prognosticPrecision), pct(h.prognosticPrecision)],
    ['Actionability progTP (20%)', pct(o.actionabilityRate), pct(h.actionabilityRate)],
    ['Timeliness progTP (15%)', pct(o.timelinessScore), pct(h.timelinessScore)],
    ['FP penalty (15%)', o.fpPenalty.toFixed(3), h.fpPenalty.toFixed(3)],
    ['Severity accuracy (10%)', pct(o.severityAccuracy), pct(h.severityAccuracy)],
    ['Density penalty (10%)', densityPenalty(o).toFixed(3), densityPenalty(h).toFixed(3)],
    ['Signal quality (0-1)', o.signalQuality.toFixed(3), h.signalQuality.toFixed(3)],
    ['Range coverage', pct(o.rangeCoverage), pct(h.rangeCoverage)],
  ]);
}

function printAlertBreakdown(old: AlgorithmResult, hybrid: AlgorithmResult): void {
  const o = old.metrics;
  const h = hybrid.metrics;
  printTable('Alert breakdown', [
    ['Total alerts shown', String(old.alerts.length), String(hybrid.alerts.length)],
    ['  Factual (spent>=budget)', String(o.factualCount), String(h.factualCount)],
    ['  Prognostic (projected)', String(o.prognosticCount), String(h.prognosticCount)],
    ['  Norm anomaly', countKind(old, 'norm_anomaly'), countKind(hybrid, 'norm_anomaly')],
    ['  Velocity spike', countKind(old, 'velocity_spike'), countKind(hybrid, 'velocity_spike')],
    ['  TA anomaly', countKind(old, 'ta_anomaly'), countKind(hybrid, 'ta_anomaly')],
    ['  TA trend change', countKind(old, 'ta_trend_change'), countKind(hybrid, 'ta_trend_change')],
    ['  No-budget recommendations', String(o.noBudgetCount), String(h.noBudgetCount)],
    ['Prognostic precision', pct(o.prognosticPrecision), pct(h.prognosticPrecision)],
    ['Alert days / month', pct(o.alertDaysPerMonth), pct(h.alertDaysPerMonth)],
    ['Useful alert rate', pct(o.usefulAlertRate), pct(h.usefulAlertRate)],
  ]);
}

function printNoisyCategories(old: AlgorithmResult, hybrid: AlgorithmResult): void {
  console.log('Зашумлённые категории (>50% prognostic FP):');
  console.log(`  Old:    ${old.metrics.noisyCategories.join(', ') || '—'}`);
  console.log(`  Hybrid: ${hybrid.metrics.noisyCategories.join(', ') || '—'}`);
}

function formatRange(a: Alert): string {
  return a.confidenceRange ? ` (${a.confidenceRange.low}-${a.confidenceRange.high})` : '';
}

function printFalsePrognostics(progFP: Alert[]): void {
  if (progFP.length === 0) return;
  console.log('  False prognostic alerts:');
  for (const a of progFP) {
    const sign = a.overshootPercent > 0 ? '+' : '';
    console.log(`    Мес ${a.month + 1} день ${a.day}: прогноз ${a.projected}${formatRange(a)}, бюджет ${a.budget}, факт ${a.actualMonthEnd} (${sign}${a.overshootPercent.toFixed(0)}%)`);
  }
}

function printLateTruePositives(progTP: Alert[]): void {
  const lateTP = progTP.filter((a) => a.day > 20);
  if (lateTP.length === 0) return;
  console.log('  Late true positives (день > 20):');
  for (const a of lateTP) {
    console.log(`    Мес ${a.month + 1} день ${a.day}: прогноз ${a.projected}${formatRange(a)}, факт ${a.actualMonthEnd}`);
  }
}

/** Budget=0 category: only a recommendation-alert count is shown */
function printNoBudgetCategory(cat: CategoryConfig, hybrid: AlgorithmResult): void {
  const noBudgetAlerts = hybrid.alerts.filter((a) => a.category === cat.name && a.kind === 'no_budget');
  if (noBudgetAlerts.length === 0) return;
  console.log(`${cat.name} (budget=0, avg ${cat.monthlyAvg}±${cat.monthlyStddev}):`);
  console.log(`  Budget recommendation alerts: ${noBudgetAlerts.length}`);
  console.log('');
}

function printBudgetedCategory(cat: CategoryConfig, deduped: Alert[]): void {
  const factual = deduped.filter((a) => a.kind === 'factual');
  const prognostic = deduped.filter((a) => a.kind === 'prognostic');
  const progTP = prognostic.filter((a) => a.wasCorrect);
  const progFP = prognostic.filter((a) => !a.wasCorrect);
  const actionable = deduped.filter((a) => a.daysRemaining > 5).length;
  const avgDetectionDay = progTP.length > 0 ? progTP.reduce((s, a) => s + a.day, 0) / progTP.length : 0;

  console.log(`${cat.name} (budget ${cat.budget}, avg ${cat.monthlyAvg}±${cat.monthlyStddev}):`);
  console.log(`  Factual: ${factual.length}, Prognostic TP: ${progTP.length}, Prognostic FP: ${progFP.length}`);
  console.log(`  Prognostic precision: ${pct(prognostic.length > 0 ? progTP.length / prognostic.length : 0)}`);
  console.log(`  Actionable: ${actionable}/${deduped.length}, Avg prognostic TP day: ${avgDetectionDay.toFixed(0)}`);

  printFalsePrognostics(progFP);
  printLateTruePositives(progTP);
  console.log('');
}

function printCategoryDetail(cat: CategoryConfig, hybrid: AlgorithmResult): void {
  const catAlerts = hybrid.alerts.filter((a) => a.category === cat.name && a.kind !== 'no_budget');
  if (catAlerts.length === 0 && cat.budget > 0) return;

  if (cat.budget <= 0) {
    printNoBudgetCategory(cat, hybrid);
    return;
  }

  const deduped = dedupeByCategoryMonth(catAlerts);
  if (deduped.length === 0) return;
  printBudgetedCategory(cat, deduped);
}

function printVerdict(old: AlgorithmResult, hybrid: AlgorithmResult): void {
  const o = old.metrics;
  const h = hybrid.metrics;
  const sqOld = o.signalQuality;
  const sqHybrid = h.signalQuality;
  const best = sqHybrid >= sqOld ? 'Hybrid' : 'Old';

  console.log(`Signal Quality: Old=${sqOld.toFixed(3)} → Hybrid=${sqHybrid.toFixed(3)}`);
  console.log(`Best algorithm: ${best}`);

  const improvementVsOld = sqOld > 0 ? ((sqHybrid - sqOld) / sqOld * 100).toFixed(1) : 'N/A';
  console.log(`Hybrid vs Old: ${Number(improvementVsOld) > 0 ? '+' : ''}${improvementVsOld}%`);

  const showReduction = old.alerts.length > 0
    ? ((old.alerts.length - hybrid.alerts.length) / old.alerts.length * 100)
    : 0;
  console.log(`Alerts shown: Old=${old.alerts.length} → Hybrid=${hybrid.alerts.length} (−${showReduction.toFixed(0)}%)`);

  console.log(`\nPrognostic precision: ${pct(o.prognosticPrecision)} → ${pct(h.prognosticPrecision)}`);
  console.log(`Actionability: ${pct(o.actionabilityRate)} → ${pct(h.actionabilityRate)}`);
  console.log(`FP penalty: ${o.fpPenalty.toFixed(3)} → ${h.fpPenalty.toFixed(3)}`);
  console.log(`Severity accuracy: ${pct(o.severityAccuracy)} → ${pct(h.severityAccuracy)}`);
  console.log(`Useful alert rate: ${pct(o.usefulAlertRate)} → ${pct(h.usefulAlertRate)}`);
  console.log(`Range coverage: ${pct(o.rangeCoverage)} → ${pct(h.rangeCoverage)}`);
  console.log(`Noise: ${o.noisyCategories.length} → ${h.noisyCategories.length} noisy categories`);
}

function printQualitativeReport(result: QualitativeResult): void {
  const { old, hybrid, categories, months } = result;

  console.log(HEAVY_RULE);
  console.log('  КАЧЕСТВЕННЫЙ БЭКТЕСТ: Old (raw production) vs Hybrid (all improvements)');
  console.log(`  ${months} months × ${categories.length} categories × ${DAYS_PER_MONTH} days`);
  console.log(`${HEAVY_RULE}\n`);

  printMainMetrics(old, hybrid);
  printAlertBreakdown(old, hybrid);
  printNoisyCategories(old, hybrid);

  // Per-category detail (hybrid)
  console.log('');
  printSectionTitle('ПО КАТЕГОРИЯМ (Hybrid детализация)');
  for (const cat of categories) {
    printCategoryDetail(cat, hybrid);
  }

  printSectionTitle('ВЕРДИКТ');
  printVerdict(old, hybrid);
}

// ═══════════════════════════════════════════════════════════════
// Real-data loader
// ═══════════════════════════════════════════════════════════════

function loadRealData(dbPath: string, groupId: number): {
  expenses: DailyExpense[];
  categories: CategoryConfig[];
  months: number;
  budgetByMonth: Map<string, number>;
} {
  const db = new Database(dbPath, { readonly: true });

  const rows = db.query<
    { date: string; category: string; eur_amount: number },
    [number]
  >('SELECT date, category, eur_amount FROM expenses WHERE group_id = ? ORDER BY date ASC').all(groupId);

  if (rows.length === 0) {
    console.error(`No expenses found for group ${groupId} in ${dbPath}`);
    process.exit(1);
  }

  const budgetRows = db.query<
    { category: string; limit_amount: number; currency: string; month: string },
    [number]
  >('SELECT category, limit_amount, currency, month FROM budgets WHERE group_id = ?').all(groupId);

  db.close();

  const monthSet = new Set<string>();
  const categoryStats = new Map<string, { total: number; count: number }>();

  for (const row of rows) {
    const monthKey = row.date.substring(0, 7);
    monthSet.add(monthKey);
    const stats = categoryStats.get(row.category) ?? { total: 0, count: 0 };
    stats.total += row.eur_amount;
    stats.count++;
    categoryStats.set(row.category, stats);
  }

  const sortedMonths = [...monthSet].sort();
  const monthIndex = new Map<string, number>();
  for (let i = 0; i < sortedMonths.length; i++) {
    monthIndex.set(sortedMonths[i] ?? '', i);
  }

  // Build per-month budget lookup
  const budgetByMonth = buildBudgetLookup(budgetRows, sortedMonths);

  // Compute latest budget per category (for CategoryConfig.budget fallback in reports)
  const latestBudget = new Map<string, number>();
  const sortedBudgetRows = [...budgetRows].sort((a, b) => {
    const na = normalizeMonth(a.month);
    const nb = normalizeMonth(b.month);
    return nb.localeCompare(na);
  });
  for (const b of sortedBudgetRows) {
    if (!latestBudget.has(b.category))
      latestBudget.set(b.category, convertCurrency(b.limit_amount, b.currency as CurrencyCode, 'EUR'));
  }

  const expenses: DailyExpense[] = rows.map((row) => ({
    day: Math.max(1, Math.min(30, Number.parseInt(row.date.substring(8, 10)))),
    month: monthIndex.get(row.date.substring(0, 7)) ?? 0,
    category: row.category,
    amount: row.eur_amount,
  }));

  const numMonths = sortedMonths.length;
  const categories: CategoryConfig[] = [];
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
      budget: latestBudget.get(cat) ?? Math.round(monthlyAvg * 1.3),
    });
  }

  return { expenses, categories, months: numMonths, budgetByMonth };
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
  const { expenses, categories, months, budgetByMonth } = loadRealData(dbPath, groupId);
  console.log(`Loaded ${expenses.length} expenses, ${categories.length} categories, ${months} months\n`);

  const result = runQualitativeBacktest(expenses, categories, months, budgetByMonth);
  printQualitativeReport(result);
} else {
  console.log('Generating spending data with 5 random seeds...\n');
  console.log('Tip: use --real --group-id=N --db=path/to/expenses.db for real data\n');

  const seeds = [42, 137, 256, 1001, 7777];
  let allOldAlerts: Alert[] = [];
  let allHybridAlerts: Alert[] = [];

  for (const seed of seeds) {
    console.log(`  Seed ${seed}...`);
    const data = generateSpendingData(seed);
    const result = runQualitativeBacktest(data, SYNTH_CATEGORIES, SYNTH_MONTHS);
    allOldAlerts = allOldAlerts.concat(result.old.alerts);
    allHybridAlerts = allHybridAlerts.concat(result.hybrid.alerts);
  }

  console.log('');

  const budgetedCats = SYNTH_CATEGORIES.filter((c) => c.budget > 0);
  const totalCatMonths = SYNTH_MONTHS * budgetedCats.length * seeds.length;
  const totalMonths = SYNTH_MONTHS * seeds.length;
  printQualitativeReport({
    old: { alerts: allOldAlerts, metrics: computeQualitativeMetrics(allOldAlerts, totalCatMonths, totalMonths) },
    hybrid: { alerts: allHybridAlerts, metrics: computeQualitativeMetrics(allHybridAlerts, totalCatMonths, totalMonths) },
    categories: SYNTH_CATEGORIES,
    months: SYNTH_MONTHS * seeds.length,
  });
}
