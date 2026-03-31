// DataSource types: built-in keys, formula refs, and resolver interface
export type BuiltinKey =
  // Top-level
  | 'income'
  | 'expenses'
  | 'balance'
  | 'savings'
  // Per-category (prefix: expenses.)
  | `expenses.${string}`
  // Per-source income (prefix: income.)
  | `income.${string}`;

export interface DataSourceRef {
  type: 'builtin';
  key: BuiltinKey;
}

export interface FormulaDataSourceRef {
  type: 'formula';
  expr: string;
}

export type AnyDataSourceRef = DataSourceRef | FormulaDataSourceRef;

/** Resolved numeric value from a data source */
export interface ResolvedValue {
  value: number;
  currency: string;
}
