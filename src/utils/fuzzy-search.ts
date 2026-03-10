/**
 * Calculate Levenshtein distance between two strings
 * Returns the minimum number of single-character edits (insertions, deletions, substitutions)
 * required to change one string into the other
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  // Use a 2-row optimization to avoid type issues with 2D array
  // Pre-allocate arrays with known size to avoid undefined access issues
  const rowLength = a.length + 1;
  let prevRow = new Array<number>(rowLength);
  let currRow = new Array<number>(rowLength);

  // Initialize first row
  for (let j = 0; j <= a.length; j++) {
    prevRow[j] = j;
  }

  // Fill in the rest of the matrix
  for (let i = 1; i <= b.length; i++) {
    currRow[0] = i;
    
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        currRow[j] = prevRow[j - 1]!;
      } else {
        const sub = prevRow[j - 1]! + 1; // substitution
        const ins = currRow[j - 1]! + 1; // insertion
        const del = prevRow[j]! + 1; // deletion
        currRow[j] = Math.min(sub, ins, del);
      }
    }
    
    // Swap rows
    const temp = prevRow;
    prevRow = currRow;
    currRow = temp;
  }

  return prevRow[a.length]!;
}

/**
 * Calculate similarity ratio between two strings (0 to 1)
 * Uses Levenshtein distance normalized by the maximum length
 * Returns 1.0 for identical strings, 0.0 for completely different
 */
export function calculateSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const distance = levenshteinDistance(a, b);
  const maxLength = Math.max(a.length, b.length);
  
  return 1 - distance / maxLength;
}

/**
 * Normalize category name - capitalize first letter
 */
export function normalizeCategoryName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/**
 * Find best matching category using fuzzy search with Levenshtein distance
 * Returns the best match or null if no match found
 * 
 * Matching priority:
 * 1. Exact match (case-insensitive)
 * 2. Category contains input (only for short partial inputs with high similarity)
 * 3. Input contains category
 * 4. Fuzzy match with similarity >= 0.9
 */
export function findBestCategoryMatch(
  input: string,
  categories: string[]
): string | null {
  if (!input || categories.length === 0) {
    return null;
  }

  const normalizedInput = input.toLowerCase().trim();
  
  // Reject empty input after normalization
  if (!normalizedInput) {
    return null;
  }

  // First try exact match (case-insensitive)
  const exactMatch = categories.find(
    (cat) => cat.toLowerCase().trim() === normalizedInput
  );
  if (exactMatch) {
    return exactMatch;
  }

  // Try to find category that contains the input
  // Only if:
  // - Input is at least 5 characters (meaningful partial)
  // - Input is significantly shorter than category (diff > 2)
  // - Similarity is at least 0.55
  const containsMatch = categories.find((cat) => {
    const normalizedCategory = cat.toLowerCase().trim();
    const lengthDiff = normalizedCategory.length - normalizedInput.length;
    
    if (
      normalizedInput.length >= 5 &&
      normalizedCategory.includes(normalizedInput) &&
      lengthDiff > 2
    ) {
      const similarity = calculateSimilarity(normalizedInput, normalizedCategory);
      return similarity >= 0.55;
    }
    return false;
  });
  if (containsMatch) {
    return containsMatch;
  }

  // Try to find category that is contained in the input
  // Category must be at least 5 characters and significantly shorter than input
  const containedInMatch = categories.find((cat) => {
    const normalizedCategory = cat.toLowerCase().trim();
    const lengthDiff = normalizedInput.length - normalizedCategory.length;
    
    if (
      normalizedCategory.length >= 5 &&
      normalizedInput.includes(normalizedCategory) &&
      lengthDiff > 2
    ) {
      const similarity = calculateSimilarity(normalizedInput, normalizedCategory);
      return similarity >= 0.55;
    }
    return false;
  });
  if (containedInMatch) {
    return containedInMatch;
  }

  // Try fuzzy matching with similarity threshold of 0.9
  const FUZZY_THRESHOLD = 0.9;
  let bestMatch: string | null = null;
  let bestSimilarity = 0;

  for (const category of categories) {
    const normalizedCategory = category.toLowerCase().trim();
    
    // Skip empty categories
    if (!normalizedCategory) continue;
    
    const similarity = calculateSimilarity(normalizedInput, normalizedCategory);

    if (similarity >= FUZZY_THRESHOLD && similarity > bestSimilarity) {
      bestMatch = category;
      bestSimilarity = similarity;
    }
  }

  return bestMatch;
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
  
  // Reject empty input after normalization
  if (!normalizedInput) {
    return [];
  }

  const matches: Array<{ category: string; score: number }> = [];

  for (const category of categories) {
    const normalizedCategory = category.toLowerCase().trim();
    
    // Skip empty categories
    if (!normalizedCategory) continue;

    // Calculate simple similarity score
    let score = 0;

    // Exact match
    if (normalizedCategory === normalizedInput) {
      score = 100;
    }
    // Category contains input (with length check)
    else if (
      normalizedCategory.includes(normalizedInput) &&
      normalizedCategory.length - normalizedInput.length > 1
    ) {
      score = 80;
    }
    // Input contains category (with length check)
    else if (
      normalizedInput.includes(normalizedCategory) &&
      normalizedInput.length - normalizedCategory.length > 1
    ) {
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
