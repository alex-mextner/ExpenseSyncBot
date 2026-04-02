/**
 * Period date resolution and array param normalization for AI tools.
 */
import { endOfMonth, format, startOfMonth, subMonths } from 'date-fns';

export interface DateRange {
  startDate: string;
  endDate: string;
}

/**
 * Resolve a period string to start/end dates.
 * Supports: "current_month", "last_month", "last_3_months", "last_6_months", "all", "YYYY-MM"
 */
export function resolvePeriodDates(period: string): DateRange {
  const now = new Date();

  switch (period) {
    case 'current_month':
      return {
        startDate: format(startOfMonth(now), 'yyyy-MM-dd'),
        endDate: format(endOfMonth(now), 'yyyy-MM-dd'),
      };
    case 'last_month': {
      const lastMonth = subMonths(now, 1);
      return {
        startDate: format(startOfMonth(lastMonth), 'yyyy-MM-dd'),
        endDate: format(endOfMonth(lastMonth), 'yyyy-MM-dd'),
      };
    }
    case 'last_3_months':
      return {
        startDate: format(startOfMonth(subMonths(now, 2)), 'yyyy-MM-dd'),
        endDate: format(endOfMonth(now), 'yyyy-MM-dd'),
      };
    case 'last_6_months':
      return {
        startDate: format(startOfMonth(subMonths(now, 5)), 'yyyy-MM-dd'),
        endDate: format(endOfMonth(now), 'yyyy-MM-dd'),
      };
    case 'all':
      return { startDate: '2000-01-01', endDate: format(endOfMonth(now), 'yyyy-MM-dd') };
    default:
      if (/^\d{4}-\d{2}$/.test(period)) {
        const monthDate = new Date(`${period}-01`);
        return {
          startDate: `${period}-01`,
          endDate: format(endOfMonth(monthDate), 'yyyy-MM-dd'),
        };
      }
      // Fallback to current month
      return {
        startDate: format(startOfMonth(now), 'yyyy-MM-dd'),
        endDate: format(endOfMonth(now), 'yyyy-MM-dd'),
      };
  }
}

/**
 * Normalize a tool input parameter to a string array.
 * Accepts string, string[], or undefined (with optional default).
 */
export function normalizeArrayParam(value: unknown, defaultValue?: string): string[] {
  if (Array.isArray(value) && value.length > 0) return value.map(String);
  if (typeof value === 'string') return [value];
  if (defaultValue !== undefined) return [defaultValue];
  return [];
}
