// Resolves BuiltinKey to value from /api/analytics response
import type { AnalyticsData } from '../api/analytics';
import type { BuiltinKey, ResolvedValue } from './types';

export function resolveBuiltin(key: BuiltinKey, data: AnalyticsData): ResolvedValue {
  const currency = data.defaultCurrency;

  if (key === 'income') return { value: data.income, currency };
  if (key === 'expenses') return { value: data.expenses, currency };
  if (key === 'balance') return { value: data.balance, currency };
  if (key === 'savings') return { value: data.savings, currency };

  if (key.startsWith('expenses.')) {
    const category = key.slice('expenses.'.length);
    return { value: data.byCategory[category] ?? 0, currency };
  }

  if (key.startsWith('income.')) {
    // Income by source not yet in analytics; return 0
    return { value: 0, currency };
  }

  return { value: 0, currency };
}

export function listBuiltinKeys(data: AnalyticsData): BuiltinKey[] {
  const keys: BuiltinKey[] = ['income', 'expenses', 'balance', 'savings'];
  for (const cat of Object.keys(data.byCategory)) {
    keys.push(`expenses.${cat}` as BuiltinKey);
  }
  return keys;
}
