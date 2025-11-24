import { InferenceClient } from "@huggingface/inference";
import { env } from "../../config/env";
import type { CurrencyCode } from "../../config/constants";
import { extractTextFromHTML } from "./receipt-fetcher";

const client = new InferenceClient(env.HF_TOKEN);

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

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // Extract text from HTML if needed
      const isHTML =
        receiptData.includes("<html") || receiptData.includes("<!DOCTYPE");
      const text = isHTML ? extractTextFromHTML(receiptData) : receiptData;

      if (isHTML) {
        console.log(
          `[AI_EXTRACTOR] Extracted text from HTML: ${receiptData.length} -> ${text.length} chars`
        );
      }
      console.log(
        `[AI_EXTRACTOR] Sending ${text.length} chars to AI (attempt ${attempt}/${maxRetries})`
      );

      // Build prompt
      const prompt = buildExtractionPrompt(text, existingCategories);

      // Call AI model
      const response = await client.chatCompletion({
        provider: "novita",
        model: "deepseek-ai/DeepSeek-R1-0528",
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

      // Parse JSON (try to extract JSON from markdown code blocks if present)
      const jsonMatch =
        responseText.match(
          /```(?:json)?\s*(\{[\s\S]*?\}|\[[\s\S]*?\])\s*```/
        ) || responseText.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);

      if (!jsonMatch || !jsonMatch[1]) {
        throw new Error("No JSON found in AI response");
      }

      const result = JSON.parse(jsonMatch[1]) as AIExtractionResult;

      // Validate result
      if (
        !result.items ||
        !Array.isArray(result.items) ||
        result.items.length === 0
      ) {
        throw new Error("Invalid result: items array is missing or empty");
      }

      // Validate each item
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
      }

      return result;
    } catch (error) {
      lastError =
        error instanceof Error
          ? error
          : new Error("Unknown error during extraction");
      console.error(
        `AI extraction attempt ${attempt}/${maxRetries} failed:`,
        lastError.message
      );

      if (attempt === maxRetries) {
        break;
      }

      // Wait before retry (exponential backoff)
      await new Promise((resolve) => setTimeout(resolve, 1000 * attempt));
    }
  }

  throw new Error(
    `Failed to extract receipt data after ${maxRetries} attempts: ${lastError?.message}`
  );
}

/**
 * Build extraction prompt for AI
 */
function buildExtractionPrompt(
  receiptText: string,
  existingCategories: string[]
): string {
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
      "possible_categories": ["Категория1", "Категория2"]
    }
  ],
  "currency": "RSD"
}

Instructions:
1. Translate all product names to Russian (name_ru)
2. Keep original names in name_original if they are in a different language
3. Extract quantity, price per unit, and total amount for each item
4. Assign the most appropriate category to each item
5. Provide 1-3 possible_categories (alternative categories) if you're not 100% confident
6. If possible_categories array is empty or you're very confident, omit it
7. Detect the currency used in the receipt (e.g., RSD, EUR, USD)

Existing categories in this group:
${existingCategories.map((cat) => `- ${cat}`).join("\n")}

If a product fits into an existing category, use it. If no existing category fits, suggest a new appropriate category name.

Receipt text:
${receiptText}

Return ONLY valid JSON, no additional text or explanations.`;
}
