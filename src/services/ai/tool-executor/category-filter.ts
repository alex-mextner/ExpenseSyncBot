/**
 * Case-insensitive category filter shared by the read tools (get_expenses, get_budgets).
 * An empty filter list means "no filter" and returns the input untouched.
 */
export function filterByCategories<T extends { category: string }>(
  items: T[],
  categories: string[],
): T[] {
  if (categories.length === 0) return items;
  const lowerCategories = categories.map((c) => c.toLowerCase());
  return items.filter((item) => lowerCategories.includes(item.category.toLowerCase()));
}
