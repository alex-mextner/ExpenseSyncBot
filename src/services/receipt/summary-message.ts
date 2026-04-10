// Shared builder for the Telegram message sent after a receipt is saved.
// Used by both the bot photo handler flow and the Mini App confirm endpoint
// so that both paths produce an identical summary format.
import type { CurrencyCode } from '../../config/constants';
import { formatAmount } from '../../services/currency/converter';
import { escapeHtml } from '../../utils/html';
import { pluralize } from '../../utils/pluralize';
import { resolveCategoryEmojis } from './category-emoji-resolver';

/**
 * Normalized item shape both receipt flows map to before formatting.
 * qty and price are optional because the AI-correction flow in
 * receipt-summarizer loses them after the round-trip — only name and
 * total survive. When absent, the item line omits the "qty × price =" prefix.
 */
export interface ReceiptSummaryItem {
  name: string;
  qty?: number;
  price?: number;
  total: number;
  category: string;
  currency: CurrencyCode;
}

/** Telegram sendMessage hard limit is 4096 characters — leave room for safety. */
const MAX_MESSAGE_LENGTH = 4000;

/**
 * Build the receipt summary message: a header with per-category totals and an
 * expandable blockquote containing every item with quantity × price = total.
 * Async because category emoji resolution may hit HF for unknown categories
 * (cached in the category_emoji_cache table after the first lookup).
 */
export async function buildReceiptSummaryMessage(items: ReceiptSummaryItem[]): Promise<string> {
  if (items.length === 0) return '';

  const currency = items[0]?.currency ?? ('EUR' as CurrencyCode);

  // Aggregate by category
  const byCategory = new Map<string, number>();
  let grandTotal = 0;
  for (const item of items) {
    grandTotal += item.total;
    byCategory.set(item.category, (byCategory.get(item.category) ?? 0) + item.total);
  }

  // Resolve emojis once per unique category (sync exact match + async HF fallback)
  const emojiByCategory = await resolveCategoryEmojis(Array.from(byCategory.keys()));

  const countWord = pluralize(items.length, 'позиция', 'позиции', 'позиций');
  const lines: string[] = [`🧾 <b>Чек обработан — ${items.length} ${countWord}:</b>`];

  for (const [cat, total] of byCategory) {
    const emoji = emojiByCategory.get(cat) ?? '💰';
    lines.push(`${emoji} ${escapeHtml(cat)}: ${formatAmount(total, currency)}`);
  }

  lines.push(`\n💰 <b>Итого:</b> ${formatAmount(grandTotal, currency)}`);

  // Full item list in an expandable blockquote
  const itemLines = items.map((item) => {
    const name = escapeHtml(item.name);
    const totalStr = formatAmount(item.total, currency);
    if (item.qty !== undefined && item.price !== undefined) {
      return `• ${name} — ${item.qty}×${formatAmount(item.price, currency)} = ${totalStr}`;
    }
    return `• ${name} = ${totalStr}`;
  });

  lines.push(`\n<blockquote expandable>${itemLines.join('\n')}</blockquote>`);

  const text = lines.join('\n');
  if (text.length <= MAX_MESSAGE_LENGTH) return text;

  // Truncate inside the blockquote while keeping HTML balanced
  return `${text.slice(0, MAX_MESSAGE_LENGTH - 20)}…</blockquote>`;
}
