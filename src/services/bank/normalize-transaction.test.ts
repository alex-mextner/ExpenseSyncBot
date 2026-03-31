// Tests for normalizePluginsTransaction — ZenPlugins Transaction → ZenTransaction conversion.

// Import after mocking dependencies sync-service needs at module load.
// sync-service imports database, env, cron — mock them all to prevent startup side-effects.
import { describe, expect, mock, test } from 'bun:test';
import type { ZenTransaction } from './registry';
import type { Transaction as ZenPluginsTransaction } from './zenmoney-types';
import { AccountType } from './zenmoney-types';

const ACCOUNT_TYPE_CASH = AccountType.cash;

mock.module('../../database', () => ({ database: {} }));
mock.module('../../config/env', () => ({
  env: {
    BOT_TOKEN: 'test',
    LARGE_TX_THRESHOLD_EUR: 500,
    NODE_ENV: 'test',
  },
}));
mock.module('node-cron', () => ({ default: { schedule: () => {} } }));
mock.module('./prefill', () => ({ preFillTransaction: async () => ({}) }));
mock.module('./telegram-sender', () => ({
  sendMessage: async () => null,
  editMessageText: async () => null,
}));

import { normalizePluginsTransaction } from './sync-service';

const accountCurrencyMap = new Map([
  ['acc-gel', 'GEL'],
  ['acc-usd', 'USD'],
]);

const baseDate = new Date('2026-03-05T20:00:00.000Z');

function makePluginsTx(overrides: Partial<ZenPluginsTransaction> = {}): ZenPluginsTransaction {
  return {
    hold: false,
    date: baseDate,
    movements: [
      {
        id: 'mov-001',
        account: { id: 'acc-gel' },
        sum: -25.5,
        fee: 0,
        invoice: null,
      },
    ],
    merchant: null,
    comment: null,
    ...overrides,
  };
}

describe('normalizePluginsTransaction', () => {
  test('pass-through: already-flat ZenTransaction returned unchanged', () => {
    const flat: ZenTransaction = {
      id: 'tx-1',
      sum: -10,
      currency: 'USD',
      date: '2026-03-05',
    };
    expect(normalizePluginsTransaction(flat, accountCurrencyMap)).toBe(flat);
  });

  test('AccountReferenceById: resolves currency from accountCurrencyMap', () => {
    const result = normalizePluginsTransaction(makePluginsTx(), accountCurrencyMap);
    expect(result).not.toBeNull();
    expect(result?.currency).toBe('GEL');
    expect(result?.sum).toBe(-25.5);
    expect(result?.id).toBe('mov-001');
  });

  test('AccountReferenceByData: reads currency from instrument directly', () => {
    const tx = makePluginsTx({
      movements: [
        {
          id: 'mov-002',
          account: {
            type: ACCOUNT_TYPE_CASH,
            instrument: 'EUR',
            company: null,
            syncIds: null,
          },
          sum: 100,
          fee: 0,
          invoice: null,
        },
      ],
    });
    const result = normalizePluginsTransaction(tx, accountCurrencyMap);
    expect(result?.currency).toBe('EUR');
  });

  test('sum === null: returns null', () => {
    const tx = makePluginsTx({
      movements: [
        {
          id: 'mov-003',
          account: { id: 'acc-gel' },
          sum: null,
          fee: 0,
          invoice: null,
        },
      ],
    });
    expect(normalizePluginsTransaction(tx, accountCurrencyMap)).toBeNull();
  });

  test('missing currency (account not in map): returns null', () => {
    const tx = makePluginsTx({
      movements: [
        {
          id: 'mov-004',
          account: { id: 'acc-unknown' },
          sum: -5,
          fee: 0,
          invoice: null,
        },
      ],
    });
    expect(normalizePluginsTransaction(tx, accountCurrencyMap)).toBeNull();
  });

  test('movement.id === null: generates deterministic synthetic ID', () => {
    const tx = makePluginsTx({
      movements: [
        {
          id: null,
          account: { id: 'acc-gel' },
          sum: -50,
          fee: 0,
          invoice: null,
        },
      ],
    });
    const result = normalizePluginsTransaction(tx, accountCurrencyMap);
    expect(result).not.toBeNull();
    expect(result?.id).toBeTruthy();
    // Deterministic: same input → same ID
    const result2 = normalizePluginsTransaction(tx, accountCurrencyMap);
    expect(result2?.id).toBe(result?.id);
  });

  test('date as Date object: converts to ISO string', () => {
    const result = normalizePluginsTransaction(makePluginsTx(), accountCurrencyMap);
    expect(result?.date).toBe('2026-03-05T20:00:00.000Z');
  });

  test('Merchant with title: sets merchant and mcc', () => {
    const tx = makePluginsTx({
      merchant: {
        title: 'Wolt',
        mcc: 5812,
        country: 'GE',
        city: null,
        location: null,
      },
    });
    const result = normalizePluginsTransaction(tx, accountCurrencyMap);
    expect(result?.merchant).toBe('Wolt');
    expect(result?.mcc).toBe(5812);
  });

  test('NonParsedMerchant with fullTitle: sets merchant', () => {
    const tx = makePluginsTx({
      merchant: {
        fullTitle: 'SOME MERCHANT',
        mcc: null,
        location: null,
      },
    });
    const result = normalizePluginsTransaction(tx, accountCurrencyMap);
    expect(result?.merchant).toBe('SOME MERCHANT');
    expect(result?.mcc).toBeUndefined();
  });

  test('comment set when present', () => {
    const result = normalizePluginsTransaction(
      makePluginsTx({ comment: 'transfer note' }),
      accountCurrencyMap,
    );
    expect(result?.comment).toBe('transfer note');
  });

  test('invoice null: no invoice fields on result', () => {
    const result = normalizePluginsTransaction(makePluginsTx(), accountCurrencyMap);
    expect(result?.invoice_sum).toBeUndefined();
    expect(result?.invoice_currency).toBeUndefined();
  });

  test('invoice present: populates invoice_sum and invoice_currency', () => {
    const tx = makePluginsTx({
      movements: [
        {
          id: 'mov-usd',
          account: { id: 'acc-usd' },
          sum: -68.3,
          fee: 0,
          invoice: { sum: -6703.4, instrument: 'RSD' },
        },
      ],
    });
    const result = normalizePluginsTransaction(tx, accountCurrencyMap);
    expect(result).not.toBeNull();
    // account currency still reflects the card account
    expect(result?.currency).toBe('USD');
    expect(result?.sum).toBe(-68.3);
    // invoice fields carry the operation currency
    expect(result?.invoice_sum).toBe(6703.4);
    expect(result?.invoice_currency).toBe('RSD');
  });

  test('invoice same currency as account: invoice fields omitted', () => {
    const tx = makePluginsTx({
      movements: [
        {
          id: 'mov-same',
          account: { id: 'acc-gel' },
          sum: -25.5,
          fee: 0,
          invoice: { sum: -25.5, instrument: 'GEL' },
        },
      ],
    });
    const result = normalizePluginsTransaction(tx, accountCurrencyMap);
    expect(result?.invoice_sum).toBeUndefined();
    expect(result?.invoice_currency).toBeUndefined();
  });

  test('empty movements array: returns null', () => {
    const tx = {
      hold: false,
      date: baseDate,
      movements: [] as unknown as ZenPluginsTransaction['movements'],
      merchant: null,
      comment: null,
    };
    expect(normalizePluginsTransaction(tx, accountCurrencyMap)).toBeNull();
  });
});
