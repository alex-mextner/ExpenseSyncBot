import type { BotInstance } from '../../bot/types';
import type { CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import type { Group, User } from '../../database/types';
import { createLogger } from '../../utils/logger.ts';
import type { AIReceiptItem } from './ai-extractor';
import { extractExpensesFromReceipt } from './ai-extractor';
import { saveExtractedItems, showReceiptConfirmationOptions } from './photo-processor';
import { fetchReceiptData } from './receipt-fetcher';

const logger = createLogger('link-analyzer');

/**
 * Extract URLs from text message
 */
export function extractURLsFromText(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`[\]]+/gi;
  return text.match(urlRegex) || [];
}

/**
 * Process payment links in message
 * @returns true if any payment links were found and processed
 */
export async function processPaymentLinks(
  bot: BotInstance,
  chatId: number,
  messageId: number,
  urls: string[],
  group: Group,
  user: User,
): Promise<boolean> {
  let found = false;

  for (const url of urls) {
    logger.info(`[LINK] Analyzing: ${url}`);

    // Set 👀 reaction
    try {
      await bot.api.setMessageReaction({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: 'emoji', emoji: '👀' }],
      });
    } catch {}

    // Fetch and analyze
    const result = await analyzeLink(url, group.id);

    if (!result) {
      logger.info(`[LINK] Not a payment link: ${url}`);
      continue;
    }

    logger.info(`[LINK] Payment! ${result.items.length} items`);
    found = true;

    // Create queue entry
    const queueItem = database.photoQueue.create({
      group_id: group.id,
      user_id: user.id,
      message_id: messageId,
      message_thread_id: null,
      file_id: `link:${url}`,
      status: 'pending',
    });

    // Save and show (summary for >5 items, item-by-item otherwise)
    saveExtractedItems(queueItem.id, result.items, result.currency);
    await showReceiptConfirmationOptions(bot, group.id, queueItem.id);
  }

  // Remove reaction if nothing found
  if (!found) {
    try {
      await bot.api.setMessageReaction({
        chat_id: chatId,
        message_id: messageId,
        reaction: [],
      });
    } catch {}
  }

  return found;
}

/**
 * Analyze single URL - returns items if payment link, null otherwise
 */
async function analyzeLink(
  url: string,
  groupId: number,
): Promise<{ items: AIReceiptItem[]; currency: CurrencyCode } | null> {
  try {
    const content = await fetchReceiptData(url);
    if (content.length < 50) return null;

    const categories = database.categories.findByGroupId(groupId);
    const result = await extractExpensesFromReceipt(
      content,
      categories.map((c) => c.name),
    );

    if (!result.items?.length) return null;

    const group = database.groups.findById(groupId);
    return {
      items: result.items,
      currency: result.currency || group?.default_currency || 'EUR',
    };
  } catch (error) {
    logger.error(`[LINK] Error: ${error}`);
    return null;
  }
}
