// Shared mock for the database singleton — use with mock.module()
import { mock } from 'bun:test';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('mock-database');

type MockFn = ReturnType<typeof mock>;

interface MockRepo {
  [method: string]: MockFn;
}

/**
 * Create a mock database object with configurable repository stubs.
 * Default: every method is a no-op mock.
 * Override specific repos/methods via the `overrides` parameter.
 *
 * Usage:
 *   mock.module('../../database', () => ({ database: mockDatabase() }));
 *   mock.module('../../database', () => ({ database: mockDatabase({ expenses: { findByGroupId: mock(() => [...]) } }) }));
 */
export function mockDatabase(
  overrides: Record<string, Partial<MockRepo>> = {},
): Record<string, MockRepo> {
  const repoNames = [
    'groups',
    'users',
    'expenses',
    'categories',
    'pendingExpenses',
    'budgets',
    'chatMessages',
    'adviceLog',
    'bankConnections',
    'bankCredentials',
    'bankAccounts',
    'bankTransactions',
    'expenseItems',
    'receiptItems',
    'merchantRules',
    'photoQueue',
    'devTasks',
    'groupSpreadsheets',
    'syncSnapshots',
    'adviceLogs',
    'recurringPatterns',
  ] as const;

  const db: Record<string, MockRepo> = {};
  for (const name of repoNames) {
    const explicitOverrides = overrides[name] ?? {};
    // The Proxy get-trap guarantees every access returns a MockFn.
    // TypeScript cannot prove this because the target is Partial<MockRepo> —
    // cast is unavoidable here.
    db[name] = new Proxy(explicitOverrides, {
      get(target, prop) {
        if (typeof prop === 'symbol') return undefined;
        if (prop in target) return target[prop];
        if (process.env['DEBUG_MOCKS']) {
          logger.warn(
            `[mockDatabase] auto-stubbed ${name}.${prop}() — add explicit override if intentional`,
          );
        }
        const fn = mock(() => undefined);
        target[prop] = fn;
        return fn;
      },
    }) as unknown as MockRepo;
  }

  // _budgetWriter mirrors budgets — BudgetManager uses _budgetWriter() function
  const budgets = db['budgets'];
  if (!db['_budgetWriter'] && budgets) {
    db['_budgetWriter'] = budgets;
  }

  return db;
}
