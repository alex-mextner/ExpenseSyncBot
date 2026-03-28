// Converts between MonthAbbr (Jan-Dec) and standard date formats

export type MonthAbbr =
  | 'Jan'
  | 'Feb'
  | 'Mar'
  | 'Apr'
  | 'May'
  | 'Jun'
  | 'Jul'
  | 'Aug'
  | 'Sep'
  | 'Oct'
  | 'Nov'
  | 'Dec';

export const MONTH_ABBREVS: MonthAbbr[] = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

export function monthAbbrFromDate(date: Date): MonthAbbr {
  const abbr = MONTH_ABBREVS[date.getMonth()];
  if (!abbr) throw new Error('Invalid month index');
  return abbr;
}

export function monthAbbrFromYYYYMM(yyyyMM: string): MonthAbbr {
  const monthIndex = parseInt(yyyyMM.slice(5, 7), 10) - 1;
  const abbr = MONTH_ABBREVS[monthIndex];
  if (!abbr) throw new Error(`Invalid month in YYYY-MM string: ${yyyyMM}`);
  return abbr;
}

export function prevMonthAbbr(year: number, month: MonthAbbr): { year: number; month: MonthAbbr } {
  const idx = MONTH_ABBREVS.indexOf(month);
  if (idx === 0) return { year: year - 1, month: 'Dec' };
  const prevMonth = MONTH_ABBREVS[idx - 1];
  if (!prevMonth) throw new Error('Invalid month index');
  return { year, month: prevMonth };
}
