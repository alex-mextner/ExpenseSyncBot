/**
 * get_expenses tool: resolves the requested periods and renders either a per-category summary
 * (summary_only) or a paginated detail listing. Both outputs carry the authoritative total for the
 * whole filtered set so the model never has to add up rows itself.
 */
import {
  BASE_CURRENCY,
  type CurrencyCode,
  isSupportedCurrency,
  SUPPORTED_CURRENCIES,
} from '../../../config/constants';
import { database } from '../../../database';
import type { Expense } from '../../../database/types';
import { createLogger } from '../../../utils/logger.ts';
import { normalizeArrayParam, resolvePeriodDates } from '../../../utils/period';
import { formatReceiptCommentForTelegram } from '../../../utils/receipt-display';
import { convertCurrency, formatAmount } from '../../currency/converter';
import {
  computeExpenseStats,
  type ExpenseStats,
  formatStats,
  formatStatsDiff,
  formatStatsTrend,
  type TrendEntry,
} from '../stats';
import type { AgentContext, ToolResult } from '../types';
import { filterByCategories } from './category-filter';

const logger = createLogger('tool-executor');

interface PeriodData {
  label: string;
  startDate: string;
  endDate: string;
  expenses: Expense[];
}

interface CategoryTotals {
  count: number;
  eur_total: number;
  amounts: Record<string, number>;
}

export async function executeGetExpenses(
  input: Record<string, unknown>,
  ctx: AgentContext,
): Promise<ToolResult> {
  const periods = normalizeArrayParam(input['period'], 'current_month');
  const categories = normalizeArrayParam(input['category']);
  // Whole numbers only: the schema says number, and a model may send 1.5.
  const pageSize = Math.floor(Math.min(Math.max((input['page_size'] as number) || 100, 1), 500));
  const page = Math.floor(Math.max((input['page'] as number) || 1, 1));
  const summaryOnly = (input['summary_only'] as boolean) || false;

  const group = database.groups.findById(ctx.groupId);
  // Totals come in the requested currency when asked (one call instead of a `calculate` per
  // category), otherwise in the group's default currency. null/blank means "not given".
  const requestedCurrency = String(input['currency'] ?? '')
    .trim()
    .toUpperCase();
  let displayCurrency: CurrencyCode = group?.default_currency ?? BASE_CURRENCY;
  if (requestedCurrency) {
    if (!isSupportedCurrency(requestedCurrency)) {
      return {
        success: false,
        error: `Unknown currency: "${requestedCurrency.slice(0, 32)}". Supported: ${SUPPORTED_CURRENCIES.join(', ')}`,
      };
    }
    displayCurrency = requestedCurrency;
  }

  // Resolve all periods and fetch expenses
  const periodData: PeriodData[] = [];

  for (const period of periods) {
    const { startDate, endDate } = resolvePeriodDates(period);
    const expenses = filterByCategories(
      database.expenses.findByDateRange(ctx.groupId, startDate, endDate),
      categories,
    );

    periodData.push({ label: period, startDate, endDate, expenses });
  }

  const isBatch = periods.length > 1;
  const allExpenses = periodData.flatMap((p) => p.expenses);

  if (summaryOnly) {
    return buildSummaryOutput(periodData, allExpenses, displayCurrency, isBatch);
  }

  return buildDetailOutput(
    periodData,
    allExpenses,
    displayCurrency,
    group?.default_currency ?? BASE_CURRENCY,
    isBatch,
    page,
    pageSize,
  );
}

function aggregateByCategory(expenses: Expense[]): Record<string, CategoryTotals> {
  const totals: Record<string, CategoryTotals> = {};
  for (const e of expenses) {
    const existing = totals[e.category];
    const cat = existing ?? { count: 0, eur_total: 0, amounts: {} };
    totals[e.category] = cat;
    cat.count++;
    cat.eur_total += e.eur_amount;
    cat.amounts[e.currency] = (cat.amounts[e.currency] || 0) + e.amount;
  }
  return totals;
}

/** One period of the summary: header, total, per-category lines (largest first) and stats. */
function renderPeriodSummary(
  pd: PeriodData,
  displayCurrency: CurrencyCode,
  isBatch: boolean,
): { lines: string[]; stats: ExpenseStats } {
  const lines: string[] = [];
  if (isBatch) lines.push(`=== ${pd.label} ===`);
  lines.push(`Period: ${pd.startDate} to ${pd.endDate}`);

  if (pd.expenses.length === 0) {
    lines.push('No expenses', '');
    return { lines, stats: { count: 0, total: 0, avg: 0, median: 0, min: null, max: null } };
  }

  const totals = aggregateByCategory(pd.expenses);
  const totalEur = Object.values(totals).reduce((s, c) => s + c.eur_total, 0);
  const totalDisplay = convertCurrency(totalEur, BASE_CURRENCY, displayCurrency);
  lines.push(`Total: ${formatAmount(totalDisplay, displayCurrency, true)}`, '');

  const sorted = Object.entries(totals).sort((a, b) => b[1].eur_total - a[1].eur_total);
  for (const [cat, data] of sorted) {
    const amountParts = Object.entries(data.amounts)
      .map(([c, a]) => formatAmount(a, c as CurrencyCode, true))
      .join(', ');
    const catDisplay = convertCurrency(data.eur_total, BASE_CURRENCY, displayCurrency);
    lines.push(
      `${cat}: ${formatAmount(catDisplay, displayCurrency, true)} (${data.count} ops) [${amountParts}]`,
    );
  }

  const stats = computeExpenseStats(pd.expenses, displayCurrency);
  lines.push('', `=== Stats${isBatch ? ` (${pd.label})` : ''} ===`);
  lines.push(formatStats(stats, displayCurrency));
  lines.push('');
  return { lines, stats };
}

/** Diff for exactly two periods, trend for three or more, nothing otherwise. */
function renderPeriodComparison(
  periodData: PeriodData[],
  perPeriodStats: ExpenseStats[],
  displayCurrency: CurrencyCode,
): string[] {
  if (periodData.length >= 3) {
    const entries: TrendEntry[] = [];
    for (let i = 0; i < periodData.length; i++) {
      const pd = periodData[i];
      const stats = perPeriodStats[i];
      if (pd && stats) entries.push({ label: pd.label, stats });
    }
    return [formatStatsTrend(entries, displayCurrency)];
  }

  const [first, second] = periodData;
  const [firstStats, secondStats] = perPeriodStats;
  if (periodData.length !== 2 || !first || !second || !firstStats || !secondStats) return [];
  return [
    formatStatsDiff(
      firstStats,
      secondStats,
      first.label,
      second.label,
      displayCurrency,
      first.expenses,
      second.expenses,
    ),
  ];
}

/** Batch-only tail: overall total and stats, then the diff / trend across periods. */
function renderBatchOverall(
  periodData: PeriodData[],
  perPeriodStats: ExpenseStats[],
  allExpenses: Expense[],
  displayCurrency: CurrencyCode,
): string[] {
  const overallStats = computeExpenseStats(allExpenses, displayCurrency);
  const overallEur = allExpenses.reduce((s, e) => s + e.eur_amount, 0);
  const overallDisplay = convertCurrency(overallEur, BASE_CURRENCY, displayCurrency);
  return [
    '=== Overall ===',
    `Total: ${formatAmount(overallDisplay, displayCurrency, true)}`,
    formatStats(overallStats, displayCurrency),
    '',
    ...renderPeriodComparison(periodData, perPeriodStats, displayCurrency),
  ];
}

function buildSummaryOutput(
  periodData: PeriodData[],
  allExpenses: Expense[],
  displayCurrency: CurrencyCode,
  isBatch: boolean,
): ToolResult {
  const lines: string[] = [];
  const perPeriodStats: ExpenseStats[] = [];

  for (const pd of periodData) {
    const section = renderPeriodSummary(pd, displayCurrency, isBatch);
    lines.push(...section.lines);
    perPeriodStats.push(section.stats);
  }

  if (isBatch && allExpenses.length > 0) {
    lines.push(...renderBatchOverall(periodData, perPeriodStats, allExpenses, displayCurrency));
  }

  const output = lines.join('\n');
  logger.info(
    `[TOOL] get_expenses summary output (${allExpenses.length} expenses, ${periodData.length} periods)`,
  );
  return { success: true, output };
}

function buildDetailOutput(
  periodData: PeriodData[],
  allExpenses: Expense[],
  displayCurrency: CurrencyCode,
  defaultCurrency: CurrencyCode,
  isBatch: boolean,
  page: number,
  pageSize: number,
): ToolResult {
  // Sort all expenses by date desc
  allExpenses.sort((a, b) => b.date.localeCompare(a.date));

  const totalPages = Math.max(1, Math.ceil(allExpenses.length / pageSize));
  const offset = (page - 1) * pageSize;
  const pageItems = allExpenses.slice(offset, offset + pageSize);

  const totalEur = allExpenses.reduce((s, e) => s + e.eur_amount, 0);
  const totalDisplay = convertCurrency(totalEur, BASE_CURRENCY, displayCurrency);
  // A requested currency other than the group's also gets the total in the group currency, so
  // the model never has to convert the authoritative total itself.
  const totalInDefault =
    displayCurrency === defaultCurrency
      ? ''
      : ` (= ${formatAmount(convertCurrency(totalEur, BASE_CURRENCY, defaultCurrency), defaultCurrency, true)})`;

  const firstPeriod = periodData[0];
  const lastPeriod = periodData[periodData.length - 1];
  const dateRange =
    isBatch && firstPeriod && lastPeriod
      ? `${firstPeriod.startDate} to ${lastPeriod.endDate}`
      : `${firstPeriod?.startDate ?? '?'} to ${firstPeriod?.endDate ?? '?'}`;

  // Stage QA 2026-10-15: a model summed page 1 of 8 and called it the total. Every page says what
  // it shows, the total for the whole filtered set (authoritative), and how to get the rest.
  const lines = [
    `Period: ${dateRange}`,
    pageItems.length > 0
      ? `Showing ${offset + 1}–${offset + pageItems.length} of ${allExpenses.length} expenses (page ${page} of ${totalPages})`
      : `Showing none of ${allExpenses.length} expenses (page ${page} of ${totalPages})`,
    `Total for all ${allExpenses.length} expenses: ${formatAmount(totalDisplay, displayCurrency, true)}${totalInDefault}`,
  ];
  if (page < totalPages) {
    lines.push(
      `More pages: ${page + 1}–${totalPages} are not shown. For totals use the "Total for all" line above (or get_expenses with summary_only: true) — never add up the rows of one page as the total. For the individual rows call get_expenses again with page=${page + 1} … page=${totalPages} with page_size=${pageSize} and the same filters.`,
    );
  }
  lines.push('');

  // Stats for ALL expenses (not just page)
  const allStats = computeExpenseStats(allExpenses, displayCurrency);
  lines.push('=== Stats (all) ===');
  lines.push(formatStats(allStats, displayCurrency));
  lines.push('');

  // Stats for current page
  if (totalPages > 1) {
    const pageStats = computeExpenseStats(pageItems, displayCurrency);
    lines.push('=== Stats (this page only, not the total) ===');
    lines.push(formatStats(pageStats, displayCurrency));
    lines.push('');
  }

  for (const e of pageItems) {
    const displayComment = formatReceiptCommentForTelegram(e.comment).trim() || '(no comment)';
    lines.push(
      `[id:${e.id}] ${e.date} | ${e.category} | ${formatAmount(e.amount, e.currency, true)} (EUR ${formatAmount(e.eur_amount, BASE_CURRENCY, true)}) | ${displayComment}`,
    );
  }

  const output = lines.join('\n');
  logger.info(
    `[TOOL] get_expenses detail output (page ${page}/${totalPages}, ${allExpenses.length} total)`,
  );
  return { success: true, output };
}
