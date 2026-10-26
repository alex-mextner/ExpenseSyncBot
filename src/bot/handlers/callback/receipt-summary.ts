/**
 * "receipt:<accept_all|bulk_edit|itemwise|accept_bulk|cancel>:<queueId>" callbacks —
 * actions on the receipt summary message.
 */
import { database } from '../../../database';
import type { Group, PhotoQueueItem, ReceiptItem, User } from '../../../database/types';
import { sendMessage } from '../../../services/bank/telegram-sender';
import { createLogger } from '../../../utils/logger.ts';
import { saveReceiptExpenses } from '../../services/expense-saver';
import type { BotInstance } from '../../types';
import {
  type CallbackCtx,
  deletePromptMessageQuietly,
  ensureCategory,
  ensureUserInGroup,
  parseIntSegment,
} from './shared';

const logger = createLogger('callback.handler');

interface ReceiptCall {
  ctx: CallbackCtx;
  bot: BotInstance;
  queueItem: PhotoQueueItem;
  group: Group;
  user: User;
}

type ReceiptActionHandler = (call: ReceiptCall) => Promise<void>;

const RECEIPT_ACTIONS = new Map<string, ReceiptActionHandler>([
  ['accept_all', handleReceiptAcceptAll],
  ['bulk_edit', handleReceiptBulkEdit],
  ['itemwise', handleReceiptItemwise],
  ['accept_bulk', handleReceiptAcceptBulk],
  ['cancel', handleReceiptCancel],
]);

/** Mark every still-pending item confirmed with the category `categoryFor` picks. */
function confirmPendingItems(
  items: ReceiptItem[],
  group: Group,
  categoryFor: (item: ReceiptItem) => string,
  createMissingCategories: boolean,
): void {
  for (const item of items) {
    if (item.status !== 'pending') continue;

    const category = categoryFor(item);
    database.receiptItems.update(item.id, {
      status: 'confirmed',
      confirmed_category: category,
    });

    if (createMissingCategories) ensureCategory(group.id, category);
  }
}

function suggestedCategory(item: ReceiptItem): string {
  return item.suggested_category;
}

/**
 * Accept all items as-is (using suggested categories)
 */
async function handleReceiptAcceptAll({
  ctx,
  bot,
  queueItem,
  group,
  user,
}: ReceiptCall): Promise<void> {
  const items = database.receiptItems.findByPhotoQueueId(queueItem.id);

  confirmPendingItems(items, group, suggestedCategory, true);

  await ctx.answerCallbackQuery({ text: '✅ Принято!' });
  await deletePromptMessageQuietly(ctx, bot);

  // Save to Google Sheets
  await saveReceiptExpenses(queueItem.id, group.id, user.id);
}

/**
 * Enter bulk edit mode (AI correction)
 */
async function handleReceiptBulkEdit({ ctx, bot, queueItem }: ReceiptCall): Promise<void> {
  const messageId = ctx.message?.id;
  const chatId = ctx.message?.chat?.id;

  // Set waiting for bulk correction flag
  database.photoQueue.update(queueItem.id, {
    summary_mode: 1,
    waiting_for_bulk_correction: 1,
    summary_message_id: messageId || null,
  });

  await ctx.answerCallbackQuery({ text: '🎨 Напишите корректировку' });

  // Update message to show instruction (no buttons - user just types correction text)
  if (!messageId || !chatId) return;

  const items = database.receiptItems.findByPhotoQueueId(queueItem.id);
  const { buildSummaryFromItems, formatSummaryMessage } = await import(
    '../../../services/receipt/receipt-summarizer'
  );

  const summary = buildSummaryFromItems(items);
  const summaryText = formatSummaryMessage(summary, items.length);

  const message = `${summaryText}\n\n✏️ <i>Напишите корректировку текстом, например:</i>\n<code>перенеси салфетки в Хозтовары</code>`;

  try {
    await bot.api.editMessageText({
      chat_id: chatId,
      message_id: messageId,
      text: message,
      parse_mode: 'HTML',
    });
  } catch (error) {
    logger.error({ err: error }, '[RECEIPT] Failed to edit message');
  }
}

/**
 * Switch to item-by-item mode
 */
async function handleReceiptItemwise({ ctx, bot, queueItem, group }: ReceiptCall): Promise<void> {
  // Reset summary mode flags
  database.photoQueue.update(queueItem.id, {
    summary_mode: 0,
    waiting_for_bulk_correction: 0,
    ai_summary: null,
    correction_history: null,
  });

  await ctx.answerCallbackQuery({ text: '📦 По одной позиции' });
  await deletePromptMessageQuietly(ctx, bot);

  // Show first item
  const { showNextItemForConfirmation } = await import('../../../services/receipt/photo-processor');
  await showNextItemForConfirmation(group.id, queueItem.id);
}

/**
 * Confirm pending items with the categories of the AI-corrected summary. When the summary
 * cannot be applied, fall back to each item's suggested category (without creating categories).
 */
async function applyBulkCategories(
  queueItem: PhotoQueueItem,
  items: ReceiptItem[],
  group: Group,
): Promise<void> {
  if (!queueItem.ai_summary) {
    // No AI summary - use suggested categories
    confirmPendingItems(items, group, suggestedCategory, true);
    return;
  }

  try {
    const summary = JSON.parse(queueItem.ai_summary);
    const { summaryToCategoryMap } = await import('../../../services/receipt/receipt-summarizer');
    const categoryMap = summaryToCategoryMap(summary);

    confirmPendingItems(
      items,
      group,
      (item) => categoryMap.get(item.name_ru) || item.suggested_category,
      true,
    );
  } catch (error) {
    logger.error({ err: error }, '[RECEIPT] Failed to parse AI summary');
    // Fall back to suggested categories
    confirmPendingItems(items, group, suggestedCategory, false);
  }
}

/**
 * Accept bulk edit result
 */
async function handleReceiptAcceptBulk({
  ctx,
  bot,
  queueItem,
  group,
  user,
}: ReceiptCall): Promise<void> {
  const items = database.receiptItems.findByPhotoQueueId(queueItem.id);

  await applyBulkCategories(queueItem, items, group);

  // Reset summary mode
  database.photoQueue.update(queueItem.id, {
    summary_mode: 0,
    waiting_for_bulk_correction: 0,
  });

  await ctx.answerCallbackQuery({ text: '✅ Принято!' });
  await deletePromptMessageQuietly(ctx, bot);

  // Save to Google Sheets
  await saveReceiptExpenses(queueItem.id, group.id, user.id);
}

/**
 * Cancel receipt processing
 */
async function handleReceiptCancel({ ctx, bot, queueItem }: ReceiptCall): Promise<void> {
  // Delete all receipt items
  database.receiptItems.deleteProcessedByPhotoQueueId(queueItem.id);

  // Reset queue item
  database.photoQueue.update(queueItem.id, {
    status: 'done',
    summary_mode: 0,
    waiting_for_bulk_correction: 0,
    ai_summary: null,
    correction_history: null,
  });

  await ctx.answerCallbackQuery({ text: '❌ Отменено' });
  await deletePromptMessageQuietly(ctx, bot);

  // Send cancellation notification
  await sendMessage('❌ Обработка чека отменена');
}

/** Resolve queue item, its group and the acting user, answering the first missing piece. */
async function resolveReceiptContext(
  ctx: CallbackCtx,
  queueId: number,
  telegramId: number,
): Promise<Omit<ReceiptCall, 'ctx' | 'bot'> | null> {
  const queueItem = database.photoQueue.findById(queueId);

  if (!queueItem) {
    await ctx.answerCallbackQuery({ text: 'Чек не найден' });
    return null;
  }

  // Use group from queueItem (where receipt was created)
  const group = database.groups.findById(queueItem.group_id);

  if (!group) {
    await ctx.answerCallbackQuery({ text: 'Группа не найдена' });
    return null;
  }

  // Ensure user exists and is linked to group
  const result = ensureUserInGroup(telegramId, ctx.message?.chat?.id);
  const user = result?.user ?? database.users.findByTelegramId(telegramId);

  if (!user) {
    await ctx.answerCallbackQuery({ text: 'Пользователь не найден' });
    return null;
  }

  return { queueItem, group, user };
}

/**
 * Handle receipt summary actions (accept_all, bulk_edit, itemwise, accept_bulk, cancel)
 */
export async function handleReceiptSummaryAction(
  ctx: CallbackCtx,
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  const [subAction, queueIdStr] = params;

  if (!subAction || !queueIdStr) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }

  const queueId = parseIntSegment(queueIdStr);

  if (queueId === null) {
    await ctx.answerCallbackQuery({ text: 'Invalid queue ID' });
    return;
  }

  const resolved = await resolveReceiptContext(ctx, queueId, telegramId);
  if (!resolved) return;

  const handler = RECEIPT_ACTIONS.get(subAction);
  if (!handler) {
    await ctx.answerCallbackQuery({ text: 'Unknown receipt action' });
    return;
  }
  await handler({ ctx, bot, ...resolved });
}
