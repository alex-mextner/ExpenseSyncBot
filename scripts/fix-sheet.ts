/**
 * Fix specific EUR(calc) values in the Google Sheet.
 *
 * This is a one-shot script used on 2026-03-24 to fix two rows where
 * EUR(calc) was incorrect (likely because amounts were manually edited
 * in the sheet after bot wrote them, but the static EUR(calc) wasn't updated).
 *
 * Fixes applied:
 *   Row 399: 4500 RSD → 127.8 EUR → corrected to ~38.36 EUR
 *   Row 408: 4500 RSD → 136.4 EUR → corrected to ~38.36 EUR
 *   Row 149: test entry "1 RSD → 0 EUR" deleted
 *
 * This script has ALREADY BEEN RUN. Kept for history / reference only.
 * If you need to fix new rows, use audit-sheet.ts to find them first.
 *
 * Usage: bun run scripts/fix-sheet.ts [--group-id N] [--dry-run]
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
const group = db.query('SELECT spreadsheet_id, google_refresh_token FROM groups WHERE id = ?').get(GROUP_ID) as {
  spreadsheet_id: string;
  google_refresh_token: string;
} | null;

if (!group?.spreadsheet_id || !group?.google_refresh_token) {
  console.error(`Group ${GROUP_ID} not found or not configured.`);
  process.exit(1);
}

const SHEET_NAME = 'Expenses';
const auth = getAuthenticatedClient(group.google_refresh_token);
const sheets = google.sheets({ version: 'v4', auth });

// Median rate for RSD, computed by audit-sheet.ts
const RATE_RSD = 0.008524;

// Rows to fix (1-indexed spreadsheet rows)
const fixes = [
  { row: 399, amount: 4500, currency: 'RSD', oldEur: 127.8 },
  { row: 408, amount: 4500, currency: 'RSD', oldEur: 136.4 },
];

for (const fix of fixes) {
  const correctEur = Math.round(fix.amount * RATE_RSD * 100) / 100;
  console.log(`Row ${fix.row}: ${fix.oldEur} → ${correctEur} (${fix.amount} ${fix.currency})`);

  if (!DRY_RUN) {
    // EUR(calc) is column F
    await sheets.spreadsheets.values.update({
      spreadsheetId: group.spreadsheet_id,
      range: `${SHEET_NAME}!F${fix.row}`,
      valueInputOption: 'RAW',
      requestBody: { values: [[correctEur]] },
    });
    console.log('  ✅ Fixed');
  }
}

console.log(DRY_RUN ? '\nDry run complete. Re-run without --dry-run to apply.' : '\nAll fixes applied.');
db.close();
