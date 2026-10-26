/**
 * "category:<add|select|choose|cancel>:…" callbacks — the new-category confirmation wizard.
 *
 * Callbacks are bound to a pending-expense id. Old name-based callbacks are intentionally
 * rejected: guessing a current pending row from stale UI can save the wrong financial record.
 */
import { MESSAGES } from '../../../config/constants';
import { database } from '../../../database';
import type { PendingExpense } from '../../../database/types';
import { sendMessage } from '../../../services/bank/telegram-sender';
import { createLogger } from '../../../utils/logger.ts';
import { createBudgetPromptKeyboard, createCategoriesListKeyboard } from '../../keyboards';
import {
  getPendingCategoryExpense,
  getPendingCategorySiblings,
  queueCategoryBudgetPrompt,
  showNextPendingCategoryStep,
  takeQueuedCategoryBudgetPrompts,
} from '../../services/category-wizard';
import { saveExpenseBatch } from '../../services/expense-saver';
import { getSheetErrorMessage } from '../../services/sheet-errors';
import type { BotInstance } from '../../types';
import {
  type CallbackCtx,
  deletePromptMessage,
  parseIntSegment,
  resolveUserGroup,
  type UserGroup,
} from './shared';

const logger = createLogger('callback.handler');

const STALE_BUTTON = 'Кнопка устарела — отправь расход снова';
const ALREADY_PROCESSED = 'Расход уже обработан';

interface CategoryCall extends UserGroup {
  ctx: CallbackCtx;
  bot: BotInstance;
  /** Segments after the sub-action */
  args: string[];
}

type CategoryActionHandler = (call: CategoryCall) => Promise<void>;

const CATEGORY_ACTIONS = new Map<string, CategoryActionHandler>([
  ['add', handleCategoryAdd],
  ['select', handleCategorySelect],
  ['choose', handleCategoryChoose],
  ['cancel', handleCategoryCancel],
]);

async function advanceCategoryWizard(
  userId: number,
  group: UserGroup['group'],
  sourceMessageId: number,
): Promise<void> {
  if (await showNextPendingCategoryStep(userId, sourceMessageId)) return;

  // Category confirmation is complete. Only now surface deferred budget actions,
  // so the user never has several different actionable wizard messages at once.
  for (const category of takeQueuedCategoryBudgetPrompts(userId, sourceMessageId)) {
    const keyboard = createBudgetPromptKeyboard(category, group.default_currency);
    await sendMessage(`💰 Хочешь установить бюджет для категории "${category}"?`, {
      reply_markup: keyboard,
    });
  }
}

/** Delete the wizard prompt; a failure is logged and never aborts the flow. */
async function deleteWizardPrompt(
  ctx: CallbackCtx,
  bot: BotInstance,
  failureLog: string,
): Promise<void> {
  try {
    await deletePromptMessage(ctx, bot);
  } catch (err) {
    logger.error({ err }, failureLog);
  }
}

/**
 * Save the confirmed sibling rows as one batch. On failure the pending rows are dropped and
 * the sheet error is surfaced to the chat — only when the callback carries a chat id (as before
 * the extraction). Returns whether the batch was saved.
 */
async function saveWizardBatch(
  ctx: CallbackCtx,
  { user, group }: UserGroup,
  siblings: PendingExpense[],
): Promise<boolean> {
  try {
    await saveExpenseBatch(
      user.id,
      group.id,
      siblings.map((expense) => expense.id),
    );
    return true;
  } catch (error) {
    logger.error({ err: error }, '[CALLBACK] Failed to save category-wizard batch');
    for (const expense of siblings) database.pendingExpenses.delete(expense.id);
    if (ctx.message?.chat?.id) await sendMessage(getSheetErrorMessage(error));
    return false;
  }
}

async function handleCategoryAdd({ ctx, bot, user, group, args }: CategoryCall): Promise<void> {
  // New protocol: category:add:<pendingExpenseId>.
  const requestedId = parseIntSegment(args[0]);
  if (requestedId === null) {
    await ctx.answerCallbackQuery({ text: STALE_BUTTON });
    return;
  }
  const pending = getPendingCategoryExpense(user.id, requestedId);

  if (!pending?.detected_category) {
    await ctx.answerCallbackQuery({ text: ALREADY_PROCESSED });
    return;
  }

  const categoryName = pending.detected_category;
  const categoryAlreadyExists = database.categories.exists(group.id, categoryName);
  if (!categoryAlreadyExists) {
    database.categories.create({ group_id: group.id, name: categoryName });
  }
  await ctx.answerCallbackQuery({
    text: categoryAlreadyExists
      ? `Категория уже существует: ${categoryName}`
      : MESSAGES.categoryAdded.replace('{category}', categoryName),
  });

  await deleteWizardPrompt(ctx, bot, '[CALLBACK] Failed to delete category add message');

  const siblings = getPendingCategorySiblings(user.id, pending);
  for (const expense of siblings) {
    database.pendingExpenses.update(expense.id, { status: 'confirmed' });
  }

  const expenseSaved =
    siblings.length > 0 && (await saveWizardBatch(ctx, { user, group }, siblings));

  if (expenseSaved && !categoryAlreadyExists) {
    queueCategoryBudgetPrompt(user.id, pending.message_id, categoryName);
  }
  await advanceCategoryWizard(user.id, group, pending.message_id);
}

async function handleCategorySelect({ ctx, user, group, args }: CategoryCall): Promise<void> {
  const pendingId = parseIntSegment(args[0]);
  if (pendingId === null) {
    await ctx.answerCallbackQuery({ text: STALE_BUTTON });
    return;
  }
  const pending = getPendingCategoryExpense(user.id, pendingId);
  if (!pending) {
    await ctx.answerCallbackQuery({ text: ALREADY_PROCESSED });
    return;
  }

  const categories = database.categories.findByGroupId(group.id);
  if (categories.length === 0) {
    await ctx.answerCallbackQuery({ text: 'Нет сохраненных категорий' });
    return;
  }

  const keyboard = createCategoriesListKeyboard(categories, pending.id);
  await ctx.editReplyMarkup(keyboard);
  await ctx.answerCallbackQuery({ text: 'Выбери категорию' });
}

async function handleCategoryChoose({ ctx, bot, user, group, args }: CategoryCall): Promise<void> {
  // New protocol: category:choose:<pendingExpenseId>:<categoryId>.
  if (args.length < 2) {
    await ctx.answerCallbackQuery({ text: STALE_BUTTON });
    return;
  }
  const pendingId = parseIntSegment(args[0]);
  const categoryId = parseIntSegment(args[1]);
  if (pendingId === null || categoryId === null) {
    await ctx.answerCallbackQuery({ text: 'Некорректные данные' });
    return;
  }

  const pending = getPendingCategoryExpense(user.id, pendingId);
  const categoryRecord = database.categories.findById(categoryId);
  if (!pending || !categoryRecord) {
    await ctx.answerCallbackQuery({
      text: pending ? 'Категория не найдена' : ALREADY_PROCESSED,
    });
    return;
  }

  const siblings = getPendingCategorySiblings(user.id, pending);
  for (const expense of siblings) {
    database.pendingExpenses.update(expense.id, {
      detected_category: categoryRecord.name,
      status: 'confirmed',
    });
  }
  await ctx.answerCallbackQuery({ text: `Категория: ${categoryRecord.name}` });

  await deleteWizardPrompt(ctx, bot, '[CALLBACK] Failed to delete category message');

  await saveWizardBatch(ctx, { user, group }, siblings);
  await advanceCategoryWizard(user.id, group, pending.message_id);
}

async function handleCategoryCancel({ ctx, bot, user, group, args }: CategoryCall): Promise<void> {
  await ctx.answerCallbackQuery({ text: 'Отменено' });
  const pendingId = parseIntSegment(args[0]);
  const pending = pendingId === null ? null : getPendingCategoryExpense(user.id, pendingId);

  await deletePromptMessage(ctx, bot);

  if (pending) {
    for (const expense of getPendingCategorySiblings(user.id, pending)) {
      database.pendingExpenses.delete(expense.id);
    }
    await advanceCategoryWizard(user.id, group, pending.message_id);
  }
}

/**
 * Handle category-related callbacks
 */
export async function handleCategoryAction(
  ctx: CallbackCtx,
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  const [subAction, ...args] = params;
  const resolved = await resolveUserGroup(ctx, telegramId);
  if (!resolved) return;

  const handler = CATEGORY_ACTIONS.get(subAction ?? '');
  if (handler) await handler({ ctx, bot, args, ...resolved });
}
