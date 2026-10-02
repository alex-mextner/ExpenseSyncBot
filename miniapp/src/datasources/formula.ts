// Numeric dashboard formulas with safe analytics substitution.
import { Parser } from 'expr-eval-fork';
import type { AnalyticsData } from '../api/analytics';
import { listBuiltinKeys, resolveBuiltin } from './builtin';
import type { BuiltinKey } from './types';

const parser = new Parser({
  allowMemberAccess: false,
  operators: { assignment: false, fndef: false },
});

/**
 * Build variable scope from analytics data.
 * Dots in key names are replaced with _ for formula identifier compatibility:
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
  const scope = new Map(Object.entries(buildScope(data)));
  let expression = parser.parse(normalizeBuiltinReference(expr, data));
  for (const variable of expression.variables()) {
    if (!scope.has(variable)) continue;
    const value = scope.get(variable);
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      throw new Error(`Formula variable "${variable}" must be a finite number`);
    }
    // Substitute numbers, never aliases or objects; category names stay inert.
    expression = expression.substitute(variable, value);
  }
  const result: unknown = expression.evaluate();
  if (typeof result !== 'number' || !Number.isFinite(result)) {
    throw new Error(`Formula "${expr}" did not evaluate to a finite number`);
  }
  return result;
}

/**
 * Validate formula without data (check syntax only).
 * Returns null if valid, error message if invalid.
 */
export function validateFormula(
  expr: string,
  data?: AnalyticsData,
): string | null {
  try {
    parser.parse(normalizeBuiltinReference(expr, data));
    return null;
  } catch (err) {
    return err instanceof Error ? err.message : 'Invalid formula';
  }
}

/** Only known builtin references use dots; arbitrary member access stays disabled. */
function normalizeBuiltinReference(expr: string, data?: AnalyticsData): string {
  return data && listBuiltinKeys(data).some((key) => key === expr)
    ? expr.replace(/\./g, '_')
    : expr;
}
