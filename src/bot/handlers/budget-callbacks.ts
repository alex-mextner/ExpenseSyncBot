// Callback handlers for the smart budget prompt buttons: suggested amount, skip, show budget

import type { Group, User } from '../../database/types';
import { formatAmount } from '../../services/currency/converter';
import { sendBudgetView } from '../commands/budget';
import {
  applyBudgetPrompt,
  lookupPromptForCallback,
  skipBudgetPrompt,
} from '../services/budget-prompt';
import type { BotInstance, Ctx } from '../types';

export type BudgetPromptAction = 'psuggest' | 'pskip' | 'view';

const STALE_TEXT = 'Запрос устарел или уже обработан';
const FOREIGN_TEXT = 'Этот запрос создан другим участником';

async function removeButtonMessage(ctx: Ctx['CallbackQuery'], bot: BotInstance): Promise<void> {
  const chatId = ctx.message?.chat?.id;
  const messageId = ctx.message?.id;
  if (chatId && messageId) {
    await bot.api.deleteMessage({ chat_id: chatId, message_id: messageId });
  }
}

function parsePositiveInt(raw: string | undefined): number | null {
  const value = Number.parseInt(raw ?? '', 10);
  return Number.isInteger(value) && value > 0 ? value : null;
}

async function handleSuggestion(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  args: string[],
  group: Group,
  user: User,
): Promise<void> {
  const promptId = parsePositiveInt(args[0]);
  const amount = parsePositiveInt(args[1]);
  if (promptId === null || amount === null) {
    await ctx.answerCallbackQuery({ text: STALE_TEXT });
    return;
  }

  const lookup = lookupPromptForCallback(promptId, group.id, user.id);
  if (!lookup.ok) {
    await ctx.answerCallbackQuery({ text: lookup.reason === 'stale' ? STALE_TEXT : FOREIGN_TEXT });
    return;
  }

  const { prompt } = lookup;
  const result = await applyBudgetPrompt(prompt, amount, prompt.currency);
  if (result === 'already_handled') {
    await ctx.answerCallbackQuery({ text: STALE_TEXT });
    return;
  }
  if (result === 'failed') {
    await ctx.answerCallbackQuery({ text: '❌ Не удалось установить бюджет' });
    return;
  }
  await ctx.answerCallbackQuery({
    text: `✅ Бюджет установлен: ${formatAmount(amount, prompt.currency)}`,
  });
  await removeButtonMessage(ctx, bot);
}

async function handleSkip(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  args: string[],
  group: Group,
  user: User,
): Promise<void> {
  const promptId = parsePositiveInt(args[0]);
  const lookup = promptId === null ? null : lookupPromptForCallback(promptId, group.id, user.id);
  if (!lookup?.ok) {
    await ctx.answerCallbackQuery({
      text: lookup?.reason === 'foreign' ? FOREIGN_TEXT : STALE_TEXT,
    });
    return;
  }
  if (!skipBudgetPrompt(lookup.prompt)) {
    await ctx.answerCallbackQuery({ text: STALE_TEXT });
    return;
  }
  await ctx.answerCallbackQuery({ text: '⏭️ Пропущено' });
  await removeButtonMessage(ctx, bot);
}

/** Route budget:psuggest / budget:pskip / budget:view. `args` excludes the sub-action. */
export async function handleBudgetPromptCallback(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
  action: BudgetPromptAction,
  args: string[],
  group: Group,
  user: User,
): Promise<void> {
  switch (action) {
    case 'psuggest':
      await handleSuggestion(ctx, bot, args, group, user);
      return;
    case 'pskip':
      await handleSkip(ctx, bot, args, group, user);
      return;
    case 'view':
      await ctx.answerCallbackQuery();
      await sendBudgetView(group);
      return;
  }
}
