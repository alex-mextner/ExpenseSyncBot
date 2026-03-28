/**
 * Interactive test script for the TBC-GE ZenPlugins integration.
 *
 * Prompts for credentials, runs the TBC-GE plugin via the ZenMoneyShim,
 * handles OTP via terminal readline, and prints accounts + transactions.
 * All output is also written to /tmp/tbc-test-<timestamp>.log (full depth, no truncation).
 *
 * Usage: bun run scripts/test-tbc.ts
 */

import { appendFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { inspect } from 'node:util';
import { Database } from 'bun:sqlite';
import { subDays } from 'date-fns';
import { getOtpHint } from '../src/services/bank/otp-hints';
import type { ScrapeResult } from '../src/services/bank/registry';
import { createZenMoneyShim } from '../src/services/bank/runtime';

// ─── Log file setup (full depth, no truncation) ───────────────────────────────

const logFile = `/tmp/tbc-test-${new Date().toISOString().replace(/[:.]/g, '-')}.log`;
appendFileSync(logFile, `=== TBC-GE test log started at ${new Date().toISOString()} ===\n\n`);

function toLogStr(...args: unknown[]): string {
  return args
    .map((a) =>
      a === null || typeof a !== 'object' ? String(a) : inspect(a, { depth: 20, colors: false }),
    )
    .join(' ');
}

const origLog = console.log.bind(console);
const origWarn = console.warn.bind(console);
const origError = console.error.bind(console);

console.log = (...args: unknown[]) => {
  origLog(...args);
  appendFileSync(logFile, toLogStr(...args) + '\n');
};
console.warn = (...args: unknown[]) => {
  origWarn(...args);
  appendFileSync(logFile, '[WARN] ' + toLogStr(...args) + '\n');
};
console.error = (...args: unknown[]) => {
  origError(...args);
  appendFileSync(logFile, '[ERROR] ' + toLogStr(...args) + '\n');
};

// ─── ZenPlugins globals (not in Bun) ─────────────────────────────────────────

(globalThis as { assert?: unknown }).assert = function assert(
  condition: unknown,
  ...args: unknown[]
): asserts condition {
  if (!condition) {
    throw new Error(`Assertion failed: ${args.map((a) => toLogStr(a)).join(' ')}`);
  }
};

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

// ─── Credential collection ────────────────────────────────────────────────────

console.log('\n=== TBC-GE plugin interactive test ===');
console.log(`Log file: ${logFile}\n`);

const login = await ask('Login (username)', process.env['TBC_LOGIN']);
if (!login) {
  console.error('Login is required.');
  process.exit(1);
}

const password = await ask('Password');
if (!password) {
  console.error('Password is required.');
  process.exit(1);
}

const preferences: Record<string, string> = {
  login,
  password,
  startDate: new Date(subDays(new Date(), 30)).toISOString(),
};

console.log(`\nUsing preferences: login=${login}, startDate=${preferences['startDate']}\n`);

// ─── In-memory SQLite (minimal schema for shim plugin state only) ─────────────

const db = new Database(':memory:');
db.exec(`
  CREATE TABLE bank_plugin_state (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    connection_id INTEGER NOT NULL,
    key TEXT NOT NULL,
    value TEXT NOT NULL,
    UNIQUE(connection_id, key)
  )
`);

const CONNECTION_ID = 1;

// ─── OTP readline handler ─────────────────────────────────────────────────────

async function readLineImpl(prompt: string): Promise<string> {
  console.log(`\n[OTP requested] Plugin says: "${prompt}"`);
  const hint = getOtpHint('tbc-ge', prompt);
  if (hint) console.log(`💡 ${hint}`);
  const code = await ask('Enter OTP code');
  if (!code) throw new Error('OTP was not provided — aborting.');
  return code;
}

// ─── Build shim and register as global ZenMoney ───────────────────────────────

const shim = createZenMoneyShim(CONNECTION_ID, db, preferences, readLineImpl);
(globalThis as { ZenMoney?: typeof shim }).ZenMoney = shim;

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
const accounts: unknown[] = [
  ...((rawResult?.accounts as unknown[] | undefined) ?? []),
  ...shim._getCollectedAccounts(),
];

const transactions: unknown[] = [
  ...((rawResult?.transactions as unknown[] | undefined) ?? []),
  ...shim._getCollectedTransactions(),
];

const setResultData = shim._getSetResult() as
  | { accounts?: unknown[]; transactions?: unknown[] }
  | undefined;
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
    const title = (accAny['title'] as string | undefined) ?? (accAny['id'] as string);
    const balance =
      typeof accAny['balance'] === 'number' ? (accAny['balance'] as number).toFixed(2) : '?';
    const currency =
      (accAny['instrument'] as string | undefined) ??
      (accAny['currency'] as string | undefined) ??
      '?';
    console.log(`  ${title}: ${balance} ${currency}`);
  }
}

console.log(`\n=== TRANSACTIONS (${transactions.length} total) ===`);
if (transactions.length === 0) {
  console.log('  (none)');
} else {
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
console.log(`\nFull log: ${logFile}`);
