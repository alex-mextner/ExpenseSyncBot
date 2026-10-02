// Russian month names for user-facing text (Intl/ICU locale data is not guaranteed in the runtime)

const MONTHS_RU = [
  'январь',
  'февраль',
  'март',
  'апрель',
  'май',
  'июнь',
  'июль',
  'август',
  'сентябрь',
  'октябрь',
  'ноябрь',
  'декабрь',
] as const;

/** "октябрь 2026" — nominative month name plus year. */
export function formatMonthYearRu(date: Date): string {
  return `${MONTHS_RU[date.getMonth()]} ${date.getFullYear()}`;
}
