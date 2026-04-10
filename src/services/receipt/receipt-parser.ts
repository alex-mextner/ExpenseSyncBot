/**
 * Receipt parser with built-in validation — single AI round that parses receipt text
 * into structured items AND validates the sum via mandatory tool calling.
 *
 * Replaces the old two-step flow (ai-extractor → ocr-validator). The model is given a
 * `calculate_sum` tool that it MUST call before returning items. This guarantees that
 * the sum is computed deterministically (not by LLM arithmetic) and that the model
 * self-checks its parse against the receipt total before emitting the final answer.
 *
 * Runs on SMART_CHAIN because OCR correctness is critical — speed is not a concern.
 */

import type OpenAI from 'openai';
import type { CurrencyCode } from '../../config/constants';
import { createLogger } from '../../utils/logger.ts';
import { aiStreamRound, stripThinkingTags } from '../ai/streaming';
import {
  type AIExtractionResult,
  type AIReceiptItem,
  type CategoryExample,
  repairTruncatedJson,
} from './ai-extractor';
import { extractTextFromHTML } from './receipt-fetcher';

const logger = createLogger('receipt-parser');

const PARSE_TIMEOUT_MS = 120_000;
const PARSE_MAX_TOKENS = 8192;
const MAX_TOOL_ROUNDS = 6;

// ── Types ───────────────────────────────────────────────────────────────────

export interface ParseResult {
  items: AIReceiptItem[];
  currency?: CurrencyCode;
  /**
   * Receipt date in YYYY-MM-DD format, extracted from the receipt text
   * (e.g. "ПФР време: 24.11.2025" → "2025-11-24"). Used to match receipts
   * against bank transactions by date. Undefined if not printed on the receipt.
   */
  date?: string;
  /** Whether the model called calculate_sum and the result matched the claimed total */
  sumVerified: boolean;
  /** Computed sum of item.total values */
  computedSum: number;
  /** Claimed total parsed from receipt (if model found one) */
  claimedTotal?: number;
  /** Provider that produced the result */
  providerUsed: string;
  /**
   * How many times the model called calculate_sum before emitting items.
   * Higher numbers mean the model had to re-parse after detecting sum mismatches —
   * a rough quality metric. 1 = perfect first-pass parse, >1 = correction cycles.
   */
  calculateSumRounds: number;
}

export type ParseProgress = (delta: string) => void;

// ── Tool definitions ────────────────────────────────────────────────────────

const TOOLS: OpenAI.ChatCompletionTool[] = [
  {
    type: 'function',
    function: {
      name: 'calculate_sum',
      description:
        'Deterministically compute the sum of a list of numbers. ALWAYS call this before emitting the final items JSON to verify that the sum of item totals matches the receipt total. Arithmetic done in your head is not acceptable.',
      parameters: {
        type: 'object',
        properties: {
          numbers: {
            type: 'array',
            items: { type: 'number' },
            description: 'Numbers to sum (usually item.total values)',
          },
          label: {
            type: 'string',
            description: 'What these numbers represent (e.g. "item totals")',
          },
        },
        required: ['numbers'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'emit_items',
      description:
        'Emit the final extracted items as structured JSON. Only call this AFTER you have verified the sum via calculate_sum and it matches the receipt total (within 1% tolerance). If it does not match, re-inspect the receipt and fix items before calling this.',
      parameters: {
        type: 'object',
        properties: {
          items: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name_ru: { type: 'string', description: 'Russian translation of item name' },
                name_original: { type: 'string', description: 'Original item name from receipt' },
                quantity: { type: 'number' },
                price: { type: 'number', description: 'Price per unit' },
                total: { type: 'number', description: 'Line total (price × quantity)' },
                category: { type: 'string' },
                possible_categories: {
                  type: 'array',
                  items: { type: 'string' },
                  description: '2-3 alternative category names',
                },
              },
              required: [
                'name_ru',
                'quantity',
                'price',
                'total',
                'category',
                'possible_categories',
              ],
            },
          },
          currency: {
            type: 'string',
            description: 'Currency code detected on receipt (RSD, EUR, USD, etc.)',
          },
          claimed_total: {
            type: 'number',
            description: 'Total amount stated on the receipt (if present)',
          },
          date: {
            type: 'string',
            description:
              'Receipt date in YYYY-MM-DD format. Look for lines like "ПФР време: 24.11.2025", "Datum: 24.11.2025", "Date: 2024-06-15". Convert to ISO YYYY-MM-DD. Omit if no date visible.',
          },
        },
        required: ['items', 'currency'],
      },
    },
  },
];

// ── Tool executor ───────────────────────────────────────────────────────────

interface CalculateSumArgs {
  numbers: number[];
  label?: string;
}

function executeCalculateSum(args: CalculateSumArgs): {
  sum: number;
  count: number;
  label: string;
} {
  const nums = args.numbers.filter((n): n is number => typeof n === 'number' && !Number.isNaN(n));
  const sum = nums.reduce((a, b) => a + b, 0);
  return {
    sum: Math.round(sum * 100) / 100,
    count: nums.length,
    label: args.label ?? 'sum',
  };
}

// ── Prompts ─────────────────────────────────────────────────────────────────

function buildSystemPrompt(hasExistingCategories: boolean): string {
  return `You are a strict receipt parser. Your job: extract items from a receipt and emit structured JSON via tool calls.

MANDATORY WORKFLOW (no exceptions):
1. Read the ENTIRE receipt top to bottom. Identify EVERY line-item (name, quantity, unit price, line total). Don't stop at the first one — most receipts have multiple items.
2. Identify the RECEIPT TOTAL (the final amount the customer paid). Look specifically for labels like "Укупан износ", "Укупно", "Total", "Итого", "Amount Due", "Сумма". The receipt total is NEVER the same as a single item's price — it's the aggregate of ALL items. If the first item's price looks equal to what you think is the total, you are wrong: keep scanning.
3. Call the calculate_sum tool with the list of item.total values AND the label "item totals".
4. Compare the returned sum with the receipt total:
   - If they match (within 1% tolerance or ≤ 0.5 absolute) → proceed to step 5.
   - If they do NOT match → re-inspect the receipt: you probably missed an item, mis-parsed a quantity, mis-identified the total, or picked up tax/tip as an item. Fix the items and/or the claimed_total, call calculate_sum again. Repeat until matched.
5. Call emit_items with the verified items, currency, and claimed_total.

RULES:
- Parse EVERY distinct product line. A receipt with 3 items must produce 3 items. Do not short-circuit after the first item.
- NEVER confuse a single item's price with the total receipt amount.
- NEVER do arithmetic in your head. ALWAYS use calculate_sum.
- NEVER call emit_items before calculate_sum. This is mandatory.
- Translate item names to Russian (name_ru). Keep original in name_original.
- Extract quantity, unit price (price), and line total (total) for each item.
- Detect the currency (RSD, EUR, USD, RUB, BYN, etc.).
- Extract the PRINTED RECEIPT DATE (look for "ПФР време", "Datum", "Date", "время", or any printed date on the receipt). Convert it to YYYY-MM-DD format. Pass it as the "date" field in emit_items. This is the actual purchase date — critical for matching receipts with bank transactions. Omit the field only if no date is printed at all.
- If the receipt has no line items (only fiscal header/footer, QR markers, no products) → emit an empty items array.
${
  hasExistingCategories
    ? 'CATEGORIES: You will be given a list of existing categories. You MUST choose "category" for each item from that list ONLY. Put 2-3 alternatives in possible_categories, also from the list.'
    : 'CATEGORIES: No categories yet — suggest clear Russian category names. Put 2-3 alternatives in possible_categories.'
}`;
}

function formatCategoryExamples(categoryExamples: Map<string, CategoryExample[]>): string {
  const lines: string[] = [];
  for (const [category, examples] of categoryExamples) {
    const formatted = examples.map((e) => `${e.comment} (${e.amount}${e.currency})`).join(', ');
    lines.push(`- ${category}: ${formatted}`);
  }
  return lines.join('\n');
}

function buildUserPrompt(
  receiptText: string,
  existingCategories: string[],
  categoryExamples?: Map<string, CategoryExample[]>,
): string {
  let prompt = 'Parse this receipt. Follow the mandatory workflow.\n\n';

  if (existingCategories.length > 0) {
    prompt += `EXISTING CATEGORIES (you MUST pick from these):\n${existingCategories.map((c) => `- ${c}`).join('\n')}\n\n`;

    if (categoryExamples && categoryExamples.size > 0) {
      prompt += `CATEGORY EXAMPLES FROM HISTORY:\n${formatCategoryExamples(categoryExamples)}\n\n`;
    }
  }

  prompt += `RECEIPT TEXT:\n${receiptText}`;
  return prompt;
}

// ── Prompt-leak detection (re-used from ai-extractor) ───────────────────────

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

// ── Main parser ─────────────────────────────────────────────────────────────

export async function parseReceipt(
  receiptData: string,
  existingCategories: string[],
  categoryExamples?: Map<string, CategoryExample[]>,
  onProgress?: ParseProgress,
): Promise<ParseResult> {
  // Extract text from HTML once
  const isHTML = receiptData.includes('<html') || receiptData.includes('<!DOCTYPE');
  const text = isHTML ? extractTextFromHTML(receiptData) : receiptData;

  if (isHTML) {
    logger.info(
      `[RECEIPT_PARSER] Extracted text from HTML: ${receiptData.length} -> ${text.length} chars`,
    );
  }

  // Detect explicit "no text" marker from OCR step
  if (text.trim() === 'NO_TEXT' || text.trim().length < 10) {
    logger.warn('[RECEIPT_PARSER] Receipt text is empty or NO_TEXT marker — no items possible');
    return {
      items: [],
      sumVerified: false,
      computedSum: 0,
      providerUsed: 'none',
      calculateSumRounds: 0,
    };
  }

  const systemPrompt = buildSystemPrompt(existingCategories.length > 0);
  const userPrompt = buildUserPrompt(text, existingCategories, categoryExamples);

  const messages: OpenAI.ChatCompletionMessageParam[] = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: userPrompt },
  ];

  let emittedItems: AIReceiptItem[] = [];
  let emittedCurrency: CurrencyCode | undefined;
  let emittedDate: string | undefined;
  let claimedTotal: number | undefined;
  let computedSum = 0;
  let sumCallCount = 0;
  let emitCalled = false;
  let providerUsed = 'unknown';

  const callbacks = onProgress ? { onTextDelta: onProgress } : undefined;

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const result = await aiStreamRound(
      {
        messages,
        tools: TOOLS,
        maxTokens: PARSE_MAX_TOKENS,
        temperature: 0.2,
        chain: 'smart',
        signal: AbortSignal.timeout(PARSE_TIMEOUT_MS),
      },
      callbacks,
    );
    providerUsed = result.providerUsed;

    logger.info(
      `[RECEIPT_PARSER] Round ${round + 1} (${result.providerUsed}): text=${result.text.length} chars, toolCalls=${result.toolCalls.length}, finish=${result.finishReason}`,
    );

    // No tool calls → either final answer or malformed response
    if (result.toolCalls.length === 0) {
      if (emitCalled) {
        // Model already emitted items, this round is just a closing message — done
        break;
      }

      // Model tried to return items as text instead of tool call — try legacy JSON repair
      logger.warn(
        `[RECEIPT_PARSER] No tool calls in round ${round + 1}, attempting legacy JSON parse`,
      );
      const cleaned = stripThinkingTags(result.text);
      try {
        const legacy = parseLegacyJsonResponse(cleaned, result.finishReason);
        emittedItems = legacy.items;
        emittedCurrency = legacy.currency;
        break;
      } catch (err) {
        logger.warn(
          `[RECEIPT_PARSER] Legacy JSON parse failed: ${err instanceof Error ? err.message : 'unknown'}`,
        );
        // Nothing to do — model gave up. Exit loop.
        break;
      }
    }

    // Append assistant message + execute tools
    messages.push(result.assistantMessage);

    for (const tc of result.toolCalls) {
      let parsedArgs: unknown;
      try {
        parsedArgs = JSON.parse(tc.arguments || '{}');
      } catch {
        parsedArgs = {};
      }

      if (tc.name === 'calculate_sum') {
        sumCallCount++;
        const sumResult = executeCalculateSum(parsedArgs as CalculateSumArgs);
        computedSum = sumResult.sum;
        logger.info(
          `[RECEIPT_PARSER] calculate_sum called: count=${sumResult.count}, sum=${sumResult.sum} (${sumResult.label})`,
        );
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify(sumResult),
        });
      } else if (tc.name === 'emit_items') {
        emitCalled = true;
        const args = parsedArgs as {
          items?: AIReceiptItem[];
          currency?: CurrencyCode;
          claimed_total?: number;
          date?: string;
        };
        emittedItems = args.items ?? [];
        emittedCurrency = args.currency;
        claimedTotal = args.claimed_total;
        // Validate date format: strict YYYY-MM-DD, drop otherwise
        if (args.date && /^\d{4}-\d{2}-\d{2}$/.test(args.date)) {
          emittedDate = args.date;
        } else if (args.date) {
          logger.warn(`[RECEIPT_PARSER] Invalid date format "${args.date}" from model, discarding`);
        }
        logger.info(
          `[RECEIPT_PARSER] emit_items called: ${emittedItems.length} items, currency=${emittedCurrency}, claimed=${claimedTotal}, date=${emittedDate ?? 'none'}`,
        );
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ received: true, count: emittedItems.length }),
        });
      } else {
        logger.warn(`[RECEIPT_PARSER] Unknown tool call: ${tc.name}`);
        messages.push({
          role: 'tool',
          tool_call_id: tc.id,
          content: JSON.stringify({ error: `Unknown tool: ${tc.name}` }),
        });
      }
    }

    if (emitCalled) {
      break;
    }
  }

  // Post-process
  await validateAndNormalizeItems(emittedItems, existingCategories);

  // Determine if sum was verified. Requires:
  //  - at least one item (meaningless to "verify" an empty receipt)
  //  - calculate_sum was called (sum is deterministic, not LLM-guessed)
  //  - claimed total was found on the receipt AND is non-zero
  //  - computed sum matches claimed total within 1% tolerance
  const actualSum = Math.round(emittedItems.reduce((a, it) => a + (it.total ?? 0), 0) * 100) / 100;
  const sumVerified =
    emittedItems.length > 0 &&
    sumCallCount > 0 &&
    claimedTotal !== undefined &&
    claimedTotal > 0 &&
    Math.abs(computedSum - claimedTotal) <= Math.max(claimedTotal * 0.01, 0.5);

  if (sumCallCount === 0 && emittedItems.length > 0) {
    logger.warn(
      '[RECEIPT_PARSER] Model emitted items without calling calculate_sum — sum not verified',
    );
  }

  logger.info(
    `[RECEIPT_PARSER] Done: ${emittedItems.length} items, computedSum=${computedSum}, actualSum=${actualSum}, claimed=${claimedTotal}, verified=${sumVerified}`,
  );

  const result: ParseResult = {
    items: emittedItems,
    sumVerified,
    computedSum: actualSum,
    providerUsed,
    calculateSumRounds: sumCallCount,
  };
  // Only record currency + claimedTotal when we actually extracted items —
  // otherwise they're meaningless placeholders (e.g. model saw a fiscal footer
  // with a total but couldn't find any line items). Date IS kept for empty
  // receipts too — a footer-only scan can still have a valid receipt date
  // printed, and downstream matchers may want it.
  if (emittedItems.length > 0) {
    if (emittedCurrency) {
      result.currency = emittedCurrency;
    }
    if (claimedTotal !== undefined && claimedTotal > 0) {
      result.claimedTotal = claimedTotal;
    }
  }
  if (emittedDate) {
    result.date = emittedDate;
  }
  return result;
}

// ── Legacy JSON fallback (for models that ignore tool calling) ──────────────

function parseLegacyJsonResponse(
  cleanedResponse: string,
  finishReason: string,
): AIExtractionResult {
  let jsonStr = cleanedResponse;

  const codeBlockMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (codeBlockMatch?.[1]) {
    jsonStr = codeBlockMatch[1];
  }

  jsonStr = jsonStr.replace(/(\d),(\d)/g, '$1.$2');

  try {
    const result = JSON.parse(jsonStr) as AIExtractionResult;
    if (!result.items || !Array.isArray(result.items) || result.items.length === 0) {
      throw new Error('Invalid result: items array is missing or empty');
    }
    return result;
  } catch {
    const itemsPos = jsonStr.lastIndexOf('{"items"');
    const lastBrace = jsonStr.lastIndexOf('}');
    if (itemsPos >= 0 && lastBrace > itemsPos) {
      const extracted = jsonStr.substring(itemsPos, lastBrace + 1);
      try {
        const result = JSON.parse(extracted) as AIExtractionResult;
        if (result.items && Array.isArray(result.items) && result.items.length > 0) {
          return result;
        }
      } catch {
        // fall through
      }
    }
    return repairTruncatedJson(jsonStr, finishReason);
  }
}

// ── Post-processing ─────────────────────────────────────────────────────────

async function validateAndNormalizeItems(
  items: AIReceiptItem[],
  existingCategories: string[],
): Promise<void> {
  for (const item of items) {
    if (
      !item.name_ru ||
      typeof item.quantity !== 'number' ||
      typeof item.price !== 'number' ||
      typeof item.total !== 'number' ||
      !item.category
    ) {
      logger.warn(`[RECEIPT_PARSER] Invalid item structure: ${JSON.stringify(item)}`);
      continue;
    }

    if (looksLikePromptLeak(item.name_ru)) {
      const safeOriginal =
        item.name_original && !looksLikePromptLeak(item.name_original) ? item.name_original : null;
      logger.warn(
        `[RECEIPT_PARSER] Prompt leak in name_ru: "${item.name_ru}", fallback: ${safeOriginal ?? 'generic'}`,
      );
      item.name_ru = safeOriginal || `Товар (${item.total})`;
    }

    if (!item.possible_categories || !Array.isArray(item.possible_categories)) {
      item.possible_categories = [];
    }

    if (existingCategories.length > 0) {
      const { findBestCategoryMatch } = await import('../../utils/fuzzy-search');

      if (!existingCategories.includes(item.category)) {
        const closestMatch = findBestCategoryMatch(item.category, existingCategories);
        if (closestMatch) {
          item.category = closestMatch;
        } else {
          const fallback =
            existingCategories.find((c) => c === 'Разное') || existingCategories[0] || 'Разное';
          item.category = fallback;
        }
      }

      if (item.possible_categories.length > 0) {
        item.possible_categories = item.possible_categories.filter((cat) =>
          existingCategories.includes(cat),
        );
      }
    }
  }
}
