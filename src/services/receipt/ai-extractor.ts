import { InferenceClient } from "@huggingface/inference";
import { env } from "../../config/env";
import type { CurrencyCode } from "../../config/constants";
import { extractTextFromHTML } from "./receipt-fetcher";

const client = new InferenceClient(env.HF_TOKEN);

// Models to try in order (reasoning model first, then fallback to non-reasoning)
const MODELS = [
  {
    provider: "fireworks-ai",
    model: "deepseek-ai/DeepSeek-R1-0528",
    name: "DeepSeek-R1",
  },
  {
    provider: "fireworks-ai",
    model: "deepseek-ai/DeepSeek-V3.2",
    name: "DeepSeek-V3",
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

/**
 * Extract expenses from receipt data using AI
 * @param receiptData - Receipt HTML or text data
 * @param existingCategories - List of existing categories in the group
 * @param maxRetries - Maximum number of retry attempts (default: 3)
 * @returns Extracted receipt items
 * @throws Error if extraction fails after retries
 */
export async function extractExpensesFromReceipt(
  receiptData: string,
  existingCategories: string[],
  maxRetries: number = 3
): Promise<AIExtractionResult> {
  let lastError: Error | null = null;

  // Extract text from HTML once (reuse for all attempts)
  const isHTML =
    receiptData.includes("<html") || receiptData.includes("<!DOCTYPE");
  const text = isHTML ? extractTextFromHTML(receiptData) : receiptData;

  if (isHTML) {
    console.log(
      `[AI_EXTRACTOR] Extracted text from HTML: ${receiptData.length} -> ${text.length} chars`
    );
  }

  // Build prompt once
  const prompt = buildExtractionPrompt(text, existingCategories);

  // Try each model in order
  for (const modelConfig of MODELS) {
    console.log(`[AI_EXTRACTOR] Trying model: ${modelConfig.name}`);

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        console.log(
          `[AI_EXTRACTOR] Sending ${text.length} chars to ${modelConfig.name} (attempt ${attempt}/${maxRetries})`
        );

        // Call AI model
        const response = await client.chatCompletion({
          provider: modelConfig.provider,
          model: modelConfig.model,
          messages: [
            {
              role: "system",
              content:
                "You are a receipt parser. Extract items from receipts and return valid JSON only.",
            },
            {
              role: "user",
              content: prompt,
            },
          ],
          max_tokens: 4000,
          temperature: 0.3,
        });

        // Get response text
        const responseText = response.choices[0]?.message?.content?.trim();

        if (!responseText) {
          throw new Error("Empty response from AI");
        }

        // Remove thinking tags from response (for reasoning models)
        const cleanedResponse = responseText
          .replace(/<think>[\s\S]*?<\/think>/gi, "")
          .trim();

        // Log raw AI response for debugging
        console.log(
          `[AI_EXTRACTOR] Raw AI response (${
            responseText.length
          } chars):\n${responseText.substring(0, 500)}...`
        );

        // Parse JSON (try to extract JSON from markdown code blocks if present)
        const jsonMatch =
          cleanedResponse.match(
            /```(?:json)?\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```/
          ) || cleanedResponse.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);

        if (!jsonMatch || !jsonMatch[1]) {
          console.error(
            `[AI_EXTRACTOR] Failed to extract JSON. Full response:\n${cleanedResponse}`
          );
          throw new Error("No JSON found in AI response");
        }

        console.log(
          `[AI_EXTRACTOR] Extracted JSON (${
            jsonMatch[1].length
          } chars):\n${jsonMatch[1].substring(0, 500)}...`
        );

        const result = JSON.parse(jsonMatch[1]) as AIExtractionResult;

        // Validate result
        if (
          !result.items ||
          !Array.isArray(result.items) ||
          result.items.length === 0
        ) {
          throw new Error("Invalid result: items array is missing or empty");
        }

        // Validate and normalize each item
        for (const item of result.items) {
          if (
            !item.name_ru ||
            typeof item.quantity !== "number" ||
            typeof item.price !== "number" ||
            typeof item.total !== "number" ||
            !item.category
          ) {
            throw new Error(`Invalid item structure: ${JSON.stringify(item)}`);
          }

          // Ensure possible_categories exists and is an array
          if (
            !item.possible_categories ||
            !Array.isArray(item.possible_categories)
          ) {
            console.warn(
              `[AI_EXTRACTOR] Item "${item.name_ru}" missing possible_categories, initializing empty array`
            );
            item.possible_categories = [];
          }

          // If existing categories provided, validate that AI used only those
          if (existingCategories.length > 0) {
            const { findBestCategoryMatch } = await import(
              "../../utils/fuzzy-search"
            );

            // Check if suggested category exists
            if (!existingCategories.includes(item.category)) {
              console.warn(
                `[AI_EXTRACTOR] AI suggested non-existing category "${item.category}" for item "${item.name_ru}"`
              );

              // Try to find closest match
              const closestMatch = findBestCategoryMatch(
                item.category,
                existingCategories
              );

              if (closestMatch) {
                console.log(
                  `[AI_EXTRACTOR] Replacing with closest match: "${closestMatch}"`
                );
                item.category = closestMatch;
              } else {
                // Fallback to first available category or "Разное"
                const fallback =
                  existingCategories.find((c) => c === "Разное") ||
                  existingCategories[0] ||
                  "Разное";
                console.log(
                  `[AI_EXTRACTOR] Using fallback category: "${fallback}"`
                );
                item.category = fallback;
              }
            }

            // Validate possible_categories - filter out non-existing ones
            if (item.possible_categories.length > 0) {
              const validAlternatives = item.possible_categories.filter((cat) =>
                existingCategories.includes(cat)
              );

              if (validAlternatives.length < item.possible_categories.length) {
                console.warn(
                  `[AI_EXTRACTOR] Filtered out ${
                    item.possible_categories.length - validAlternatives.length
                  } ` +
                    `non-existing categories from possible_categories for "${item.name_ru}"`
                );
                item.possible_categories = validAlternatives;
              }
            }
          }
        }

        console.log(
          `[AI_EXTRACTOR] Successfully extracted ${result.items.length} items using ${modelConfig.name}`
        );
        return result;
      } catch (error) {
        lastError =
          error instanceof Error
            ? error
            : new Error("Unknown error during extraction");

        // Log detailed error info
        if (error instanceof SyntaxError) {
          console.error(
            `[AI_EXTRACTOR] JSON Parse error on attempt ${attempt}/${maxRetries} (${modelConfig.name}):`,
            lastError.message
          );
        } else {
          console.error(
            `[AI_EXTRACTOR] Extraction failed on attempt ${attempt}/${maxRetries} (${modelConfig.name}):`,
            lastError.message
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
            console.error(
              `[AI_EXTRACTOR] HTTP Response: ${err.httpResponse.status} ${
                err.httpResponse.statusText || ""
              }`
            );
            if (err.httpResponse.body) {
              console.error(
                `[AI_EXTRACTOR] Response body:`,
                typeof err.httpResponse.body === "string"
                  ? err.httpResponse.body.substring(0, 1000)
                  : JSON.stringify(err.httpResponse.body, null, 2).substring(
                      0,
                      1000
                    )
              );
            }
          }
          if (err.httpRequest) {
            console.error(
              `[AI_EXTRACTOR] Request: ${err.httpRequest.method} ${err.httpRequest.url}`
            );
          }
          if (err.cause) {
            console.error(`[AI_EXTRACTOR] Cause:`, err.cause);
          }
          if (lastError.stack) {
            console.error(`[AI_EXTRACTOR] Stack:`, lastError.stack);
          }
        }

        if (attempt < maxRetries) {
          // Wait before retry (exponential backoff)
          await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
        }
      }
    }

    console.log(
      `[AI_EXTRACTOR] ${modelConfig.name} failed after ${maxRetries} attempts, trying next model...`
    );
  }

  throw new Error(
    `Failed to extract receipt data after trying all models: ${lastError?.message}`
  );
}

/**
 * Build extraction prompt for AI
 */
function buildExtractionPrompt(
  receiptText: string,
  existingCategories: string[]
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
${existingCategories.map((cat) => `- ${cat}`).join("\n")}

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

EXAMPLES of good categorization (use existing categories only):
- Item: "Молоко 3.2%" + existing ["Еда", "Разное", "Хобби"] → category: "Еда", possible_categories: ["Разное"]
- Item: "Шуруп 4x50" + existing ["Инструменты", "Разное"] → category: "Инструменты", possible_categories: ["Разное"]

Receipt text:
${receiptText}

Return ONLY valid JSON, no additional text or explanations.`;
}
