// Rich Telegram HTML budget overview: aligned <pre> table, RU month name, safe 4096-char chunking

import { endOfMonth, format, startOfMonth } from 'date-fns';
import { getCategoryEmoji } from '../../config/category-emojis';
import { BASE_CURRENCY, type CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import { computeBudgetProgress } from '../../database/repositories/budget.repository';
import type { Budget } from '../../database/types';
import { spendingAnalytics } from '../../services/analytics/spending-analytics';
import { convertCurrency, formatAmount } from '../../services/currency/converter';
import { escapeHtml, packHtmlBlocks } from '../../utils/html';
import { formatMonthYearRu } from '../../utils/ru-date';

const TABLE_CHUNK_LIMIT = 3500;
const MAX_NAME_WIDTH = 16;
const MAX_FORECAST_LINES = 10;

interface CategoryRow {
  budget: Budget;
  spent: number;
  percentage: number;
  isExceeded: boolean;
  isWarning: boolean;
}

interface CurrencyTotal {
  spent: number;
  limit: number;
}

function percent(spent: number, limit: number): number {
  return limit > 0 ? Math.round((spent / limit) * 100) : 0;
}

function marker(row: CategoryRow): string {
  if (row.isExceeded) return '🔴';
  return row.isWarning ? '🟡' : '🟢';
}

function truncateName(name: string): string {
  const chars = Array.from(name);
  return chars.length > MAX_NAME_WIDTH ? `${chars.slice(0, MAX_NAME_WIDTH - 1).join('')}…` : name;
}

function padCell(cell: string, width: number, align: 'left' | 'right'): string {
  // Pad by code points: String#padEnd counts UTF-16 units, which misaligns emoji cells.
  const gap = ' '.repeat(Math.max(0, width - Array.from(cell).length));
  return align === 'right' ? `${gap}${cell}` : `${cell}${gap}`;
}

/** Pad every column to its widest cell so rows line up in a monospace <pre>. */
function alignColumns(rows: string[][], align: Array<'left' | 'right'>): string[] {
  const widths = (rows[0] ?? []).map((_, col) =>
    Math.max(...rows.map((row) => Array.from(row[col] ?? '').length)),
  );
  return rows.map((row) =>
    row.map((cell, col) => padCell(cell, widths[col] ?? 0, align[col] ?? 'left')).join(' '),
  );
}

function wrapPre(lines: string[]): string {
  return `<pre>${lines.map(escapeHtml).join('\n')}</pre>`;
}

function loadRows(groupId: number, budgets: Budget[], now: Date): CategoryRow[] {
  const totals = database.expenses.getCategoryTotals(
    groupId,
    format(startOfMonth(now), 'yyyy-MM-dd'),
    format(endOfMonth(now), 'yyyy-MM-dd'),
  );
  const spentEur = new Map(totals.map((row) => [row.category, row.total]));
  const rows = budgets.map((budget) => {
    const spent = convertCurrency(
      spentEur.get(budget.category) ?? 0,
      BASE_CURRENCY,
      budget.currency,
    );
    const progress = computeBudgetProgress(budget, spent);
    return {
      budget,
      spent,
      percentage: progress.percentage,
      isExceeded: progress.is_exceeded,
      isWarning: progress.is_warning,
    };
  });
  return rows.sort(
    (a, b) => b.percentage - a.percentage || a.budget.category.localeCompare(b.budget.category),
  );
}

function sumByCurrency(rows: CategoryRow[]): Map<CurrencyCode, CurrencyTotal> {
  const totals = new Map<CurrencyCode, CurrencyTotal>();
  for (const { budget, spent } of rows) {
    const total = totals.get(budget.currency) ?? { spent: 0, limit: 0 };
    total.spent += spent;
    total.limit += budget.limit_amount;
    totals.set(budget.currency, total);
  }
  return totals;
}

function totalsBlock(groupId: number, rows: CategoryRow[]): string {
  const totals = sumByCurrency(rows);
  const cells = [...totals].map(([currency, { spent, limit }]) => [
    `Итого ${currency}`,
    formatAmount(spent, currency),
    '/',
    formatAmount(limit, currency),
    `${percent(spent, limit)}%`,
  ]);
  if (totals.size > 1) {
    const display = database.groups.findById(groupId)?.default_currency ?? BASE_CURRENCY;
    const all = [...totals].reduce(
      (sum, [currency, t]) => ({
        spent: sum.spent + convertCurrency(t.spent, currency, display),
        limit: sum.limit + convertCurrency(t.limit, currency, display),
      }),
      { spent: 0, limit: 0 },
    );
    cells.push([
      `Всего ≈ ${display}`,
      formatAmount(all.spent, display),
      '/',
      formatAmount(all.limit, display),
      `${percent(all.spent, all.limit)}%`,
    ]);
  }
  return wrapPre(alignColumns(cells, ['left', 'right', 'left', 'right', 'right']));
}

/** Table rows packed into <pre> blocks that each stay well under the Telegram limit. */
function tableBlocks(rows: CategoryRow[]): string[] {
  const cells = rows.map((row) => [
    `${marker(row)} ${truncateName(row.budget.category)}`,
    formatAmount(row.spent, row.budget.currency),
    '/',
    formatAmount(row.budget.limit_amount, row.budget.currency),
    `${row.percentage}%`,
  ]);
  // Marker emoji + space prefix are identical in width for every row, so pad names only.
  const lines = alignColumns(cells, ['left', 'right', 'left', 'right', 'right']);
  const blocks: string[] = [];
  let chunk: string[] = [];
  let size = 0;
  for (const line of lines) {
    const lineSize = escapeHtml(line).length + 1;
    if (chunk.length > 0 && size + lineSize > TABLE_CHUNK_LIMIT) {
      blocks.push(wrapPre(chunk));
      chunk = [];
      size = 0;
    }
    chunk.push(line);
    size += lineSize;
  }
  if (chunk.length > 0) blocks.push(wrapPre(chunk));
  return blocks;
}

function forecastBlock(groupId: number, rows: CategoryRow[]): string | null {
  const analysis = spendingAnalytics.getFinancialSnapshot(groupId).technicalAnalysis;
  if (!analysis) return null;
  const insights: string[] = [];
  for (const cat of analysis.categories) {
    const row = rows.find((r) => r.budget.category === cat.category);
    if (!row) continue;
    const forecast = Math.round(
      convertCurrency(cat.forecasts.ensemble, BASE_CURRENCY, row.budget.currency),
    );
    const forecastPct = percent(forecast, row.budget.limit_amount);
    const rising = cat.trend.direction === 'rising';
    if (forecastPct >= 80 || cat.anomaly.isAnomaly || (rising && cat.trend.confidence >= 0.6)) {
      const arrow = rising ? '↑' : cat.trend.direction === 'falling' ? '↓' : '→';
      const warn = cat.anomaly.isAnomaly ? ' ⚠️' : '';
      insights.push(
        `${getCategoryEmoji(cat.category)} ${escapeHtml(cat.category)}: прогноз ${formatAmount(forecast, row.budget.currency)} ${arrow}${warn}`,
      );
    }
  }
  if (insights.length === 0) return null;
  // N+2 rule: never hide fewer than 3 lines behind "и ещё N".
  const hidden = insights.length - MAX_FORECAST_LINES;
  const visible = hidden >= 3 ? insights.slice(0, MAX_FORECAST_LINES) : insights;
  const tail = hidden >= 3 ? `\n… и ещё ${hidden}` : '';
  return `<b>Прогноз на месяц</b>\n${visible.join('\n')}${tail}`;
}

/** Build the budget overview as one or more Telegram HTML messages. */
export function formatBudgetProgress(
  groupId: number,
  now: Date = new Date(),
): { messages: string[]; hasBudgets: boolean } {
  const title = `📊 <b>Бюджет на ${formatMonthYearRu(now)}</b>`;
  const budgets = database.budgets.getAllBudgetsForMonth(groupId, format(now, 'yyyy-MM'));
  if (budgets.length === 0) {
    return { messages: [`${title}\n\nБюджеты не установлены.`], hasBudgets: false };
  }

  const rows = loadRows(groupId, budgets, now);
  const legend = '<i>🟢 в рамках · 🟡 от 90% · 🔴 превышен</i>';
  const blocks = [`${title}\n${legend}`, totalsBlock(groupId, rows), ...tableBlocks(rows)];
  const forecast = forecastBlock(groupId, rows);
  if (forecast) blocks.push(forecast);
  return { messages: packHtmlBlocks(blocks), hasBudgets: true };
}

/** Confirmation text after a budget was written (used by /budget set and the prompt flow). */
export function formatBudgetSetMessage(params: {
  category: string;
  amount: number;
  currency: CurrencyCode;
  sheetsSynced: boolean;
  sheetsConnected: boolean;
}): string {
  const { category, amount, currency, sheetsSynced, sheetsConnected } = params;
  const summary = `Бюджет установлен: ${getCategoryEmoji(category)} ${escapeHtml(category)} = ${formatAmount(amount, currency)}`;
  if (sheetsSynced) return summary;
  if (sheetsConnected) {
    return `${summary}\n\nНе удалось записать в Google Sheets. Используй /budget sync позже.`;
  }
  return `${summary}\n\nПодключи Google Sheets (/connect) чтобы синхронизировать бюджеты.`;
}
