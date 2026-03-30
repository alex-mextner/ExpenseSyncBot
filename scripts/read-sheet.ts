/**
 * Dump raw Google Sheet data for a group.
 *
 * Prints all rows from the Expenses sheet as JSON lines.
 * Useful for ad-hoc debugging when the bot writes something unexpected.
 *
 * Usage: bun run scripts/read-sheet.ts [--group-id N] [--from ROW] [--to ROW]
 *
 * Options:
 *   --group-id N   DB group ID (default: 1)
 *   --from N       First data row to show, 1-based (default: 1 = first expense)
 *   --to N         Last data row to show (default: all)
 */

import { google } from 'googleapis';
import { getAuthenticatedClient } from '../src/services/google/oauth';
import { Database } from 'bun:sqlite';

const args = process.argv.slice(2);
function getArg(name: string, fallback: string): string {
  const idx = args.indexOf(name);
  return idx !== -1 && idx + 1 < args.length ? (args[idx + 1] ?? fallback) : fallback;
}
const GROUP_ID = Number(getArg('--group-id', '1'));
const FROM = Number(getArg('--from', '1'));
const TO = Number(getArg('--to', '0')); // 0 = all

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
console.log(`Total rows: ${rows.length} (1 header + ${rows.length - 1} data)`);

if (rows.length > 0) {
  console.log(`HEADERS: ${JSON.stringify(rows[0])}\n`);
}

const start = FROM; // 1-based data row = index in rows array (header is 0)
const end = TO > 0 ? Math.min(TO, rows.length - 1) : rows.length - 1;

for (let i = start; i <= end; i++) {
  console.log(`Row ${i}: ${JSON.stringify(rows[i])}`);
}

db.close();
