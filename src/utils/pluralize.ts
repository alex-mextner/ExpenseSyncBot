// Russian numeral declension — picks the correct noun form for a given count.

/**
 * Returns the correct Russian noun form for a given number.
 * Rules: 1 → one, 2-4 → few, 5-20 → many, 21 → one again, etc.
 * Special case: 11-19 always → many (одиннадцать карточек, не карточка).
 */
export function pluralize(n: number, one: string, few: string, many: string): string {
  const abs = Math.abs(n);
  const mod10 = abs % 10;
  const mod100 = abs % 100;
  if (mod100 >= 11 && mod100 <= 19) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}
