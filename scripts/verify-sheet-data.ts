/** Cross-check all sheet rows against DB to find currency/amount mismatches */

import { google } from 'googleapis';
import { getAuthenticatedClient } from '../src/services/google/oauth';
import { Database } from 'bun:sqlite';

const GROUP_ID = 1;
const db = new Database('./data/expenses.db', { readonly: true });
const group = db.query('SELECT google_refresh_token FROM groups WHERE id = ?').get(GROUP_ID) as {
  google_refresh_token: string;
} | null;

if (!group) { console.error('Group not found'); process.exit(1); }

const auth = getAuthenticatedClient(group.google_refresh_token, 'legacy');
const sheets = google.sheets({ version: 'v4', auth });

// Load all DB expenses for this group
const dbExpenses = db
  .query('SELECT date, amount, currency, eur_amount, category, comment FROM expenses WHERE group_id = ? ORDER BY date, id')
  .all(GROUP_ID) as {
    date: string; amount: number; currency: string; eur_amount: number; category: string; comment: string;
  }[];

// Clone for consumption (we pop matches)
const dbPool = [...dbExpenses];

const spreadsheetIds = db
  .query('SELECT year, spreadsheet_id FROM group_spreadsheets WHERE group_id = ? ORDER BY year')
  .all(GROUP_ID) as { year: number; spreadsheet_id: string }[];

for (const { year, spreadsheet_id } of spreadsheetIds) {
  console.log(`\n=== Year ${year} ===`);

  const resp = await sheets.spreadsheets.values.get({
    spreadsheetId: spreadsheet_id,
    range: 'Expenses!A:Z',
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const rows = resp.data.values || [];
  const headers = rows[0] as string[];
  console.log(`Headers: ${JSON.stringify(headers)}`);
  console.log(`Data rows: ${rows.length - 1}`);

  // Find currency column indices
  const currCols: { idx: number; code: string }[] = [];
  for (let i = 0; i < headers.length; i++) {
    const m = headers[i]?.match(/^([A-Z]{3})\s*\(/);
    if (m?.[1] && headers[i] !== 'EUR (calc)' && headers[i] !== 'Rate (→EUR)') {
      currCols.push({ idx: i, code: m[1] });
    }
  }
  const eurCalcIdx = headers.indexOf('EUR (calc)');
  const catIdx = headers.indexOf('Категория');
  const commentIdx = headers.indexOf('Комментарий');
  const rateIdx = headers.indexOf('Rate (→EUR)');

  const issues: string[] = [];
  let matched = 0;
  let unmatched = 0;

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as string[];
    if (!row || !row[0]) continue;

    const date = row[0];
    const eurCalc = parseFloat(row[eurCalcIdx] || '0') || 0;
    const cat = row[catIdx] || '';
    const comment = row[commentIdx] || '';
    const rate = parseFloat(row[rateIdx] || '0') || 0;

    // Find which currency column has a value
    let sheetAmount = 0;
    let sheetCurrency = '';
    for (const { idx, code } of currCols) {
      const val = parseFloat(row[idx] || '0') || 0;
      if (val > 0) {
        sheetAmount = val;
        sheetCurrency = code;
        break;
      }
    }

    if (!sheetCurrency) {
      if (eurCalc > 0) {
        issues.push(`Row ${i + 1}: NO currency amount, EUR(calc)=${eurCalc} | ${date} ${cat} ${comment}`);
      }
      continue;
    }

    // Find matching DB expense
    const dbIdx = dbPool.findIndex(d =>
      d.date === date &&
      d.category === cat &&
      Math.abs(d.eur_amount - eurCalc) < 1.0
    );

    if (dbIdx === -1) {
      unmatched++;
      continue;
    }

    const dbRow = dbPool[dbIdx]!;
    dbPool.splice(dbIdx, 1);
    matched++;

    // Check currency match
    if (dbRow.currency !== sheetCurrency) {
      issues.push(
        `Row ${i + 1}: CURRENCY MISMATCH — sheet: ${sheetAmount} ${sheetCurrency}, DB: ${dbRow.amount} ${dbRow.currency} | ${date} ${cat}`
      );
    }

    // Check amount match (same currency)
    if (dbRow.currency === sheetCurrency && Math.abs(dbRow.amount - sheetAmount) > 0.01) {
      issues.push(
        `Row ${i + 1}: AMOUNT MISMATCH — sheet: ${sheetAmount}, DB: ${dbRow.amount} ${sheetCurrency} | ${date} ${cat}`
      );
    }

    // Check rate sanity for non-EUR
    if (sheetCurrency !== 'EUR' && rate > 0 && sheetAmount > 0) {
      const computedEur = sheetAmount * rate;
      const deviation = Math.abs(computedEur - eurCalc) / Math.max(eurCalc, 0.01);
      if (deviation > 0.05) {
        issues.push(
          `Row ${i + 1}: RATE MISMATCH — ${sheetAmount}*${rate}=${computedEur.toFixed(2)} but EUR(calc)=${eurCalc} (${(deviation * 100).toFixed(1)}% off) | ${date} ${cat}`
        );
      }
    }

    // Check that multiple currency columns don't have values simultaneously
    let filledCurrCols = 0;
    for (const { idx } of currCols) {
      if (row[idx] && parseFloat(row[idx]) > 0) filledCurrCols++;
    }
    if (filledCurrCols > 1) {
      issues.push(`Row ${i + 1}: MULTIPLE currencies filled (${filledCurrCols} columns) | ${date} ${cat}`);
    }
  }

  console.log(`Matched: ${matched}, Unmatched sheet rows: ${unmatched}`);
  console.log(`Issues: ${issues.length}`);
  for (const iss of issues) console.log(`  ${iss}`);
}

console.log(`\nDB expenses not matched to any sheet: ${dbPool.length}`);
if (dbPool.length > 0) {
  for (const d of dbPool.slice(0, 10)) {
    console.log(`  ${d.date} | ${d.amount} ${d.currency} | EUR ${d.eur_amount} | ${d.category} | ${d.comment}`);
  }
  if (dbPool.length > 10) console.log(`  ... and ${dbPool.length - 10} more`);
}

db.close();
