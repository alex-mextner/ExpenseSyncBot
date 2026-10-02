// Persistent smart budget prompts: send with suggestions, apply by button or typed amount/reply

import { format } from 'date-fns';
import type { CurrencyCode } from '../../config/constants';
import { database } from '../../database';
import type { BudgetPrompt, Group, User } from '../../database/types';
import { sendMessage } from '../../services/bank/telegram-sender';
import { getBudgetManager } from '../../services/budget-manager';
import { type BudgetSuggestions, suggestBudgetAmounts } from '../../services/budget-suggestions';
import { parseBudgetInputAmount } from '../../services/currency/budget-amount-parser';
import { formatAmount } from '../../services/currency/converter';
import { chatStorage } from '../../utils/chat-context';
import { escapeHtml } from '../../utils/html';
import { createLogger } from '../../utils/logger.ts';
import { formatMonthYearRu } from '../../utils/ru-date';
import { formatBudgetSetMessage } from '../commands/budget-view';
import { createBudgetSuggestionKeyboard, createBudgetViewKeyboard } from '../keyboards';

const logger = createLogger('budget-prompt');

const INPUT_HINT =
  'Выбери вариант кнопкой или напиши свою сумму сообщением, например 150 или 150 EUR. ' +
  'Если открыто несколько запросов — ответь реплаем на нужное сообщение.';

export type PromptLookup =
  | { ok: true; prompt: BudgetPrompt }
  | { ok: false; reason: 'stale' | 'foreign' };

export type ApplyResult = 'applied' | 'already_handled' | 'failed';

export interface PromptTextInput {
  group: Group;
  user: User;
  text: string;
  replyToMessageId: number | null;
  messageThreadId: number | null;
}

function formatPromptText(
  category: string,
  suggestions: BudgetSuggestions,
  currency: CurrencyCode,
  now: Date,
): string {
  const title = `💰 Бюджет для категории <b>${escapeHtml(category)}</b> на ${formatMonthYearRu(now)}`;
  if (suggestions.options.length === 0) {
    return (
      `${title}\n\nПока нет данных, чтобы предложить сумму: по этой категории нет ни бюджетов, ` +
      'ни расходов за прошлые месяцы. Напиши лимит сообщением, например 150 или 150 EUR, или пропусти.'
    );
  }
  const lines = suggestions.options.map(
    (option) => `• ${formatAmount(option.amount, currency)} — ${option.reason}`,
  );
  return `${title}\n\nВарианты по данным:\n${lines.join('\n')}\n\n${INPUT_HINT}`;
}

/** Create a persistent prompt for a category and send it with data-driven suggestions. */
export async function sendBudgetPrompt(params: {
  group: Group;
  userId: number;
  category: string;
}): Promise<void> {
  const { group, userId, category } = params;
  const currency = group.default_currency;
  const threadId = chatStorage.getStore()?.threadId ?? null;
  const now = new Date();

  database.budgetPrompts.supersedeActive(group.id, userId, category, threadId);
  const prompt = database.budgetPrompts.create({
    group_id: group.id,
    user_id: userId,
    category,
    currency,
    message_thread_id: threadId,
  });

  const suggestions = suggestBudgetAmounts(group.id, category, currency, now);
  const keyboard = createBudgetSuggestionKeyboard(
    prompt.id,
    suggestions.options.map((option) => option.amount),
    currency,
  );
  const sent = await sendMessage(formatPromptText(category, suggestions, currency, now), {
    reply_markup: keyboard,
  });

  if (sent) {
    database.budgetPrompts.bindMessage(prompt.id, sent.message_id);
    return;
  }
  // The user never saw it, so it must not capture their next plain amount.
  database.budgetPrompts.finish(prompt.id, 'skipped');
}

/** Resolve a button's prompt id for the pressing user; stale/foreign prompts are rejected. */
export function lookupPromptForCallback(
  promptId: number,
  groupId: number,
  userId: number,
): PromptLookup {
  const prompt = database.budgetPrompts.findActiveById(promptId);
  if (!prompt || prompt.group_id !== groupId) return { ok: false, reason: 'stale' };
  if (prompt.user_id !== userId) return { ok: false, reason: 'foreign' };
  return { ok: true, prompt };
}

/** Atomically claim the prompt, write the budget through BudgetManager, confirm in chat. */
export async function applyBudgetPrompt(
  prompt: BudgetPrompt,
  amount: number,
  currency: CurrencyCode,
): Promise<ApplyResult> {
  if (!database.budgetPrompts.finish(prompt.id, 'used')) return 'already_handled';

  try {
    const result = await getBudgetManager().set({
      groupId: prompt.group_id,
      category: prompt.category,
      month: format(new Date(), 'yyyy-MM'),
      amount,
      currency,
    });
    const group = database.groups.findById(prompt.group_id);
    await sendMessage(
      formatBudgetSetMessage({
        category: prompt.category,
        amount,
        currency,
        sheetsSynced: result.sheetsSynced,
        sheetsConnected: Boolean(group?.google_refresh_token),
      }),
      { reply_markup: createBudgetViewKeyboard() },
    );
    return 'applied';
  } catch (err) {
    logger.error({ err, promptId: prompt.id }, '[BUDGET-PROMPT] Failed to set budget');
    database.budgetPrompts.reopen(prompt.id);
    return 'failed';
  }
}

/** Retire the prompt without touching budgets. False when it was already handled. */
export function skipBudgetPrompt(prompt: BudgetPrompt): boolean {
  return database.budgetPrompts.finish(prompt.id, 'skipped');
}

type TextTarget =
  | { kind: 'prompt'; prompt: BudgetPrompt }
  | { kind: 'ambiguous'; prompts: BudgetPrompt[] }
  | { kind: 'none' };

function resolveTextTarget(input: PromptTextInput): TextTarget {
  const { group, user, replyToMessageId, messageThreadId } = input;
  if (replyToMessageId !== null) {
    // A reply is an explicit address: it either names a prompt or the text is not for us.
    const prompt = database.budgetPrompts.findActiveByMessage(
      group.id,
      user.id,
      replyToMessageId,
      messageThreadId,
    );
    return prompt ? { kind: 'prompt', prompt } : { kind: 'none' };
  }
  const prompts = database.budgetPrompts.findActiveForUser(group.id, user.id, messageThreadId);
  const [only] = prompts;
  if (!only) return { kind: 'none' };
  return prompts.length === 1 ? { kind: 'prompt', prompt: only } : { kind: 'ambiguous', prompts };
}

async function sendAmbiguityHint(prompts: BudgetPrompt[]): Promise<void> {
  const names = prompts.map((prompt) => `«${escapeHtml(prompt.category)}»`).join(', ');
  await sendMessage(
    `У тебя открыто несколько запросов бюджета: ${names}. ` +
      'Ответь реплаем на сообщение с нужной категорией, чтобы я не перепутал.',
  );
}

/**
 * Handle a plain amount or a reply to a prompt. Returns true when the message was consumed.
 * Only a strict amount ("150", "150 eur", "1 500 RSD") is ever intercepted.
 */
export async function handleBudgetPromptText(input: PromptTextInput): Promise<boolean> {
  const parsed = parseBudgetInputAmount(input.text);
  if (!parsed) return false;

  const target = resolveTextTarget(input);
  if (target.kind === 'none') return false;
  if (target.kind === 'ambiguous') {
    await sendAmbiguityHint(target.prompts);
    return true;
  }

  const { prompt } = target;
  const result = await applyBudgetPrompt(prompt, parsed.amount, parsed.currency ?? prompt.currency);
  if (result === 'failed') {
    await sendMessage('Не удалось установить бюджет. Попробуй ещё раз или используй /budget set.');
  }
  return true;
}
