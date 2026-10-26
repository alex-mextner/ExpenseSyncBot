// Characterization tests for the category text input flow (receipt item waiting for a
// typed category), reached through handleExpenseMessage.

import { beforeEach, describe, expect, test } from 'bun:test';
import {
  fakeBotWithReactions,
  fakeMessageCtx,
  findBestCategoryMatchAsyncMock,
  handleBankEditReplyMock,
  makeGroup,
  makeReceiptItem,
  makeUser,
  mockCategories,
  mockGroups,
  mockPendingExpenses,
  mockReceiptItems,
  mockUsers,
  normalizeCategoryNameMock,
  resetAllMocks,
  saveReceiptExpensesMock,
  sendMessageMock,
  showNextItemForConfirmationMock,
} from './message.test-support';

// Dynamic import: the handler must load AFTER every mock.module() in the support file ran.
const { handleExpenseMessage } = await import('./message.handler');

async function sendCategoryText(text: string): Promise<boolean> {
  return handleExpenseMessage(
    fakeMessageCtx(text, { replyToMessageId: 12 }),
    fakeBotWithReactions().bot,
  );
}

describe('category text input — routing and lookup', () => {
  beforeEach(() => {
    resetAllMocks();
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockGroups.findById.mockReturnValue(makeGroup());
    mockReceiptItems.findWaitingForCategoryInput.mockReturnValue(makeReceiptItem());
    mockReceiptItems.findByPhotoQueueId.mockReturnValue([{ status: 'confirmed' }]);
    mockCategories.findByGroupId.mockReturnValue([{ name: 'Еда' }, { name: 'Транспорт' }]);
  });

  test('waiting item consumes the message before bank reply routing and expense parsing', async () => {
    findBestCategoryMatchAsyncMock.mockResolvedValue('Еда');

    const handled = await sendCategoryText('100 EUR groceries');

    expect(handled).toBe(true);
    expect(mockReceiptItems.findWaitingForCategoryInput).toHaveBeenCalledWith(1);
    expect(handleBankEditReplyMock).not.toHaveBeenCalled();
    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
  });

  test('normalizes the typed text and matches against the group categories', async () => {
    normalizeCategoryNameMock.mockImplementation((s: string) => s.trim().toLowerCase());
    findBestCategoryMatchAsyncMock.mockResolvedValue('Еда');

    await sendCategoryText('  ЕДА ');

    expect(findBestCategoryMatchAsyncMock).toHaveBeenCalledWith('еда', ['Еда', 'Транспорт']);
    expect(mockCategories.findByGroupId).toHaveBeenCalledWith(1);
  });
});

describe('category text input — exact match', () => {
  beforeEach(() => {
    resetAllMocks();
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockGroups.findById.mockReturnValue(makeGroup());
    mockUsers.findByTelegramId.mockReturnValue(makeUser({ id: 5 }));
    mockReceiptItems.findWaitingForCategoryInput.mockReturnValue(
      makeReceiptItem({ id: 7, photo_queue_id: 70 }),
    );
    mockReceiptItems.findByPhotoQueueId.mockReturnValue([{ status: 'confirmed' }]);
    mockCategories.findByGroupId.mockReturnValue([{ name: 'Еда' }]);
    // Case-insensitive equality counts as exact
    findBestCategoryMatchAsyncMock.mockResolvedValue('Еда');
  });

  test('confirms the item with the stored category name and tells the user', async () => {
    const handled = await sendCategoryText('еда');

    expect(handled).toBe(true);
    expect(mockReceiptItems.update).toHaveBeenCalledWith(7, {
      status: 'confirmed',
      confirmed_category: 'Еда',
      waiting_for_category_input: 0,
    });
    expect(sendMessageMock).toHaveBeenCalledWith('✅ Используется категория: <b>Еда</b>');
    expect(mockCategories.create).not.toHaveBeenCalled();
  });

  test('all items confirmed → saves receipt expenses with db user and group ids, after the notice', async () => {
    await sendCategoryText('Еда');

    expect(mockReceiptItems.findByPhotoQueueId).toHaveBeenCalledWith(70);
    expect(mockUsers.findByTelegramId).toHaveBeenCalledWith(99);
    expect(mockGroups.findById).toHaveBeenCalledWith(1);
    expect(saveReceiptExpensesMock).toHaveBeenCalledWith(70, 1, 5);
    expect(showNextItemForConfirmationMock).not.toHaveBeenCalled();

    const update = mockReceiptItems.update.mock.invocationCallOrder[0] ?? 0;
    const notice = sendMessageMock.mock.invocationCallOrder[0] ?? 0;
    const save = saveReceiptExpensesMock.mock.invocationCallOrder[0] ?? 0;
    expect(update).toBeLessThan(notice);
    expect(notice).toBeLessThan(save);
  });

  test('items still pending → shows the next item, nothing saved', async () => {
    mockReceiptItems.findByPhotoQueueId.mockReturnValue([
      { status: 'confirmed' },
      { status: 'pending' },
    ]);

    await sendCategoryText('Еда');

    expect(showNextItemForConfirmationMock).toHaveBeenCalledWith(1, 70);
    expect(saveReceiptExpensesMock).not.toHaveBeenCalled();
  });

  test('all confirmed but the user is unknown → no save, no next item', async () => {
    mockUsers.findByTelegramId.mockReturnValue(null);

    const handled = await sendCategoryText('Еда');

    expect(handled).toBe(true);
    expect(saveReceiptExpensesMock).not.toHaveBeenCalled();
    expect(showNextItemForConfirmationMock).not.toHaveBeenCalled();
  });

  test('all confirmed but the group row is gone → no save, no next item', async () => {
    mockGroups.findById.mockReturnValue(null);

    await sendCategoryText('Еда');

    expect(saveReceiptExpensesMock).not.toHaveBeenCalled();
    expect(showNextItemForConfirmationMock).not.toHaveBeenCalled();
  });
});

describe('category text input — similar match', () => {
  beforeEach(() => {
    resetAllMocks();
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockReceiptItems.findWaitingForCategoryInput.mockReturnValue(
      makeReceiptItem({ id: 7, photo_queue_id: 70 }),
    );
    mockCategories.findByGroupId.mockReturnValue([{ name: 'Еда' }]);
    findBestCategoryMatchAsyncMock.mockResolvedValue('Еда');
  });

  test('asks the user to use the found category or create the typed one', async () => {
    const handled = await sendCategoryText('Еду');

    expect(handled).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock).toHaveBeenCalledWith(
      'Найдена похожая категория: <b>Еда</b>\n\nВыберите действие:',
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: '✅ Использовать "Еда"', callback_data: 'use_found_category:7:Еда' }],
            [{ text: '❌ Создать новую "Еду"', callback_data: 'create_new_category:7:Еду' }],
          ],
        },
      },
    );
  });

  test('does not touch the item, categories or the save flow', async () => {
    await sendCategoryText('Еду');

    expect(mockReceiptItems.update).not.toHaveBeenCalled();
    expect(mockCategories.create).not.toHaveBeenCalled();
    expect(mockReceiptItems.findByPhotoQueueId).not.toHaveBeenCalled();
    expect(saveReceiptExpensesMock).not.toHaveBeenCalled();
    expect(showNextItemForConfirmationMock).not.toHaveBeenCalled();
  });
});

describe('category text input — no match (create new)', () => {
  beforeEach(() => {
    resetAllMocks();
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockGroups.findById.mockReturnValue(makeGroup());
    mockUsers.findByTelegramId.mockReturnValue(makeUser({ id: 5 }));
    mockReceiptItems.findWaitingForCategoryInput.mockReturnValue(
      makeReceiptItem({ id: 7, photo_queue_id: 70 }),
    );
    mockReceiptItems.findByPhotoQueueId.mockReturnValue([{ status: 'confirmed' }]);
    findBestCategoryMatchAsyncMock.mockResolvedValue(null);
  });

  test('confirms the item, creates the category and announces it', async () => {
    mockCategories.exists.mockReturnValue(false);

    const handled = await sendCategoryText('Книги');

    expect(handled).toBe(true);
    expect(mockReceiptItems.update).toHaveBeenCalledWith(7, {
      status: 'confirmed',
      confirmed_category: 'Книги',
      waiting_for_category_input: 0,
    });
    expect(mockCategories.exists).toHaveBeenCalledWith(1, 'Книги');
    expect(mockCategories.create).toHaveBeenCalledWith({ group_id: 1, name: 'Книги' });
    expect(sendMessageMock).toHaveBeenCalledWith('✅ Создана новая категория: <b>Книги</b>');
    expect(saveReceiptExpensesMock).toHaveBeenCalledWith(70, 1, 5);
  });

  test('category created meanwhile is not created twice', async () => {
    mockCategories.exists.mockReturnValue(true);

    await sendCategoryText('Книги');

    expect(mockCategories.create).not.toHaveBeenCalled();
    expect(mockReceiptItems.update).toHaveBeenCalledTimes(1);
    expect(saveReceiptExpensesMock).toHaveBeenCalledTimes(1);
  });

  test('uses the normalized name for the item, the category and the notice', async () => {
    normalizeCategoryNameMock.mockImplementation((s: string) => s.trim().toUpperCase());
    mockCategories.exists.mockReturnValue(false);

    await sendCategoryText(' книги ');

    expect(mockReceiptItems.update).toHaveBeenCalledWith(7, {
      status: 'confirmed',
      confirmed_category: 'КНИГИ',
      waiting_for_category_input: 0,
    });
    expect(mockCategories.create).toHaveBeenCalledWith({ group_id: 1, name: 'КНИГИ' });
    expect(sendMessageMock).toHaveBeenCalledWith('✅ Создана новая категория: <b>КНИГИ</b>');
  });

  test('items still pending → shows the next item', async () => {
    mockReceiptItems.findByPhotoQueueId.mockReturnValue([{ status: 'pending' }]);

    await sendCategoryText('Книги');

    expect(showNextItemForConfirmationMock).toHaveBeenCalledWith(1, 70);
    expect(saveReceiptExpensesMock).not.toHaveBeenCalled();
  });

  test('all confirmed but the user is unknown → no save, no next item', async () => {
    mockUsers.findByTelegramId.mockReturnValue(null);

    await sendCategoryText('Книги');

    expect(saveReceiptExpensesMock).not.toHaveBeenCalled();
    expect(showNextItemForConfirmationMock).not.toHaveBeenCalled();
  });

  test('all confirmed but the group row is gone → no save, no next item', async () => {
    mockGroups.findById.mockReturnValue(null);

    await sendCategoryText('Книги');

    expect(saveReceiptExpensesMock).not.toHaveBeenCalled();
    expect(showNextItemForConfirmationMock).not.toHaveBeenCalled();
  });
});
