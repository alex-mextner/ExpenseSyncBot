/** Receipt summarizer — uses Hugging Face to generate a human-readable summary of receipt items */
import { InferenceClient } from '@huggingface/inference';
import { BASE_CURRENCY, type CurrencyCode } from '../../config/constants';
import { env } from '../../config/env';
import type { ReceiptItem } from '../../database/types';
import { formatAmount } from '../../services/currency/converter';
import { escapeHtml } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';

const logger = createLogger('receipt-summarizer');

const client = new InferenceClient(env.HF_TOKEN);

/**
 * Summary item structure
 */
export interface SummaryItem {
  name: string;
  total: number;
}

/**
 * Category in summary
 */
export interface SummaryCategory {
  name: string;
  items: SummaryItem[];
}

/**
 * Receipt summary structure
 */
export interface ReceiptSummary {
  categories: SummaryCategory[];
  totalAmount: number;
  currency: string;
}

/**
 * Correction history entry
 */
export interface CorrectionEntry {
  user: string;
  result: string;
}

/**
 * Category emoji map
 */
const CATEGORY_EMOJIS: Record<string, string> = {
  Еда: '🍔',
  Продукты: '🍔',
  Дом: '🏠',
  Хозтовары: '🧹',
  Транспорт: '🚗',
  Здоровье: '💊',
  Развлечения: '🎬',
  Одежда: '👕',
  Техника: '📱',
  Разное: '🛒',
};

/**
 * Get emoji for category
 */
function getCategoryEmoji(category: string): string {
  // Try exact match
  if (CATEGORY_EMOJIS[category]) {
    return CATEGORY_EMOJIS[category];
  }

  // Try partial match
  for (const [key, emoji] of Object.entries(CATEGORY_EMOJIS)) {
    if (category.toLowerCase().includes(key.toLowerCase())) {
      return emoji;
    }
  }

  return '📦';
}

/**
 * Build summary from receipt items (simple algorithm, no AI)
 */
export function buildSummaryFromItems(items: ReceiptItem[]): ReceiptSummary {
  const byCategory = new Map<string, ReceiptItem[]>();

  for (const item of items) {
    const cat = item.suggested_category;
    if (!byCategory.has(cat)) {
      byCategory.set(cat, []);
    }
    byCategory.get(cat)?.push(item);
  }

  return {
    categories: Array.from(byCategory.entries()).map(([name, catItems]) => ({
      name,
      items: catItems.map((i) => ({ name: i.name_ru, total: i.total })),
    })),
    totalAmount: items.reduce((sum, i) => sum + i.total, 0),
    currency: items[0]?.currency || BASE_CURRENCY,
  };
}

/**
 * Format summary for Telegram message
 */
export function formatSummaryMessage(summary: ReceiptSummary, itemCount: number): string {
  let message = `🧾 <b>Распознан чек (${itemCount} позиций):</b>\n\n`;

  for (const category of summary.categories) {
    const emoji = getCategoryEmoji(category.name);
    const itemNames = category.items.map((i) => i.name);

    // Show max 3 items, then "и еще X позиций"
    const maxShow = 3;
    let itemsText: string;

    if (itemNames.length <= maxShow) {
      itemsText = itemNames.join(', ');
    } else {
      const shown = itemNames.slice(0, maxShow).join(', ');
      const remaining = itemNames.length - maxShow;
      itemsText = `${shown} и еще ${remaining} позиций`;
    }

    message += `${emoji} <b>${escapeHtml(category.name)}:</b> ${escapeHtml(itemsText)}\n`;
  }

  message += `\n💰 <b>Итого:</b> ${formatAmount(summary.totalAmount, summary.currency as CurrencyCode)}`;

  return message;
}

/**
 * Validate that summary totals match original (within 1%)
 */
export function validateSummaryTotals(newSummary: ReceiptSummary, originalTotal: number): boolean {
  const newTotal = newSummary.categories.reduce(
    (sum, cat) => sum + cat.items.reduce((s, item) => s + item.total, 0),
    0,
  );

  if (originalTotal === 0) return newTotal === 0;

  const diff = Math.abs(newTotal - originalTotal) / originalTotal;
  return diff <= 0.01; // ±1%
}

/**
 * Apply user correction using AI
 */
export async function applyCorrectionWithAI(
  currentSummary: ReceiptSummary,
  userCorrection: string,
  availableCategories: string[],
  correctionHistory: CorrectionEntry[],
): Promise<ReceiptSummary> {
  const historyText =
    correctionHistory.length > 0
      ? correctionHistory.map((e) => `- Пользователь: "${e.user}" → ${e.result}`).join('\n')
      : 'Нет предыдущих корректировок';

  const prompt = `Ты обрабатываешь корректировку пользователя для сводки расходов из чека.

ТЕКУЩАЯ СВОДКА (JSON):
${JSON.stringify(currentSummary, null, 2)}

ДОСТУПНЫЕ КАТЕГОРИИ: ${availableCategories.join(', ')}

КОРРЕКТИРОВКА ПОЛЬЗОВАТЕЛЯ:
"${userCorrection}"

ИСТОРИЯ КОРРЕКТИРОВОК:
${historyText}

ЗАДАЧА: Примени корректировку и верни обновленный JSON.

ВАЖНО:
- Используй ТОЛЬКО категории из списка доступных
- Сохраняй все items, только перемещай между категориями
- Если пользователь хочет объединить категории - перенеси все items из одной в другую
- Если категория пустеет - удали её из списка
- НЕ меняй total у items - это суммы из чека
- totalAmount должен остаться таким же: ${currentSummary.totalAmount}
- currency должен остаться таким же: ${currentSummary.currency}

ФОРМАТ ОТВЕТА (строго JSON, без markdown, без пояснений):
{
  "categories": [
    {"name": "Категория", "items": [{"name": "Товар", "total": 100}]}
  ],
  "totalAmount": ${currentSummary.totalAmount},
  "currency": "${currentSummary.currency}"
}`;

  logger.info(`[RECEIPT_SUMMARIZER] Sending correction to AI: "${userCorrection}"`);

  const response = await client.chatCompletion({
    provider: 'novita',
    model: 'deepseek-ai/DeepSeek-R1-0528',
    messages: [
      {
        role: 'system',
        content:
          'You are a JSON processor. Apply user corrections to receipt summaries. Return only valid JSON, no explanations.',
      },
      {
        role: 'user',
        content: prompt,
      },
    ],
    max_tokens: 2000,
    temperature: 0.3,
  });

  const responseText = response.choices[0]?.message?.content?.trim();

  if (!responseText) {
    throw new Error('Empty response from AI');
  }

  // Remove thinking tags
  const cleanedResponse = responseText.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();

  logger.info(`[RECEIPT_SUMMARIZER] AI response: ${cleanedResponse.substring(0, 200)}...`);

  // Extract JSON
  const jsonMatch =
    cleanedResponse.match(/```(?:json)?\s*(\{[\s\S]*?\})\s*```/) ||
    cleanedResponse.match(/(\{[\s\S]*\})/);

  if (!jsonMatch || !jsonMatch[1]) {
    throw new Error('No valid JSON in AI response');
  }

  const parsed = JSON.parse(jsonMatch[1]) as ReceiptSummary;

  // Validate structure
  if (!parsed.categories || !Array.isArray(parsed.categories)) {
    throw new Error('Invalid summary structure: missing categories array');
  }

  // Ensure totalAmount and currency are preserved
  parsed.totalAmount = currentSummary.totalAmount;
  parsed.currency = currentSummary.currency;

  return parsed;
}

/**
 * Convert summary back to category mapping for saving
 * Returns map: itemName -> category
 */
export function summaryToCategoryMap(summary: ReceiptSummary): Map<string, string> {
  const map = new Map<string, string>();

  for (const category of summary.categories) {
    for (const item of category.items) {
      map.set(item.name, category.name);
    }
  }

  return map;
}
