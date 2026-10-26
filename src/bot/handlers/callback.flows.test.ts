// Characterization tests for the category-wizard, budget and receipt-item callbacks routed by
// callback.handler.ts. They pin reply texts, side-effect order and guard clauses so the
// handlers can be restructured without changing behavior.

import { beforeEach, describe, expect, test } from 'bun:test';
import { getCurrencySymbol, MESSAGES } from '../../config/constants';
import {
  answeredTexts,
  budgetPromptKeyboardMock,
  categoriesListKeyboardMock,
  dispatch,
  fakeBot,
  fakeCallbackCtx,
  getPendingCategoryExpenseMock,
  getPendingCategorySiblingsMock,
  logMock,
  mockCategories,
  mockGroups,
  mockPendingExpenses,
  mockReceiptItems,
  mockUsers,
  pendingExpense,
  queueCategoryBudgetPromptMock,
  receiptItem,
  resetCallbackMocks,
  runCallback,
  saveExpenseBatchMock,
  saveReceiptExpensesMock,
  sendMessageMock,
  setBudgetMock,
  showNextItemMock,
  showNextPendingCategoryStepMock,
  takeQueuedCategoryBudgetPromptsMock,
  trackMembershipMock,
} from './callback.test-support';

beforeEach(resetCallbackMocks);

const DELETED = { chat_id: -100, message_id: 200 };

describe('category:* — shared guard', () => {
  test('group not configured → rejected before any sub-action runs', async () => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => null);
    const { ctx } = await dispatch('category:cancel:77');
    expect(answeredTexts(ctx)).toEqual(['Группа не настроена']);
    expect(getPendingCategoryExpenseMock).not.toHaveBeenCalled();
  });

  test('callback without a message (no chat) is rejected', async () => {
    const { ctx } = await dispatch('category:cancel:77', (c) => {
      c.message = undefined;
    });
    expect(answeredTexts(ctx)).toEqual(['Группа не настроена']);
  });

  test('new user is created in the group and membership is tracked', async () => {
    mockUsers.findByTelegramId.mockImplementation(() => null);
    mockUsers.create.mockImplementation(() => ({ id: 10, telegram_id: 42, group_id: 1 }) as never);
    await dispatch('category:cancel:77');
    expect(mockUsers.create).toHaveBeenCalledWith({ telegram_id: 42, group_id: 1 });
    expect(trackMembershipMock).toHaveBeenCalledWith(42, 1);
  });

  test('user linked to another group is moved to the callback group', async () => {
    let calls = 0;
    mockUsers.findByTelegramId.mockImplementation(() => {
      calls += 1;
      return { id: 10, telegram_id: 42, group_id: calls === 1 ? 99 : 1 } as never;
    });
    const { ctx } = await dispatch('category:cancel:77');
    expect(mockUsers.update).toHaveBeenCalledWith(42, { group_id: 1 });
    expect(answeredTexts(ctx)).toEqual(['Отменено']);
  });

  test('user vanishing after the group move → rejected', async () => {
    let calls = 0;
    mockUsers.findByTelegramId.mockImplementation(() => {
      calls += 1;
      return calls === 1 ? ({ id: 10, telegram_id: 42, group_id: 99 } as never) : null;
    });
    const { ctx } = await dispatch('category:cancel:77');
    expect(answeredTexts(ctx)).toEqual(['Группа не настроена']);
  });

  test('unknown sub-action is silently ignored', async () => {
    const { ctx } = await dispatch('category:bogus:1');
    expect(answeredTexts(ctx)).toEqual([]);
  });
});

describe('category:add', () => {
  test('missing / non-numeric pending id → stale button', async () => {
    for (const data of ['category:add', 'category:add:abc']) {
      const { ctx } = await dispatch(data);
      expect(answeredTexts(ctx)).toEqual(['Кнопка устарела — отправь расход снова']);
    }
    expect(getPendingCategoryExpenseMock).not.toHaveBeenCalled();
  });

  test('unknown pending expense → already processed', async () => {
    const { ctx } = await dispatch('category:add:77');
    expect(getPendingCategoryExpenseMock).toHaveBeenCalledWith(10, 77);
    expect(answeredTexts(ctx)).toEqual(['Расход уже обработан']);
  });

  test('pending expense without detected category → already processed', async () => {
    getPendingCategoryExpenseMock.mockImplementation(() =>
      pendingExpense({ detected_category: null }),
    );
    const { ctx } = await dispatch('category:add:77');
    expect(answeredTexts(ctx)).toEqual(['Расход уже обработан']);
    expect(mockCategories.create).not.toHaveBeenCalled();
  });

  describe('with a pending expense', () => {
    const pending = pendingExpense();
    const sibling = pendingExpense({ id: 78 });

    beforeEach(() => {
      getPendingCategoryExpenseMock.mockImplementation(() => pending);
      getPendingCategorySiblingsMock.mockImplementation(() => [pending, sibling]);
      mockCategories.exists.mockImplementation(() => false);
    });

    test('creates the category, saves every sibling in one batch and queues the budget prompt', async () => {
      const { ctx, bot } = await dispatch('category:add:77');
      expect(mockCategories.exists).toHaveBeenCalledWith(1, 'Животные');
      expect(mockCategories.create).toHaveBeenCalledWith({ group_id: 1, name: 'Животные' });
      expect(answeredTexts(ctx)).toEqual([
        MESSAGES.categoryAdded.replace('{category}', 'Животные'),
      ]);
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
      expect(mockPendingExpenses.update).toHaveBeenCalledWith(77, { status: 'confirmed' });
      expect(mockPendingExpenses.update).toHaveBeenCalledWith(78, { status: 'confirmed' });
      expect(saveExpenseBatchMock).toHaveBeenCalledWith(10, 1, [77, 78]);
      expect(queueCategoryBudgetPromptMock).toHaveBeenCalledWith(10, 500, 'Животные');
      expect(showNextPendingCategoryStepMock).toHaveBeenCalledWith(10, 500);
    });

    test('existing category is reported, not recreated, and no budget prompt is queued', async () => {
      mockCategories.exists.mockImplementation(() => true);
      const { ctx } = await dispatch('category:add:77');
      expect(mockCategories.create).not.toHaveBeenCalled();
      expect(answeredTexts(ctx)).toEqual(['Категория уже существует: Животные']);
      expect(saveExpenseBatchMock).toHaveBeenCalledTimes(1);
      expect(queueCategoryBudgetPromptMock).not.toHaveBeenCalled();
    });

    test('no siblings → nothing saved, no budget prompt, wizard still advances', async () => {
      getPendingCategorySiblingsMock.mockImplementation(() => []);
      await dispatch('category:add:77');
      expect(saveExpenseBatchMock).not.toHaveBeenCalled();
      expect(queueCategoryBudgetPromptMock).not.toHaveBeenCalled();
      expect(showNextPendingCategoryStepMock).toHaveBeenCalledWith(10, 500);
    });

    test('failed save deletes the pending rows, reports the sheet error and skips the prompt', async () => {
      saveExpenseBatchMock.mockImplementation(() => Promise.reject(new Error('boom')));
      await dispatch('category:add:77');
      expect(mockPendingExpenses.delete).toHaveBeenCalledWith(77);
      expect(mockPendingExpenses.delete).toHaveBeenCalledWith(78);
      expect(sendMessageMock).toHaveBeenCalledWith('sheet error');
      expect(queueCategoryBudgetPromptMock).not.toHaveBeenCalled();
      expect(logMock.error).toHaveBeenCalled();
      expect(showNextPendingCategoryStepMock).toHaveBeenCalledWith(10, 500);
    });

    test('failed save stays silent when the callback carries no chat id any more', async () => {
      saveExpenseBatchMock.mockImplementation(() => Promise.reject(new Error('boom')));
      const { bot } = await dispatch('category:add:77', (c) => {
        c.answerCallbackQuery.mockImplementation(() => {
          c.message = undefined;
          return Promise.resolve();
        });
      });
      expect(mockPendingExpenses.delete).toHaveBeenCalledWith(77);
      expect(bot.api.deleteMessage).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    test('a failing message delete is logged and does not stop the flow', async () => {
      const ctx = fakeCallbackCtx('category:add:77');
      const bot = fakeBot();
      bot.api.deleteMessage.mockImplementation(() => Promise.reject(new Error('gone')));
      await runCallback(ctx, bot);
      expect(logMock.error).toHaveBeenCalled();
      expect(saveExpenseBatchMock).toHaveBeenCalledTimes(1);
    });

    test('wizard finished → deferred budget prompts are sent once each, after the save', async () => {
      showNextPendingCategoryStepMock.mockImplementation(() => Promise.resolve(false));
      takeQueuedCategoryBudgetPromptsMock.mockImplementation(() => ['Животные', 'Еда']);
      await dispatch('category:add:77');
      expect(takeQueuedCategoryBudgetPromptsMock).toHaveBeenCalledWith(10, 500);
      expect(budgetPromptKeyboardMock).toHaveBeenCalledWith('Животные', 'EUR');
      expect(budgetPromptKeyboardMock).toHaveBeenCalledWith('Еда', 'EUR');
      expect(sendMessageMock).toHaveBeenCalledTimes(2);
      expect(sendMessageMock).toHaveBeenCalledWith(
        '💰 Хочешь установить бюджет для категории "Животные"?',
        { reply_markup: { inline_keyboard: [[{ text: 'Животные/EUR', callback_data: 'x' }]] } },
      );
    });

    test('wizard still has steps → no budget prompts are taken', async () => {
      await dispatch('category:add:77');
      expect(takeQueuedCategoryBudgetPromptsMock).not.toHaveBeenCalled();
    });
  });
});

describe('category:select', () => {
  test('missing / non-numeric id → stale button', async () => {
    for (const data of ['category:select', 'category:select:x']) {
      const { ctx } = await dispatch(data);
      expect(answeredTexts(ctx)).toEqual(['Кнопка устарела — отправь расход снова']);
    }
  });

  test('unknown pending expense → already processed', async () => {
    const { ctx } = await dispatch('category:select:77');
    expect(answeredTexts(ctx)).toEqual(['Расход уже обработан']);
  });

  test('group without categories → message and no keyboard', async () => {
    getPendingCategoryExpenseMock.mockImplementation(() => pendingExpense());
    const { ctx } = await dispatch('category:select:77');
    expect(answeredTexts(ctx)).toEqual(['Нет сохраненных категорий']);
    expect(ctx.editReplyMarkup).not.toHaveBeenCalled();
  });

  test('swaps in the categories keyboard bound to the pending id, then answers', async () => {
    const categories = [{ id: 1, name: 'Еда' }];
    getPendingCategoryExpenseMock.mockImplementation(() => pendingExpense());
    mockCategories.findByGroupId.mockImplementation(() => categories);
    const { ctx } = await dispatch('category:select:77');
    expect(mockCategories.findByGroupId).toHaveBeenCalledWith(1);
    expect(categoriesListKeyboardMock).toHaveBeenCalledWith(categories, 77);
    expect(ctx.editReplyMarkup).toHaveBeenCalledWith({
      inline_keyboard: [[{ text: 'list/77', callback_data: 'x' }]],
    });
    expect(answeredTexts(ctx)).toEqual(['Выбери категорию']);
  });
});

describe('category:choose', () => {
  test('fewer than two params → stale button', async () => {
    for (const data of ['category:choose', 'category:choose:77']) {
      const { ctx } = await dispatch(data);
      expect(answeredTexts(ctx)).toEqual(['Кнопка устарела — отправь расход снова']);
    }
  });

  test('non-numeric ids → invalid data', async () => {
    for (const data of ['category:choose:x:1', 'category:choose:77:y']) {
      const { ctx } = await dispatch(data);
      expect(answeredTexts(ctx)).toEqual(['Некорректные данные']);
    }
  });

  test('unknown pending expense → already processed', async () => {
    mockCategories.findById.mockImplementation(() => ({ id: 3, name: 'Еда' }));
    const { ctx } = await dispatch('category:choose:77:3');
    expect(answeredTexts(ctx)).toEqual(['Расход уже обработан']);
  });

  test('unknown category → not found', async () => {
    getPendingCategoryExpenseMock.mockImplementation(() => pendingExpense());
    const { ctx } = await dispatch('category:choose:77:3');
    expect(mockCategories.findById).toHaveBeenCalledWith(3);
    expect(answeredTexts(ctx)).toEqual(['Категория не найдена']);
    expect(saveExpenseBatchMock).not.toHaveBeenCalled();
  });

  describe('with pending expense and category', () => {
    const pending = pendingExpense();
    const sibling = pendingExpense({ id: 78 });

    beforeEach(() => {
      getPendingCategoryExpenseMock.mockImplementation(() => pending);
      getPendingCategorySiblingsMock.mockImplementation(() => [pending, sibling]);
      mockCategories.findById.mockImplementation(() => ({ id: 3, name: 'Еда' }));
    });

    test('stamps the category on every sibling, deletes the prompt, saves the batch, advances', async () => {
      const { ctx, bot } = await dispatch('category:choose:77:3');
      for (const id of [77, 78]) {
        expect(mockPendingExpenses.update).toHaveBeenCalledWith(id, {
          detected_category: 'Еда',
          status: 'confirmed',
        });
      }
      expect(answeredTexts(ctx)).toEqual(['Категория: Еда']);
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
      expect(saveExpenseBatchMock).toHaveBeenCalledWith(10, 1, [77, 78]);
      expect(showNextPendingCategoryStepMock).toHaveBeenCalledWith(10, 500);
    });

    test('failed save deletes the pending rows and reports the sheet error', async () => {
      saveExpenseBatchMock.mockImplementation(() => Promise.reject(new Error('boom')));
      await dispatch('category:choose:77:3');
      expect(mockPendingExpenses.delete).toHaveBeenCalledWith(77);
      expect(mockPendingExpenses.delete).toHaveBeenCalledWith(78);
      expect(sendMessageMock).toHaveBeenCalledWith('sheet error');
      expect(showNextPendingCategoryStepMock).toHaveBeenCalledWith(10, 500);
    });

    test('failed save stays silent when the callback carries no chat id any more', async () => {
      saveExpenseBatchMock.mockImplementation(() => Promise.reject(new Error('boom')));
      const { bot } = await dispatch('category:choose:77:3', (c) => {
        c.answerCallbackQuery.mockImplementation(() => {
          c.message = undefined;
          return Promise.resolve();
        });
      });
      expect(mockPendingExpenses.delete).toHaveBeenCalledWith(77);
      expect(bot.api.deleteMessage).not.toHaveBeenCalled();
      expect(sendMessageMock).not.toHaveBeenCalled();
    });

    test('a failing message delete is logged and the save still happens', async () => {
      const ctx = fakeCallbackCtx('category:choose:77:3');
      const bot = fakeBot();
      bot.api.deleteMessage.mockImplementation(() => Promise.reject(new Error('gone')));
      await runCallback(ctx, bot);
      expect(logMock.error).toHaveBeenCalled();
      expect(saveExpenseBatchMock).toHaveBeenCalledTimes(1);
    });

    test('finished wizard sends deferred budget prompts', async () => {
      showNextPendingCategoryStepMock.mockImplementation(() => Promise.resolve(false));
      takeQueuedCategoryBudgetPromptsMock.mockImplementation(() => ['Еда']);
      await dispatch('category:choose:77:3');
      expect(sendMessageMock).toHaveBeenCalledWith(
        '💰 Хочешь установить бюджет для категории "Еда"?',
        { reply_markup: { inline_keyboard: [[{ text: 'Еда/EUR', callback_data: 'x' }]] } },
      );
    });
  });
});

describe('category:cancel', () => {
  test('answers first, deletes the prompt, drops every sibling and advances the wizard', async () => {
    const pending = pendingExpense();
    getPendingCategoryExpenseMock.mockImplementation(() => pending);
    getPendingCategorySiblingsMock.mockImplementation(() => [pending, pendingExpense({ id: 78 })]);
    const { ctx, bot } = await dispatch('category:cancel:77');
    expect(answeredTexts(ctx)).toEqual(['Отменено']);
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
    expect(mockPendingExpenses.delete).toHaveBeenCalledWith(77);
    expect(mockPendingExpenses.delete).toHaveBeenCalledWith(78);
    expect(showNextPendingCategoryStepMock).toHaveBeenCalledWith(10, 500);
  });

  test('non-numeric id → prompt deleted, nothing else touched', async () => {
    const { bot } = await dispatch('category:cancel:abc');
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
    expect(getPendingCategoryExpenseMock).not.toHaveBeenCalled();
    expect(mockPendingExpenses.delete).not.toHaveBeenCalled();
    expect(showNextPendingCategoryStepMock).not.toHaveBeenCalled();
  });

  test('already processed pending expense → no wizard advance', async () => {
    await dispatch('category:cancel:77');
    expect(mockPendingExpenses.delete).not.toHaveBeenCalled();
    expect(showNextPendingCategoryStepMock).not.toHaveBeenCalled();
  });

  test('delete failure is not swallowed: dispatcher reports an internal error', async () => {
    const ctx = fakeCallbackCtx('category:cancel:77');
    const bot = fakeBot();
    bot.api.deleteMessage.mockImplementation(() => Promise.reject(new Error('gone')));
    await runCallback(ctx, bot);
    expect(answeredTexts(ctx)).toEqual(['Отменено', 'Internal error']);
  });
});

describe('budget:*', () => {
  const month = expect.stringMatching(/^\d{4}-\d{2}$/);

  test('group not configured → rejected', async () => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => null);
    const { ctx } = await dispatch('budget:skip:Food');
    expect(answeredTexts(ctx)).toEqual(['Группа не настроена']);
  });

  test('"budget:set" stores the budget for the current month, answers, deletes the prompt', async () => {
    const { ctx, bot } = await dispatch('budget:set:Food:250:usd');
    expect(setBudgetMock).toHaveBeenCalledWith({
      groupId: 1,
      category: 'Food',
      month,
      amount: 250,
      currency: 'USD',
    });
    expect(answeredTexts(ctx)).toEqual([`✅ Бюджет установлен: ${getCurrencySymbol('USD')}250`]);
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
  });

  test('"budget:set" defaults to 100 in the group currency', async () => {
    const { ctx } = await dispatch('budget:set:Food');
    expect(setBudgetMock).toHaveBeenCalledWith({
      groupId: 1,
      category: 'Food',
      month,
      amount: 100,
      currency: 'EUR',
    });
    expect(answeredTexts(ctx)).toEqual([`✅ Бюджет установлен: ${getCurrencySymbol('EUR')}100`]);
  });

  test('unrecognized currency falls back to the group currency', async () => {
    await dispatch('budget:set:Food:50:bad');
    expect(setBudgetMock).toHaveBeenCalledWith(
      expect.objectContaining({ amount: 50, currency: 'EUR' }),
    );
  });

  test('amount is parsed with parseFloat semantics', async () => {
    await dispatch('budget:set:Food:12.5abc');
    expect(setBudgetMock).toHaveBeenCalledWith(expect.objectContaining({ amount: 12.5 }));
  });

  test('missing category is stored as an empty string', async () => {
    await dispatch('budget:set');
    expect(setBudgetMock).toHaveBeenCalledWith(expect.objectContaining({ category: '' }));
  });

  test('without a message ID nothing is deleted', async () => {
    const { bot } = await dispatch('budget:set:Food:5:EUR', (c) => {
      c.message = { id: 0, chat: { id: -100, type: 'supergroup' } };
    });
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
  });

  test('invalid amounts are rejected before touching the budget', async () => {
    for (const amount of ['abc', '0', '-5']) {
      const { ctx } = await dispatch(`budget:set:Food:${amount}`);
      expect(answeredTexts(ctx)).toEqual(['❌ Неверная сумма']);
    }
    expect(setBudgetMock).not.toHaveBeenCalled();
  });

  test('"budget:add-category" creates the category unconditionally, then stores the budget', async () => {
    const { ctx, bot } = await dispatch('budget:add-category:Food:75:USD');
    expect(mockCategories.exists).not.toHaveBeenCalled();
    expect(mockCategories.create).toHaveBeenCalledWith({ group_id: 1, name: 'Food' });
    expect(setBudgetMock).toHaveBeenCalledWith({
      groupId: 1,
      category: 'Food',
      month,
      amount: 75,
      currency: 'USD',
    });
    expect(answeredTexts(ctx)).toEqual([
      `✅ Категория "Food" создана, бюджет ${getCurrencySymbol('USD')}75 установлен`,
    ]);
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
  });

  test('"budget:add-category" with an invalid amount creates nothing', async () => {
    const { ctx } = await dispatch('budget:add-category:Food:nope');
    expect(answeredTexts(ctx)).toEqual(['❌ Неверная сумма']);
    expect(mockCategories.create).not.toHaveBeenCalled();
    expect(setBudgetMock).not.toHaveBeenCalled();
  });

  test('"budget:skip" and "budget:cancel" answer and delete the prompt', async () => {
    for (const [data, text] of [
      ['budget:skip:Food', '⏭️ Пропущено'],
      ['budget:cancel:Food', '❌ Отменено'],
    ] as const) {
      const { ctx, bot } = await dispatch(data);
      expect(answeredTexts(ctx)).toEqual([text]);
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
    }
  });

  test('unknown sub-action', async () => {
    const { ctx } = await dispatch('budget:zzz:Food');
    expect(answeredTexts(ctx)).toEqual(['Unknown budget action']);
  });
});

describe('confirm_receipt_item', () => {
  const pendingItem = receiptItem();

  test('missing or non-numeric params → Invalid parameters', async () => {
    for (const data of [
      'confirm_receipt_item',
      'confirm_receipt_item:5',
      'confirm_receipt_item::0',
      'confirm_receipt_item:x:0',
      'confirm_receipt_item:5:y',
    ]) {
      const { ctx } = await dispatch(data);
      expect(answeredTexts(ctx)).toEqual(['Invalid parameters']);
    }
    expect(mockReceiptItems.findById).not.toHaveBeenCalled();
  });

  test('group not configured → rejected', async () => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => null);
    const { ctx } = await dispatch('confirm_receipt_item:5:-1');
    expect(answeredTexts(ctx)).toEqual(['Группа не настроена']);
    expect(mockReceiptItems.findById).not.toHaveBeenCalled();
  });

  test('unknown or already processed item', async () => {
    const { ctx: unknown } = await dispatch('confirm_receipt_item:5:-1');
    expect(answeredTexts(unknown)).toEqual(['Товар не найден или уже обработан']);

    mockReceiptItems.findById.mockImplementation(() => receiptItem({ status: 'confirmed' }));
    const { ctx: done } = await dispatch('confirm_receipt_item:5:-1');
    expect(answeredTexts(done)).toEqual(['Товар не найден или уже обработан']);
    expect(mockReceiptItems.update).not.toHaveBeenCalled();
  });

  describe('with a pending item', () => {
    beforeEach(() => {
      mockReceiptItems.findById.mockImplementation(() => pendingItem);
      mockReceiptItems.findByPhotoQueueId.mockImplementation(() => [pendingItem]);
    });

    test('index -1 confirms the suggested category and shows the next item while others are pending', async () => {
      const { ctx, bot } = await dispatch('confirm_receipt_item:5:-1');
      expect(mockReceiptItems.update).toHaveBeenCalledWith(5, {
        status: 'confirmed',
        confirmed_category: 'Еда',
      });
      expect(mockCategories.create).not.toHaveBeenCalled();
      expect(answeredTexts(ctx)).toEqual(['✅ Еда']);
      expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
      expect(showNextItemMock).toHaveBeenCalledWith(1, 9);
      expect(saveReceiptExpensesMock).not.toHaveBeenCalled();
    });

    test('creates the category when it does not exist yet', async () => {
      mockCategories.exists.mockImplementation(() => false);
      await dispatch('confirm_receipt_item:5:-1');
      expect(mockCategories.exists).toHaveBeenCalledWith(1, 'Еда');
      expect(mockCategories.create).toHaveBeenCalledWith({ group_id: 1, name: 'Еда' });
    });

    test('saves the receipt once every item is confirmed', async () => {
      mockReceiptItems.findByPhotoQueueId.mockImplementation(() => [
        receiptItem({ status: 'confirmed' }),
      ]);
      await dispatch('confirm_receipt_item:5:-1');
      expect(saveReceiptExpensesMock).toHaveBeenCalledWith(9, 1, 10);
      expect(showNextItemMock).not.toHaveBeenCalled();
    });

    test('index picks from possible + already-confirmed categories, deduplicated, suggested excluded', async () => {
      mockReceiptItems.findByPhotoQueueId.mockImplementation(() => [
        pendingItem,
        receiptItem({ id: 6, status: 'confirmed', confirmed_category: 'Хозтовары' }),
        receiptItem({ id: 7, status: 'confirmed', confirmed_category: 'Напитки' }),
        receiptItem({ id: 8, status: 'confirmed', confirmed_category: 'Еда' }),
        receiptItem({ id: 9, status: 'skipped', confirmed_category: 'Skipped' }),
      ]);
      const { ctx } = await dispatch('confirm_receipt_item:5:2');
      expect(mockReceiptItems.update).toHaveBeenCalledWith(5, {
        status: 'confirmed',
        confirmed_category: 'Хозтовары',
      });
      expect(answeredTexts(ctx)).toEqual(['✅ Хозтовары']);
    });

    test('index 0 uses the first possible category', async () => {
      await dispatch('confirm_receipt_item:5:0');
      expect(mockReceiptItems.update).toHaveBeenCalledWith(5, {
        status: 'confirmed',
        confirmed_category: 'Напитки',
      });
    });

    test('out-of-range or negative index (other than -1) is rejected', async () => {
      for (const index of ['2', '5', '-2']) {
        const { ctx } = await dispatch(`confirm_receipt_item:5:${index}`);
        expect(answeredTexts(ctx)).toEqual(['Некорректный индекс категории']);
      }
      expect(mockReceiptItems.update).not.toHaveBeenCalled();
    });
  });
});

describe('receipt_item_other', () => {
  test('missing or non-numeric id → Invalid parameters', async () => {
    for (const data of ['receipt_item_other', 'receipt_item_other:x']) {
      const { ctx } = await dispatch(data);
      expect(answeredTexts(ctx)).toEqual(['Invalid parameters']);
    }
  });

  test('unknown or non-pending item', async () => {
    mockReceiptItems.findById.mockImplementation(() => receiptItem({ status: 'skipped' }));
    const { ctx } = await dispatch('receipt_item_other:5');
    expect(answeredTexts(ctx)).toEqual(['Товар не найден или уже обработан']);
    expect(mockReceiptItems.update).not.toHaveBeenCalled();
  });

  test('flags the item as awaiting text, drops the buttons, asks for a category', async () => {
    mockReceiptItems.findById.mockImplementation(() => receiptItem());
    const { ctx, bot } = await dispatch('receipt_item_other:5');
    expect(mockReceiptItems.update).toHaveBeenCalledWith(5, { waiting_for_category_input: 1 });
    expect(answeredTexts(ctx)).toEqual(['✏️ Напишите название категории']);
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
    expect(sendMessageMock).toHaveBeenCalledWith(
      '✏️ Напишите категорию для товара:\n<b>Молоко</b>\n\nПросто отправьте сообщение с названием категории.',
    );
  });

  test('without a chat the flag is still set but nothing is deleted or sent', async () => {
    mockReceiptItems.findById.mockImplementation(() => receiptItem());
    const { ctx, bot } = await dispatch('receipt_item_other:5', (c) => {
      c.message = undefined;
    });
    expect(mockReceiptItems.update).toHaveBeenCalledWith(5, { waiting_for_category_input: 1 });
    expect(answeredTexts(ctx)).toEqual(['✏️ Напишите название категории']);
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });
});

describe('skip_receipt_item', () => {
  test('missing or non-numeric id → Invalid parameters', async () => {
    for (const data of ['skip_receipt_item', 'skip_receipt_item:x']) {
      const { ctx } = await dispatch(data);
      expect(answeredTexts(ctx)).toEqual(['Invalid parameters']);
    }
  });

  test('group not configured → rejected', async () => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => null);
    const { ctx } = await dispatch('skip_receipt_item:5');
    expect(answeredTexts(ctx)).toEqual(['Группа не настроена']);
  });

  test('unknown or non-pending item', async () => {
    mockReceiptItems.findById.mockImplementation(() => receiptItem({ status: 'confirmed' }));
    const { ctx } = await dispatch('skip_receipt_item:5');
    expect(answeredTexts(ctx)).toEqual(['Товар не найден или уже обработан']);
    expect(mockReceiptItems.update).not.toHaveBeenCalled();
  });

  test('marks skipped, deletes the prompt and shows the next pending item', async () => {
    mockReceiptItems.findById.mockImplementation(() => receiptItem());
    mockReceiptItems.findByPhotoQueueId.mockImplementation(() => [
      receiptItem({ status: 'skipped' }),
      receiptItem({ id: 6, status: 'pending' }),
    ]);
    const { ctx, bot } = await dispatch('skip_receipt_item:5');
    expect(mockReceiptItems.update).toHaveBeenCalledWith(5, { status: 'skipped' });
    expect(answeredTexts(ctx)).toEqual(['⏭️ Товар пропущен']);
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
    expect(showNextItemMock).toHaveBeenCalledWith(1, 9);
    expect(saveReceiptExpensesMock).not.toHaveBeenCalled();
  });

  test('saves the receipt when nothing is pending anymore (confirmed or skipped)', async () => {
    mockReceiptItems.findById.mockImplementation(() => receiptItem());
    mockReceiptItems.findByPhotoQueueId.mockImplementation(() => [
      receiptItem({ status: 'skipped' }),
      receiptItem({ id: 6, status: 'confirmed' }),
    ]);
    await dispatch('skip_receipt_item:5');
    expect(saveReceiptExpensesMock).toHaveBeenCalledWith(9, 1, 10);
    expect(showNextItemMock).not.toHaveBeenCalled();
  });
});

describe('use_found_category', () => {
  test('missing item id, missing category or non-numeric id → Invalid parameters', async () => {
    for (const data of ['use_found_category', 'use_found_category:5', 'use_found_category:x:Еда']) {
      const { ctx } = await dispatch(data);
      expect(answeredTexts(ctx)).toEqual(['Invalid parameters']);
    }
  });

  test('group not configured → rejected', async () => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => null);
    const { ctx } = await dispatch('use_found_category:5:Еда');
    expect(answeredTexts(ctx)).toEqual(['Группа не настроена']);
  });

  test('unknown item → not found', async () => {
    const { ctx } = await dispatch('use_found_category:5:Еда');
    expect(answeredTexts(ctx)).toEqual(['Товар не найден']);
  });

  test('confirms regardless of the previous status, clears the waiting flag, shows the next item', async () => {
    mockReceiptItems.findById.mockImplementation(() => receiptItem({ status: 'skipped' }));
    mockReceiptItems.findByPhotoQueueId.mockImplementation(() => [receiptItem()]);
    mockCategories.exists.mockImplementation(() => false);
    const { ctx, bot } = await dispatch('use_found_category:5:Еда');
    expect(mockReceiptItems.update).toHaveBeenCalledWith(5, {
      status: 'confirmed',
      confirmed_category: 'Еда',
      waiting_for_category_input: 0,
    });
    expect(mockCategories.create).toHaveBeenCalledWith({ group_id: 1, name: 'Еда' });
    expect(answeredTexts(ctx)).toEqual(['✅ Еда']);
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
    expect(showNextItemMock).toHaveBeenCalledWith(1, 9);
  });

  test('saves the receipt when every item is confirmed; existing category is not recreated', async () => {
    mockReceiptItems.findById.mockImplementation(() => receiptItem());
    mockReceiptItems.findByPhotoQueueId.mockImplementation(() => [
      receiptItem({ status: 'confirmed' }),
    ]);
    await dispatch('use_found_category:5:Еда');
    expect(mockCategories.create).not.toHaveBeenCalled();
    expect(saveReceiptExpensesMock).toHaveBeenCalledWith(9, 1, 10);
  });

  test('only the first ":" segment is the category name', async () => {
    mockReceiptItems.findById.mockImplementation(() => receiptItem());
    await dispatch('use_found_category:5:Еда:лишнее');
    expect(mockReceiptItems.update).toHaveBeenCalledWith(
      5,
      expect.objectContaining({ confirmed_category: 'Еда' }),
    );
  });
});

describe('create_new_category', () => {
  test('missing item id, missing category or non-numeric id → Invalid parameters', async () => {
    for (const data of [
      'create_new_category',
      'create_new_category:5',
      'create_new_category:x:Еда',
    ]) {
      const { ctx } = await dispatch(data);
      expect(answeredTexts(ctx)).toEqual(['Invalid parameters']);
    }
  });

  test('group not configured → rejected', async () => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => null);
    const { ctx } = await dispatch('create_new_category:5:Еда');
    expect(answeredTexts(ctx)).toEqual(['Группа не настроена']);
  });

  test('unknown item → not found', async () => {
    const { ctx } = await dispatch('create_new_category:5:Еда');
    expect(answeredTexts(ctx)).toEqual(['Товар не найден']);
  });

  test('persists the normalized name, creates the category, shows the next item', async () => {
    mockReceiptItems.findById.mockImplementation(() => receiptItem());
    mockReceiptItems.findByPhotoQueueId.mockImplementation(() => [receiptItem()]);
    mockCategories.exists.mockImplementation(() => false);
    const { ctx, bot } = await dispatch('create_new_category:5:Еда');
    expect(mockReceiptItems.update).toHaveBeenCalledWith(5, {
      status: 'confirmed',
      confirmed_category: 'N(Еда)',
      waiting_for_category_input: 0,
    });
    expect(mockCategories.exists).toHaveBeenCalledWith(1, 'N(Еда)');
    expect(mockCategories.create).toHaveBeenCalledWith({ group_id: 1, name: 'N(Еда)' });
    expect(answeredTexts(ctx)).toEqual(['✅ Создана новая: N(Еда)']);
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
    expect(showNextItemMock).toHaveBeenCalledWith(1, 9);
  });

  test('saves the receipt when every item is confirmed', async () => {
    mockReceiptItems.findById.mockImplementation(() => receiptItem());
    mockReceiptItems.findByPhotoQueueId.mockImplementation(() => [
      receiptItem({ status: 'confirmed' }),
    ]);
    await dispatch('create_new_category:5:Еда');
    expect(mockCategories.create).not.toHaveBeenCalled();
    expect(saveReceiptExpensesMock).toHaveBeenCalledWith(9, 1, 10);
  });
});
