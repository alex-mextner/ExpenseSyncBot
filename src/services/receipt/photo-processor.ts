import type { Bot } from 'gramio';
import { createReceiptSummaryKeyboard } from '../../bot/keyboards';
import type { CurrencyCode } from '../../config/constants';
import { env } from '../../config/env';
import { database } from '../../database';
import { createLogger } from '../../utils/logger.ts';
import {
  type AIExtractionResult,
  type AIReceiptItem,
  extractExpensesFromReceipt,
} from './ai-extractor';
import { scanQRFromImage } from './qr-scanner';
import { fetchReceiptData } from './receipt-fetcher';
import { buildSummaryFromItems, formatSummaryMessage } from './receipt-summarizer';

const logger = createLogger('photo-processor');

let isProcessing = false;

/**
 * Escape HTML special characters for Telegram
 */
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Start background photo processor
 * Processes photos from the queue and extracts receipt data
 */
export async function startPhotoProcessor(bot: Bot): Promise<void> {
  logger.info('[PHOTO_PROCESSOR] Starting background photo processor');

  // Process queue every 5 seconds
  setInterval(async () => {
    if (isProcessing) {
      return;
    }

    isProcessing = true;

    try {
      await processQueue(bot);
    } catch (error) {
      logger.error({ err: error }, '[PHOTO_PROCESSOR] Error in processor');
    } finally {
      isProcessing = false;
    }
  }, 5000);
}

/**
 * Process all pending items in the queue
 */
async function processQueue(bot: Bot): Promise<void> {
  const pendingItems = database.photoQueue.findPending();

  if (pendingItems.length === 0) {
    return;
  }

  logger.info(`[PHOTO_PROCESSOR] Processing ${pendingItems.length} pending item(s)`);

  for (const item of pendingItems) {
    try {
      await processPhotoQueueItem(bot, item.id);
    } catch (error) {
      logger.error({ err: error }, `[PHOTO_PROCESSOR] Error processing item ${item.id}`);
    }
  }
}

/**
 * Save extracted items to receipt_items table
 * Reusable for both photo processing and link analysis
 */
export function saveExtractedItems(
  photoQueueId: number,
  items: AIReceiptItem[],
  currency: CurrencyCode,
): void {
  for (const item of items) {
    database.receiptItems.create({
      photo_queue_id: photoQueueId,
      name_ru: item.name_ru,
      name_original: item.name_original,
      quantity: item.quantity,
      price: item.price,
      total: item.total,
      currency,
      suggested_category: item.category,
      possible_categories: item.possible_categories || [],
      status: 'pending',
    });
  }

  database.photoQueue.update(photoQueueId, { status: 'done' });

  logger.info(`[PHOTO_PROCESSOR] Saved ${items.length} items for queue #${photoQueueId}`);
}

/**
 * Process a single photo queue item
 */
async function processPhotoQueueItem(bot: Bot, queueItemId: number): Promise<void> {
  const queueItem = database.photoQueue.findById(queueItemId);

  if (!queueItem || queueItem.status !== 'pending') {
    return;
  }

  logger.info(`[PHOTO_PROCESSOR] Processing queue item #${queueItemId}`);

  // Update status to processing
  database.photoQueue.update(queueItemId, { status: 'processing' });

  // Get telegram group ID and set 👀 reaction to indicate processing started
  const group = database.groups.findById(queueItem.group_id);
  if (group) {
    try {
      await bot.api.setMessageReaction({
        chat_id: group.telegram_group_id,
        message_id: queueItem.message_id,
        reaction: [{ type: 'emoji', emoji: '👀' }],
      });
      logger.info(`[PHOTO_PROCESSOR] Set 👀 reaction for message - processing started`);
    } catch (error) {
      logger.error({ err: error }, '[PHOTO_PROCESSOR] Failed to set reaction');
    }
  }

  try {
    // Download photo from Telegram
    const photoBuffer = await downloadPhoto(bot, queueItem.file_id);

    // Save processed image to disk for debugging
    try {
      const sharp = (await import('sharp')).default;
      const fs = await import('node:fs/promises');
      const path = await import('node:path');

      const processedBuffer = await sharp(photoBuffer)
        .resize(1280, 1280, { fit: 'inside', withoutEnlargement: true })
        .jpeg({ quality: 90 })
        .toBuffer();

      // Create debug directory if doesn't exist
      const debugDir = path.join(process.cwd(), 'debug-images');
      await fs.mkdir(debugDir, { recursive: true });

      // Save with timestamp
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const filename = `qr-${queueItemId}-${timestamp}.jpg`;
      const filepath = path.join(debugDir, filename);

      await fs.writeFile(filepath, processedBuffer);
      logger.info(`[PHOTO_PROCESSOR] 🔍 Debug image saved: ${filepath}`);
    } catch (debugError) {
      logger.error({ err: debugError }, '[PHOTO_PROCESSOR] Failed to save debug image');
    }

    // Scan QR code
    const qrData = await scanQRFromImage(photoBuffer);

    let receiptData: string;

    if (!qrData) {
      // No QR code found - try OCR fallback
      logger.info(
        `[PHOTO_PROCESSOR] No QR code found in photo #${queueItemId}, trying OCR fallback`,
      );

      try {
        const { extractTextFromImage } = await import('./ocr-extractor');
        receiptData = await extractTextFromImage(photoBuffer);
        logger.info(`[PHOTO_PROCESSOR] OCR successful, extracted ${receiptData.length} chars`);
      } catch (ocrError) {
        const ocrErrorMessage = ocrError instanceof Error ? ocrError.message : 'Unknown error';
        logger.error(`[PHOTO_PROCESSOR] OCR also failed: ${ocrErrorMessage}`);

        // Both QR and OCR failed - mark as done and set reaction
        database.photoQueue.update(queueItemId, { status: 'done' });

        // Get telegram group ID and set reaction
        const group = database.groups.findById(queueItem.group_id);
        if (group) {
          try {
            await bot.api.setMessageReaction({
              chat_id: group.telegram_group_id,
              message_id: queueItem.message_id,
              reaction: [{ type: 'emoji', emoji: '🤷‍♂' as any }],
            });
            logger.info(`[PHOTO_PROCESSOR] Set 🤷‍♂️ reaction - both QR and OCR failed`);
          } catch (error) {
            logger.error({ err: error }, '[PHOTO_PROCESSOR] Failed to set reaction');
          }
        }

        return;
      }
    } else {
      logger.info(`[PHOTO_PROCESSOR] QR code found: ${qrData.substring(0, 100)}...`);

      // Fetch receipt data from QR
      try {
        receiptData = await fetchReceiptData(qrData);
      } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        logger.error(
          `[PHOTO_PROCESSOR] Failed to fetch receipt data from QR, trying OCR fallback: ${errorMessage}`,
        );

        // Try OCR as fallback when QR fetch fails
        try {
          const { extractTextFromImage } = await import('./ocr-extractor');
          receiptData = await extractTextFromImage(photoBuffer);
          logger.info(`[PHOTO_PROCESSOR] OCR fallback successful after QR fetch failed`);
        } catch (ocrError) {
          // Both QR fetch and OCR failed
          const ocrErrorMessage = ocrError instanceof Error ? ocrError.message : 'Unknown error';
          logger.error(`[PHOTO_PROCESSOR] OCR also failed: ${ocrErrorMessage}`);

          database.photoQueue.update(queueItemId, {
            status: 'error',
            error_message: `❌ Не удалось загрузить чек: ${errorMessage}`,
          });

          // Notify user
          await notifyUser(
            bot,
            queueItem.group_id,
            `❌ Не удалось загрузить чек: ${errorMessage}`,
            queueItem.message_thread_id,
          );
          return;
        }
      }
    }

    // Get existing categories for the group
    const categories = database.categories.findByGroupId(queueItem.group_id);
    const categoryNames = categories.map((c) => c.name);

    // Extract expenses using AI
    let extractionResult: AIExtractionResult;
    try {
      extractionResult = await extractExpensesFromReceipt(receiptData, categoryNames);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error(`[PHOTO_PROCESSOR] Failed to extract expenses: ${errorMessage}`);
      database.photoQueue.update(queueItemId, {
        status: 'error',
        error_message: `❌ AI не распознал чек: ${errorMessage}`,
      });

      // Notify user
      await notifyUser(
        bot,
        queueItem.group_id,
        `❌ AI не распознал чек: ${errorMessage}`,
        queueItem.message_thread_id,
      );
      return;
    }

    if (!extractionResult.items || extractionResult.items.length === 0) {
      database.photoQueue.update(queueItemId, {
        status: 'error',
        error_message: '❌ В чеке не найдены расходы',
      });

      // Notify user
      await notifyUser(
        bot,
        queueItem.group_id,
        '❌ В чеке не найдены расходы',
        queueItem.message_thread_id,
      );
      return;
    }

    // Get group default currency if AI didn't detect it
    const group = database.groups.findById(queueItem.group_id);
    const currency = extractionResult.currency || group?.default_currency || 'EUR';

    // Save receipt items to database
    saveExtractedItems(queueItemId, extractionResult.items, currency);

    // Show confirmation options (summary for >5 items, item-by-item otherwise)
    await showReceiptConfirmationOptions(bot, queueItem.group_id, queueItemId);
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    logger.error({ err: errorMessage }, '[PHOTO_PROCESSOR] Unexpected error');

    database.photoQueue.update(queueItemId, {
      status: 'error',
      error_message: `❌ Ошибка обработки: ${errorMessage}`,
    });

    // Notify user
    await notifyUser(
      bot,
      queueItem.group_id,
      `❌ Ошибка обработки: ${errorMessage}`,
      queueItem.message_thread_id,
    );
  }
}

/**
 * Download photo from Telegram
 */
async function downloadPhoto(bot: Bot, fileId: string): Promise<Buffer> {
  // Get file info
  const file = await bot.api.getFile({ file_id: fileId });

  if (!file.file_path) {
    throw new Error('File path not found');
  }

  // Download file
  const url = `https://api.telegram.org/file/bot${env.BOT_TOKEN}/${file.file_path}`;
  const response = await fetch(url);

  if (!response.ok) {
    throw new Error(`Failed to download file: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  return Buffer.from(arrayBuffer);
}

/**
 * Show receipt confirmation options
 * If items > 5: show summary with bulk options
 * Otherwise: show item-by-item confirmation
 */
export async function showReceiptConfirmationOptions(
  bot: Bot,
  groupId: number,
  photoQueueId: number,
): Promise<void> {
  const items = database.receiptItems.findByPhotoQueueId(photoQueueId);
  const pendingItems = items.filter((item) => item.status === 'pending');

  if (pendingItems.length === 0) {
    logger.info('[PHOTO_PROCESSOR] No pending items to confirm');
    return;
  }

  // If 5 or fewer items, use item-by-item confirmation
  if (pendingItems.length <= 5) {
    await showNextItemForConfirmation(bot, groupId, photoQueueId);
    return;
  }

  // More than 5 items - show summary with options
  const group = database.groups.findById(groupId);
  if (!group) {
    logger.error(`[PHOTO_PROCESSOR] Group not found: ${groupId}`);
    return;
  }

  // Build summary from items
  const summary = buildSummaryFromItems(pendingItems);
  const summaryMessage = formatSummaryMessage(summary, pendingItems.length);

  // Store summary in photo queue
  database.photoQueue.update(photoQueueId, {
    ai_summary: JSON.stringify(summary),
    summary_mode: 1,
  });

  // Get thread ID from photo queue
  const queueItem = database.photoQueue.findById(photoQueueId);

  // Send summary message with keyboard
  const sentMessage = await bot.api.sendMessage({
    chat_id: group.telegram_group_id,
    ...(queueItem?.message_thread_id && { message_thread_id: queueItem.message_thread_id }),
    text: summaryMessage,
    parse_mode: 'HTML',
    reply_markup: createReceiptSummaryKeyboard(photoQueueId).toJSON(),
  });

  // Store message ID for later editing
  database.photoQueue.update(photoQueueId, {
    summary_message_id: sentMessage.message_id,
  });

  logger.info(
    `[PHOTO_PROCESSOR] Showed receipt summary for ${pendingItems.length} items, queue #${photoQueueId}`,
  );
}

/**
 * Show next pending receipt item for confirmation
 */
export async function showNextItemForConfirmation(
  bot: Bot,
  groupId: number,
  photoQueueId?: number,
): Promise<void> {
  // If photo_queue_id provided, find next pending item from that receipt only
  let nextItem: ReturnType<typeof database.receiptItems.findNextPending> = null;

  if (photoQueueId) {
    const allItems = database.receiptItems.findByPhotoQueueId(photoQueueId);
    nextItem = allItems.find((item) => item.status === 'pending') || null;
  } else {
    nextItem = database.receiptItems.findNextPending();
  }

  if (!nextItem) {
    logger.info('[PHOTO_PROCESSOR] No more pending items to confirm');
    return;
  }

  const group = database.groups.findById(groupId);

  if (!group) {
    logger.error(`[PHOTO_PROCESSOR] Group not found: ${groupId}`);
    return;
  }

  // Collect all confirmed categories from this receipt (custom categories from user)
  const allItemsFromReceipt = database.receiptItems.findByPhotoQueueId(nextItem.photo_queue_id);
  const confirmedCategories = allItemsFromReceipt
    .map((item) => (item.status === 'confirmed' ? item.confirmed_category : null))
    .filter((cat): cat is string => cat !== null);

  // Merge with possible_categories, ensuring no duplicates
  const allPossibleCategories = [...nextItem.possible_categories, ...confirmedCategories].filter(
    (cat, index, self) => cat !== nextItem.suggested_category && self.indexOf(cat) === index,
  );

  logger.info(
    `[PHOTO_PROCESSOR] Item ${nextItem.id}: suggested="${nextItem.suggested_category}", possible=${JSON.stringify(allPossibleCategories)}, confirmed from receipt=${JSON.stringify(confirmedCategories)}`,
  );

  // Build confirmation message (escape HTML special characters)
  let message = `🧾 <b>Подтвердите товар из чека:</b>\n\n`;
  message += `📦 <b>${escapeHtml(nextItem.name_ru)}</b>`;
  if (nextItem.name_original) {
    message += ` (${escapeHtml(nextItem.name_original)})`;
  }
  message += `\n`;
  message += `🔢 Количество: <code>${nextItem.quantity}</code>\n`;
  message += `💰 Цена: <code>${nextItem.price} ${escapeHtml(nextItem.currency)}</code>\n`;
  message += `💵 Сумма: <code>${nextItem.total} ${escapeHtml(nextItem.currency)}</code>\n`;
  message += `\n📂 Предложенная категория: <b>${escapeHtml(nextItem.suggested_category)}</b>`;

  // Build inline keyboard with possible categories
  const buttons: Array<Array<{ text: string; callback_data: string }>> = [];

  // Add suggested category as first button (use index -1 for suggested)
  buttons.push([
    {
      text: `✅ ${nextItem.suggested_category}`,
      callback_data: `confirm_receipt_item:${nextItem.id}:-1`,
    },
  ]);

  // Add all possible categories (including confirmed custom ones) with their indices
  if (allPossibleCategories.length > 0) {
    for (let i = 0; i < allPossibleCategories.length; i++) {
      const category = allPossibleCategories[i]!;
      buttons.push([
        {
          text: category,
          callback_data: `confirm_receipt_item:${nextItem.id}:${i}`,
        },
      ]);
    }
  }

  // Add "Other category" button
  buttons.push([
    {
      text: '✏️ Другая категория (напишите текстом)',
      callback_data: `receipt_item_other:${nextItem.id}`,
    },
  ]);

  // Add "Skip" button
  buttons.push([
    {
      text: '⏭️ Пропустить товар',
      callback_data: `skip_receipt_item:${nextItem.id}`,
    },
  ]);

  // Get thread ID from current item's photo queue
  const queueItem = database.photoQueue.findById(nextItem.photo_queue_id);

  logger.info(
    {
      data: {
        photoQueueId: nextItem.photo_queue_id,
        queueItem,
        messageThreadId: queueItem?.message_thread_id,
        willIncludeThreadId: !!queueItem?.message_thread_id,
      },
    },
    '[PHOTO_PROCESSOR] Sending confirmation',
  );

  // Send message to group
  await bot.api.sendMessage({
    chat_id: group.telegram_group_id,
    ...(queueItem?.message_thread_id && { message_thread_id: queueItem.message_thread_id }),
    text: message,
    parse_mode: 'HTML',
    reply_markup: {
      inline_keyboard: buttons,
    },
  });
}

/**
 * Notify user about errors
 */
async function notifyUser(
  bot: Bot,
  groupId: number,
  message: string,
  messageThreadId?: number | null,
): Promise<void> {
  const group = database.groups.findById(groupId);

  if (!group) {
    logger.error(`[PHOTO_PROCESSOR] Group not found: ${groupId}`);
    return;
  }

  await bot.api.sendMessage({
    chat_id: group.telegram_group_id,
    ...(messageThreadId && { message_thread_id: messageThreadId }),
    text: message,
    parse_mode: 'HTML',
  });
}
