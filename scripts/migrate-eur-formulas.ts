/**
 * Migrate existing EUR(calc) static values to formulas.
 *
 * For each expense row:
 * 1. Find which currency column has a value (amount)
 * 2. Derive the exchange rate: rate = EUR(calc) / amount
 * 3. Write rate to Rate (→EUR) column
 * 4. Replace EUR(calc) with formula =AMOUNT_CELL*RATE_CELL
 *
 * EUR-denominated rows (where EUR column has the value) keep static EUR(calc)
 * since rate=1 and formula would be pointless.
 *
 * Usage: bun run scripts/migrate-eur-formulas.ts [--group-id N] [--dry-run]
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

const SHEET_NAME = 'Expenses';
const RATE_HEADER = 'Rate (→EUR)';
const EUR_CALC_HEADER = 'EUR (calc)';

const db = new Database('./data/expenses.db', { readonly: true });
const group = db.query('SELECT id, google_refresh_token, oauth_client_type FROM groups WHERE id = ?').get(GROUP_ID) as {
  id: number;
  google_refresh_token: string;
  oauth_client_type: string | null;
} | null;

if (!group?.google_refresh_token) {
  console.error(`Group ${GROUP_ID} not found or has no Google refresh token.`);
  process.exit(1);
}

// Get all spreadsheets for this group (one per year)
const spreadsheetRows = db
  .query('SELECT year, spreadsheet_id FROM group_spreadsheets WHERE group_id = ? ORDER BY year')
  .all(group.id) as { year: number; spreadsheet_id: string }[];

if (spreadsheetRows.length === 0) {
  console.error(`Group ${GROUP_ID} has no spreadsheets.`);
  process.exit(1);
}

console.log(`Found ${spreadsheetRows.length} spreadsheet(s): ${spreadsheetRows.map((r) => `${r.year}`).join(', ')}\n`);

const auth = getAuthenticatedClient(group.google_refresh_token, (group.oauth_client_type || 'current') as 'current' | 'legacy');
const sheets = google.sheets({ version: 'v4', auth });

// Process each spreadsheet
for (const { year, spreadsheet_id } of spreadsheetRows) {
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Processing spreadsheet for year ${year}: ${spreadsheet_id}`);
  console.log('='.repeat(60));

// Read all data
const response = await sheets.spreadsheets.values.get({
  spreadsheetId: spreadsheet_id,
  range: `${SHEET_NAME}!A:Z`,
});

const rows = response.data.values || [];
if (rows.length === 0) {
  console.log('Sheet is empty.');
  process.exit(0);
}

const headers = rows[0] as string[];
console.log('Headers:', headers.join(' | '));

// Find column indices
const eurCalcIdx = headers.indexOf(EUR_CALC_HEADER);
let rateIdx = headers.indexOf(RATE_HEADER);

if (eurCalcIdx === -1) {
  console.error('EUR (calc) column not found');
  process.exit(1);
}

// Find currency columns
const currCols: Array<{ idx: number; code: string }> = [];
for (let i = 0; i < headers.length; i++) {
  const header = headers[i] ?? '';
  const m = header.match(/^([A-Z]{3})\s*\(/);
  if (m?.[1] && header !== EUR_CALC_HEADER && header !== RATE_HEADER) {
    currCols.push({ idx: i, code: m[1] });
  }
}

console.log(`Currency columns: ${currCols.map((c) => `${c.code}(col ${colLetter(c.idx)})`).join(', ')}`);
console.log(`EUR (calc): col ${colLetter(eurCalcIdx)}`);
console.log(`Rate: ${rateIdx !== -1 ? `col ${colLetter(rateIdx)}` : 'NOT FOUND — will be created'}`);
console.log(`Data rows: ${rows.length - 1}\n`);

// If Rate column doesn't exist, create it
if (rateIdx === -1 && !DRY_RUN) {
  rateIdx = headers.length;
  const spreadsheet = await sheets.spreadsheets.get({ spreadsheetId: spreadsheet_id });
  const sheet = spreadsheet.data.sheets?.find((s) => s.properties?.title === SHEET_NAME);
  const sheetId = sheet?.properties?.sheetId;

  if (sheetId !== undefined) {
    await sheets.spreadsheets.batchUpdate({
      spreadsheetId: spreadsheet_id,
      requestBody: {
        requests: [{
          updateCells: {
            rows: [{
              values: [{
                userEnteredValue: { stringValue: RATE_HEADER },
                userEnteredFormat: {
                  textFormat: { bold: true },
                  backgroundColor: { red: 0.9, green: 0.9, blue: 0.9 },
                },
              }],
            }],
            fields: 'userEnteredValue,userEnteredFormat',
            start: { sheetId, rowIndex: 0, columnIndex: rateIdx },
          },
        }],
      },
    });
    console.log(`Created Rate column at ${colLetter(rateIdx)}\n`);
  }
} else if (rateIdx === -1 && DRY_RUN) {
  rateIdx = headers.length;
  console.log(`[DRY RUN] Would create Rate column at ${colLetter(rateIdx)}\n`);
}

// Process each row
interface Update {
  row: number; // 1-based
  rateCell: string;
  rateValue: number;
  eurCalcCell: string;
  eurFormula: string;
  description: string;
}

const updates: Update[] = [];
let skippedEur = 0;
let skippedNoAmount = 0;
let skippedHasRate = 0;
let skippedZero = 0;

for (let i = 1; i < rows.length; i++) {
  const row = rows[i] as string[];
  if (!row || !row[0]) continue;

  const rowNum = i + 1; // 1-based spreadsheet row

  // Check if Rate already filled
  if (rateIdx < headers.length) {
    const existingRate = row[rateIdx];
    if (existingRate && existingRate.trim() !== '') {
      skippedHasRate++;
      continue;
    }
  }

  // Find which currency has a value
  let amountColIdx = -1;
  let amount = 0;
  let currency = '';

  for (const { idx, code } of currCols) {
    const val = row[idx];
    if (val && val.trim() !== '') {
      const parsed = parseFloat(val);
      if (!Number.isNaN(parsed) && parsed > 0) {
        amountColIdx = idx;
        amount = parsed;
        currency = code;
        break;
      }
    }
  }

  if (amountColIdx === -1) {
    skippedNoAmount++;
    continue;
  }

  // EUR expenses — keep static (rate=1)
  if (currency === 'EUR') {
    skippedEur++;
    continue;
  }

  // Get current EUR(calc) value
  const eurCalcStr = row[eurCalcIdx];
  if (!eurCalcStr || eurCalcStr.trim() === '') {
    skippedZero++;
    continue;
  }
  const eurCalc = parseFloat(eurCalcStr);
  if (Number.isNaN(eurCalc) || eurCalc === 0) {
    skippedZero++;
    continue;
  }

  // Derive rate from EUR(calc) / amount
  const rate = eurCalc / amount;

  // Sanity check: rate should be reasonable
  if (rate <= 0 || rate > 100) {
    console.log(`  WARN Row ${rowNum}: suspicious rate ${rate.toFixed(6)} (${amount} ${currency} → ${eurCalc} EUR) — skipping`);
    continue;
  }

  const rateCell = `${colLetter(rateIdx)}${rowNum}`;
  const amountCell = `${colLetter(amountColIdx)}${rowNum}`;
  const eurCalcCell = `${colLetter(eurCalcIdx)}${rowNum}`;

  updates.push({
    row: rowNum,
    rateCell,
    rateValue: Math.round(rate * 1_000_000) / 1_000_000, // 6 decimal places
    eurCalcCell,
    eurFormula: `=${amountCell}*${rateCell}`,
    description: `${amount} ${currency} × ${rate.toFixed(6)} = ${eurCalc} EUR`,
  });
}

console.log(`=== MIGRATION PLAN ===`);
console.log(`Rows to update: ${updates.length}`);
console.log(`Skipped (EUR currency): ${skippedEur}`);
console.log(`Skipped (already has Rate): ${skippedHasRate}`);
console.log(`Skipped (no amount): ${skippedNoAmount}`);
console.log(`Skipped (zero EUR): ${skippedZero}`);
console.log('');

// Show first 10 updates as preview
for (const u of updates.slice(0, 10)) {
  console.log(`  Row ${u.row}: ${u.description} → Rate=${u.rateValue}, Formula=${u.eurFormula}`);
}
if (updates.length > 10) {
  console.log(`  ... and ${updates.length - 10} more`);
}
console.log('');

if (updates.length === 0) {
  console.log('Nothing to migrate for this spreadsheet.');
  continue;
}

if (DRY_RUN) {
  console.log('Dry run — skipping writes for this spreadsheet.');
  continue;
}

// Apply updates in batches (Google API allows batch value updates)
// Write Rate values first, then EUR formulas
const BATCH_SIZE = 100;

for (let batch = 0; batch < updates.length; batch += BATCH_SIZE) {
  const chunk = updates.slice(batch, batch + BATCH_SIZE);

  // Batch 1: write Rate values
  const rateData = chunk.map((u) => ({
    range: `${SHEET_NAME}!${u.rateCell}`,
    values: [[u.rateValue]],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheet_id,
    requestBody: {
      valueInputOption: 'RAW',
      data: rateData,
    },
  });

  // Batch 2: write EUR(calc) formulas
  const formulaData = chunk.map((u) => ({
    range: `${SHEET_NAME}!${u.eurCalcCell}`,
    values: [[u.eurFormula]],
  }));

  await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId: spreadsheet_id,
    requestBody: {
      valueInputOption: 'USER_ENTERED', // formulas need USER_ENTERED
      data: formulaData,
    },
  });

  console.log(`  Batch ${Math.floor(batch / BATCH_SIZE) + 1}: updated rows ${chunk[0]?.row}–${chunk[chunk.length - 1]?.row}`);
}

console.log(`\n✅ Year ${year}: ${updates.length} rows updated with Rate + EUR formula.`);
} // end for (spreadsheetRows)

console.log('\n✅ All spreadsheets processed.');
db.close();

function colLetter(index: number): string {
  let letter = '';
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode(65 + (n % 26)) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}
