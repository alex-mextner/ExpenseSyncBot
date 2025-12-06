import type { CurrencyCode } from "../../config/constants";
import type { Group, User } from "../../database/types";
import { database } from "../../database";
import { fetchReceiptData } from "./receipt-fetcher";
import { extractExpensesFromReceipt } from "./ai-extractor";
import { saveExtractedItems, showNextItemForConfirmation } from "./photo-processor";

/**
 * Extract URLs from text message
 */
export function extractURLsFromText(text: string): string[] {
  const urlRegex = /https?:\/\/[^\s<>"{}|\\^`\[\]]+/gi;
  return text.match(urlRegex) || [];
}

/**
 * Process payment links in message
 * @returns true if any payment links were found and processed
 */
export async function processPaymentLinks(
  bot: any,
  chatId: number,
  messageId: number,
  urls: string[],
  group: Group,
  user: User
): Promise<boolean> {
  let found = false;

  for (const url of urls) {
    console.log(`[LINK] Analyzing: ${url}`);

    // Set 👀 reaction
    try {
      await bot.api.setMessageReaction({
        chat_id: chatId,
        message_id: messageId,
        reaction: [{ type: "emoji", emoji: "👀" }],
      });
    } catch {}

    // Fetch and analyze
    const result = await analyzeLink(url, group.id);

    if (!result) {
      console.log(`[LINK] Not a payment link: ${url}`);
      continue;
    }

    console.log(`[LINK] Payment! ${result.items.length} items`);
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

    // Save and show
    saveExtractedItems(queueItem.id, result.items, result.currency);
    await showNextItemForConfirmation(bot, group.id, queueItem.id);
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
  groupId: number
): Promise<{ items: any[]; currency: CurrencyCode } | null> {
  try {
    const content = await fetchReceiptData(url);
    if (content.length < 50) return null;

    const categories = database.categories.findByGroupId(groupId);
    const result = await extractExpensesFromReceipt(content, categories.map(c => c.name));

    if (!result.items?.length) return null;

    const group = database.groups.findById(groupId);
    return {
      items: result.items,
      currency: result.currency || group?.default_currency || "EUR",
    };
  } catch (error) {
    console.error(`[LINK] Error: ${error}`);
    return null;
  }
}
