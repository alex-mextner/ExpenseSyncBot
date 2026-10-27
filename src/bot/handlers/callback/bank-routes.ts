/**
 * Routes for the "bank_*" callbacks. Almost all of them share one shape: a chat is required
 * plus 0-2 numeric ids (or a string key) parsed from the callback data; any missing/zero
 * value is answered with "invalid data" before the real handler runs.
 */
import { sendOldTransactionCards, skipOldTransactions } from '../../../services/bank/sync-service';
import { pluralize } from '../../../utils/pluralize';
import {
  handleBankAccountsCallback,
  handleBankAccountToggleCallback,
  handleBankAddCallback,
  handleBankConfirmCallback,
  handleBankDisconnectCallback,
  handleBankDisconnectCancelCallback,
  handleBankDisconnectConfirmCallback,
  handleBankEditCallback,
  handleBankLetterCallback,
  handleBankLetterNavCallback,
  handleBankMergeCallback,
  handleBankNewCallback,
  handleBankNoCommentCallback,
  handleBankReceiptCallback,
  handleBankReconnectCallback,
  handleBankSettingsBackCallback,
  handleBankSettingsCallback,
  handleBankSetupCallback,
  handleBankSyncAllCallback,
  handleBankSyncCallback,
  handleBankWizardCancelCallback,
  handleBankWizardStartCallback,
} from '../../commands/bank';
import type { BotInstance } from '../../types';
import type { CallbackCtx, RouteCall, RouteHandler } from './shared';

const INVALID_DATA = 'Неверные данные';

/** A callback that carries a chat. */
interface ChatCall {
  ctx: CallbackCtx;
  bot: BotInstance;
  chatId: number;
}

async function rejectInvalidData(ctx: CallbackCtx): Promise<void> {
  await ctx.answerCallbackQuery({ text: INVALID_DATA });
}

/** Chat only, no other argument. */
function chatRoute(run: (call: ChatCall) => Promise<void>): RouteHandler {
  return async ({ ctx, bot, chatId }) => {
    if (!chatId) return rejectInvalidData(ctx);
    await run({ ctx, bot, chatId });
  };
}

/** Chat plus one numeric id (`params[0]`); a missing, non-numeric or zero id is invalid. */
function idRoute(run: (call: ChatCall, id: number) => Promise<void>): RouteHandler {
  return async ({ ctx, bot, chatId, params }) => {
    const id = Number(params[0]);
    if (!chatId || !id) return rejectInvalidData(ctx);
    await run({ ctx, bot, chatId }, id);
  };
}

/** Chat plus two numeric ids (`params[0]`, `params[1]`). */
function twoIdRoute(
  run: (call: ChatCall, first: number, second: number) => Promise<void>,
): RouteHandler {
  return async ({ ctx, bot, chatId, params }) => {
    const first = Number(params[0]);
    const second = Number(params[1]);
    if (!chatId || !first || !second) return rejectInvalidData(ctx);
    await run({ ctx, bot, chatId }, first, second);
  };
}

/** Chat plus a string key derived from the segments; an empty key is invalid. */
function keyRoute(
  keyOf: (params: string[]) => string | undefined,
  run: (call: ChatCall, key: string) => Promise<void>,
): RouteHandler {
  return async ({ ctx, bot, chatId, params }) => {
    const key = keyOf(params);
    if (!chatId || !key) return rejectInvalidData(ctx);
    await run({ ctx, bot, chatId }, key);
  };
}

/** Chat plus the numeric connection id handled by (ctx, bot, connectionId, chatId) handlers. */
function connectionRoute(
  handler: (
    ctx: CallbackCtx,
    bot: BotInstance,
    connectionId: number,
    chatId: number,
  ) => Promise<void>,
): RouteHandler {
  return idRoute(({ ctx, bot, chatId }, connectionId) => handler(ctx, bot, connectionId, chatId));
}

/** Transaction-level handlers take (ctx, transactionId, chatId). */
function transactionRoute(
  handler: (ctx: CallbackCtx, transactionId: number, chatId: number) => Promise<void>,
): RouteHandler {
  return idRoute(({ ctx, chatId }, transactionId) => handler(ctx, transactionId, chatId));
}

async function showOldTransactions({ ctx, params, chatId }: RouteCall): Promise<void> {
  const connectionId = Number(params[0]);
  if (!chatId || !connectionId) return rejectInvalidData(ctx);

  await ctx.answerCallbackQuery({ text: 'Отправляю карточки...' });
  await ctx.editText('⌛ Отправляю карточки для подтверждения...');
  const count = await sendOldTransactionCards(connectionId);
  if (count === 0) {
    await ctx.editText('ℹ️ Нет транзакций для подтверждения');
  } else {
    await ctx.editText(
      `✅ Отправлено ${count} ${pluralize(count, 'карточка', 'карточки', 'карточек')} для подтверждения`,
    );
  }
}

async function skipOldTransactionsRoute({ ctx, params, chatId }: RouteCall): Promise<void> {
  const connectionId = Number(params[0]);
  if (!chatId || !connectionId) return rejectInvalidData(ctx);

  await ctx.answerCallbackQuery({ text: 'Пропускаю старые...' });
  const skipped = await skipOldTransactions(connectionId);
  await ctx.editText(
    `⏭ Пропущено ${skipped} ${pluralize(skipped, 'старая транзакция', 'старые транзакции', 'старых транзакций')}`,
  );
}

export const BANK_ROUTES: ReadonlyArray<readonly [string, RouteHandler]> = [
  ['bank_confirm', transactionRoute(handleBankConfirmCallback)],
  ['bank_edit', transactionRoute(handleBankEditCallback)],
  ['bank_nocomment', transactionRoute(handleBankNoCommentCallback)],
  [
    'bank_merge',
    twoIdRoute(({ ctx, chatId }, txId, expenseId) =>
      handleBankMergeCallback(ctx, txId, expenseId, chatId),
    ),
  ],
  ['bank_new', transactionRoute(handleBankNewCallback)],
  [
    'bank_receipt',
    twoIdRoute(({ ctx, chatId }, txId, receiptId) =>
      handleBankReceiptCallback(ctx, txId, receiptId, chatId),
    ),
  ],
  [
    'bank_setup',
    keyRoute(
      (params) => params[0],
      ({ ctx, bot, chatId }, bankKey) => handleBankSetupCallback(ctx, bot, bankKey, chatId),
    ),
  ],
  ['bank_reconnect', connectionRoute(handleBankReconnectCallback)],
  [
    'bank_wizard_start',
    keyRoute(
      (params) => params.join(':'),
      ({ ctx, bot, chatId }, bankKey) => handleBankWizardStartCallback(ctx, bot, bankKey, chatId),
    ),
  ],
  [
    'bank_wizard_cancel',
    chatRoute(({ ctx, chatId }) => handleBankWizardCancelCallback(ctx, chatId)),
  ],
  ['bank_settings', connectionRoute(handleBankSettingsCallback)],
  [
    'bank_sync',
    idRoute(({ ctx, chatId }, connectionId) => handleBankSyncCallback(ctx, connectionId, chatId)),
  ],
  ['bank_sync_all', chatRoute(({ ctx, chatId }) => handleBankSyncAllCallback(ctx, chatId))],
  ['bank_disconnect', connectionRoute(handleBankDisconnectCallback)],
  ['bank_disconnect_confirm', connectionRoute(handleBankDisconnectConfirmCallback)],
  ['bank_disconnect_cancel', connectionRoute(handleBankDisconnectCancelCallback)],
  ['bank_settings_back', connectionRoute(handleBankSettingsBackCallback)],
  ['bank_add', chatRoute(({ ctx, chatId }) => handleBankAddCallback(ctx, chatId))],
  [
    'bank_letter',
    keyRoute(
      (params) => params[0]?.toUpperCase(),
      ({ ctx, bot, chatId }, letter) => handleBankLetterCallback(ctx, bot, letter, chatId),
    ),
  ],
  [
    'bank_letter_nav',
    chatRoute(({ ctx, bot, chatId }) => handleBankLetterNavCallback(ctx, bot, chatId)),
  ],
  ['bank_accounts', connectionRoute(handleBankAccountsCallback)],
  [
    'bank_account_toggle',
    twoIdRoute(({ ctx, bot, chatId }, accountId, connectionId) =>
      handleBankAccountToggleCallback(ctx, bot, accountId, connectionId, chatId),
    ),
  ],
  ['bank_show_old', showOldTransactions],
  ['bank_skip_old', skipOldTransactionsRoute],
];
