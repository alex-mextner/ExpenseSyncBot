// One-time recovery: copy 2026 expense rows from the prior-year spreadsheet
// to the current-year spreadsheet, then optionally delete them from the old one.
//
// Run after a yearFromDateCell bug left the new spreadsheet with an empty Expenses tab.
// Usage: bun run scripts/recover-expenses-migration.ts [--group-id N] [--dry-run] [--no-delete]

import { Database } from 'bun:sqlite';
import { type GoogleConn, appendExpenseRowsRaw, deleteExpenseRowsByIndex, readExpenseRowsRaw } from '../src/services/google/sheets';
import { yearFromDateCell } from '../src/services/google/budget-migration';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const NO_DELETE = args.includes('--no-delete');
const GROUP_ID = (() => {
  const idx = args.indexOf('--group-id');
  return idx !== -1 && idx + 1 < args.length ? Number(args[idx + 1]) : 1;
})();
const SPLIT_YEAR = new Date().getFullYear();

if (DRY_RUN) console.log('*** DRY RUN — no changes will be made ***\n');
if (NO_DELETE) console.log('*** --no-delete: old rows will NOT be removed from source spreadsheet ***\n');

const db = new Database('./data/expenses.db', { readonly: true });

const group = db
  .query<
    { id: number; google_refresh_token: string; oauth_client: string },
    [number]
  >('SELECT id, google_refresh_token, oauth_client FROM groups WHERE id = ?')
  .get(GROUP_ID);

if (!group?.google_refresh_token) {
  console.error(`Group ${GROUP_ID} not found or has no refresh token.`);
  process.exit(1);
}

const conn: GoogleConn = {
  refreshToken: group.google_refresh_token,
  oauthClient: group.oauth_client as GoogleConn['oauthClient'],
};

// Find both spreadsheets
type SpreadsheetRow = { year: number; spreadsheet_id: string };
const spreadsheets = db
  .query<SpreadsheetRow, [number]>(
    'SELECT year, spreadsheet_id FROM group_spreadsheets WHERE group_id = ? ORDER BY year DESC',
  )
  .all(GROUP_ID);

const newSheet = spreadsheets.find((s) => s.year === SPLIT_YEAR);
const oldSheet = spreadsheets.find((s) => s.year < SPLIT_YEAR);

if (!newSheet) {
  console.error(`No ${SPLIT_YEAR} spreadsheet found for group ${GROUP_ID} in group_spreadsheets.`);
  process.exit(1);
}
if (!oldSheet) {
  console.error(`No prior-year spreadsheet found for group ${GROUP_ID} in group_spreadsheets.`);
  process.exit(1);
}

console.log(`Source (${oldSheet.year}): ${oldSheet.spreadsheet_id}`);
console.log(`Target (${newSheet.year}): ${newSheet.spreadsheet_id}`);

// Read all rows from the old spreadsheet
console.log('\nReading expense rows from source spreadsheet...');
const allRows = await readExpenseRowsRaw(conn, oldSheet.spreadsheet_id);
console.log(`Total rows in source: ${allRows.length}`);

// Filter rows matching the split year
const splitYearRows = allRows
  .map((row, idx) => ({ row, sheetRowIdx: idx + 2 })) // +2: 1-based index + skip header
  .filter(({ row }) => yearFromDateCell(row[0] ?? '') === SPLIT_YEAR);

if (splitYearRows.length === 0) {
  console.log(`\nNo ${SPLIT_YEAR} rows found in source spreadsheet. Nothing to recover.`);
  console.log('Possible reasons:');
  console.log('  - Rows were already copied and deleted in a previous migration run');
  console.log('  - Source spreadsheet has no expenses for this year');
  process.exit(0);
}

console.log(`\nFound ${splitYearRows.length} rows for year ${SPLIT_YEAR}:`);
for (const { row, sheetRowIdx } of splitYearRows.slice(0, 5)) {
  console.log(`  Row ${sheetRowIdx}: ${row[0]} | ${row[1]} | ${row[2]} | ...`);
}
if (splitYearRows.length > 5) {
  console.log(`  ... and ${splitYearRows.length - 5} more`);
}

// Also check how many rows are already in the target
const existingRows = await readExpenseRowsRaw(conn, newSheet.spreadsheet_id);
console.log(`\nTarget spreadsheet currently has ${existingRows.length} expense rows.`);

if (existingRows.length > 0) {
  console.log('⚠️  Target already has rows — will append without deduplication.');
  console.log('   If rows were already partially copied, abort and fix manually.');
}

if (!DRY_RUN) {
  console.log('\nCopying rows to target...');
  await appendExpenseRowsRaw(
    conn,
    newSheet.spreadsheet_id,
    splitYearRows.map(({ row }) => row),
  );
  console.log(`✅ Copied ${splitYearRows.length} rows to target spreadsheet.`);

  if (!NO_DELETE) {
    console.log('Deleting copied rows from source...');
    await deleteExpenseRowsByIndex(
      conn,
      oldSheet.spreadsheet_id,
      splitYearRows.map(({ sheetRowIdx }) => sheetRowIdx),
    );
    console.log(`✅ Deleted ${splitYearRows.length} rows from source spreadsheet.`);
  }
} else {
  console.log(`\nDry run: would copy ${splitYearRows.length} rows to target.`);
  if (!NO_DELETE) {
    console.log(`Dry run: would delete ${splitYearRows.length} rows from source.`);
  }
}

console.log('\nDone.');
db.close();
