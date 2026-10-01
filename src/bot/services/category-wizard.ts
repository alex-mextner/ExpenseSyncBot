/** Sequential wizard for manual expenses whose categories are not known yet. */
import { MESSAGES } from '../../config/constants';
import { database } from '../../database';
import type { PendingExpense } from '../../database/types';
import { sendMessage } from '../../services/bank/telegram-sender';
import { createCategoryConfirmKeyboard } from '../keyboards';

const deferredBudgetCategories = new Map<string, string[]>();

function wizardKey(userId: number, messageId: number): string {
  return `${userId}:${messageId}`;
}

export function getPendingCategoryExpense(
  userId: number,
  pendingExpenseId: number,
): PendingExpense | null {
  const pending = database.pendingExpenses.findById(pendingExpenseId);
  if (!pending || pending.user_id !== userId || pending.status !== 'pending_category') return null;
  return pending;
}

/** All same-category rows from the same original Telegram message, oldest first. */
export function getPendingCategorySiblings(
  userId: number,
  current: PendingExpense,
): PendingExpense[] {
  return database.pendingExpenses
    .findByUserId(userId)
    .filter(
      (pending) =>
        pending.message_id === current.message_id &&
        pending.status === 'pending_category' &&
        pending.detected_category === current.detected_category,
    )
    .sort((left, right) => left.id - right.id);
}

/** Show exactly one next category-confirmation step for the original message. */
export async function showNextPendingCategoryStep(
  userId: number,
  messageId: number,
): Promise<boolean> {
  const pending = database.pendingExpenses
    .findByUserId(userId)
    .filter(
      (expense) =>
        expense.message_id === messageId &&
        expense.status === 'pending_category' &&
        Boolean(expense.detected_category),
    )
    .sort((left, right) => left.id - right.id)[0];

  if (!pending?.detected_category) return false;

  await sendMessage(MESSAGES.newCategoryDetected.replace('{category}', pending.detected_category), {
    reply_markup: createCategoryConfirmKeyboard(pending.id),
  });
  return true;
}

/** Defer budget prompts until the category wizard is fully complete. */
export function queueCategoryBudgetPrompt(
  userId: number,
  messageId: number,
  category: string,
): void {
  const key = wizardKey(userId, messageId);
  const queued = deferredBudgetCategories.get(key) ?? [];
  if (!queued.includes(category)) queued.push(category);
  deferredBudgetCategories.set(key, queued);
}

export function takeQueuedCategoryBudgetPrompts(userId: number, messageId: number): string[] {
  const key = wizardKey(userId, messageId);
  const queued = deferredBudgetCategories.get(key) ?? [];
  deferredBudgetCategories.delete(key);
  return queued;
}
