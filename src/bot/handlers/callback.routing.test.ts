// Characterization tests for the callback_data router in callback.handler.ts.
// Pin routing precedence (exact-prefix match, case sensitivity, no prototype lookups),
// parameter-splitting quirks and the per-action guard clauses, independent of how the
// dispatcher is structured internally.

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  answeredTexts,
  bankMocks,
  cancelFeedbackMock,
  connectMocks,
  devMock,
  disconnectMocks,
  dispatch,
  fakeBot,
  fakeCallbackCtx,
  getBudgetSyncCachedResultMock,
  getSyncCachedResultMock,
  logMock,
  mockMerchantRules,
  resetCallbackMocks,
  runCallback,
  sendMessageMock,
  sendOldMock,
  settingsMocks,
  skipOldMock,
} from './callback.test-support';

beforeEach(resetCallbackMocks);

describe('routing precedence', () => {
  test('actions are matched exactly, not by prefix', async () => {
    for (const data of [
      'bank_confirm_x:7',
      'bank:7',
      'confirm_receipt:1',
      'budget_set:1',
      'sync:1',
    ]) {
      const { ctx } = await dispatch(data);
      expect(answeredTexts(ctx)).toEqual(['Unknown action']);
    }
    expect(bankMocks.handleBankConfirmCallback).not.toHaveBeenCalled();
  });

  test('actions are case sensitive', async () => {
    const { ctx } = await dispatch('Settings:edit');
    expect(settingsMocks.handleSettingsCallback).not.toHaveBeenCalled();
    expect(answeredTexts(ctx)).toEqual(['Unknown action']);
  });

  test('Object.prototype member names are not routed', async () => {
    for (const data of ['constructor:1', 'toString:1', '__proto__:1', 'hasOwnProperty:1']) {
      const { ctx } = await dispatch(data);
      expect(answeredTexts(ctx)).toEqual(['Unknown action']);
      expect(logMock.error).not.toHaveBeenCalled();
    }
  });

  test('"confirm_receipt_item" is the receipt flow, not the generic "confirm" flow', async () => {
    const { ctx } = await dispatch('confirm_receipt_item:abc:0');
    expect(answeredTexts(ctx)).toEqual(['Invalid parameters']);
  });

  test('"bank_disconnect*" and "bank_settings*" variants hit their own handler only', async () => {
    await dispatch('bank_disconnect_confirm:3');
    await dispatch('bank_settings_back:3');
    expect(bankMocks.handleBankDisconnectConfirmCallback).toHaveBeenCalledTimes(1);
    expect(bankMocks.handleBankSettingsBackCallback).toHaveBeenCalledTimes(1);
    expect(bankMocks.handleBankDisconnectCallback).not.toHaveBeenCalled();
    expect(bankMocks.handleBankSettingsCallback).not.toHaveBeenCalled();
  });

  test('"bsync_more" is not shadowed by "budget"', async () => {
    getBudgetSyncCachedResultMock.mockImplementation(() => null);
    const { ctx } = await dispatch('bsync_more:key:a');
    expect(answeredTexts(ctx)).toEqual(['Данные устарели. Перезапусти бота.']);
  });
});

describe('parameter splitting', () => {
  test('"setup" re-joins every remaining segment with ":"', async () => {
    const { ctx } = await dispatch('setup:a:b:c');
    expect(connectMocks.handleSetupChoiceCallback).toHaveBeenCalledWith(ctx, 'a:b:c');
  });

  test('"setup" with no params forwards an empty string', async () => {
    const { ctx } = await dispatch('setup');
    expect(connectMocks.handleSetupChoiceCallback).toHaveBeenCalledWith(ctx, '');
  });

  test('"currency" only uses the first param', async () => {
    const { ctx } = await dispatch('currency:EUR:extra');
    expect(connectMocks.handleCurrencyCallback).toHaveBeenCalledWith(ctx, 'EUR', -100);
  });

  test('"default" without params is rejected with "Invalid parameters"', async () => {
    const { ctx } = await dispatch('default');
    expect(connectMocks.handleDefaultCurrencyCallback).not.toHaveBeenCalled();
    expect(answeredTexts(ctx)).toEqual(['Invalid parameters']);
  });

  test('"default" without chat is rejected with "Invalid parameters"', async () => {
    const { ctx } = await dispatch('default:EUR', (c) => {
      c.message = undefined;
    });
    expect(connectMocks.handleDefaultCurrencyCallback).not.toHaveBeenCalled();
    expect(answeredTexts(ctx)).toEqual(['Invalid parameters']);
  });

  test('"dev" forwards params, telegram id and bot', async () => {
    const { ctx, bot } = await dispatch('dev:a:b');
    expect(devMock).toHaveBeenCalledWith(ctx, ['a', 'b'], 42, bot);
  });
});

describe('generic confirm flow', () => {
  test('"confirm:x:yes" confirms without deleting the message', async () => {
    const { ctx, bot } = await dispatch('confirm:x:yes');
    expect(answeredTexts(ctx)).toEqual(['✅ Подтверждено']);
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
  });

  test('"confirm:x:anything-else" cancels and deletes the button message', async () => {
    const { ctx, bot } = await dispatch('confirm:x:maybe');
    expect(answeredTexts(ctx)).toEqual(['❌ Отменено']);
    expect(bot.api.deleteMessage).toHaveBeenCalledWith({ chat_id: -100, message_id: 200 });
  });

  test('"confirm:x:no" without a message does not try to delete', async () => {
    const { ctx, bot } = await dispatch('confirm:x:no', (c) => {
      c.message = undefined;
    });
    expect(answeredTexts(ctx)).toEqual(['❌ Отменено']);
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
  });

  test('"confirm:disconnect" with no answer cancels the disconnect', async () => {
    await dispatch('confirm:disconnect');
    expect(disconnectMocks.handleDisconnectCancel).toHaveBeenCalledTimes(1);
    expect(disconnectMocks.handleDisconnectConfirm).not.toHaveBeenCalled();
  });
});

describe('feedback_cancel', () => {
  test('answers, cancels pending feedback for the chat and deletes the prompt', async () => {
    const { ctx, bot } = await dispatch('feedback_cancel');
    expect(cancelFeedbackMock).toHaveBeenCalledWith(-100);
    expect(answeredTexts(ctx)).toEqual(['❌ Отменено']);
    expect(bot.api.deleteMessage).toHaveBeenCalledWith({ chat_id: -100, message_id: 200 });
  });

  test('without a message nothing is cancelled or deleted, but it is still answered', async () => {
    const { ctx, bot } = await dispatch('feedback_cancel', (c) => {
      c.message = undefined;
    });
    expect(cancelFeedbackMock).not.toHaveBeenCalled();
    expect(answeredTexts(ctx)).toEqual(['❌ Отменено']);
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
  });
});

describe('bank_* guards', () => {
  const INVALID = ['Неверные данные'];

  test('numeric id of 0 is rejected like a missing id', async () => {
    const { ctx } = await dispatch('bank_sync:0');
    expect(bankMocks.handleBankSyncCallback).not.toHaveBeenCalled();
    expect(answeredTexts(ctx)).toEqual(INVALID);
  });

  test('non-numeric id is rejected', async () => {
    const { ctx } = await dispatch('bank_edit:abc');
    expect(bankMocks.handleBankEditCallback).not.toHaveBeenCalled();
    expect(answeredTexts(ctx)).toEqual(INVALID);
  });

  test('missing chat is rejected even with a valid id', async () => {
    const { ctx } = await dispatch('bank_confirm:7', (c) => {
      c.message = undefined;
    });
    expect(bankMocks.handleBankConfirmCallback).not.toHaveBeenCalled();
    expect(answeredTexts(ctx)).toEqual(INVALID);
  });

  test('two-id actions need BOTH ids', async () => {
    for (const data of [
      'bank_merge:7',
      'bank_merge:7:0',
      'bank_receipt:7',
      'bank_account_toggle:3',
    ]) {
      const { ctx } = await dispatch(data);
      expect(answeredTexts(ctx)).toEqual(INVALID);
    }
    expect(bankMocks.handleBankMergeCallback).not.toHaveBeenCalled();
    expect(bankMocks.handleBankReceiptCallback).not.toHaveBeenCalled();
    expect(bankMocks.handleBankAccountToggleCallback).not.toHaveBeenCalled();
  });

  test('chat-only actions are rejected without a chat', async () => {
    for (const data of ['bank_sync_all', 'bank_add', 'bank_wizard_cancel', 'bank_letter_nav']) {
      const { ctx } = await dispatch(data, (c) => {
        c.message = undefined;
      });
      expect(answeredTexts(ctx)).toEqual(INVALID);
    }
    expect(bankMocks.handleBankSyncAllCallback).not.toHaveBeenCalled();
    expect(bankMocks.handleBankAddCallback).not.toHaveBeenCalled();
    expect(bankMocks.handleBankWizardCancelCallback).not.toHaveBeenCalled();
    expect(bankMocks.handleBankLetterNavCallback).not.toHaveBeenCalled();
  });

  test('"bank_letter" without a letter is rejected; with one it is upper-cased', async () => {
    const missing = await dispatch('bank_letter');
    expect(answeredTexts(missing.ctx)).toEqual(INVALID);
    const ok = await dispatch('bank_letter:z');
    expect(bankMocks.handleBankLetterCallback).toHaveBeenCalledWith(ok.ctx, ok.bot, 'Z', -100);
  });

  test('"bank_setup" forwards bot, bank key and chat; empty key is rejected', async () => {
    const ok = await dispatch('bank_setup:tbc');
    expect(bankMocks.handleBankSetupCallback).toHaveBeenCalledWith(ok.ctx, ok.bot, 'tbc', -100);
    const missing = await dispatch('bank_setup:');
    expect(answeredTexts(missing.ctx)).toEqual(INVALID);
  });

  test('"bank_wizard_start" with no key is rejected', async () => {
    const { ctx } = await dispatch('bank_wizard_start');
    expect(bankMocks.handleBankWizardStartCallback).not.toHaveBeenCalled();
    expect(answeredTexts(ctx)).toEqual(INVALID);
  });

  test('handler argument order per action', async () => {
    const reconnect = await dispatch('bank_reconnect:3');
    expect(bankMocks.handleBankReconnectCallback).toHaveBeenCalledWith(
      reconnect.ctx,
      reconnect.bot,
      3,
      -100,
    );
    const sync = await dispatch('bank_sync:3');
    expect(bankMocks.handleBankSyncCallback).toHaveBeenCalledWith(sync.ctx, 3, -100);
    const toggle = await dispatch('bank_account_toggle:11:3');
    expect(bankMocks.handleBankAccountToggleCallback).toHaveBeenCalledWith(
      toggle.ctx,
      toggle.bot,
      11,
      3,
      -100,
    );
    const accounts = await dispatch('bank_accounts:4');
    expect(bankMocks.handleBankAccountsCallback).toHaveBeenCalledWith(
      accounts.ctx,
      accounts.bot,
      4,
      -100,
    );
    const nav = await dispatch('bank_letter_nav');
    expect(bankMocks.handleBankLetterNavCallback).toHaveBeenCalledWith(nav.ctx, nav.bot, -100);
    const wizardCancel = await dispatch('bank_wizard_cancel');
    expect(bankMocks.handleBankWizardCancelCallback).toHaveBeenCalledWith(wizardCancel.ctx, -100);
  });

  test('a throwing handler is contained: error logged, "Internal error" answered', async () => {
    bankMocks.handleBankAddCallback.mockImplementationOnce(() => Promise.reject(new Error('x')));
    const { ctx } = await dispatch('bank_add');
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(answeredTexts(ctx)).toEqual(['Internal error']);
  });

  test('a failing error-notification is swallowed', async () => {
    bankMocks.handleBankAddCallback.mockImplementationOnce(() => Promise.reject(new Error('x')));
    const ctx = fakeCallbackCtx('bank_add');
    ctx.answerCallbackQuery.mockImplementation(() => Promise.reject(new Error('answer failed')));
    await runCallback(ctx, fakeBot());
    expect(logMock.error).toHaveBeenCalledTimes(1);
  });
});

describe('bank_show_old / bank_skip_old', () => {
  test('show_old answers, announces, sends cards, then reports the count with plural form', async () => {
    sendOldMock.mockImplementationOnce(() => Promise.resolve(2));
    const { ctx } = await dispatch('bank_show_old:3');
    expect(answeredTexts(ctx)).toEqual(['Отправляю карточки...']);
    expect(ctx.editText.mock.calls.map((c) => c[0])).toEqual([
      '⌛ Отправляю карточки для подтверждения...',
      '✅ Отправлено 2 карточки для подтверждения',
    ]);
  });

  test('show_old with 5 cards uses the genitive plural', async () => {
    sendOldMock.mockImplementationOnce(() => Promise.resolve(5));
    const { ctx } = await dispatch('bank_show_old:3');
    expect(ctx.editText.mock.calls.at(-1)?.[0]).toBe('✅ Отправлено 5 карточек для подтверждения');
  });

  test('show_old/skip_old reject missing id or chat before doing any work', async () => {
    const a = await dispatch('bank_show_old:');
    const b = await dispatch('bank_skip_old:3', (c) => {
      c.message = undefined;
    });
    expect(answeredTexts(a.ctx)).toEqual(['Неверные данные']);
    expect(answeredTexts(b.ctx)).toEqual(['Неверные данные']);
    expect(sendOldMock).not.toHaveBeenCalled();
    expect(skipOldMock).not.toHaveBeenCalled();
  });

  test('skip_old reports how many transactions were skipped', async () => {
    skipOldMock.mockImplementationOnce(() => Promise.resolve(1));
    const { ctx } = await dispatch('bank_skip_old:3');
    expect(answeredTexts(ctx)).toEqual(['Пропускаю старые...']);
    expect(ctx.editText).toHaveBeenCalledWith('⏭ Пропущено 1 старая транзакция');
  });
});

describe('merchant_*', () => {
  test('approve answers, updates status and clears the keyboard', async () => {
    const { ctx, bot } = await dispatch('merchant_approve:11');
    expect(mockMerchantRules.updateStatus).toHaveBeenCalledWith(11, 'approved');
    expect(answeredTexts(ctx)).toEqual(['✅ Правило принято']);
    expect(bot.api.editMessageReplyMarkup).toHaveBeenCalledWith({
      chat_id: -100,
      message_id: 200,
      reply_markup: { inline_keyboard: [] },
    });
  });

  test('reject answers with its own text', async () => {
    const { ctx } = await dispatch('merchant_reject:11');
    expect(answeredTexts(ctx)).toEqual(['❌ Правило отклонено']);
  });

  test('a keyboard edit failure (old message) is swallowed', async () => {
    const ctx = fakeCallbackCtx('merchant_reject:11');
    const bot = fakeBot();
    bot.api.editMessageReplyMarkup.mockImplementation(() => Promise.reject(new Error('old')));
    await runCallback(ctx, bot);
    expect(logMock.error).not.toHaveBeenCalled();
    expect(answeredTexts(ctx)).toEqual(['❌ Правило отклонено']);
  });

  test('without a message the status is still updated but no keyboard is edited', async () => {
    const { bot } = await dispatch('merchant_approve:11', (c) => {
      c.message = undefined;
    });
    expect(mockMerchantRules.updateStatus).toHaveBeenCalledTimes(1);
    expect(bot.api.editMessageReplyMarkup).not.toHaveBeenCalled();
  });

  test('approve/reject with id 0 are rejected without touching the DB', async () => {
    const a = await dispatch('merchant_approve:0');
    const r = await dispatch('merchant_reject:x');
    expect(answeredTexts(a.ctx)).toEqual(['Неверные данные']);
    expect(answeredTexts(r.ctx)).toEqual(['Неверные данные']);
    expect(mockMerchantRules.updateStatus).not.toHaveBeenCalled();
  });

  test('edit needs a chat; with one it only acknowledges', async () => {
    const noChat = await dispatch('merchant_edit:11', (c) => {
      c.message = undefined;
    });
    expect(answeredTexts(noChat.ctx)).toEqual(['Неверные данные']);
    const ok = await dispatch('merchant_edit:11');
    expect(answeredTexts(ok.ctx)).toEqual([undefined]);
    expect(mockMerchantRules.updateStatus).not.toHaveBeenCalled();
  });
});

describe('sync_more', () => {
  const entry = (n: number, extra: { field?: string; comment?: string } = {}) => ({
    date: '2026-10-01',
    amount: n,
    currency: 'EUR',
    category: `C${n}`,
    comment: extra.comment ?? '',
    ...(extra.field ? { field: extra.field } : {}),
  });
  const many = (count: number) => Array.from({ length: count }, (_, i) => entry(i));

  test('missing section or chat → "Данные устарели" before the cache is consulted', async () => {
    const a = await dispatch('sync_more:key');
    const b = await dispatch('sync_more:key:a', (c) => {
      c.message = undefined;
    });
    expect(answeredTexts(a.ctx)).toEqual(['Данные устарели']);
    expect(answeredTexts(b.ctx)).toEqual(['Данные устарели']);
    expect(getSyncCachedResultMock).not.toHaveBeenCalled();
  });

  test('cache miss asks to re-run /sync', async () => {
    const { ctx } = await dispatch('sync_more:key:a');
    expect(answeredTexts(ctx)).toEqual(['Данные устарели. Выполни /sync заново.']);
  });

  test('section "a" lists only entries after the first page of 10', async () => {
    getSyncCachedResultMock.mockImplementation(() => ({
      added: many(12),
      deleted: [],
      updated: [],
    }));
    const { ctx } = await dispatch('sync_more:key:a');
    expect(answeredTexts(ctx)).toEqual([undefined]);
    expect(sendMessageMock).toHaveBeenCalledWith(
      '📋 Добавлено (ещё 2):\n  2026-10-01 10 EUR C10\n  2026-10-01 11 EUR C11',
    );
  });

  test('section "d" → Удалено; any other section → Обновлено, with the changed field', async () => {
    getSyncCachedResultMock.mockImplementation(() => ({
      added: [],
      deleted: [...many(10), entry(10)],
      updated: [...many(10), entry(11, { field: 'amount' })],
    }));
    await dispatch('sync_more:key:d');
    await dispatch('sync_more:key:zzz');
    expect(sendMessageMock.mock.calls.map((c) => c[0])).toEqual([
      '📋 Удалено (ещё 1):\n  2026-10-01 10 EUR C10',
      '📋 Обновлено (ещё 1):\n  2026-10-01 11 EUR C11 (amount)',
    ]);
  });

  test('over-long text is cut to 4090 chars plus an ellipsis line', async () => {
    getSyncCachedResultMock.mockImplementation(() => ({
      added: [...many(10), ...Array.from({ length: 200 }, (_, i) => entry(i + 100))],
      deleted: [],
      updated: [],
    }));
    await dispatch('sync_more:key:a');
    const text = String(sendMessageMock.mock.calls[0]?.[0]);
    expect(text.length).toBe(4090 + '\n...'.length);
    expect(text.endsWith('\n...')).toBe(true);
  });

  test('a failed send is logged, not thrown', async () => {
    getSyncCachedResultMock.mockImplementation(() => ({
      added: many(11),
      deleted: [],
      updated: [],
    }));
    sendMessageMock.mockImplementation(() => Promise.reject(new Error('tg down')));
    const { ctx } = await dispatch('sync_more:key:a');
    expect(answeredTexts(ctx)).toEqual([undefined]);
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(answeredTexts(ctx)).not.toContain('Internal error');
  });
});

describe('bsync_more', () => {
  const budget = (n: number, oldLimit?: number) => ({
    category: `C${n}`,
    limit: n,
    currency: 'EUR',
    ...(oldLimit === undefined ? {} : { oldLimit }),
  });
  const many = (count: number) => Array.from({ length: count }, (_, i) => budget(i));

  test('missing section → "Данные устарели"', async () => {
    const { ctx } = await dispatch('bsync_more:key');
    expect(answeredTexts(ctx)).toEqual(['Данные устарели']);
  });

  test('updated section shows the previous limit when present (including 0)', async () => {
    getBudgetSyncCachedResultMock.mockImplementation(() => ({
      added: [],
      deleted: [],
      updated: [...many(10), budget(10, 5), budget(11, 0)],
    }));
    await dispatch('bsync_more:key:u');
    expect(sendMessageMock).toHaveBeenCalledWith(
      '📋 Бюджеты — Обновлено (ещё 2):\n  C10: 10 EUR (было 5)\n  C11: 11 EUR (было 0)',
    );
  });

  test('added and deleted sections use their own labels', async () => {
    getBudgetSyncCachedResultMock.mockImplementation(() => ({
      added: [...many(10), budget(10)],
      deleted: [...many(10), budget(11)],
      updated: [],
    }));
    await dispatch('bsync_more:key:a');
    await dispatch('bsync_more:key:d');
    expect(sendMessageMock.mock.calls.map((c) => c[0])).toEqual([
      '📋 Бюджеты — Добавлено (ещё 1):\n  C10: 10 EUR',
      '📋 Бюджеты — Удалено (ещё 1):\n  C11: 11 EUR',
    ]);
  });
});
