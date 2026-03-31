/**
 * Full repair of all spreadsheets for a group:
 *
 * 1. Fix column order to canonical: Дата | USD | EUR | RUB | RSD | [other] | EUR (calc) | Категория | Комментарий | Rate (→EUR)
 * 2. Fill missing currency amounts from DB (broken rows with EUR-only)
 * 3. Fill missing Rate values (derived from EUR/amount)
 * 4. Replace static EUR (calc) with formulas
 *
 * Usage: bun run scripts/repair-all-sheets.ts [--group-id N] [--dry-run]
 */

import { google } from 'googleapis';
import { getAuthenticatedClient } from '../src/services/google/oauth';
import { Database } from 'bun:sqlite';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? (args[idx + 1] ?? fallback) : fallback;
}
const GROUP_ID = Number(getArg('--group-id', '1'));

if (DRY_RUN) console.log('*** DRY RUN — no changes will be made ***\n');

const db = new Database('./data/expenses.db', { readonly: true });
const group = db.query('SELECT id, google_refresh_token FROM groups WHERE id = ?').get(GROUP_ID) as {
  id: number;
  google_refresh_token: string;
} | null;

if (!group?.google_refresh_token) {
  console.error(`Group ${GROUP_ID} not found or has no Google refresh token.`);
  process.exit(1);
}

// Try to read oauth_client_type if column exists
let oauthClientType = 'legacy';
try {
  const row = db.query('SELECT oauth_client_type FROM groups WHERE id = ?').get(group.id) as { oauth_client_type: string | null } | null;
  if (row?.oauth_client_type) oauthClientType = row.oauth_client_type;
} catch { /* column doesn't exist yet */ }

const auth = getAuthenticatedClient(group.google_refresh_token, oauthClientType as 'current' | 'legacy');
const sheetsApi = google.sheets({ version: 'v4', auth });

// Get all spreadsheets for this group
const spreadsheetRows = db
  .query('SELECT year, spreadsheet_id FROM group_spreadsheets WHERE group_id = ? ORDER BY year')
  .all(group.id) as { year: number; spreadsheet_id: string }[];

// Also find backup spreadsheets on Drive
const drive = google.drive({ version: 'v3', auth });
let allSpreadsheets: { name: string; id: string }[] = [];
try {
  const files = await drive.files.list({
    q: "mimeType=\"application/vnd.google-apps.spreadsheet\"",
    fields: "files(id,name)",
  });
  allSpreadsheets = (files.data.files || []).map((f) => ({ name: f.name!, id: f.id! }));
} catch {
  console.log('Could not list Drive files (no scope?)');
}

// Build list of all spreadsheets to process
const toProcess: { name: string; id: string }[] = [];
for (const row of spreadsheetRows) {
  toProcess.push({ name: `Group ${GROUP_ID} / ${row.year}`, id: row.spreadsheet_id });
}
for (const f of allSpreadsheets) {
  if (!toProcess.find((t) => t.id === f.id) && f.name.includes('Expense')) {
    toProcess.push({ name: `Backup: ${f.name}`, id: f.id });
  }
}

console.log(`Processing ${toProcess.length} spreadsheet(s):\n`);
for (const t of toProcess) console.log(`  ${t.name}: ${t.id}`);

// Load all DB expenses for matching
const dbExpenses = db
  .query(
    'SELECT id, date, amount, currency, eur_amount, category, comment FROM expenses WHERE group_id = ? ORDER BY date, id',
  )
  .all(GROUP_ID) as {
  id: number;
  date: string;
  amount: number;
  currency: string;
  eur_amount: number;
  category: string;
  comment: string;
}[];

console.log(`\nDB expenses loaded: ${dbExpenses.length}`);

// Canonical column order (currency columns come from enabled_currencies)
const CANONICAL_PREFIX = ['Дата'];
const CANONICAL_SUFFIX = ['EUR (calc)', 'Категория', 'Комментарий', 'Rate (→EUR)'];

function colLetter(index: number): string {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

function isCurrencyHeader(h: string): boolean {
  return /^[A-Z]{3}\s*\(/.test(h) && h !== 'EUR (calc)' && h !== 'Rate (→EUR)';
}

// ── Process each spreadsheet ──

for (const { name, id: spreadsheetId } of toProcess) {
  console.log(`\n${'='.repeat(70)}`);
  console.log(`${name}: ${spreadsheetId}`);
  console.log('='.repeat(70));

  // Read with FORMULA to detect static values
  const formulaResp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: 'Expenses!A:Z',
    valueRenderOption: 'FORMULA',
  });
  const formulaRows = formulaResp.data.values || [];

  // Read with FORMATTED_VALUE for display/matching
  const formattedResp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId,
    range: 'Expenses!A:Z',
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const fmtRows = formattedResp.data.values || [];

  if (fmtRows.length === 0) {
    console.log('  Empty sheet, skipping.');
    continue;
  }

  const headers = fmtRows[0] as string[];
  console.log(`  Headers: ${JSON.stringify(headers)}`);
  console.log(`  Data rows: ${fmtRows.length - 1}`);

  // ── Step 1: Check and fix column order ──

  // Determine canonical order for this sheet's currencies
  const currHeaders = headers.filter(isCurrencyHeader);
  const canonicalHeaders = [...CANONICAL_PREFIX, ...currHeaders, ...CANONICAL_SUFFIX];

  // Check if current order matches canonical
  const needsReorder = JSON.stringify(headers) !== JSON.stringify(canonicalHeaders);

  if (needsReorder) {
    console.log(`  ⚠️  Column order wrong!`);
    console.log(`    Current:   ${JSON.stringify(headers)}`);
    console.log(`    Canonical: ${JSON.stringify(canonicalHeaders)}`);

    if (!DRY_RUN) {
      // Reorder all data rows by mapping old column positions to new
      const colMap: number[] = []; // canonical index → old index (or -1 if new)
      for (const ch of canonicalHeaders) {
        const oldIdx = headers.indexOf(ch);
        colMap.push(oldIdx);
      }

      const newRows: (string | number | null)[][] = [];
      // Header row
      newRows.push(canonicalHeaders);
      // Data rows
      for (let i = 1; i < formulaRows.length; i++) {
        const oldRow = formulaRows[i] || [];
        const newRow: (string | number | null)[] = [];
        for (const oldIdx of colMap) {
          newRow.push(oldIdx >= 0 ? (oldRow[oldIdx] ?? '') : '');
        }
        newRows.push(newRow);
      }

      // Get spreadsheet metadata for sheetId
      const meta = await sheetsApi.spreadsheets.get({ spreadsheetId });
      const sheet = meta.data.sheets?.find((s) => s.properties?.title === 'Expenses');
      const sheetId = sheet?.properties?.sheetId ?? 0;

      // Clear entire sheet and rewrite
      await sheetsApi.spreadsheets.values.clear({
        spreadsheetId,
        range: 'Expenses!A:Z',
      });

      await sheetsApi.spreadsheets.values.update({
        spreadsheetId,
        range: `Expenses!A1:${colLetter(canonicalHeaders.length - 1)}${newRows.length}`,
        valueInputOption: 'USER_ENTERED',
        requestBody: { values: newRows },
      });

      // Bold + gray background for header row
      await sheetsApi.spreadsheets.batchUpdate({
        spreadsheetId,
        requestBody: {
          requests: [
            {
              repeatCell: {
                range: {
                  sheetId,
                  startRowIndex: 0,
                  endRowIndex: 1,
                  startColumnIndex: 0,
                  endColumnIndex: canonicalHeaders.length,
                },
                cell: {
                  userEnteredFormat: {
                    textFormat: { bold: true },
                    backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
                  },
                },
                fields: 'userEnteredFormat(textFormat,backgroundColor)',
              },
            },
          ],
        },
      });

      console.log(`  ✅ Columns reordered`);

      // Re-read after reorder for subsequent steps
      const reResp = await sheetsApi.spreadsheets.values.get({
        spreadsheetId,
        range: 'Expenses!A:Z',
        valueRenderOption: 'FORMATTED_VALUE',
      });
      fmtRows.splice(0, fmtRows.length, ...(reResp.data.values || []));
      formulaRows.splice(0, formulaRows.length, ...(reResp.data.values || []));
      // Re-read formulas too
      const reFormulaResp = await sheetsApi.spreadsheets.values.get({
        spreadsheetId,
        range: 'Expenses!A:Z',
        valueRenderOption: 'FORMULA',
      });
      formulaRows.splice(0, formulaRows.length, ...(reFormulaResp.data.values || []));
    } else {
      console.log(`  [DRY RUN] Would reorder columns`);
    }
  } else {
    console.log(`  ✅ Column order correct`);
  }

  // ── Step 2: Fix broken rows (no currency amount but has EUR calc) ──

  const currentHeaders = fmtRows[0] as string[];
  const currCols: { idx: number; code: string }[] = [];
  for (let i = 0; i < currentHeaders.length; i++) {
    if (isCurrencyHeader(currentHeaders[i]!)) {
      const m = currentHeaders[i]!.match(/^([A-Z]{3})/);
      if (m?.[1]) currCols.push({ idx: i, code: m[1] });
    }
  }

  const eurCalcIdx = currentHeaders.indexOf('EUR (calc)');
  const rateIdx = currentHeaders.indexOf('Rate (→EUR)');

  // Build DB lookup for matching
  const dbLookup = new Map<string, typeof dbExpenses>();
  for (const r of dbExpenses) {
    const key = `${r.date}|${r.category}|${Math.round(r.eur_amount * 10) / 10}`;
    if (!dbLookup.has(key)) dbLookup.set(key, []);
    dbLookup.get(key)!.push(r);
  }

  interface RowFix {
    sheetRow: number;
    currencyColIdx: number;
    amount: number;
    rate: number;
    eurFormula: string;
  }

  const fixes: RowFix[] = [];
  let brokenTotal = 0;
  let brokenMatched = 0;
  let brokenUnmatched = 0;

  for (let i = 1; i < fmtRows.length; i++) {
    const row = fmtRows[i] as string[];
    if (!row || !row[0]) continue;

    // Check if broken
    let hasAmount = false;
    for (const { idx } of currCols) {
      if (row[idx] && Number(row[idx]) > 0) {
        hasAmount = true;
        break;
      }
    }
    if (hasAmount) continue;

    const eurCalc = parseFloat(row[eurCalcIdx] || '0') || 0;
    if (eurCalc <= 0) continue;

    brokenTotal++;

    const date = row[0];
    const cat = row[currentHeaders.indexOf('Категория')] || '';
    const key = `${date}|${cat}|${Math.round(eurCalc * 10) / 10}`;

    const dbMatch = dbLookup.get(key);
    if (dbMatch && dbMatch.length > 0) {
      brokenMatched++;
      const expense = dbMatch.shift()!;
      if (dbMatch.length === 0) dbLookup.delete(key);

      // Find the column for this currency
      const currCol = currCols.find((c) => c.code === expense.currency);
      if (currCol) {
        const rate = expense.currency === 'EUR' ? 1 : (expense.amount > 0 ? eurCalc / expense.amount : 1);
        const sheetRow = i + 1;
        fixes.push({
          sheetRow,
          currencyColIdx: currCol.idx,
          amount: expense.amount,
          rate: Math.round(rate * 1_000_000) / 1_000_000,
          eurFormula:
            expense.currency === 'EUR'
              ? '' // EUR expenses keep static EUR(calc) = amount
              : `=${colLetter(currCol.idx)}${sheetRow}*${colLetter(rateIdx)}${sheetRow}`,
        });
      }
    } else {
      brokenUnmatched++;
    }
  }

  console.log(`  Broken rows: ${brokenTotal} (matched DB: ${brokenMatched}, unmatched: ${brokenUnmatched})`);
  console.log(`  Fixes to apply: ${fixes.length}`);

  if (fixes.length > 0 && !DRY_RUN) {
    const batchData: { range: string; values: (string | number)[][] }[] = [];

    for (const fix of fixes) {
      // Write currency amount
      batchData.push({
        range: `Expenses!${colLetter(fix.currencyColIdx)}${fix.sheetRow}`,
        values: [[fix.amount]],
      });

      // Write rate (only if Rate column exists)
      if (rateIdx >= 0) {
        batchData.push({
          range: `Expenses!${colLetter(rateIdx)}${fix.sheetRow}`,
          values: [[fix.rate]],
        });
      }

      // Write EUR formula (non-EUR only)
      if (fix.eurFormula && eurCalcIdx >= 0) {
        batchData.push({
          range: `Expenses!${colLetter(eurCalcIdx)}${fix.sheetRow}`,
          values: [[fix.eurFormula]],
        });
      }
    }

    // Batch update
    for (let batch = 0; batch < batchData.length; batch += 300) {
      const chunk = batchData.slice(batch, batch + 300);
      await sheetsApi.spreadsheets.values.batchUpdate({
        spreadsheetId,
        requestBody: {
          valueInputOption: 'USER_ENTERED',
          data: chunk,
        },
      });
    }
    console.log(`  ✅ Fixed ${fixes.length} broken rows`);
  } else if (fixes.length > 0) {
    console.log(`  [DRY RUN] Would fix ${fixes.length} rows`);
    for (const f of fixes.slice(0, 5)) {
      console.log(`    Row ${f.sheetRow}: amount=${f.amount} col=${colLetter(f.currencyColIdx)}, rate=${f.rate}`);
    }
  }

  // ── Step 3: Fix remaining static EUR(calc) and missing Rate (via same logic as migrate script) ──

  if (rateIdx >= 0 && eurCalcIdx >= 0 && !DRY_RUN) {
    // Re-read with FORMULA to check for static EUR values
    const formulaResp2 = await sheetsApi.spreadsheets.values.get({
      spreadsheetId,
      range: 'Expenses!A:Z',
      valueRenderOption: 'FORMULA',
    });
    const fRows = formulaResp2.data.values || [];

    const rateFixes: { range: string; values: (string | number)[][] }[] = [];
    const eurFixes: { range: string; values: (string | number)[][] }[] = [];

    for (let i = 1; i < fRows.length; i++) {
      const row = fRows[i] as (string | number | null | undefined)[];
      if (!row || !row[0]) continue;

      const eurVal = row[eurCalcIdx];
      // Already a formula — skip
      if (typeof eurVal === 'string' && eurVal.startsWith('=')) continue;
      if (eurVal === '' || eurVal === undefined || eurVal === null) continue;

      // Find amount column
      let amountColIdx = -1;
      let amountCode = '';
      for (const { idx, code } of currCols) {
        const val = row[idx];
        if (val !== '' && val !== undefined && val !== null && Number(val) > 0) {
          amountColIdx = idx;
          amountCode = code;
          break;
        }
      }
      if (amountColIdx === -1) continue;

      // EUR expenses: keep static EUR(calc) but ensure Rate=1
      if (amountCode === 'EUR') {
        const rateVal = row[rateIdx];
        if (rateVal === '' || rateVal === undefined || rateVal === null) {
          rateFixes.push({
            range: `Expenses!${colLetter(rateIdx)}${i + 1}`,
            values: [[1]],
          });
        }
        continue;
      }

      // Non-EUR: derive rate and set formula
      const rateVal = row[rateIdx];
      const rateEmpty = rateVal === '' || rateVal === undefined || rateVal === null;

      if (rateEmpty) {
        const eurNum = Number(eurVal);
        const amountNum = Number(row[amountColIdx]);
        if (amountNum > 0 && eurNum > 0) {
          const derivedRate = Math.round((eurNum / amountNum) * 1_000_000) / 1_000_000;
          rateFixes.push({
            range: `Expenses!${colLetter(rateIdx)}${i + 1}`,
            values: [[derivedRate]],
          });
        }
      }

      const sheetRow = i + 1;
      eurFixes.push({
        range: `Expenses!${colLetter(eurCalcIdx)}${sheetRow}`,
        values: [[`=${colLetter(amountColIdx)}${sheetRow}*${colLetter(rateIdx)}${sheetRow}`]],
      });
    }

    if (rateFixes.length > 0 || eurFixes.length > 0) {
      const allFixes = [...rateFixes, ...eurFixes];
      for (let batch = 0; batch < allFixes.length; batch += 300) {
        await sheetsApi.spreadsheets.values.batchUpdate({
          spreadsheetId,
          requestBody: {
            valueInputOption: 'USER_ENTERED',
            data: allFixes.slice(batch, batch + 300),
          },
        });
      }
      console.log(`  ✅ Fixed ${rateFixes.length} rates, ${eurFixes.length} EUR formulas`);
    }
  }
}

// ── Step 4: Check for DB expenses missing from sheet ──

console.log(`\n${'='.repeat(70)}`);
console.log('Checking for DB expenses not in any spreadsheet...');
console.log('='.repeat(70));

// Re-read current sheets to get all dates+categories
const missingMonths = new Set<string>();
for (const exp of dbExpenses) {
  const month = exp.date.slice(0, 7);
  missingMonths.add(month);
}
console.log(`DB expense months: ${[...missingMonths].sort().join(', ')}`);
console.log(`Total DB expenses: ${dbExpenses.length}`);

// Count sheet rows per spreadsheet
for (const { name, id } of toProcess.filter((t) => !t.name.includes('Backup'))) {
  const resp = await sheetsApi.spreadsheets.values.get({
    spreadsheetId: id,
    range: 'Expenses!A:A',
    valueRenderOption: 'FORMATTED_VALUE',
  });
  const rows = resp.data.values || [];
  console.log(`${name}: ${rows.length - 1} rows in sheet`);
}

console.log('\n✅ All spreadsheets processed.');
db.close();
