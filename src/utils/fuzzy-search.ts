/** Fuzzy category matching: phonetic normalization + Levenshtein distance + zero-shot classifier fallback */

import { InferenceClient } from '@huggingface/inference';
import { env } from '../config/env';
import { createLogger } from './logger';

const logger = createLogger('fuzzy-search');

/**
 * Normalize category name - capitalize first letter
 */
export function normalizeCategoryName(name: string): string {
  // Trim whitespace + trailing dots/punctuation that cause category duplicates
  const trimmed = name.trim().replace(/[.\s]+$/, '');
  if (!trimmed) return trimmed;
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1);
}

/** Check if a category name looks like it has multiple words (spaces inside) */
export function isMultiWordCategory(name: string): boolean {
  return name.trim().includes(' ');
}

/**
 * Phonetic normalization for Russian text.
 * Reduces common phonetic confusions before fuzzy comparison:
 *   - ё → е, й → и (common keyboard/spelling variants)
 *   - о → а (unstressed vowel reduction: "кофе" ≈ "кафе")
 *   - voiced consonants → unvoiced: б→п, в→ф, г→к, д→т, ж→ш, з→с
 */
export function normalizePhonetic(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/ё/g, 'е')
    .replace(/й/g, 'и')
    .replace(/о/g, 'а')
    .replace(/б/g, 'п')
    .replace(/в/g, 'ф')
    .replace(/г/g, 'к')
    .replace(/д/g, 'т')
    .replace(/ж/g, 'ш')
    .replace(/з/g, 'с');
}

/**
 * Safe element accessor for Uint16Array.
 * noUncheckedIndexedAccess makes arr[i] return number|undefined even for typed arrays.
 * All callers use indices that are provably in-bounds, but the compiler can't verify that.
 */
function rowAt(arr: Uint16Array, i: number): number {
  const v = arr[i];
  if (v === undefined) throw new RangeError(`levenshtein: index ${i} out of bounds`);
  return v;
}

/**
 * Levenshtein edit distance between two strings (case-sensitive, use normalized inputs).
 * Two-row DP: prevRow holds the previous iteration, currRow the current.
 */
export function levenshteinDistance(a: string, b: string): number {
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prevRow = new Uint16Array(a.length + 1);
  let currRow = new Uint16Array(a.length + 1);

  for (let j = 0; j <= a.length; j++) prevRow[j] = j;

  for (let i = 1; i <= b.length; i++) {
    currRow[0] = i;
    for (let j = 1; j <= a.length; j++) {
      if (b.charAt(i - 1) === a.charAt(j - 1)) {
        currRow[j] = rowAt(prevRow, j - 1);
      } else {
        const sub = rowAt(prevRow, j - 1) + 1;
        const ins = rowAt(currRow, j - 1) + 1;
        const del = rowAt(prevRow, j) + 1;
        currRow[j] = Math.min(sub, ins, del);
      }
    }
    const tmp = prevRow;
    prevRow = currRow;
    currRow = tmp;
  }

  return rowAt(prevRow, a.length);
}

/**
 * Similarity ratio [0..1] based on Levenshtein distance.
 * 1 = identical, 0 = completely different.
 */
export function calculateSimilarity(a: string, b: string): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  return 1 - levenshteinDistance(a, b) / Math.max(a.length, b.length);
}

const FUZZY_THRESHOLD = 0.9;

/**
 * Find best matching category.
 * Priority: exact → contains → contained-in → phonetic-exact → Levenshtein(≥0.9) on phonetic forms.
 * All comparisons are case-insensitive. Phonetic normalization applied to both sides.
 */
export function findBestCategoryMatch(input: string, categories: string[]): string | null {
  if (!input || categories.length === 0) {
    return null;
  }

  const normalizedInput = input.toLowerCase().trim();
  const phoneticInput = normalizePhonetic(input);

  // 1. Exact match (case-insensitive)
  const exactMatch = categories.find((cat) => cat.toLowerCase() === normalizedInput);
  if (exactMatch) return exactMatch;

  // 2. Category starts with input
  const startsWithMatch = categories.find((cat) => cat.toLowerCase().startsWith(normalizedInput));
  if (startsWithMatch) return startsWithMatch;

  // 3. Input contains category
  const containedInMatch = categories.find((cat) => normalizedInput.includes(cat.toLowerCase()));
  if (containedInMatch) return containedInMatch;

  // 4. Phonetic exact match (both sides normalized)
  const phoneticExact = categories.find((cat) => normalizePhonetic(cat) === phoneticInput);
  if (phoneticExact) return phoneticExact;

  // 5. Levenshtein on phonetically normalized strings
  let bestMatch: string | null = null;
  let bestScore = 0;

  for (const cat of categories) {
    const score = calculateSimilarity(phoneticInput, normalizePhonetic(cat));
    if (score >= FUZZY_THRESHOLD && score > bestScore) {
      bestScore = score;
      bestMatch = cat;
    }
  }

  return bestMatch;
}

const CLASSIFIER_MODEL = 'joeddav/xlm-roberta-large-xnli';
const CLASSIFIER_MIN_SCORE = 0.4;

/**
 * Zero-shot classifier fallback: asks the model "is this text about category X?"
 * Used when all string-based methods fail (different wording for same concept).
 * Example: "Расходы на ремонт квартиры" → matches "Ремонт" semantically.
 */
async function classifyCategory(input: string, categories: string[]): Promise<string | null> {
  if (!env.HF_TOKEN || categories.length === 0) return null;

  try {
    const client = new InferenceClient(env.HF_TOKEN);
    const result = await client.zeroShotClassification({
      model: CLASSIFIER_MODEL,
      inputs: input,
      parameters: { candidate_labels: categories },
    });

    const top = result[0];
    if (top && top.score >= CLASSIFIER_MIN_SCORE) {
      logger.debug({ input, match: top.label, score: top.score }, 'classifier match');
      return top.label;
    }
    return null;
  } catch (err) {
    logger.warn({ err, input }, 'zero-shot classifier failed, skipping');
    return null;
  }
}

/**
 * Async version of findBestCategoryMatch with zero-shot classifier fallback.
 * Pipeline: exact → startsWith → contains → phonetic → Levenshtein → classifier.
 * Use this in places where async is acceptable (handlers, sync).
 * Falls back gracefully if HF_TOKEN is not set or classifier fails.
 */
export async function findBestCategoryMatchAsync(
  input: string,
  categories: string[],
): Promise<string | null> {
  // Try all sync methods first
  const syncResult = findBestCategoryMatch(input, categories);
  if (syncResult) return syncResult;

  // Last resort: zero-shot classifier (semantic matching)
  return classifyCategory(input, categories);
}
