/**
 * Interactive test script for the TBC-GE ZenPlugins integration.
 *
 * Prompts for credentials, runs the TBC-GE plugin via the ZenMoneyShim,
 * handles OTP via terminal readline, and prints accounts + transactions.
 *
 * Usage: bun run scripts/test-tbc.ts
 */

import { createInterface } from 'node:readline';
import { Database } from 'bun:sqlite';
import { subDays } from 'date-fns';
import { runMigrations } from '../src/database/schema';
import { createZenMoneyShim } from '../src/services/bank/runtime';
import type { ScrapeResult } from '../src/services/bank/registry';

// ─── Interactive prompt helpers ───────────────────────────────────────────────

const rl = createInterface({ input: process.stdin, output: process.stdout });

function ask(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const hint = defaultValue ? ` [${defaultValue}]` : '';
    rl.question(`${question}${hint}: `, (answer) => {
      resolve(answer.trim() || defaultValue || '');
    });
  });
}

async function askPassword(question: string): Promise<string> {
  // Bun/Node doesn't have built-in password masking; just use a plain prompt.
  return ask(question);
}

// ─── Credential collection ────────────────────────────────────────────────────

console.log('\n=== TBC-GE plugin interactive test ===\n');

const login = await ask('Login (username)', process.env['TBC_LOGIN']);
if (!login) {
  console.error('Login is required.');
  process.exit(1);
}

const password = await askPassword('Password');
if (!password) {
  console.error('Password is required.');
  process.exit(1);
}

const preferences: Record<string, string> = {
  login,
  password,
  // startDate is a date-type preference — auto-filled by registry, provide sensible default here
  startDate: new Date(subDays(new Date(), 30)).toISOString(),
};

console.log(`\nUsing preferences: login=${login}, startDate=${preferences['startDate']}\n`);

// ─── In-memory SQLite (for shim plugin state storage) ─────────────────────────

const db = new Database(':memory:');
db.exec('PRAGMA foreign_keys = ON;');
runMigrations(db);

// Create a fake group and bank connection so the DB schema constraints are met.
db.exec(`
  INSERT INTO groups (telegram_group_id, default_currency) VALUES (999999, 'GEL');
`);
const groupRow = db.query('SELECT id FROM groups WHERE telegram_group_id = 999999').get() as {
  id: number;
};

db.exec(`
  INSERT INTO bank_connections (group_id, bank_name, display_name, status)
  VALUES (${groupRow.id}, 'tbc-ge', 'TBC GE test', 'active');
`);
const connRow = db
  .query('SELECT id FROM bank_connections WHERE bank_name = ?')
  .get('tbc-ge') as { id: number };

const CONNECTION_ID = connRow.id;

// ─── OTP readline handler ─────────────────────────────────────────────────────

async function readLineImpl(prompt: string): Promise<string> {
  console.log(`\n[OTP requested] Plugin says: "${prompt}"`);
  const code = await ask('Enter OTP code');
  if (!code) throw new Error('OTP was not provided — aborting.');
  return code;
}

// ─── Build shim and register as global ZenMoney ───────────────────────────────

const shim = createZenMoneyShim(CONNECTION_ID, db, preferences, readLineImpl);

// Extend the shim with extra ZenMoney API surface that the TBC-GE plugin calls
// but that createZenMoneyShim does not provide (these are harmless stubs).
const zenMoneyGlobal = Object.assign(shim, {
  // Plugins call ZenMoney.isAccountSkipped(id) to check user exclusion lists.
  // In a standalone test there are no excluded accounts.
  isAccountSkipped: (_id: string) => false,

  // Some plugins set ZenMoney.locale as a property.
  locale: 'en',

  // No-arg ZenMoney.saveData() — flushes all pending state.
  // createZenMoneyShim implements saveData(key, value) but TBC also calls it with no args.
  // Wrap to handle both signatures transparently.
  saveData: (key?: string, value?: unknown) => {
    if (key !== undefined) {
      shim.saveData(key, value);
    }
    // No-arg variant: nothing to flush (shim writes synchronously already).
  },
});

(globalThis as { ZenMoney?: typeof zenMoneyGlobal }).ZenMoney = zenMoneyGlobal;

// ─── Load and run the plugin ───────────────────────────────────────────────────

console.log('Loading TBC-GE plugin…');

const pluginPath = new URL(
  '../src/services/bank/ZenPlugins/src/plugins/tbc-ge/index.ts',
  import.meta.url,
).pathname;

// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const { scrape } = (await import(/* @vite-ignore */ pluginPath)) as {
  scrape: (args: {
    preferences: Record<string, string>;
    fromDate: Date;
    toDate: Date;
    isInBackground: boolean;
  }) => Promise<ScrapeResult>;
};

const fromDate = subDays(new Date(), 30);
const toDate = new Date();

console.log(`\nRunning scrape from ${fromDate.toISOString()} to ${toDate.toISOString()}…\n`);

let rawResult: Partial<ScrapeResult> | undefined;
try {
  rawResult = await scrape({ preferences, fromDate, toDate, isInBackground: false });
} finally {
  delete (globalThis as { ZenMoney?: unknown }).ZenMoney;
  rl.close();
  db.close();
}

// Collect from both scrape() return value and shim addAccount/addTransaction calls.
// The plugin returns ZenPlugins-internal types (with `instrument`, `movements`, etc.)
// which are wider than our registry ZenAccount/ZenTransaction — use unknown[] for printing.
const accounts: unknown[] = [
  ...((rawResult?.accounts as unknown[] | undefined) ?? []),
  ...shim._getCollectedAccounts(),
];

const transactions: unknown[] = [
  ...((rawResult?.transactions as unknown[] | undefined) ?? []),
  ...shim._getCollectedTransactions(),
];

const setResultData = shim._getSetResult() as { accounts?: unknown[]; transactions?: unknown[] } | undefined;
if (setResultData) {
  accounts.push(...(setResultData.accounts ?? []));
  transactions.push(...(setResultData.transactions ?? []));
}

// ─── Print results ─────────────────────────────────────────────────────────────

console.log('\n=== ACCOUNTS ===');
if (accounts.length === 0) {
  console.log('  (none)');
} else {
  for (const acc of accounts) {
    const accAny = acc as { [k: string]: unknown };
    // ZenPlugins use `instrument` for currency and `syncID` for ID internally.
    const title = (accAny['title'] as string | undefined) ?? (accAny['id'] as string);
    const balance =
      typeof accAny['balance'] === 'number' ? (accAny['balance'] as number).toFixed(2) : '?';
    const currency =
      (accAny['instrument'] as string | undefined) ?? (accAny['currency'] as string | undefined) ?? '?';
    console.log(`  ${title}: ${balance} ${currency}`);
  }
}

console.log(`\n=== TRANSACTIONS (${transactions.length} total) ===`);
if (transactions.length === 0) {
  console.log('  (none)');
} else {
  // Print up to 20 most-recent transactions.
  const SAMPLE_SIZE = 20;
  const sample = transactions.slice(-SAMPLE_SIZE);
  for (const tx of sample) {
    const txAny = tx as { [k: string]: unknown };
    const movements = txAny['movements'] as Array<Record<string, unknown>> | undefined;
    const firstMovement = movements?.[0];
    const sum =
      typeof firstMovement?.['sum'] === 'number'
        ? (firstMovement['sum'] as number).toFixed(2)
        : typeof txAny['sum'] === 'number'
          ? (txAny['sum'] as number).toFixed(2)
          : '?';
    const currency =
      (firstMovement?.['instrument'] as string | undefined) ??
      (txAny['currency'] as string | undefined) ??
      '?';
    const date =
      (txAny['date'] as string | undefined) ??
      (movements?.[0]?.['date'] as string | undefined) ??
      '?';
    const merchant = txAny['merchant'] as Record<string, unknown> | undefined;
    const label =
      (merchant?.['title'] as string | undefined) ??
      (txAny['comment'] as string | undefined) ??
      (txAny['id'] as string | undefined) ??
      '-';
    console.log(`  ${date}  ${sum} ${currency}  ${label}`);
  }
  if (transactions.length > SAMPLE_SIZE) {
    console.log(`  … and ${transactions.length - SAMPLE_SIZE} more`);
  }
}

console.log('\nDone.');
