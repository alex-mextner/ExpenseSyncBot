// Characterization tests for handleExpenseMessage: awaited-input routing, user/group
// bookkeeping, and the expense save pipeline (reactions, error, summary, wizard, advice).

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { PhotoQueueItem } from '../../database/types';
import { DevTaskState } from '../../services/dev-pipeline/types';
import { getSheetErrorMessage } from '../services/sheet-errors';
import {
  consumePendingDesignEditMock,
  consumePendingFeedbackMock,
  extractURLsFromTextMock,
  type FakePipeline,
  fakeBotWithReactions,
  fakeMessageCtx,
  findBestCategoryMatchAsyncMock,
  getPipelineInstanceMock,
  handleBankEditReplyMock,
  handleCustomCurrencyInputMock,
  handleWizardInputMock,
  isAwaitingCustomCurrencyMock,
  logMock,
  makeGroup,
  makeUser,
  maybeSmartAdviceMock,
  mockCategories,
  mockDevTasks,
  mockGroupMembers,
  mockGroups,
  mockPendingExpenses,
  mockPhotoQueue,
  mockReceiptItems,
  mockUsers,
  processPaymentLinksMock,
  resetAllMocks,
  resolveOtpForGroupMock,
  saveExpenseBatchMock,
  sendMessageMock,
  setExpenseReactionMock,
  showNextPendingCategoryStepMock,
  submitFeedbackMock,
} from './message.test-support';

// Bulk-correction collaborators are imported dynamically by the handler.
const applyCorrectionWithAIMock = mock(() => Promise.resolve({}));
mock.module('../../services/receipt/receipt-summarizer', () => ({
  buildSummaryFromItems: mock(() => ({})),
  formatSummaryMessage: mock(() => 'summary-text'),
  applyCorrectionWithAI: applyCorrectionWithAIMock,
  validateSummaryTotals: mock(() => true),
}));
mock.module('../keyboards', () => ({
  createBulkEditKeyboard: mock((id: number) => ({ inline_keyboard: [[{ text: 'edit', id }]] })),
}));
mock.module('../../services/receipt/status-writer', () => ({
  StatusWriter: class {
    append = mock();
    finalize = mock(() => Promise.resolve());
    close = mock(() => Promise.resolve());
  },
}));

// Dynamic import: the handler must load AFTER every mock.module() above has registered.
const { handleExpenseMessage } = await import('./message.handler');

function makePipeline(): FakePipeline {
  return {
    editPR: mock((_taskId: number, _text: string) => Promise.resolve()),
    editDesign: mock((_taskId: number, _text: string) => Promise.resolve()),
  };
}

describe('handleExpenseMessage — pending design/code edit input', () => {
  beforeEach(() => {
    resetAllMocks();
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    consumePendingDesignEditMock.mockReturnValue(5);
  });

  test('no pipeline instance: input is swallowed, nothing is sent, later flows are skipped', async () => {
    const { bot } = fakeBotWithReactions();

    const handled = await handleExpenseMessage(fakeMessageCtx('new design'), bot);

    expect(handled).toBe(true);
    expect(consumePendingDesignEditMock).toHaveBeenCalledWith(-100);
    expect(sendMessageMock).not.toHaveBeenCalled();
    expect(consumePendingFeedbackMock).not.toHaveBeenCalled();
    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
  });

  test.each([
    DevTaskState.AWAITING_REVIEW,
    DevTaskState.AWAITING_MERGE,
  ])('task in %s → editPR with the message text', async (state) => {
    const pipeline = makePipeline();
    getPipelineInstanceMock.mockReturnValue(pipeline);
    mockDevTasks.findById.mockReturnValue({ state });

    const handled = await handleExpenseMessage(
      fakeMessageCtx('fix the PR'),
      fakeBotWithReactions().bot,
    );

    expect(handled).toBe(true);
    expect(mockDevTasks.findById).toHaveBeenCalledWith(5);
    expect(pipeline.editPR).toHaveBeenCalledWith(5, 'fix the PR');
    expect(pipeline.editDesign).not.toHaveBeenCalled();
  });

  test('task in another state → editDesign', async () => {
    const pipeline = makePipeline();
    getPipelineInstanceMock.mockReturnValue(pipeline);
    mockDevTasks.findById.mockReturnValue({ state: DevTaskState.APPROVAL });

    await handleExpenseMessage(fakeMessageCtx('tweak design'), fakeBotWithReactions().bot);

    expect(pipeline.editDesign).toHaveBeenCalledWith(5, 'tweak design');
    expect(pipeline.editPR).not.toHaveBeenCalled();
  });

  test('task not found → editDesign', async () => {
    const pipeline = makePipeline();
    getPipelineInstanceMock.mockReturnValue(pipeline);
    mockDevTasks.findById.mockReturnValue(null);

    await handleExpenseMessage(fakeMessageCtx('tweak design'), fakeBotWithReactions().bot);

    expect(pipeline.editDesign).toHaveBeenCalledWith(5, 'tweak design');
    expect(pipeline.editPR).not.toHaveBeenCalled();
  });

  test('pipeline error is reported to the chat and the message is still consumed', async () => {
    const pipeline = makePipeline();
    pipeline.editDesign.mockRejectedValue(new Error('pipeline exploded'));
    getPipelineInstanceMock.mockReturnValue(pipeline);

    const handled = await handleExpenseMessage(
      fakeMessageCtx('tweak design'),
      fakeBotWithReactions().bot,
    );

    expect(handled).toBe(true);
    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    expect(sendMessageMock.mock.calls[0]?.[0]).toBe('pipeline exploded');
  });
});

describe('handleExpenseMessage — feedback, bulk correction and bank edit routing', () => {
  beforeEach(() => {
    resetAllMocks();
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockCategories.exists.mockReturnValue(true);
  });

  test('pending feedback prompt consumes the text', async () => {
    consumePendingFeedbackMock.mockReturnValue(9);
    const ctx = fakeMessageCtx('great bot');
    const { bot } = fakeBotWithReactions();
    const group = makeGroup();

    const handled = await handleExpenseMessage(ctx, bot);

    expect(handled).toBe(true);
    expect(consumePendingFeedbackMock).toHaveBeenCalledWith(-100, 99);
    expect(submitFeedbackMock).toHaveBeenCalledWith(ctx, group, 'great bot', {
      promptMessageId: 9,
      bot,
    });
    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
  });

  test('feedback id 0 is still a pending prompt (null check, not truthiness)', async () => {
    consumePendingFeedbackMock.mockReturnValue(0);

    const handled = await handleExpenseMessage(fakeMessageCtx('text'), fakeBotWithReactions().bot);

    expect(handled).toBe(true);
    expect(submitFeedbackMock).toHaveBeenCalledTimes(1);
  });

  test('waiting bulk correction consumes the text, before category input and bank reply', async () => {
    const queueItem = { id: 31, ai_summary: null, correction_history: null } as PhotoQueueItem;
    mockPhotoQueue.findWaitingForBulkCorrection.mockReturnValue(queueItem);

    const handled = await handleExpenseMessage(
      fakeMessageCtx('move napkins', { replyToMessageId: 8 }),
      fakeBotWithReactions().bot,
    );

    expect(handled).toBe(true);
    expect(mockPhotoQueue.findWaitingForBulkCorrection).toHaveBeenCalledWith(1);
    // No receipt items for the queue → handler reports and stops
    expect(mockReceiptItems.findByPhotoQueueId).toHaveBeenCalledWith(31);
    expect(sendMessageMock).toHaveBeenCalledWith('❌ Товары не найдены');
    expect(mockReceiptItems.findWaitingForCategoryInput).not.toHaveBeenCalled();
    expect(handleBankEditReplyMock).not.toHaveBeenCalled();
    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
  });

  test('bank edit reply that is not handled falls through to expense parsing', async () => {
    handleBankEditReplyMock.mockResolvedValue(false);

    const handled = await handleExpenseMessage(
      fakeMessageCtx('100 EUR groceries', { replyToMessageId: 555 }),
      fakeBotWithReactions().bot,
    );

    expect(handled).toBe(true);
    expect(handleBankEditReplyMock).toHaveBeenCalledTimes(1);
    expect(mockPendingExpenses.create).toHaveBeenCalledTimes(1);
  });

  test('payment links are passed the group and user; no payment falls through to parsing', async () => {
    extractURLsFromTextMock.mockReturnValue(['https://x.example/r']);
    processPaymentLinksMock.mockResolvedValue(false);
    const { bot } = fakeBotWithReactions();

    const handled = await handleExpenseMessage(fakeMessageCtx('100 EUR groceries'), bot);

    expect(handled).toBe(true);
    expect(processPaymentLinksMock.mock.calls[0]).toEqual([
      bot,
      -100,
      500,
      ['https://x.example/r'],
      makeGroup(),
      makeUser(),
    ]);
    expect(mockPendingExpenses.create).toHaveBeenCalledTimes(1);
  });

  test('slash commands skip onboarding, wizard and OTP consumers and are routed to AI', async () => {
    const handled = await handleExpenseMessage(
      fakeMessageCtx('/start'),
      fakeBotWithReactions().bot,
    );

    expect(handled).toBe(false);
    expect(isAwaitingCustomCurrencyMock).not.toHaveBeenCalled();
    expect(handleWizardInputMock).not.toHaveBeenCalled();
    expect(resolveOtpForGroupMock).not.toHaveBeenCalled();
    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
  });

  test('not awaiting custom currency: continues, connect handler untouched', async () => {
    isAwaitingCustomCurrencyMock.mockReturnValue(false);

    await handleExpenseMessage(fakeMessageCtx('100 EUR groceries'), fakeBotWithReactions().bot);

    expect(isAwaitingCustomCurrencyMock).toHaveBeenCalledWith(-100);
    expect(handleCustomCurrencyInputMock).not.toHaveBeenCalled();
    expect(handleWizardInputMock).toHaveBeenCalledWith(
      expect.anything(),
      1,
      '100 EUR groceries',
      expect.anything(),
    );
    expect(resolveOtpForGroupMock).toHaveBeenCalledWith(-100, '100 EUR groceries');
  });

  test('message from the active topic is processed', async () => {
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup({ active_topic_id: 7 }));

    const handled = await handleExpenseMessage(
      fakeMessageCtx('100 EUR groceries', { threadId: 7 }),
      fakeBotWithReactions().bot,
    );

    expect(handled).toBe(true);
    expect(saveExpenseBatchMock).toHaveBeenCalledTimes(1);
  });
});

describe('handleExpenseMessage — user and group bookkeeping', () => {
  beforeEach(() => {
    resetAllMocks();
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockCategories.exists.mockReturnValue(true);
  });

  test('unknown user is created in the group', async () => {
    mockUsers.findByTelegramId.mockReturnValue(null);

    const handled = await handleExpenseMessage(
      fakeMessageCtx('100 EUR groceries'),
      fakeBotWithReactions().bot,
    );

    expect(handled).toBe(true);
    expect(mockUsers.create).toHaveBeenCalledWith({ telegram_id: 99, group_id: 1 });
    expect(mockUsers.update).not.toHaveBeenCalled();
    expect(saveExpenseBatchMock).toHaveBeenCalledWith(1, 1, [42]);
  });

  test('user in another group is moved and re-read', async () => {
    mockUsers.findByTelegramId
      .mockReturnValueOnce(makeUser({ id: 3, group_id: 2 }))
      .mockReturnValueOnce(makeUser({ id: 3, group_id: 1 }));

    const handled = await handleExpenseMessage(
      fakeMessageCtx('100 EUR groceries'),
      fakeBotWithReactions().bot,
    );

    expect(handled).toBe(true);
    expect(mockUsers.update).toHaveBeenCalledWith(99, { group_id: 1 });
    expect(mockUsers.findByTelegramId).toHaveBeenCalledTimes(2);
    expect(saveExpenseBatchMock).toHaveBeenCalledWith(3, 1, [42]);
  });

  test('user vanishing after the group move stops processing', async () => {
    mockUsers.findByTelegramId
      .mockReturnValueOnce(makeUser({ group_id: 2 }))
      .mockReturnValueOnce(null);

    const handled = await handleExpenseMessage(
      fakeMessageCtx('100 EUR groceries'),
      fakeBotWithReactions().bot,
    );

    expect(handled).toBe(true);
    expect(mockUsers.update).toHaveBeenCalledWith(99, { group_id: 1 });
    expect(mockGroupMembers.upsert).not.toHaveBeenCalled();
    expect(mockPendingExpenses.create).not.toHaveBeenCalled();
  });

  test('changed chat title updates the group, same title does not', async () => {
    await handleExpenseMessage(
      fakeMessageCtx('100 EUR groceries', { chatTitle: 'Renamed' }),
      fakeBotWithReactions().bot,
    );
    expect(mockGroups.update).toHaveBeenCalledWith(-100, { title: 'Renamed' });

    mockGroups.update.mockClear();
    await handleExpenseMessage(
      fakeMessageCtx('100 EUR groceries', { chatTitle: 'Test Group' }),
      fakeBotWithReactions().bot,
    );
    expect(mockGroups.update).not.toHaveBeenCalled();
  });

  test('membership is upserted once per user+group pair', async () => {
    const bot = fakeBotWithReactions().bot;

    await handleExpenseMessage(fakeMessageCtx('100 EUR groceries', { fromId: 4242 }), bot);
    await handleExpenseMessage(fakeMessageCtx('50 EUR groceries', { fromId: 4242 }), bot);

    expect(mockGroupMembers.upsert).toHaveBeenCalledTimes(1);
    expect(mockGroupMembers.upsert).toHaveBeenCalledWith(4242, 1);
  });
});

describe('handleExpenseMessage — reactions, errors and summary', () => {
  beforeEach(() => {
    resetAllMocks();
    mockGroups.findByTelegramGroupId.mockReturnValue(makeGroup());
    mockCategories.exists.mockReturnValue(true);
  });

  test('happy path: 👀 first, then the count reaction, then smart advice', async () => {
    const { bot, setReaction } = fakeBotWithReactions();

    const handled = await handleExpenseMessage(fakeMessageCtx('100 EUR groceries'), bot);

    expect(handled).toBe(true);
    expect(setReaction).toHaveBeenCalledTimes(1);
    expect(setReaction).toHaveBeenCalledWith({
      chat_id: -100,
      message_id: 500,
      reaction: [{ type: 'emoji', emoji: '👀' }],
    });
    expect(setExpenseReactionMock).toHaveBeenCalledWith(bot, -100, 500, 1);
    expect(maybeSmartAdviceMock).toHaveBeenCalledWith(1);
    expect(findBestCategoryMatchAsyncMock).not.toHaveBeenCalled();
    expect(showNextPendingCategoryStepMock).not.toHaveBeenCalled();
    expect(sendMessageMock).not.toHaveBeenCalled();
  });

  test('failed 👀 reaction is only logged, saving proceeds', async () => {
    const { bot, setReaction } = fakeBotWithReactions();
    setReaction.mockRejectedValue(new Error('reaction rejected'));

    const handled = await handleExpenseMessage(fakeMessageCtx('100 EUR groceries'), bot);
    await Promise.resolve();

    expect(handled).toBe(true);
    expect(saveExpenseBatchMock).toHaveBeenCalledTimes(1);
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(logMock.error.mock.calls[0]?.[1]).toBe('[MSG] Failed to set 👀 reaction');
  });

  test('failed final reaction is only logged', async () => {
    setExpenseReactionMock.mockRejectedValue(new Error('no reaction'));

    const handled = await handleExpenseMessage(
      fakeMessageCtx('100 EUR groceries'),
      fakeBotWithReactions().bot,
    );

    expect(handled).toBe(true);
    expect(logMock.error).toHaveBeenCalledTimes(1);
    expect(logMock.error.mock.calls[0]?.[1]).toBe('[MSG] Failed to set final reaction');
    expect(maybeSmartAdviceMock).toHaveBeenCalledTimes(1);
  });

  test('batch error: pending expenses deleted, 👎 reaction, sheet error sent, advice still runs', async () => {
    const error = new Error('sheets blew up');
    saveExpenseBatchMock.mockRejectedValue(error);
    let nextId = 10;
    mockPendingExpenses.create.mockImplementation((data) => ({
      id: nextId++,
      ...(data as object),
    }));
    const { bot, setReaction } = fakeBotWithReactions();

    const handled = await handleExpenseMessage(
      fakeMessageCtx('100 EUR groceries\n50 EUR coffee'),
      bot,
    );

    expect(handled).toBe(true);
    expect(saveExpenseBatchMock).toHaveBeenCalledWith(1, 1, [10, 11]);
    expect(mockPendingExpenses.delete.mock.calls).toEqual([[10], [11]]);
    expect(setReaction).toHaveBeenLastCalledWith({
      chat_id: -100,
      message_id: 500,
      reaction: [{ type: 'emoji', emoji: '👎' }],
    });
    expect(setExpenseReactionMock).not.toHaveBeenCalled();
    expect(sendMessageMock.mock.calls[0]?.[0]).toBe(getSheetErrorMessage(error));
    // Nothing was saved: both summary lines are flagged ❓
    const summary = String(sendMessageMock.mock.calls[1]?.[0]);
    expect(summary.split('\n').every((line) => line.endsWith(' ❓'))).toBe(true);
    expect(maybeSmartAdviceMock).toHaveBeenCalledWith(1);
  });

  test('summary shows comment and marks only unsaved lines with ❓', async () => {
    mockCategories.exists.mockImplementation((_gid, name) => name === 'groceries');
    const { bot } = fakeBotWithReactions();

    const handled = await handleExpenseMessage(
      fakeMessageCtx('100 EUR groceries milk\n50 EUR экзотика'),
      bot,
    );

    expect(handled).toBe(true);
    expect(saveExpenseBatchMock).toHaveBeenCalledWith(1, 1, [42]);
    const lines = String(sendMessageMock.mock.calls[0]?.[0]).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^1 .*groceries — milk$/);
    expect(lines[1]).toMatch(/^2 .*экзотика ❓$/);
    // The new category starts the wizard and ends the flow without advice
    expect(showNextPendingCategoryStepMock).toHaveBeenCalledWith(1, 500);
    expect(maybeSmartAdviceMock).not.toHaveBeenCalled();
    expect(setExpenseReactionMock).toHaveBeenCalledWith(bot, -100, 500, 2);
  });

  test('summary escapes HTML in category and comment', async () => {
    mockCategories.exists.mockReturnValue(true);

    await handleExpenseMessage(
      fakeMessageCtx('100 EUR a<b x&y\n50 EUR coffee'),
      fakeBotWithReactions().bot,
    );

    const summary = String(sendMessageMock.mock.calls[0]?.[0]);
    expect(summary).toContain('a&lt;b — x&amp;y');
  });

  test('only unknown categories: no 👀, no save, no count reaction, wizard started', async () => {
    mockCategories.exists.mockReturnValue(false);
    const { bot, setReaction } = fakeBotWithReactions();

    const handled = await handleExpenseMessage(fakeMessageCtx('100 EUR экзотика'), bot);

    expect(handled).toBe(true);
    // newCategories alone still triggers the 👀 reaction
    expect(setReaction).toHaveBeenCalledTimes(1);
    expect(saveExpenseBatchMock).not.toHaveBeenCalled();
    expect(setExpenseReactionMock).not.toHaveBeenCalled();
    expect(showNextPendingCategoryStepMock).toHaveBeenCalledWith(1, 500);
    expect(maybeSmartAdviceMock).not.toHaveBeenCalled();
  });

  test('fuzzy match replaces the category in the pending expense and the summary', async () => {
    mockCategories.exists.mockReturnValue(false);
    mockCategories.getCategoryNames.mockReturnValue(['groceries']);
    findBestCategoryMatchAsyncMock.mockResolvedValue('groceries');

    await handleExpenseMessage(
      fakeMessageCtx('100 EUR grocerys\n20 EUR grocerys'),
      fakeBotWithReactions().bot,
    );

    expect(findBestCategoryMatchAsyncMock).toHaveBeenCalledWith('grocerys', ['groceries']);
    expect(mockPendingExpenses.create.mock.calls.map((c) => c[0])).toEqual([
      expect.objectContaining({ detected_category: 'groceries', status: 'confirmed' }),
      expect.objectContaining({ detected_category: 'groceries', status: 'confirmed' }),
    ]);
    expect(String(sendMessageMock.mock.calls[0]?.[0])).not.toContain('❓');
    expect(showNextPendingCategoryStepMock).not.toHaveBeenCalled();
  });

  test('repeated unknown category creates one pending expense per line but one wizard step', async () => {
    mockCategories.exists.mockReturnValue(false);

    await handleExpenseMessage(
      fakeMessageCtx('100 EUR экзотика\n20 EUR экзотика'),
      fakeBotWithReactions().bot,
    );

    expect(mockPendingExpenses.create).toHaveBeenCalledTimes(2);
    expect(showNextPendingCategoryStepMock).toHaveBeenCalledTimes(1);
  });
});
