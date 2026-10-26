/** "budget:<set|add-category|skip|cancel>:<category>[:<amount>[:<currency>]]" callbacks. */
import { format } from 'date-fns';
import { type CurrencyCode, getCurrencySymbol } from '../../../config/constants';
import { database } from '../../../database';
import type { Group } from '../../../database/types';
import { getBudgetManager } from '../../../services/budget-manager';
import { normalizeCurrency } from '../../commands/budget';
import type { BotInstance } from '../../types';
import { type CallbackCtx, deletePromptMessage, resolveUserGroup } from './shared';

const DEFAULT_BUDGET_AMOUNT = 100;

interface BudgetCall {
  ctx: CallbackCtx;
  bot: BotInstance;
  group: Group;
  /** Category segment; undefined when the callback carried none */
  category: string | undefined;
  /** Segments after the category: [amount, currency] */
  rest: string[];
}

type BudgetActionHandler = (call: BudgetCall) => Promise<void>;

interface BudgetAmount {
  amount: number;
  currency: CurrencyCode;
}

const BUDGET_ACTIONS = new Map<string, BudgetActionHandler>([
  ['set', handleBudgetSet],
  ['add-category', handleBudgetAddCategory],
  ['skip', answerAndDelete('⏭️ Пропущено')],
  ['cancel', answerAndDelete('❌ Отменено')],
]);

/** Parse "[amount, currency]" (defaults: 100 in the group currency); null for a bad amount. */
function parseBudgetAmount(rest: string[], group: Group): BudgetAmount | null {
  const [amountStr, currencyStr] = rest;
  const amount = amountStr ? parseFloat(amountStr) : DEFAULT_BUDGET_AMOUNT;
  const currency = currencyStr
    ? normalizeCurrency(currencyStr) || group.default_currency
    : group.default_currency;

  if (Number.isNaN(amount) || amount <= 0) return null;
  return { amount, currency };
}

async function storeCurrentMonthBudget(
  group: Group,
  category: string | undefined,
  { amount, currency }: BudgetAmount,
): Promise<void> {
  await getBudgetManager().set({
    groupId: group.id,
    category: category ?? '',
    month: format(new Date(), 'yyyy-MM'),
    amount,
    currency,
  });
}

function answerAndDelete(text: string): BudgetActionHandler {
  return async ({ ctx, bot }) => {
    await ctx.answerCallbackQuery({ text });
    await deletePromptMessage(ctx, bot);
  };
}

async function handleBudgetSet({ ctx, bot, group, category, rest }: BudgetCall): Promise<void> {
  const parsed = parseBudgetAmount(rest, group);
  if (!parsed) {
    await ctx.answerCallbackQuery({ text: '❌ Неверная сумма' });
    return;
  }

  await storeCurrentMonthBudget(group, category, parsed);

  const currencySymbol = getCurrencySymbol(parsed.currency);
  await ctx.answerCallbackQuery({
    text: `✅ Бюджет установлен: ${currencySymbol}${parsed.amount}`,
  });
  await deletePromptMessage(ctx, bot);
}

async function handleBudgetAddCategory({
  ctx,
  bot,
  group,
  category,
  rest,
}: BudgetCall): Promise<void> {
  const parsed = parseBudgetAmount(rest, group);
  if (!parsed) {
    await ctx.answerCallbackQuery({ text: '❌ Неверная сумма' });
    return;
  }

  database.categories.create({ group_id: group.id, name: category ?? '' });
  await storeCurrentMonthBudget(group, category, parsed);

  const currencySymbol = getCurrencySymbol(parsed.currency);
  await ctx.answerCallbackQuery({
    text: `✅ Категория "${category}" создана, бюджет ${currencySymbol}${parsed.amount} установлен`,
  });
  await deletePromptMessage(ctx, bot);
}

/**
 * Handle budget-related callbacks
 */
export async function handleBudgetAction(
  ctx: CallbackCtx,
  params: string[],
  telegramId: number,
  bot: BotInstance,
): Promise<void> {
  const [subAction, category, ...rest] = params;
  const resolved = await resolveUserGroup(ctx, telegramId);
  if (!resolved) return;

  const handler = BUDGET_ACTIONS.get(subAction ?? '');
  if (!handler) {
    await ctx.answerCallbackQuery({ text: 'Unknown budget action' });
    return;
  }
  await handler({ ctx, bot, group: resolved.group, category, rest });
}
