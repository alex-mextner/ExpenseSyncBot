// Formula evaluator: expr-eval with built-in variable injection
import { Parser } from 'expr-eval';
import type { AnalyticsData } from '../api/analytics';
import { listBuiltinKeys, resolveBuiltin } from './builtin';
import type { BuiltinKey } from './types';

const parser = new Parser();

/**
 * Build variable scope from analytics data.
 * Dots in key names are replaced with _ for expr-eval compatibility:
 * expenses.Еда → expenses_Еда
 */
export function buildScope(data: AnalyticsData): Record<string, number> {
  const scope: Record<string, number> = {};
  for (const key of listBuiltinKeys(data)) {
    const varName = key.replace(/\./g, '_');
    scope[varName] = resolveBuiltin(key as BuiltinKey, data).value;
  }
  return scope;
}

/**
 * Evaluate a formula expression against analytics data.
 * Returns the numeric result or throws on invalid expression.
 */
export function evaluateFormula(expr: string, data: AnalyticsData): number {
  const scope = buildScope(data);
  const result = parser.evaluate(expr, scope);
  if (typeof result !== 'number' || !isFinite(result)) {
    throw new Error(`Formula "${expr}" did not evaluate to a finite number`);
  }
  return result;
}

/**
 * Validate formula without data (check syntax only).
 * Returns null if valid, error message if invalid.
 */
export function validateFormula(expr: string): string | null {
  try {
    parser.parse(expr);
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid formula';
  }
}
