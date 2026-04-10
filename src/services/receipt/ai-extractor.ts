/**
 * Receipt item types and JSON repair helper.
 *
 * Historically this file held `extractExpensesFromReceipt` — the old two-step
 * text→JSON extractor. That function has been replaced by `parseReceipt` in
 * `receipt-parser.ts`, which does extraction + sum verification in a single
 * tool-calling round.
 *
 * What remains here:
 *  - Shared types (`AIReceiptItem`, `AIExtractionResult`, `CategoryExample`)
 *    reused by parseReceipt and by callers that need to shape extraction output.
 *  - `repairTruncatedJson` — a salvage helper for legacy models that return
 *    truncated JSON blobs. Kept because parseReceipt falls back to it when the
 *    model ignores tool calling and dumps plain JSON instead.
 */

import type { CurrencyCode } from '../../config/constants';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('ai-extractor');

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
  /**
   * Receipt date in YYYY-MM-DD format, extracted from the printed date on the
   * receipt (e.g. "ПФР време: 24.11.2025"). Used to match receipts against bank
   * transactions by date. Undefined if not printed on the receipt.
   */
  date?: string;
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
