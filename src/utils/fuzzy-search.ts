/**
 * Normalize category name - capitalize first letter
 */
export function normalizeCategoryName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Find best matching category using simple fuzzy search
 * Returns the best match or null if no match found
 */
export function findBestCategoryMatch(
  input: string,
  categories: string[]
): string | null {
  if (!input || categories.length === 0) {
    return null;
  }

  const normalizedInput = input.toLowerCase().trim();

  // First try exact match (case-insensitive)
  const exactMatch = categories.find(
    (cat) => cat.toLowerCase() === normalizedInput
  );
  if (exactMatch) {
    return exactMatch;
  }

  // Try to find category that contains the input
  const containsMatch = categories.find((cat) =>
    cat.toLowerCase().includes(normalizedInput)
  );
  if (containsMatch) {
    return containsMatch;
  }

  // Try to find category that is contained in the input
  const containedInMatch = categories.find((cat) =>
    normalizedInput.includes(cat.toLowerCase())
  );
  if (containedInMatch) {
    return containedInMatch;
  }

  // No match found
  return null;
}

/**
 * Find similar categories (returns multiple matches)
 */
export function findSimilarCategories(
  input: string,
  categories: string[],
  limit: number = 3
): string[] {
  if (!input || categories.length === 0) {
    return [];
  }

  const normalizedInput = input.toLowerCase().trim();
  const matches: Array<{ category: string; score: number }> = [];

  for (const category of categories) {
    const normalizedCategory = category.toLowerCase();

    // Calculate simple similarity score
    let score = 0;

    // Exact match
    if (normalizedCategory === normalizedInput) {
      score = 100;
    }
    // Category contains input
    else if (normalizedCategory.includes(normalizedInput)) {
      score = 80;
    }
    // Input contains category
    else if (normalizedInput.includes(normalizedCategory)) {
      score = 70;
    }
    // Check if they share words
    else {
      const inputWords = normalizedInput.split(/\s+/);
      const categoryWords = normalizedCategory.split(/\s+/);

      const commonWords = inputWords.filter((word) =>
        categoryWords.some((catWord) => catWord.includes(word) || word.includes(catWord))
      );

      if (commonWords.length > 0) {
        score = 50 + (commonWords.length / inputWords.length) * 30;
      }
    }

    if (score > 0) {
      matches.push({ category, score });
    }
  }

  // Sort by score and return top matches
  return matches
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((m) => m.category);
}
