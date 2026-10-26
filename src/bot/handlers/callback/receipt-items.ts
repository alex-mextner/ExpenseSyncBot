/**
 * Per-item receipt callbacks: confirm_receipt_item, receipt_item_other, skip_receipt_item,
 * use_found_category, create_new_category.
 */
import { database } from '../../../database';
import type { ReceiptItem } from '../../../database/types';
import { sendMessage } from '../../../services/bank/telegram-sender';
import { saveReceiptExpenses } from '../../services/expense-saver';
import type { BotInstance } from '../../types';
import {
  type CallbackCtx,
  deletePromptMessage,
  ensureCategory,
  parseIntSegment,
  resolveUserGroup,
  type UserGroup,
} from './shared';

const INVALID_PARAMETERS = 'Invalid parameters';
const ITEM_NOT_FOUND_OR_DONE = 'Товар не найден или уже обработан';

/** How a receipt flow continues after one item changed state. */
type ReceiptProgress = 'all-done' | 'items-left';

function itemsProgress(
  photoQueueId: number,
  isDone: (item: ReceiptItem) => boolean,
): ReceiptProgress {
  return database.receiptItems.findByPhotoQueueId(photoQueueId).every(isDone)
    ? 'all-done'
    : 'items-left';
}

/** Save the receipt once every item is settled, otherwise prompt for the next pending item. */
async function continueReceiptFlow(
  { user, group }: UserGroup,
  photoQueueId: number,
  progress: ReceiptProgress,
): Promise<void> {
  if (progress === 'all-done') {
    await saveReceiptExpenses(photoQueueId, group.id, user.id);
    return;
  }
  const { showNextItemForConfirmation } = await import('../../../services/receipt/photo-processor');
  await showNextItemForConfirmation(group.id, photoQueueId);
}

/**
 * Category choices offered for an item: its possible categories plus categories the user
 * already confirmed on this receipt, minus the suggestion, deduplicated. Must stay identical
 * to the list built by showNextItemForConfirmation, since the callback carries an index.
 */
function offeredCategories(item: ReceiptItem, siblings: ReceiptItem[]): string[] {
  const confirmedCategories = siblings
    .map((sibling) => (sibling.status === 'confirmed' ? sibling.confirmed_category : null))
    .filter((cat): cat is string => cat !== null);

  return [...item.possible_categories, ...confirmedCategories].filter(
    (cat, index, self) => cat !== item.suggested_category && self.indexOf(cat) === index,
  );
}

/** Index -1 means the suggested category; otherwise an index into the offered list. */
function categoryForIndex(
  item: ReceiptItem,
  siblings: ReceiptItem[],
  categoryIndex: number,
): string | null {
  if (categoryIndex === -1) return item.suggested_category;
  return offeredCategories(item, siblings)[categoryIndex] || null;
}

/**
 * Handle receipt item confirmation
 */
export async function handleReceiptItemConfirm(
  ctx: CallbackCtx,
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  const itemId = parseIntSegment(params[0]);
  const categoryIndex = parseIntSegment(params[1]);

  if (itemId === null || categoryIndex === null) {
    await ctx.answerCallbackQuery({ text: INVALID_PARAMETERS });
    return;
  }

  const resolved = await resolveUserGroup(ctx, telegramId);
  if (!resolved) return;

  const item = database.receiptItems.findById(itemId);

  if (!item || item.status !== 'pending') {
    await ctx.answerCallbackQuery({ text: ITEM_NOT_FOUND_OR_DONE });
    return;
  }

  const category = categoryForIndex(
    item,
    database.receiptItems.findByPhotoQueueId(item.photo_queue_id),
    categoryIndex,
  );
  if (category === null) {
    await ctx.answerCallbackQuery({ text: 'Некорректный индекс категории' });
    return;
  }

  database.receiptItems.update(itemId, {
    status: 'confirmed',
    confirmed_category: category,
  });
  ensureCategory(resolved.group.id, category);

  await ctx.answerCallbackQuery({ text: `✅ ${category}` });
  await deletePromptMessage(ctx, bot);

  await continueReceiptFlow(
    resolved,
    item.photo_queue_id,
    itemsProgress(item.photo_queue_id, (i) => i.status === 'confirmed'),
  );
}

/**
 * Handle "Other category" button
 */
export async function handleReceiptItemOther(
  ctx: CallbackCtx,
  params: string[],
  bot: BotInstance,
): Promise<void> {
  const itemId = parseIntSegment(params[0]);

  if (itemId === null) {
    await ctx.answerCallbackQuery({ text: INVALID_PARAMETERS });
    return;
  }

  const item = database.receiptItems.findById(itemId);

  if (!item || item.status !== 'pending') {
    await ctx.answerCallbackQuery({ text: ITEM_NOT_FOUND_OR_DONE });
    return;
  }

  // Set waiting flag
  database.receiptItems.update(itemId, {
    waiting_for_category_input: 1,
  });

  await ctx.answerCallbackQuery({
    text: '✏️ Напишите название категории',
  });
  await deletePromptMessage(ctx, bot);

  // Send new message asking for category
  if (ctx.message?.chat?.id) {
    await sendMessage(
      `✏️ Напишите категорию для товара:\n<b>${item.name_ru}</b>\n\nПросто отправьте сообщение с названием категории.`,
    );
  }
}

/**
 * Handle "skip receipt item" button
 */
export async function handleSkipReceiptItem(
  ctx: CallbackCtx,
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  const itemId = parseIntSegment(params[0]);

  if (itemId === null) {
    await ctx.answerCallbackQuery({ text: INVALID_PARAMETERS });
    return;
  }

  const resolved = await resolveUserGroup(ctx, telegramId);
  if (!resolved) return;

  const item = database.receiptItems.findById(itemId);

  if (!item || item.status !== 'pending') {
    await ctx.answerCallbackQuery({ text: ITEM_NOT_FOUND_OR_DONE });
    return;
  }

  database.receiptItems.update(itemId, {
    status: 'skipped',
  });

  await ctx.answerCallbackQuery({ text: '⏭️ Товар пропущен' });
  await deletePromptMessage(ctx, bot);

  // Done once nothing is pending (every item confirmed or skipped)
  await continueReceiptFlow(
    resolved,
    item.photo_queue_id,
    itemsProgress(item.photo_queue_id, (i) => i.status !== 'pending'),
  );
}

/**
 * Shared body of "use found category" / "create new category": both take
 * `<action>:<itemId>:<category>` and confirm the item with a category the user chose.
 */
async function confirmItemWithChosenCategory(
  ctx: CallbackCtx,
  params: string[],
  telegramId: number,
  bot: BotInstance,
  resolveCategory: (rawCategory: string) => Promise<string>,
  successText: (category: string) => string,
): Promise<void> {
  const rawCategory = params[1];
  const itemId = parseIntSegment(params[0]);

  if (itemId === null || !rawCategory) {
    await ctx.answerCallbackQuery({ text: INVALID_PARAMETERS });
    return;
  }

  const resolved = await resolveUserGroup(ctx, telegramId);
  if (!resolved) return;

  const item = database.receiptItems.findById(itemId);

  if (!item) {
    await ctx.answerCallbackQuery({ text: 'Товар не найден' });
    return;
  }

  const category = await resolveCategory(rawCategory);

  database.receiptItems.update(itemId, {
    status: 'confirmed',
    confirmed_category: category,
    waiting_for_category_input: 0,
  });
  ensureCategory(resolved.group.id, category);

  await ctx.answerCallbackQuery({ text: successText(category) });
  await deletePromptMessage(ctx, bot);

  await continueReceiptFlow(
    resolved,
    item.photo_queue_id,
    itemsProgress(item.photo_queue_id, (i) => i.status === 'confirmed'),
  );
}

/**
 * Handle "use found category" button
 */
export function handleUseFoundCategory(
  ctx: CallbackCtx,
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  return confirmItemWithChosenCategory(
    ctx,
    params,
    telegramId,
    bot,
    (category) => Promise.resolve(category),
    (category) => `✅ ${category}`,
  );
}

/**
 * Handle "create new category" button
 */
export function handleCreateNewCategory(
  ctx: CallbackCtx,
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  return confirmItemWithChosenCategory(
    ctx,
    params,
    telegramId,
    bot,
    async (category) => {
      const { normalizeCategoryName } = await import('../../../utils/fuzzy-search');
      return normalizeCategoryName(category);
    },
    (category) => `✅ Создана новая: ${category}`,
  );
}
