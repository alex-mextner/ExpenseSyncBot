/** AI receipt extractor — uses Hugging Face inference to parse receipt items from HTML text */
import { InferenceClient } from '@huggingface/inference';
import type { CurrencyCode } from '../../config/constants';
import { env } from '../../config/env';
import { createLogger } from '../../utils/logger.ts';
import { extractTextFromHTML } from './receipt-fetcher';

const logger = createLogger('ai-extractor');

/** Detect when the AI model returns prompt format descriptions instead of actual values */
function looksLikePromptLeak(nameRu: string): boolean {
  const lower = nameRu.toLowerCase();
  const leakPatterns = [
    'название товара',
    'перевод на русский',
    'оригинальное название',
    'product name',
    'name_ru',
    'name_original',
    'наименование позиции',
    'описание товара',
  ];
  return leakPatterns.some((p) => lower.includes(p));
}

const client = new InferenceClient(env.HF_TOKEN);

// Models to try in order (reasoning model first, then fallback to non-reasoning)
const MODELS = [
  {
    provider: 'novita',
    model: 'deepseek-ai/DeepSeek-R1-0528',
    name: 'DeepSeek-R1',
  },
  {
    provider: 'fireworks-ai',
    model: 'deepseek-ai/DeepSeek-V3.2',
    name: 'DeepSeek-V3',
  },
] as const;

/**
 * Receipt item from AI extraction
 */
export interface AIReceiptItem {
  name_ru: string;
  name_original?: string;
  quantity: number;
  price: number;
  total: number;
  category: string;
  possible_categories?: string[];
}

/**
 * AI extraction result
 */
export interface AIExtractionResult {
  items: AIReceiptItem[];
  currency?: CurrencyCode;
}

/** Category example from expense history, used to improve AI categorization */
export interface CategoryExample {
  comment: string;
  amount: number;
  currency: string;
}

/**
 * Attempt to repair truncated JSON by extracting complete items from a cut-off response.
 * When AI output is truncated (finish_reason=length), the JSON ends mid-item.
 * We find all complete item objects and reconstruct valid JSON.
 */
export function repairTruncatedJson(
  jsonStr: string,
  finishReason?: string | null,
): AIExtractionResult {
  logger.warn(
    `[AI_EXTRACTOR] Attempting truncated JSON repair (finish_reason=${finishReason}, ${jsonStr.length} chars)`,
  );

  // Find the items array start
  const itemsArrayStart = jsonStr.indexOf('"items"');
  if (itemsArrayStart < 0) {
    logger.error(
      `[AI_EXTRACTOR] Cannot repair: no "items" key found. Response:\n${jsonStr.substring(0, 500)}`,
    );
    throw new Error('No valid JSON found in AI response');
  }

  const bracketStart = jsonStr.indexOf('[', itemsArrayStart);
  if (bracketStart < 0) {
    logger.error('[AI_EXTRACTOR] Cannot repair: no array bracket after "items"');
    throw new Error('No valid JSON found in AI response');
  }

  // Extract complete item objects using brace matching
  const items: AIReceiptItem[] = [];
  let i = bracketStart + 1;
  while (i < jsonStr.length) {
    // Find next object start
    const objStart = jsonStr.indexOf('{', i);
    if (objStart < 0) break;

    // Find matching closing brace by counting depth
    let depth = 0;
    let objEnd = -1;
    for (let j = objStart; j < jsonStr.length; j++) {
      if (jsonStr[j] === '{') depth++;
      if (jsonStr[j] === '}') depth--;
      if (depth === 0) {
        objEnd = j;
        break;
      }
    }

    if (objEnd < 0) {
      // Incomplete object — truncated here, stop
      break;
    }

    const objStr = jsonStr.substring(objStart, objEnd + 1);
    try {
      // Fix decimal separator before parsing
      const fixed = objStr.replace(/(\d),(\d)/g, '$1.$2');
      const item = JSON.parse(fixed) as AIReceiptItem;
      if (item.name_ru && typeof item.total === 'number') {
        items.push(item);
      }
    } catch {
      // Malformed object, skip
    }

    i = objEnd + 1;
  }

  if (items.length === 0) {
    logger.error(
      `[AI_EXTRACTOR] Repair failed: no complete items found. Response:\n${jsonStr.substring(0, 500)}`,
    );
    throw new Error('No valid JSON found in AI response');
  }

  // Try to extract currency from the response
  const currencyMatch = jsonStr.match(/"currency"\s*:\s*"([A-Z]{3})"/);
  const currency = currencyMatch?.[1] as AIExtractionResult['currency'];

  logger.info(
    `[AI_EXTRACTOR] Repaired truncated JSON: salvaged ${items.length} complete items${currency ? `, currency=${currency}` : ''}`,
  );

  const result: AIExtractionResult = { items };
  if (currency) {
    result.currency = currency;
  }
  return result;
}

/**
 * Extract expenses from receipt data using AI
 * @param receiptData - Receipt HTML or text data
 * @param existingCategories - List of existing categories in the group
 * @param categoryExamples - Recent expense examples per category for better AI categorization
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @returns Extracted receipt items
 * @throws Error if extraction fails after retries
 */
export async function extractExpensesFromReceipt(
  receiptData: string,
  existingCategories: string[],
  categoryExamples?: Map<string, CategoryExample[]>,
  maxRetries: number = 3,
): Promise<AIExtractionResult> {
  let lastError: Error | null = null;

  // Extract text from HTML once (reuse for all attempts)
  const isHTML = receiptData.includes('<html') || receiptData.includes('<!DOCTYPE');
  const text = isHTML ? extractTextFromHTML(receiptData) : receiptData;

  if (isHTML) {
    logger.info(
      `[AI_EXTRACTOR] Extracted text from HTML: ${receiptData.length} -> ${text.length} chars`,
    );
  }

  // Build prompt once
  const prompt = buildExtractionPrompt(text, existingCategories, categoryExamples);

  // Try each model in order
  for (const modelConfig of MODELS) {
    logger.info(`[AI_EXTRACTOR] Trying model: ${modelConfig.name}`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        logger.info(
          `[AI_EXTRACTOR] Sending ${text.length} chars to ${modelConfig.name} (attempt ${attempt}/${maxRetries})`,
        );

        // Call AI model
        const response = await client.chatCompletion({
          provider: modelConfig.provider,
          model: modelConfig.model,
          messages: [
            {
              role: 'system',
              content:
                'You are a receipt parser. Extract items from receipts and return valid JSON only.',
            },
            {
              role: 'user',
              content: prompt,
            },
          ],
          max_tokens: 8192,
          temperature: 0.3,
        });

        // Get response text and finish reason
        const choice = response.choices[0];
        const responseText = choice?.message?.content?.trim();
        const finishReason = choice?.finish_reason;

        logger.info(
          `[AI_EXTRACTOR] Response from ${modelConfig.name}: finish_reason=${finishReason}, usage=${JSON.stringify(response.usage)}`,
        );

        if (!responseText) {
          throw new Error('Empty response from AI');
        }

        // Remove thinking tags from response (for reasoning models)
        // Using greedy * to capture until the LAST </think>
        const cleanedResponse = responseText.replace(/<think>[\s\S]*<\/think>/gi, '').trim();

        // Log raw AI response for debugging
        logger.info(`[AI_EXTRACTOR] Raw AI response (${responseText.length} chars)`);
        logger.info(
          `[AI_EXTRACTOR] Cleaned response (${cleanedResponse.length} chars):\n${cleanedResponse}`,
        );

        // Extract JSON from response
        let jsonStr = cleanedResponse;

        // Step 1: Remove markdown code block wrapper if present
        const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
        if (codeBlockMatch?.[1]) {
          jsonStr = codeBlockMatch[1];
        }

        // Step 2: Fix decimal separator (399,99 -> 399.99)
        jsonStr = jsonStr.replace(/(\d),(\d)/g, '$1.$2');

        // Step 3: Try direct JSON.parse, fallback to finding {"items"...}, then truncated repair
        let result: AIExtractionResult;
        try {
          result = JSON.parse(jsonStr) as AIExtractionResult;
        } catch {
          // Fallback 1: find last {"items"...} object in response
          const itemsPos = jsonStr.lastIndexOf('{"items"');
          const lastBrace = jsonStr.lastIndexOf('}');

          if (itemsPos >= 0 && lastBrace > itemsPos) {
            const extracted = jsonStr.substring(itemsPos, lastBrace + 1);
            try {
              result = JSON.parse(extracted) as AIExtractionResult;
              logger.info(
                `[AI_EXTRACTOR] Fallback: extracted {"items"...} (${extracted.length} chars)`,
              );
            } catch {
              // Fallback 2: try repairing truncated JSON
              result = repairTruncatedJson(jsonStr, finishReason);
            }
          } else {
            // Fallback 2: try repairing truncated JSON
            result = repairTruncatedJson(jsonStr, finishReason);
          }
        }

        logger.info(`[AI_EXTRACTOR] Parsed JSON with ${result.items?.length || 0} items`);

        // Validate result
        if (!result.items || !Array.isArray(result.items) || result.items.length === 0) {
          throw new Error('Invalid result: items array is missing or empty');
        }

        // Validate and normalize each item
        for (const item of result.items) {
          if (
            !item.name_ru ||
            typeof item.quantity !== 'number' ||
            typeof item.price !== 'number' ||
            typeof item.total !== 'number' ||
            !item.category
          ) {
            throw new Error(`Invalid item structure: ${JSON.stringify(item)}`);
          }

          // Detect leaked prompt instructions in name_ru (weak models echo format descriptions)
          if (looksLikePromptLeak(item.name_ru)) {
            const safeOriginal =
              item.name_original && !looksLikePromptLeak(item.name_original)
                ? item.name_original
                : null;
            logger.warn(
              `[AI_EXTRACTOR] Prompt leak detected in name_ru: "${item.name_ru}", fallback: ${safeOriginal ?? 'generic'}`,
            );
            item.name_ru = safeOriginal || `Товар (${item.total})`;
          }

          // Ensure possible_categories exists and is an array
          if (!item.possible_categories || !Array.isArray(item.possible_categories)) {
            logger.warn(
              `[AI_EXTRACTOR] Item "${item.name_ru}" missing possible_categories, initializing empty array`,
            );
            item.possible_categories = [];
          }

          // If existing categories provided, validate that AI used only those
          if (existingCategories.length > 0) {
            const { findBestCategoryMatch } = await import('../../utils/fuzzy-search');

            // Check if suggested category exists
            if (!existingCategories.includes(item.category)) {
              logger.warn(
                `[AI_EXTRACTOR] AI suggested non-existing category "${item.category}" for item "${item.name_ru}"`,
              );

              // Try to find closest match
              const closestMatch = findBestCategoryMatch(item.category, existingCategories);

              if (closestMatch) {
                logger.info(`[AI_EXTRACTOR] Replacing with closest match: "${closestMatch}"`);
                item.category = closestMatch;
              } else {
                // Fallback to first available category or "Разное"
                const fallback =
                  existingCategories.find((c) => c === 'Разное') ||
                  existingCategories[0] ||
                  'Разное';
                logger.info(`[AI_EXTRACTOR] Using fallback category: "${fallback}"`);
                item.category = fallback;
              }
            }

            // Validate possible_categories - filter out non-existing ones
            if (item.possible_categories.length > 0) {
              const validAlternatives = item.possible_categories.filter((cat) =>
                existingCategories.includes(cat),
              );

              if (validAlternatives.length < item.possible_categories.length) {
                logger.warn(
                  `[AI_EXTRACTOR] Filtered out ${
                    item.possible_categories.length - validAlternatives.length
                  } ` + `non-existing categories from possible_categories for "${item.name_ru}"`,
                );
                item.possible_categories = validAlternatives;
              }
            }
          }
        }

        logger.info(
          `[AI_EXTRACTOR] Successfully extracted ${result.items.length} items using ${modelConfig.name}`,
        );
        return result;
      } catch (error) {
        lastError = error instanceof Error ? error : new Error('Unknown error during extraction');

        // Log detailed error info
        if (error instanceof SyntaxError) {
          logger.error(
            `[AI_EXTRACTOR] JSON Parse error on attempt ${attempt}/${maxRetries} (${modelConfig.name}): ${lastError.message}`,
          );
        } else {
          logger.error(
            `[AI_EXTRACTOR] Extraction failed on attempt ${attempt}/${maxRetries} (${modelConfig.name}): ${lastError.message}`,
          );

          // Log additional error details for network errors (HuggingFace InferenceClientProviderApiError)
          const err = error as Error & {
            httpRequest?: { url?: string; method?: string };
            httpResponse?: {
              status?: number;
              statusText?: string;
              body?: unknown;
            };
            cause?: unknown;
          };

          if (err.httpResponse) {
            logger.error(
              `[AI_EXTRACTOR] HTTP Response: ${err.httpResponse.status} ${
                err.httpResponse.statusText || ''
              }`,
            );
            if (err.httpResponse.body) {
              logger.error(
                `[AI_EXTRACTOR] Response body: ${typeof err.httpResponse.body === 'string' ? err.httpResponse.body.substring(0, 1000) : JSON.stringify(err.httpResponse.body, null, 2).substring(0, 1000)}`,
              );
            }
          }
          if (err.httpRequest) {
            logger.error(
              `[AI_EXTRACTOR] Request: ${err.httpRequest.method} ${err.httpRequest.url}`,
            );
          }
          if (err.cause) {
            logger.error({ err: err.cause }, '[AI_EXTRACTOR] Cause');
          }
          if (lastError.stack) {
            logger.error({ err: lastError.stack }, '[AI_EXTRACTOR] Stack');
          }
        }

        if (attempt < maxRetries) {
          // Wait before retry (exponential backoff)
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    logger.info(
      `[AI_EXTRACTOR] ${modelConfig.name} failed after ${maxRetries} attempts, trying next model...`,
    );
  }

  throw new Error(`Failed to extract receipt data after trying all models: ${lastError?.message}`);
}

/**
 * Format category examples as a prompt section for AI context
 */
function formatCategoryExamples(categoryExamples: Map<string, CategoryExample[]>): string {
  const lines: string[] = [];
  for (const [category, examples] of categoryExamples) {
    const formatted = examples.map((e) => `${e.comment} (${e.amount}${e.currency})`).join(', ');
    lines.push(`- ${category}: ${formatted}`);
  }
  return lines.join('\n');
}

/**
 * Build extraction prompt for AI
 */
function buildExtractionPrompt(
  receiptText: string,
  existingCategories: string[],
  categoryExamples?: Map<string, CategoryExample[]>,
): string {
  const hasExistingCategories = existingCategories.length > 0;

  return `Extract all items from this receipt and return a JSON object with the following structure:

{
  "items": [
    {
      "name_ru": "Название товара на русском",
      "name_original": "Original product name (if available)",
      "quantity": 1.5,
      "price": 100.50,
      "total": 150.75,
      "category": "Категория",
      "possible_categories": ["Альтернатива1", "Альтернатива2"]
    }
  ],
  "currency": "RSD"
}

CRITICAL INSTRUCTIONS:
1. Translate all product names to Russian (name_ru)
2. Keep original names in name_original if they are in a different language
3. Extract quantity, price per unit, and total amount for each item
4. ALWAYS provide "possible_categories" array with 2-3 alternative category names - this field is REQUIRED
5. Detect the currency used in the receipt (e.g., RSD, EUR, USD)

CATEGORY SELECTION (MOST IMPORTANT):
${
  hasExistingCategories
    ? `This group has existing categories. You MUST use ONLY these categories:
${existingCategories.map((cat) => `- ${cat}`).join('\n')}

STRICT Rules:
- You MUST choose "category" from the list above - NO exceptions!
- DO NOT create new categories - use the closest existing one
- If unsure, use the most general category from the list (e.g., "Разное", "Хозтовары", etc.)
- Put 2-3 other existing categories in "possible_categories" as alternatives
- ALL categories (both "category" and "possible_categories") MUST be from the list above`
    : `This group has no categories yet. You can suggest new category names.
- Create clear, concise category names in Russian
- Provide 2-3 alternative category names in "possible_categories"`
}

${
  categoryExamples && categoryExamples.size > 0
    ? `CATEGORY EXAMPLES FROM HISTORY:
These are real expenses from this group. Use them to understand what belongs in each category:
${formatCategoryExamples(categoryExamples)}

`
    : ''
}EXAMPLES of good categorization (use existing categories only):
- Item: "Молоко 3.2%" + existing ["Еда", "Разное", "Хобби"] → category: "Еда", possible_categories: ["Разное"]
- Item: "Шуруп 4x50" + existing ["Инструменты", "Разное"] → category: "Инструменты", possible_categories: ["Разное"]

Receipt text:
${receiptText}

Return ONLY valid JSON, no additional text or explanations.`;
}
