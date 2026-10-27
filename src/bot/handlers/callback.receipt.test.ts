// Characterization tests for the "receipt:<action>:<queueId>" summary callbacks routed by
// callback.handler.ts (accept_all, bulk_edit, itemwise, accept_bulk, cancel).

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Group } from '../../database/types';
import {
  answeredTexts,
  buildSummaryMock,
  dispatch,
  type FakeBot,
  type FakeCtx,
  fakeBot,
  fakeCallbackCtx,
  formatSummaryMock,
  GROUP,
  logMock,
  mockCategories,
  mockGroups,
  mockPhotoQueue,
  mockReceiptItems,
  mockUsers,
  queueItem,
  receiptItem,
  resetCallbackMocks,
  runCallback,
  saveReceiptExpensesMock,
  sendMessageMock,
  showNextItemMock,
  summaryToCategoryMapMock,
  USER,
} from './callback.test-support';

beforeEach(() => {
  resetCallbackMocks();
  mockPhotoQueue.findById.mockImplementation(() => queueItem());
});

const DELETED = { chat_id: -100, message_id: 200 };

describe('receipt:* — shared preconditions', () => {
  test('missing action or queue id → Invalid parameters', async () => {
    for (const data of ['receipt', 'receipt:accept_all', 'receipt::9']) {
      const { ctx } = await dispatch(data);
      expect(answeredTexts(ctx)).toEqual(['Invalid parameters']);
    }
    expect(mockPhotoQueue.findById).not.toHaveBeenCalled();
  });

  test('non-numeric queue id → Invalid queue ID', async () => {
    const { ctx } = await dispatch('receipt:accept_all:abc');
    expect(answeredTexts(ctx)).toEqual(['Invalid queue ID']);
  });

  test('unknown queue item → receipt not found', async () => {
    mockPhotoQueue.findById.mockImplementation(() => null);
    const { ctx } = await dispatch('receipt:accept_all:9');
    expect(mockPhotoQueue.findById).toHaveBeenCalledWith(9);
    expect(answeredTexts(ctx)).toEqual(['Чек не найден']);
  });

  test('group of the queue item is looked up by its own group_id', async () => {
    mockPhotoQueue.findById.mockImplementation(() => queueItem({ group_id: 7 }));
    mockGroups.findById.mockImplementation(() => null);
    const { ctx } = await dispatch('receipt:accept_all:9');
    expect(mockGroups.findById).toHaveBeenCalledWith(7);
    expect(answeredTexts(ctx)).toEqual(['Группа не найдена']);
  });

  test('user missing everywhere → user not found', async () => {
    mockUsers.findByTelegramId.mockImplementation(() => null);
    mockUsers.create.mockImplementation(() => null);
    const { ctx } = await dispatch('receipt:accept_all:9');
    expect(answeredTexts(ctx)).toEqual(['Пользователь не найден']);
    expect(saveReceiptExpensesMock).not.toHaveBeenCalled();
  });

  test('chat group unknown but the user exists → falls back to the plain user lookup', async () => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => null);
    await dispatch('receipt:accept_all:9');
    expect(saveReceiptExpensesMock).toHaveBeenCalledWith(9, 1, USER.id);
  });

  test('unknown sub-action', async () => {
    const { ctx } = await dispatch('receipt:frobnicate:9');
    expect(answeredTexts(ctx)).toEqual(['Unknown receipt action']);
  });
});

describe('receipt:accept_all', () => {
  test('confirms only pending items with their suggested category and saves with the queue group', async () => {
    const queueGroup: Group = { ...GROUP, id: 7 };
    mockPhotoQueue.findById.mockImplementation(() => queueItem({ group_id: 7 }));
    mockGroups.findById.mockImplementation(() => queueGroup);
    mockReceiptItems.findByPhotoQueueId.mockImplementation(() => [
      receiptItem({ id: 5, suggested_category: 'Еда' }),
      receiptItem({ id: 6, status: 'confirmed', suggested_category: 'Другое' }),
      receiptItem({ id: 8, status: 'skipped', suggested_category: 'Другое' }),
    ]);
    mockCategories.exists.mockImplementation(() => false);
    const { ctx, bot } = await dispatch('receipt:accept_all:9');
    expect(mockReceiptItems.update).toHaveBeenCalledTimes(1);
    expect(mockReceiptItems.update).toHaveBeenCalledWith(5, {
      status: 'confirmed',
      confirmed_category: 'Еда',
    });
    expect(mockCategories.create).toHaveBeenCalledTimes(1);
    expect(mockCategories.create).toHaveBeenCalledWith({ group_id: 7, name: 'Еда' });
    expect(answeredTexts(ctx)).toEqual(['✅ Принято!']);
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
    expect(saveReceiptExpensesMock).toHaveBeenCalledWith(9, 7, 10);
  });

  test('existing category is not recreated', async () => {
    mockReceiptItems.findByPhotoQueueId.mockImplementation(() => [receiptItem()]);
    await dispatch('receipt:accept_all:9');
    expect(mockCategories.create).not.toHaveBeenCalled();
  });

  test('a failing message delete is swallowed and the receipt is still saved', async () => {
    const ctx = fakeCallbackCtx('receipt:accept_all:9');
    const bot = fakeBot();
    bot.api.deleteMessage.mockImplementation(() => Promise.reject(new Error('gone')));
    await runCallback(ctx, bot);
    expect(answeredTexts(ctx)).toEqual(['✅ Принято!']);
    expect(saveReceiptExpensesMock).toHaveBeenCalledWith(9, 1, 10);
  });

  test('without a message nothing is deleted', async () => {
    const { bot } = await dispatch('receipt:accept_all:9', (c) => {
      c.message = undefined;
    });
    expect(bot.api.deleteMessage).not.toHaveBeenCalled();
    expect(saveReceiptExpensesMock).toHaveBeenCalledTimes(1);
  });
});

describe('receipt:bulk_edit', () => {
  const items = [receiptItem(), receiptItem({ id: 6 })];

  test('flags bulk-correction mode, then rewrites the summary message with instructions', async () => {
    mockReceiptItems.findByPhotoQueueId.mockImplementation(() => items);
    const { ctx, bot } = await dispatch('receipt:bulk_edit:9');
    expect(mockPhotoQueue.update).toHaveBeenCalledWith(9, {
      summary_mode: 1,
      waiting_for_bulk_correction: 1,
      summary_message_id: 200,
    });
    expect(answeredTexts(ctx)).toEqual(['🎨 Напишите корректировку']);
    expect(buildSummaryMock).toHaveBeenCalledWith(items);
    expect(formatSummaryMock).toHaveBeenCalledWith({ built: true }, 2);
    expect(bot.api.editMessageText).toHaveBeenCalledWith({
      chat_id: -100,
      message_id: 200,
      text: 'SUMMARY(2 items)\n\n✏️ <i>Напишите корректировку текстом, например:</i>\n<code>перенеси салфетки в Хозтовары</code>',
      parse_mode: 'HTML',
    });
  });

  test('edit failure is logged, not thrown', async () => {
    const ctx = fakeCallbackCtx('receipt:bulk_edit:9');
    const bot = fakeBot();
    bot.api.editMessageText.mockImplementation(() => Promise.reject(new Error('too old')));
    await runCallback(ctx, bot);
    expect(logMock.error).toHaveBeenCalled();
    expect(answeredTexts(ctx)).toEqual(['🎨 Напишите корректировку']);
  });

  test('without a message the flag is set (null message id) and nothing is edited', async () => {
    const { ctx, bot } = await dispatch('receipt:bulk_edit:9', (c) => {
      c.message = undefined;
    });
    expect(mockPhotoQueue.update).toHaveBeenCalledWith(9, {
      summary_mode: 1,
      waiting_for_bulk_correction: 1,
      summary_message_id: null,
    });
    expect(answeredTexts(ctx)).toEqual(['🎨 Напишите корректировку']);
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
    expect(mockReceiptItems.findByPhotoQueueId).not.toHaveBeenCalled();
  });
});

describe('receipt:itemwise', () => {
  test('resets summary mode, deletes the summary and starts the item-by-item flow', async () => {
    const { ctx, bot } = await dispatch('receipt:itemwise:9');
    expect(mockPhotoQueue.update).toHaveBeenCalledWith(9, {
      summary_mode: 0,
      waiting_for_bulk_correction: 0,
      ai_summary: null,
      correction_history: null,
    });
    expect(answeredTexts(ctx)).toEqual(['📦 По одной позиции']);
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
    expect(showNextItemMock).toHaveBeenCalledWith(1, 9);
  });

  test('a failing message delete is swallowed', async () => {
    const ctx = fakeCallbackCtx('receipt:itemwise:9');
    const bot = fakeBot();
    bot.api.deleteMessage.mockImplementation(() => Promise.reject(new Error('gone')));
    await runCallback(ctx, bot);
    expect(showNextItemMock).toHaveBeenCalledWith(1, 9);
  });
});

describe('receipt:accept_bulk', () => {
  const pendingA = receiptItem({ id: 5, name_ru: 'Молоко', suggested_category: 'Еда' });
  const pendingB = receiptItem({ id: 6, name_ru: 'Мыло', suggested_category: 'Прочее' });
  const confirmed = receiptItem({ id: 7, status: 'confirmed', suggested_category: 'Другое' });

  beforeEach(() => {
    mockReceiptItems.findByPhotoQueueId.mockImplementation(() => [pendingA, pendingB, confirmed]);
  });

  function expectFinished(ctx: FakeCtx, bot: FakeBot) {
    expect(mockPhotoQueue.update).toHaveBeenLastCalledWith(9, {
      summary_mode: 0,
      waiting_for_bulk_correction: 0,
    });
    expect(answeredTexts(ctx)).toEqual(['✅ Принято!']);
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
    expect(saveReceiptExpensesMock).toHaveBeenCalledWith(9, 1, 10);
  }

  test('AI summary: categories come from the summary map, falling back to the suggestion', async () => {
    mockPhotoQueue.findById.mockImplementation(() => queueItem({ ai_summary: '{"cats":1}' }));
    summaryToCategoryMapMock.mockImplementation(() => new Map([['Молоко', 'Молочка']]));
    mockCategories.exists.mockImplementation(() => false);
    const { ctx, bot } = await dispatch('receipt:accept_bulk:9');
    expect(summaryToCategoryMapMock).toHaveBeenCalledWith({ cats: 1 });
    expect(mockReceiptItems.update).toHaveBeenCalledTimes(2);
    expect(mockReceiptItems.update).toHaveBeenCalledWith(5, {
      status: 'confirmed',
      confirmed_category: 'Молочка',
    });
    expect(mockReceiptItems.update).toHaveBeenCalledWith(6, {
      status: 'confirmed',
      confirmed_category: 'Прочее',
    });
    expect(mockCategories.create).toHaveBeenCalledWith({ group_id: 1, name: 'Молочка' });
    expect(mockCategories.create).toHaveBeenCalledWith({ group_id: 1, name: 'Прочее' });
    expectFinished(ctx, bot);
  });

  test('AI summary with existing categories creates nothing', async () => {
    mockPhotoQueue.findById.mockImplementation(() => queueItem({ ai_summary: '{}' }));
    await dispatch('receipt:accept_bulk:9');
    expect(mockCategories.create).not.toHaveBeenCalled();
    expect(mockReceiptItems.update).toHaveBeenCalledTimes(2);
  });

  test('unparsable AI summary: error logged, pending items get their suggested category (no category creation)', async () => {
    mockPhotoQueue.findById.mockImplementation(() => queueItem({ ai_summary: '{not json' }));
    mockCategories.exists.mockImplementation(() => false);
    const { ctx, bot } = await dispatch('receipt:accept_bulk:9');
    expect(logMock.error).toHaveBeenCalled();
    expect(summaryToCategoryMapMock).not.toHaveBeenCalled();
    expect(mockReceiptItems.update).toHaveBeenCalledTimes(2);
    expect(mockReceiptItems.update).toHaveBeenCalledWith(5, {
      status: 'confirmed',
      confirmed_category: 'Еда',
    });
    expect(mockCategories.create).not.toHaveBeenCalled();
    expectFinished(ctx, bot);
  });

  test('summary conversion failure after partial progress re-applies suggestions to every pending item', async () => {
    mockPhotoQueue.findById.mockImplementation(() => queueItem({ ai_summary: '{}' }));
    mockReceiptItems.update.mockImplementationOnce(() => {
      throw new Error('db down');
    });
    await dispatch('receipt:accept_bulk:9');
    expect(logMock.error).toHaveBeenCalled();
    expect(mockReceiptItems.update).toHaveBeenCalledTimes(3);
    expect(saveReceiptExpensesMock).toHaveBeenCalledTimes(1);
  });

  test('no AI summary: suggested categories, created when missing', async () => {
    mockCategories.exists.mockImplementation(() => false);
    const { ctx, bot } = await dispatch('receipt:accept_bulk:9');
    expect(summaryToCategoryMapMock).not.toHaveBeenCalled();
    expect(mockReceiptItems.update).toHaveBeenCalledTimes(2);
    expect(mockCategories.create).toHaveBeenCalledWith({ group_id: 1, name: 'Еда' });
    expect(mockCategories.create).toHaveBeenCalledWith({ group_id: 1, name: 'Прочее' });
    expectFinished(ctx, bot);
  });

  test('no AI summary, categories already exist: nothing created', async () => {
    await dispatch('receipt:accept_bulk:9');
    expect(mockCategories.create).not.toHaveBeenCalled();
  });

  test('a failing message delete is swallowed', async () => {
    const ctx = fakeCallbackCtx('receipt:accept_bulk:9');
    const bot = fakeBot();
    bot.api.deleteMessage.mockImplementation(() => Promise.reject(new Error('gone')));
    await runCallback(ctx, bot);
    expect(saveReceiptExpensesMock).toHaveBeenCalledTimes(1);
  });
});

describe('receipt:cancel', () => {
  test('purges processed items, closes the queue entry, deletes the summary and notifies', async () => {
    const { ctx, bot } = await dispatch('receipt:cancel:9');
    expect(mockReceiptItems.deleteProcessedByPhotoQueueId).toHaveBeenCalledWith(9);
    expect(mockPhotoQueue.update).toHaveBeenCalledWith(9, {
      status: 'done',
      summary_mode: 0,
      waiting_for_bulk_correction: 0,
      ai_summary: null,
      correction_history: null,
    });
    expect(answeredTexts(ctx)).toEqual(['❌ Отменено']);
    expect(bot.api.deleteMessage).toHaveBeenCalledWith(DELETED);
    expect(sendMessageMock).toHaveBeenCalledWith('❌ Обработка чека отменена');
    expect(saveReceiptExpensesMock).not.toHaveBeenCalled();
  });

  test('a failing message delete is swallowed and the notification is still sent', async () => {
    const ctx = fakeCallbackCtx('receipt:cancel:9');
    const bot = fakeBot();
    bot.api.deleteMessage.mockImplementation(() => Promise.reject(new Error('gone')));
    await runCallback(ctx, bot);
    expect(sendMessageMock).toHaveBeenCalledWith('❌ Обработка чека отменена');
  });
});
