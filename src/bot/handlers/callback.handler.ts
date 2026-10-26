/** Inline keyboard callback handler — processes button presses for OAuth, budget, and receipt flows */
import { createLogger } from '../../utils/logger.ts';
import { handleDevCallback } from '../commands/dev';
import { handleSettingsCallback } from '../commands/settings';
import type { BotInstance, Ctx } from '../types';
import { BANK_ROUTES } from './callback/bank-routes';
import { handleBudgetAction } from './callback/budget';
import { handleCategoryAction } from './callback/category';
import {
  handleConfirmAction,
  handleCurrencyChoice,
  handleDefaultCurrencyChoice,
  handleFeedbackCancel,
  handleMerchantApprove,
  handleMerchantEdit,
  handleMerchantReject,
  handleSetupChoice,
} from './callback/misc-routes';
import { handleBudgetSyncMoreCallback, handleSyncMoreCallback } from './callback/overflow';
import {
  handleCreateNewCategory,
  handleReceiptItemConfirm,
  handleReceiptItemOther,
  handleSkipReceiptItem,
  handleUseFoundCategory,
} from './callback/receipt-items';
import { handleReceiptSummaryAction } from './callback/receipt-summary';
import type { RouteHandler } from './callback/shared';

const logger = createLogger('callback.handler');

/**
 * Action name (the `callback_data` segment before the first ":") → handler.
 *
 * Matching is exact and case sensitive: "bank_confirm_x" or "Settings" are unknown actions,
 * not prefix matches. A Map (not an object literal) so names such as "constructor" or
 * "__proto__" can never resolve to an inherited member.
 */
const ROUTES = new Map<string, RouteHandler>([
  ['feedback_cancel', handleFeedbackCancel],
  ['settings', ({ ctx, params }) => handleSettingsCallback(ctx, params)],
  ['setup', handleSetupChoice],
  ['currency', handleCurrencyChoice],
  ['default', handleDefaultCurrencyChoice],
  [
    'category',
    ({ ctx, params, telegramId, bot }) => handleCategoryAction(ctx, params, telegramId, bot),
  ],
  ['confirm', handleConfirmAction],
  [
    'budget',
    ({ ctx, params, telegramId, bot }) => handleBudgetAction(ctx, params, telegramId, bot),
  ],
  [
    'confirm_receipt_item',
    ({ ctx, params, telegramId, bot }) => handleReceiptItemConfirm(ctx, params, telegramId, bot),
  ],
  ['receipt_item_other', ({ ctx, params, bot }) => handleReceiptItemOther(ctx, params, bot)],
  [
    'skip_receipt_item',
    ({ ctx, params, telegramId, bot }) => handleSkipReceiptItem(ctx, params, telegramId, bot),
  ],
  [
    'use_found_category',
    ({ ctx, params, telegramId, bot }) => handleUseFoundCategory(ctx, params, telegramId, bot),
  ],
  [
    'create_new_category',
    ({ ctx, params, telegramId, bot }) => handleCreateNewCategory(ctx, params, telegramId, bot),
  ],
  [
    'receipt',
    ({ ctx, params, telegramId, bot }) => handleReceiptSummaryAction(ctx, params, telegramId, bot),
  ],
  ['dev', ({ ctx, params, telegramId, bot }) => handleDevCallback(ctx, params, telegramId, bot)],
  ...BANK_ROUTES,
  ['merchant_approve', handleMerchantApprove],
  ['merchant_reject', handleMerchantReject],
  ['merchant_edit', handleMerchantEdit],
  ['sync_more', ({ ctx, params }) => handleSyncMoreCallback(ctx, params)],
  ['bsync_more', ({ ctx, params }) => handleBudgetSyncMoreCallback(ctx, params)],
]);

/**
 * Handle callback queries from inline keyboards
 */
export async function handleCallbackQuery(
  ctx: Ctx['CallbackQuery'],
  bot: BotInstance,
): Promise<void> {
  const data = ctx.data;
  const telegramId = ctx.from.id;
  const chatId = ctx.message?.chat?.id;

  if (!data) {
    return;
  }

  const [action, ...params] = data.split(':');

  try {
    const route = ROUTES.get(action ?? '');
    if (!route) {
      await ctx.answerCallbackQuery({ text: 'Unknown action' });
      return;
    }
    await route({ ctx, params, bot, chatId, telegramId });
  } catch (error) {
    logger.error({ err: error }, `[CALLBACK] Unhandled error for action "${data}"`);
    try {
      await ctx.answerCallbackQuery({ text: 'Internal error' });
    } catch {
      // Best-effort error notification — original error already logged above
    }
  }
}
