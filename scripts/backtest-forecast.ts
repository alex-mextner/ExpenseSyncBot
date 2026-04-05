/**
 * Backtest: old (naive linear) vs new (EMA-based) forecast algorithm.
 *
 * Simulates 12 months of realistic spending across multiple categories,
 * then for each day of each month compares:
 * - Projection accuracy (projected vs actual month-end total)
 * - Alert quality (false positives, missed alerts, true alerts)
 *
 * Run: bun scripts/backtest-forecast.ts
 */

// Inlined from spending-analytics.ts to avoid importing the full module tree (which requires env vars)

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

    profiles.set(category, {
      ema: Math.round(ema * 100) / 100,
      cv: Math.round(cv * 1000) / 1000,
      monthsOfData: n,
    });
  }

  return profiles;
}

function projectCategory(
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
  const projected = alpha * paceBased + (1 - alpha) * historyBased;
  return Math.round(projected * 100) / 100;
}

// ═══════════════════════════════════════════════════════════════
// Spending simulation
// ═══════════════════════════════════════════════════════════════

interface CategoryConfig {
  name: string;
  /** Average monthly total */
  monthlyAvg: number;
  /** Stddev of monthly total */
  monthlyStddev: number;
  /** Average transactions per month */
  avgTxPerMonth: number;
  /** Budget limit */
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
  day: number; // 1-30
  month: number; // 0-11
  category: string;
  amount: number;
}

/** Generate 12 months of realistic spending data */
function generateSpendingData(seed: number): DailyExpense[] {
  // Deterministic pseudo-random using seed
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
      // Decide how much to spend this month (normal distribution around average)
      const monthlyTarget = normalR(cat.monthlyAvg, cat.monthlyStddev);
      // Distribute across ~avgTxPerMonth transactions
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
// Old algorithm: naive linear extrapolation
// ═══════════════════════════════════════════════════════════════

function oldProjection(currentSpent: number, daysElapsed: number, daysInMonth: number): number {
  if (daysElapsed <= 0) return 0;
  return (currentSpent / daysElapsed) * daysInMonth;
}

function oldStatus(
  spent: number,
  projected: number,
  budget: number,
): 'on_track' | 'warning' | 'critical' | 'exceeded' {
  if (spent >= budget) return 'exceeded';
  if (projected > budget) return 'critical';
  if (projected > budget * 0.85) return 'warning';
  return 'on_track';
}

// ═══════════════════════════════════════════════════════════════
// New algorithm: EMA-based projection
// ═══════════════════════════════════════════════════════════════

function newProjection(
  currentSpent: number,
  daysElapsed: number,
  daysInMonth: number,
  profile: CategoryProfile | null,
): number {
  return projectCategory(currentSpent, daysElapsed, daysInMonth, profile);
}

// ═══════════════════════════════════════════════════════════════
// Backtesting engine
// ═══════════════════════════════════════════════════════════════

interface AlertEvent {
  month: number;
  day: number;
  category: string;
  status: string;
  projected: number;
  budget: number;
  actualMonthEnd: number;
  wasCorrect: boolean;
}

interface BacktestResult {
  oldAlerts: AlertEvent[];
  newAlerts: AlertEvent[];
  oldAccuracy: number[];
  newAccuracy: number[];
}

function runBacktest(expenses: DailyExpense[]): BacktestResult {
  const oldAlerts: AlertEvent[] = [];
  const newAlerts: AlertEvent[] = [];
  const oldErrors: number[] = [];
  const newErrors: number[] = [];

  for (let month = 0; month < MONTHS; month++) {
    const monthExpenses = expenses.filter((e) => e.month === month);

    // Actual month-end totals per category
    const actualTotals: Record<string, number> = {};
    for (const cat of CATEGORIES) {
      actualTotals[cat.name] = monthExpenses
        .filter((e) => e.category === cat.name)
        .reduce((s, e) => s + e.amount, 0);
    }

    // Build historical profiles from months 0..month-1
    const historyRows: { category: string; month: string; monthly_total: number; tx_count: number }[] = [];

    for (let m = 0; m < month; m++) {
      const mExpenses = expenses.filter((e) => e.month === m);
      const catTotals: Record<string, { total: number; count: number }> = {};
      for (const e of mExpenses) {
        if (!catTotals[e.category]) catTotals[e.category] = { total: 0, count: 0 };
        catTotals[e.category]!.total += e.amount;
        catTotals[e.category]!.count++;
      }
      for (const [cat, data] of Object.entries(catTotals)) {
        historyRows.push({
          category: cat,
          month: `2025-${String(m + 1).padStart(2, '0')}`,
          monthly_total: data.total,
          tx_count: data.count,
        });
      }
    }

    const profiles = buildCategoryProfiles(historyRows);

    // Simulate each day of the month
    for (let day = 1; day <= DAYS_PER_MONTH; day++) {
      for (const cat of CATEGORIES) {
        const spentSoFar = monthExpenses
          .filter((e) => e.category === cat.name && e.day <= day)
          .reduce((s, e) => s + e.amount, 0);

        const actual = actualTotals[cat.name] ?? 0;
        const profile = profiles.get(cat.name) ?? null;

        // Old algorithm
        const oldProj = oldProjection(spentSoFar, day, DAYS_PER_MONTH);
        const oldSt = oldStatus(spentSoFar, oldProj, cat.budget);

        // New algorithm
        const newProj = newProjection(spentSoFar, day, DAYS_PER_MONTH, profile);
        const newSt = oldStatus(spentSoFar, newProj, cat.budget);

        // Track projection accuracy (only on specific days: 5, 10, 15, 20, 25)
        if ([5, 10, 15, 20, 25].includes(day) && actual > 0) {
          const oldError = Math.abs(oldProj - actual) / actual;
          const newError = Math.abs(newProj - actual) / actual;
          oldErrors.push(oldError);
          newErrors.push(newError);
        }

        // Track alerts (critical or exceeded)
        const actualExceeds = actual > cat.budget;
        if (oldSt === 'critical' || oldSt === 'exceeded') {
          oldAlerts.push({
            month,
            day,
            category: cat.name,
            status: oldSt,
            projected: Math.round(oldProj),
            budget: cat.budget,
            actualMonthEnd: Math.round(actual),
            wasCorrect: actualExceeds,
          });
        }
        if (newSt === 'critical' || newSt === 'exceeded') {
          newAlerts.push({
            month,
            day,
            category: cat.name,
            status: newSt,
            projected: Math.round(newProj),
            budget: cat.budget,
            actualMonthEnd: Math.round(actual),
            wasCorrect: actualExceeds,
          });
        }
      }
    }
  }

  return {
    oldAlerts,
    newAlerts,
    oldAccuracy: oldErrors,
    newAccuracy: newErrors,
  };
}

// ═══════════════════════════════════════════════════════════════
// Report generation
// ═══════════════════════════════════════════════════════════════

function computeStats(alerts: AlertEvent[]) {
  const unique = new Map<string, AlertEvent>();
  // Deduplicate: keep first alert per category per month
  for (const a of alerts) {
    const key = `${a.month}:${a.category}`;
    if (!unique.has(key)) unique.set(key, a);
  }
  const deduped = [...unique.values()];
  const truePositives = deduped.filter((a) => a.wasCorrect).length;
  const falsePositives = deduped.filter((a) => !a.wasCorrect).length;
  const precision = deduped.length > 0 ? truePositives / deduped.length : 0;

  // Find earliest alert day for true positives
  const tpDays = deduped.filter((a) => a.wasCorrect).map((a) => a.day);
  const avgDetectionDay = tpDays.length > 0 ? tpDays.reduce((s, d) => s + d, 0) / tpDays.length : 0;

  // By category
  const byCat: Record<string, { tp: number; fp: number; total: number }> = {};
  for (const a of deduped) {
    if (!byCat[a.category]) byCat[a.category] = { tp: 0, fp: 0, total: 0 };
    byCat[a.category]!.total++;
    if (a.wasCorrect) byCat[a.category]!.tp++;
    else byCat[a.category]!.fp++;
  }

  return { totalRaw: alerts.length, unique: deduped.length, truePositives, falsePositives, precision, avgDetectionDay, byCat };
}

function printReport(result: BacktestResult) {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  BACKTEST: Old (naive linear) vs New (EMA-based) forecast');
  console.log('  12 months × 6 categories × 30 days = 2160 category-days');
  console.log('═══════════════════════════════════════════════════════════\n');

  // === Quantitative: alert counts ===
  const oldStats = computeStats(result.oldAlerts);
  const newStats = computeStats(result.newAlerts);

  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│ КОЛИЧЕСТВЕННОЕ СРАВНЕНИЕ (alert counts)                │');
  console.log('├────────────────────────┬──────────────┬────────────────┤');
  console.log('│ Метрика                │ Old (linear) │ New (EMA)      │');
  console.log('├────────────────────────┼──────────────┼────────────────┤');
  console.log(`│ Raw alert-days         │ ${String(oldStats.totalRaw).padStart(12)} │ ${String(newStats.totalRaw).padStart(14)} │`);
  console.log(`│ Unique alerts          │ ${String(oldStats.unique).padStart(12)} │ ${String(newStats.unique).padStart(14)} │`);
  console.log(`│ True positives (TP)    │ ${String(oldStats.truePositives).padStart(12)} │ ${String(newStats.truePositives).padStart(14)} │`);
  console.log(`│ False positives (FP)   │ ${String(oldStats.falsePositives).padStart(12)} │ ${String(newStats.falsePositives).padStart(14)} │`);
  console.log(`│ Precision (TP/total)   │ ${(oldStats.precision * 100).toFixed(1).padStart(11)}% │ ${(newStats.precision * 100).toFixed(1).padStart(13)}% │`);
  console.log(`│ Avg detection day (TP) │ ${oldStats.avgDetectionDay.toFixed(1).padStart(12)} │ ${newStats.avgDetectionDay.toFixed(1).padStart(14)} │`);
  console.log('└────────────────────────┴──────────────┴────────────────┘\n');

  // FP reduction
  if (oldStats.falsePositives > 0) {
    const reduction = ((oldStats.falsePositives - newStats.falsePositives) / oldStats.falsePositives * 100);
    console.log(`→ Ложных срабатываний: ${oldStats.falsePositives} → ${newStats.falsePositives} (−${reduction.toFixed(0)}%)`);
  }
  if (oldStats.truePositives > 0 && newStats.truePositives > 0) {
    console.log(`→ Реальных алертов сохранено: ${newStats.truePositives}/${oldStats.truePositives}`);
  }

  // === By category ===
  console.log('\n┌───────────────────────────────────────────────────────────────────┐');
  console.log('│ ПО КАТЕГОРИЯМ (unique alerts: TP / FP)                            │');
  console.log('├──────────────┬───────────────────┬────────────────────────────────┤');
  console.log('│ Категория    │ Old (TP / FP)     │ New (TP / FP)                 │');
  console.log('├──────────────┼───────────────────┼────────────────────────────────┤');

  for (const cat of CATEGORIES) {
    const oldCat = oldStats.byCat[cat.name] ?? { tp: 0, fp: 0, total: 0 };
    const newCat = newStats.byCat[cat.name] ?? { tp: 0, fp: 0, total: 0 };
    const label = cat.name.padEnd(12);
    const oldStr = `${oldCat.tp} / ${oldCat.fp}`;
    const newStr = `${newCat.tp} / ${newCat.fp}`;
    console.log(`│ ${label} │ ${oldStr.padStart(17)} │ ${newStr.padStart(30)} │`);
  }
  console.log('└──────────────┴───────────────────┴────────────────────────────────┘\n');

  // === Projection accuracy ===
  const oldMAPE = (result.oldAccuracy.reduce((s, v) => s + v, 0) / result.oldAccuracy.length) * 100;
  const newMAPE = (result.newAccuracy.reduce((s, v) => s + v, 0) / result.newAccuracy.length) * 100;

  // By checkpoint day
  const checkpoints = [5, 10, 15, 20, 25];
  const perDay = checkpoints.length;
  const chunkSize = result.oldAccuracy.length / perDay;

  console.log('┌─────────────────────────────────────────────────────────┐');
  console.log('│ ТОЧНОСТЬ ПРОГНОЗА (MAPE — средняя абсолютная ошибка %) │');
  console.log('├────────────────────────┬──────────────┬────────────────┤');
  console.log('│ День месяца            │ Old (linear) │ New (EMA)      │');
  console.log('├────────────────────────┼──────────────┼────────────────┤');

  for (let i = 0; i < perDay; i++) {
    const start = Math.round(i * chunkSize);
    const end = Math.round((i + 1) * chunkSize);
    const oldSlice = result.oldAccuracy.slice(start, end);
    const newSlice = result.newAccuracy.slice(start, end);
    const oldDayMAPE = (oldSlice.reduce((s, v) => s + v, 0) / oldSlice.length) * 100;
    const newDayMAPE = (newSlice.reduce((s, v) => s + v, 0) / newSlice.length) * 100;
    console.log(`│ Day ${String(checkpoints[i]).padEnd(18)} │ ${oldDayMAPE.toFixed(1).padStart(11)}% │ ${newDayMAPE.toFixed(1).padStart(13)}% │`);
  }

  console.log('├────────────────────────┼──────────────┼────────────────┤');
  console.log(`│ Overall MAPE           │ ${oldMAPE.toFixed(1).padStart(11)}% │ ${newMAPE.toFixed(1).padStart(13)}% │`);
  console.log('└────────────────────────┴──────────────┴────────────────┘\n');

  // === Qualitative ===
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  КАЧЕСТВЕННЫЙ АНАЛИЗ');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Show worst false positive examples from old
  const oldFP = result.oldAlerts.filter((a) => !a.wasCorrect);
  const worstOldFP = [...new Map(oldFP.map(a => [`${a.month}:${a.category}`, a])).values()]
    .sort((a, b) => a.day - b.day)
    .slice(0, 5);

  if (worstOldFP.length > 0) {
    console.log('Примеры ложных алертов СТАРОГО алгоритма (первые по дню):');
    for (const a of worstOldFP) {
      console.log(`  Месяц ${a.month + 1}, день ${a.day}: ${a.category} — прогноз ${a.projected}, бюджет ${a.budget}, факт ${a.actualMonthEnd}`);
    }
  }

  // Show true positives caught only by new
  const newTP = result.newAlerts.filter((a) => a.wasCorrect);
  const newOnlyTP = newTP.filter((a) => {
    return !result.oldAlerts.some(
      (o) => o.month === a.month && o.category === a.category && o.wasCorrect,
    );
  });
  if (newOnlyTP.length > 0) {
    console.log('\nАлерты, пойманные ТОЛЬКО новым алгоритмом:');
    for (const a of newOnlyTP.slice(0, 5)) {
      console.log(`  Месяц ${a.month + 1}, день ${a.day}: ${a.category} — прогноз ${a.projected}, факт ${a.actualMonthEnd}`);
    }
  }

  // Summary
  console.log('\n══════════════════════════════');
  console.log('  ВЕРДИКТ');
  console.log('══════════════════════════════\n');

  const fpReduction = oldStats.falsePositives > 0
    ? ((oldStats.falsePositives - newStats.falsePositives) / oldStats.falsePositives * 100)
    : 0;
  const accuracyImprovement = oldMAPE > 0 ? ((oldMAPE - newMAPE) / oldMAPE * 100) : 0;

  console.log(`Signal/Noise (precision): ${(oldStats.precision * 100).toFixed(0)}% → ${(newStats.precision * 100).toFixed(0)}%`);
  console.log(`False positives: −${fpReduction.toFixed(0)}% (${oldStats.falsePositives} → ${newStats.falsePositives})`);
  console.log(`Forecast accuracy (MAPE): −${accuracyImprovement.toFixed(0)}% better (${oldMAPE.toFixed(1)}% → ${newMAPE.toFixed(1)}%)`);
  console.log(`True alerts preserved: ${newStats.truePositives}/${oldStats.truePositives}`);
}

// ═══════════════════════════════════════════════════════════════
// Run multiple seeds for statistical robustness
// ═══════════════════════════════════════════════════════════════

console.log('Generating spending data with 5 random seeds...\n');

const seeds = [42, 137, 256, 1001, 7777];
let allOldAlerts: AlertEvent[] = [];
let allNewAlerts: AlertEvent[] = [];
let allOldAccuracy: number[] = [];
let allNewAccuracy: number[] = [];

for (const seed of seeds) {
  const data = generateSpendingData(seed);
  const result = runBacktest(data);
  allOldAlerts = allOldAlerts.concat(result.oldAlerts);
  allNewAlerts = allNewAlerts.concat(result.newAlerts);
  allOldAccuracy = allOldAccuracy.concat(result.oldAccuracy);
  allNewAccuracy = allNewAccuracy.concat(result.newAccuracy);
}

printReport({
  oldAlerts: allOldAlerts,
  newAlerts: allNewAlerts,
  oldAccuracy: allOldAccuracy,
  newAccuracy: allNewAccuracy,
});
