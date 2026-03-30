/**
 * Audit Google Sheet for EUR(calc) anomalies.
 *
 * Reads all expense rows, computes the median exchange rate per currency,
 * and flags any row whose EUR(calc) deviates >30% from the median.
 *
 * Usage: bun run scripts/audit-sheet.ts [--group-id N] [--threshold 0.3]
 *
 * Options:
 *   --group-id N     DB group ID (default: 1)
 *   --threshold N    Max allowed deviation from median, 0–1 (default: 0.3 = 30%)
 */

import { google } from 'googleapis';
import { getAuthenticatedClient } from '../src/services/google/oauth';
import { Database } from 'bun:sqlite';

// --- CLI args ---
const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? (args[idx + 1] ?? fallback) : fallback;
}
const GROUP_ID = Number(getArg('--group-id', '1'));
const THRESHOLD = Number(getArg('--threshold', '0.3'));

// --- Setup ---
const db = new Database('./data/expenses.db', { readonly: true });
const group = db.query('SELECT spreadsheet_id, google_refresh_token FROM groups WHERE id = ?').get(GROUP_ID) as {
  spreadsheet_id: string;
  google_refresh_token: string;
} | null;

if (!group?.spreadsheet_id || !group?.google_refresh_token) {
  console.error(`Group ${GROUP_ID} not found or not configured.`);
  process.exit(1);
}

const auth = getAuthenticatedClient(group.google_refresh_token);
const sheets = google.sheets({ version: 'v4', auth });

const response = await sheets.spreadsheets.values.get({
  spreadsheetId: group.spreadsheet_id,
  range: 'Expenses!A:Z',
});

const rows = response.data.values || [];
if (rows.length === 0) {
  console.log('Sheet is empty.');
  process.exit(0);
}

const headers = rows[0] as string[];
const eurCalcIdx = headers.indexOf('EUR (calc)');
const categoryIdx = headers.indexOf('Категория');
const commentIdx = headers.indexOf('Комментарий');

if (eurCalcIdx === -1) {
  console.error('EUR (calc) column not found in headers:', headers);
  process.exit(1);
}

// Detect currency columns (pattern: "USD ($)", "RSD (RSD)", etc.)
const currCols: Array<{ idx: number; code: string }> = [];
for (let i = 0; i < headers.length; i++) {
  const header = headers[i] ?? '';
  const m = header.match(/^([A-Z]{3})\s*\(/);
  if (m?.[1] && header !== 'EUR (calc)') {
    currCols.push({ idx: i, code: m[1] });
  }
}

console.log(`Headers: ${headers.join(' | ')}`);
console.log(`Currency columns: ${currCols.map((c) => c.code).join(', ')}`);
console.log(`Threshold: ${(THRESHOLD * 100).toFixed(0)}%`);
console.log(`Rows: ${rows.length - 1}\n`);

// --- Collect rates per currency ---
const ratesByCurrency = new Map<string, number[]>();
for (const { code } of currCols) {
  if (code !== 'EUR') ratesByCurrency.set(code, []);
}

for (let i = 1; i < rows.length; i++) {
  const row = rows[i] as string[];
  if (!row?.[0]) continue;
  const eurCalc = parseFloat(row[eurCalcIdx] || '');
  if (Number.isNaN(eurCalc) || eurCalc === 0) continue;

  for (const { idx, code } of currCols) {
    if (code === 'EUR') continue;
    const amount = parseFloat(row[idx] || '');
    if (Number.isNaN(amount) || amount <= 0) continue;
    ratesByCurrency.get(code)?.push(eurCalc / amount);
  }
}

function median(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length === 0) return 0;
  return sorted.length % 2 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

// --- Flag outliers ---
let issues = 0;

console.log('=== MEDIAN RATES ===');
for (const [code, rates] of ratesByCurrency.entries()) {
  if (rates.length === 0) continue;
  const med = median(rates);
  console.log(`${code}: median = ${med.toFixed(6)} (${rates.length} entries)`);
}
console.log('');

// Check EUR column: EUR(calc) should match EUR amount
for (let i = 1; i < rows.length; i++) {
  const row = rows[i] as string[];
  if (!row?.[0]) continue;
  const eurCalc = parseFloat(row[eurCalcIdx] || '');
  if (Number.isNaN(eurCalc)) continue;

  const eurCol = currCols.find((c) => c.code === 'EUR');
  if (!eurCol) continue;
  const eurAmount = parseFloat(row[eurCol.idx] || '');
  if (Number.isNaN(eurAmount) || eurAmount <= 0) continue;

  if (Math.abs(eurCalc - eurAmount) > 0.5) {
    console.log(
      `MISMATCH Row ${i + 1}: ${row[0]} | ${eurAmount} EUR → EUR(calc)=${eurCalc} | diff=${(eurCalc - eurAmount).toFixed(2)} | ${row[categoryIdx] || ''} ${row[commentIdx] || ''}`,
    );
    issues++;
  }
}

// Check other currencies against median
for (const [code, rates] of ratesByCurrency.entries()) {
  if (rates.length === 0) continue;
  const med = median(rates);

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as string[];
    if (!row?.[0]) continue;
    const eurCalc = parseFloat(row[eurCalcIdx] || '');
    if (Number.isNaN(eurCalc) || eurCalc === 0) continue;

    const col = currCols.find((c) => c.code === code);
    if (!col) continue;
    const amount = parseFloat(row[col.idx] || '');
    if (Number.isNaN(amount) || amount <= 0) continue;

    const rate = eurCalc / amount;
    const deviation = Math.abs(rate - med) / med;
    if (deviation > THRESHOLD) {
      const expected = Math.round(amount * med * 100) / 100;
      console.log(
        `OUTLIER Row ${i + 1}: ${row[0]} | ${amount} ${code} → ${eurCalc} EUR (expected ~${expected}) | dev=${(deviation * 100).toFixed(1)}% | ${row[categoryIdx] || ''} ${row[commentIdx] || ''}`,
      );
      issues++;
    }
  }
}

console.log(`\n${issues === 0 ? '✅ No issues found.' : `⚠️ ${issues} issue(s) found.`}`);
db.close();
