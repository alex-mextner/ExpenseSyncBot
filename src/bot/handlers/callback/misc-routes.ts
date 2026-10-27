/**
 * Routes for the small callbacks that need no module of their own: feedback cancel,
 * onboarding currency/setup buttons, generic confirm, and merchant-rule review.
 */
import { database } from '../../../database';
import {
  handleCurrencyCallback,
  handleDefaultCurrencyCallback,
  handleSetupChoiceCallback,
} from '../../commands/connect';
import { handleDisconnectCancel, handleDisconnectConfirm } from '../../commands/disconnect';
import { cancelPendingFeedback } from '../../commands/feedback';
import { deletePromptMessage, type RouteCall, type RouteHandler } from './shared';

const INVALID_DATA = 'Неверные данные';

export const handleFeedbackCancel: RouteHandler = async ({ ctx, bot, chatId }) => {
  if (chatId) cancelPendingFeedback(chatId);
  await ctx.answerCallbackQuery({ text: '❌ Отменено' });
  await deletePromptMessage(ctx, bot);
};

export const handleSetupChoice: RouteHandler = async ({ ctx, params }) => {
  await handleSetupChoiceCallback(ctx, params.join(':'));
};

export const handleCurrencyChoice: RouteHandler = async ({ ctx, params, chatId }) => {
  const currencyAction = params[0];
  if (!currencyAction || !chatId) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }
  await handleCurrencyCallback(ctx, currencyAction, chatId);
};

/** Step 2 of onboarding: default currency selection. */
export const handleDefaultCurrencyChoice: RouteHandler = async ({ ctx, params, chatId }) => {
  const currency = params[0];
  if (!currency || !chatId) {
    await ctx.answerCallbackQuery({ text: 'Invalid parameters' });
    return;
  }
  await handleDefaultCurrencyCallback(ctx, currency, chatId);
};

/**
 * Handle confirmation callbacks
 */
export const handleConfirmAction: RouteHandler = async ({ ctx, params, bot }) => {
  const action = params[0] ?? '';
  const answer = params[1] ?? '';

  if (action === 'disconnect') {
    if (answer === 'yes') {
      await handleDisconnectConfirm(ctx, bot);
    } else {
      await handleDisconnectCancel(ctx, bot);
    }
    return;
  }

  if (answer === 'yes') {
    await ctx.answerCallbackQuery({ text: '✅ Подтверждено' });
    // Handle specific confirmation actions here
  } else {
    await ctx.answerCallbackQuery({ text: '❌ Отменено' });
    await deletePromptMessage(ctx, bot);
  }
};

/** Approve/reject a suggested merchant rule, then strip the buttons from the card. */
function reviewMerchantRule(status: 'approved' | 'rejected', answerText: string): RouteHandler {
  return async ({ ctx, params, bot, chatId }: RouteCall) => {
    const ruleId = Number(params[0]);
    if (!ruleId) {
      await ctx.answerCallbackQuery({ text: INVALID_DATA });
      return;
    }
    database.merchantRules.updateStatus(ruleId, status);
    await ctx.answerCallbackQuery({ text: answerText });
    if (chatId && ctx.message?.id) {
      try {
        await bot.api.editMessageReplyMarkup({
          chat_id: chatId,
          message_id: ctx.message.id,
          reply_markup: { inline_keyboard: [] },
        });
      } catch {
        // message may be too old to edit
      }
    }
  };
}

export const handleMerchantApprove = reviewMerchantRule('approved', '✅ Правило принято');
export const handleMerchantReject = reviewMerchantRule('rejected', '❌ Правило отклонено');

export const handleMerchantEdit: RouteHandler = async ({ ctx, params, chatId }) => {
  const ruleId = Number(params[0]);
  if (!ruleId || !chatId) {
    await ctx.answerCallbackQuery({ text: INVALID_DATA });
    return;
  }
  await ctx.answerCallbackQuery();
  // TODO(#218): implement reply-based edit for merchant rules (out of scope for the cccc cleanup)
};
