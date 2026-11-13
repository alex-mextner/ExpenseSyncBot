/** Display totals preserve native amounts for new currencies and stored EUR for foreign expenses. */
import Big from 'big.js';
import { BASE_CURRENCY, type CurrencyCode, getCurrencyPrecision } from '../../config/constants';
import type { Expense } from '../../database/types';
import { convertCurrency } from './converter';

type ExpenseAmounts = Pick<Expense, 'amount' | 'currency' | 'eur_amount'>;

/** New currencies preserve native amounts; older currencies retain their existing EUR-based reports. */
export function usesOriginalCurrencyAmounts(currency: CurrencyCode): boolean {
  return ['GEL', 'OMR', 'THB', 'MYR', 'KHR', 'TRY'].includes(currency);
}

/** Individual display values for statistics such as minimum, maximum and median. */
export function expenseAmountInCurrency(
  expense: ExpenseAmounts,
  displayCurrency: CurrencyCode,
): number {
  if (usesOriginalCurrencyAmounts(displayCurrency) && expense.currency === displayCurrency)
    return expense.amount;
  return convertCurrency(expense.eur_amount, BASE_CURRENCY, displayCurrency);
}

/** Convert only the foreign EUR subtotal; never reconstruct native travel-currency amounts from rounded EUR cents. */
export function sumExpensesInCurrency(
  expenses: readonly ExpenseAmounts[],
  displayCurrency: CurrencyCode,
): number {
  if (!usesOriginalCurrencyAmounts(displayCurrency)) {
    const totalEur = expenses.reduce((total, expense) => total + expense.eur_amount, 0);
    return convertCurrency(totalEur, BASE_CURRENCY, displayCurrency);
  }

  let nativeAmount = new Big(0);
  let foreignEur = new Big(0);
  for (const expense of expenses) {
    if (expense.currency === displayCurrency) nativeAmount = nativeAmount.plus(expense.amount);
    else foreignEur = foreignEur.plus(expense.eur_amount);
  }
  const foreignAmount = foreignEur.eq(0)
    ? 0
    : convertCurrency(foreignEur.toNumber(), BASE_CURRENCY, displayCurrency);
  return nativeAmount.plus(foreignAmount).round(getCurrencyPrecision(displayCurrency)).toNumber();
}
