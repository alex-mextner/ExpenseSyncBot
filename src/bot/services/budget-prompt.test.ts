// Tests for the persistent budget prompt service: sending, plain input, reply disambiguation, claiming

import { mock } from 'bun:test';
// ── Real in-memory persistence for prompts, stubs for everything else ──
import { BudgetPromptRepository } from '../../database/repositories/budget-prompt.repository';
import { GroupRepository } from '../../database/repositories/group.repository';
import { UserRepository } from '../../database/repositories/user.repository';
import { createTestDb } from '../../test-utils/db';
import { createMockLogger } from '../../test-utils/mocks/logger';

const db = createTestDb();
const prompts = new BudgetPromptRepository(db);
const groupRepo = new GroupRepository(db);
const userRepo = new UserRepository(db);

const groupsStub = { findById: mock((_id: number) => ({ id: 1, google_refresh_token: 'tok' })) };
const budgetsStub = {
  getBudgetForMonth: mock(() => null),
  getBudgetCandidatesForMonth: mock((): unknown[] => []),
};
const expensesStub = {
  getMonthlyHistoryByCategory: mock((): unknown[] => []),
};

mock.module('../../database', () => ({
  database: {
    budgetPrompts: prompts,
    groups: groupsStub,
    budgets: budgetsStub,
    expenses: expensesStub,
  },
}));

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({ createLogger: () => logMock, logger: logMock }));

let nextMessageId = 1000;
const sendMessageMock = mock(
  (_text: string, _options?: { reply_markup?: unknown }): Promise<{ message_id: number } | null> =>
    Promise.resolve({ message_id: nextMessageId++ }),
);
mock.module('../../services/bank/telegram-sender', () => ({ sendMessage: sendMessageMock }));

const setBudgetMock = mock(
  (_params: {
    groupId: number;
    category: string;
    month: string;
    amount: number;
    currency: string;
  }) => Promise.resolve({ sheetsSynced: true }),
);
mock.module('../../services/budget-manager', () => ({
  getBudgetManager: () => ({ set: setBudgetMock }),
}));

import { afterEach, beforeEach, describe, expect, setSystemTime, test } from 'bun:test';
import type { Group, User } from '../../database/types';

const {
  applyBudgetPrompt,
  handleBudgetPromptText,
  lookupPromptForCallback,
  sendBudgetPrompt,
  sendBudgetPrompts,
  skipBudgetPrompt,
} = await import('./budget-prompt');

let group: Group;
let user: User;
let otherUser: User;

function keyboardData(options: { reply_markup?: unknown } | undefined): string[] {
  const json = (
    options?.reply_markup as { toJSON: () => { inline_keyboard: unknown[][] } }
  ).toJSON();
  return (json.inline_keyboard.flat() as Array<{ callback_data?: string }>).map(
    (b) => b.callback_data ?? '',
  );
}

async function openPrompt(category: string, forUser: User = user): Promise<number> {
  await sendBudgetPrompt({ group, userId: forUser.id, category });
  const all = prompts.findActiveForUser(group.id, forUser.id, null);
  const created = all.find((p) => p.category === category);
  if (!created) throw new Error('prompt was not created');
  return created.id;
}

function input(
  text: string,
  extra: { reply?: number | null; thread?: number | null; who?: User } = {},
) {
  return {
    group,
    user: extra.who ?? user,
    text,
    replyToMessageId: extra.reply ?? null,
    messageThreadId: extra.thread ?? null,
  };
}

beforeEach(() => {
  db.exec('DELETE FROM budget_prompts; DELETE FROM users; DELETE FROM groups;');
  group = { ...groupRepo.create({ telegram_group_id: -100500 }), default_currency: 'EUR' };
  user = userRepo.create({ telegram_id: 1, group_id: group.id });
  otherUser = userRepo.create({ telegram_id: 2, group_id: group.id });
  nextMessageId = 1000;
  sendMessageMock.mockClear();
  setBudgetMock.mockClear();
  setBudgetMock.mockImplementation(() => Promise.resolve({ sheetsSynced: true }));
  budgetsStub.getBudgetForMonth.mockReturnValue(null);
  budgetsStub.getBudgetCandidatesForMonth.mockReturnValue([]);
  expensesStub.getMonthlyHistoryByCategory.mockReturnValue([]);
  logMock.error.mockClear();
  logMock.warn.mockClear();
});

describe('sendBudgetPrompt', () => {
  test('persists the prompt, binds the sent message id and uses its numeric id in callbacks', async () => {
    expensesStub.getMonthlyHistoryByCategory.mockReturnValue([
      { category: 'Food', month: '2026-09', monthly_total: 200, tx_count: 4 },
    ]);
    await sendBudgetPrompt({ group, userId: user.id, category: 'Food' });

    const [created] = prompts.findActiveForUser(group.id, user.id, null);
    expect(created?.telegram_message_id).toBe(1000);
    const [text, options] = sendMessageMock.mock.calls[0] ?? [];
    expect(text).toContain('Food');
    expect(text).toContain('последний месяц с расходами');
    expect(keyboardData(options)).toContain(`budget:psuggest:${created?.id}:200`);
    expect(keyboardData(options)).toContain(`budget:pskip:${created?.id}`);
  });

  test('without any history it offers no amounts and does not claim a recommendation', async () => {
    await sendBudgetPrompt({ group, userId: user.id, category: 'Gym' });
    const [text, options] = sendMessageMock.mock.calls[0] ?? [];
    expect(text).toContain('нет данных');
    expect(text).not.toContain('Варианты по данным');
    expect(keyboardData(options).filter((d) => d.startsWith('budget:psuggest'))).toEqual([]);
  });

  test('escapes the category in HTML', async () => {
    await sendBudgetPrompt({ group, userId: user.id, category: 'R&D <i>' });
    expect(sendMessageMock.mock.calls[0]?.[0]).toContain('R&amp;D &lt;i&gt;');
  });

  test('a repeated prompt for the same category retires the old one', async () => {
    const first = await openPrompt('Food');
    const second = await openPrompt('Food');
    expect(prompts.findById(first)?.status).toBe('skipped');
    expect(prompts.findById(second)?.status).toBe('active');
  });

  test('a failed send leaves no active prompt behind', async () => {
    sendMessageMock.mockResolvedValueOnce(null);
    await sendBudgetPrompt({ group, userId: user.id, category: 'Food' });
    expect(prompts.findActiveForUser(group.id, user.id, null)).toEqual([]);
  });
});

describe('handleBudgetPromptText', () => {
  test('one active prompt: a plain amount sets that category', async () => {
    const id = await openPrompt('Food');
    sendMessageMock.mockClear();

    expect(await handleBudgetPromptText(input('150'))).toBe(true);

    expect(setBudgetMock).toHaveBeenCalledTimes(1);
    expect(setBudgetMock.mock.calls[0]?.[0]).toMatchObject({
      groupId: group.id,
      category: 'Food',
      amount: 150,
      currency: 'EUR',
    });
    expect(prompts.findById(id)?.status).toBe('used');
    const [text, options] = sendMessageMock.mock.calls[0] ?? [];
    expect(text).toContain('Бюджет установлен');
    expect(keyboardData(options)).toContain('budget:view');
  });

  test('an explicit currency overrides the prompt currency', async () => {
    await openPrompt('Food');
    await handleBudgetPromptText(input('1 500 RSD'));
    expect(setBudgetMock.mock.calls[0]?.[0]).toMatchObject({ amount: 1500, currency: 'RSD' });
  });

  test('prose is never intercepted', async () => {
    await openPrompt('Food');
    expect(await handleBudgetPromptText(input('поставь бюджет на еду 150'))).toBe(false);
    expect(await handleBudgetPromptText(input('150 кофе'))).toBe(false);
    expect(setBudgetMock).not.toHaveBeenCalled();
  });

  test('several active prompts: a plain amount is NOT applied and a hint is sent', async () => {
    const food = await openPrompt('Food');
    const rent = await openPrompt('Rent');
    sendMessageMock.mockClear();

    expect(await handleBudgetPromptText(input('150'))).toBe(true);

    expect(setBudgetMock).not.toHaveBeenCalled();
    expect(prompts.findById(food)?.status).toBe('active');
    expect(prompts.findById(rent)?.status).toBe('active');
    const text = sendMessageMock.mock.calls[0]?.[0] ?? '';
    expect(text).toContain('Food');
    expect(text).toContain('Rent');
    expect(text).toContain('реплаем');
  });

  test('several active prompts: replying to one prompt selects exactly that category', async () => {
    await openPrompt('Food');
    const rentId = await openPrompt('Rent');
    const rentMessage = prompts.findById(rentId)?.telegram_message_id ?? -1;

    expect(await handleBudgetPromptText(input('900', { reply: rentMessage }))).toBe(true);

    expect(setBudgetMock).toHaveBeenCalledTimes(1);
    expect(setBudgetMock.mock.calls[0]?.[0]).toMatchObject({ category: 'Rent', amount: 900 });
    expect(prompts.findById(rentId)?.status).toBe('used');
    expect(prompts.findActiveForUser(group.id, user.id, null).map((p) => p.category)).toEqual([
      'Food',
    ]);
  });

  test('a reply to an unrelated message is left for normal handling even with one prompt', async () => {
    await openPrompt('Food');
    expect(await handleBudgetPromptText(input('150', { reply: 424242 }))).toBe(false);
    expect(setBudgetMock).not.toHaveBeenCalled();
  });

  test('no active prompts: nothing is intercepted', async () => {
    expect(await handleBudgetPromptText(input('150'))).toBe(false);
  });

  test('prompts of another user or another topic are invisible', async () => {
    await openPrompt('Food', otherUser);
    expect(await handleBudgetPromptText(input('150'))).toBe(false);
    await openPrompt('Rent');
    expect(await handleBudgetPromptText(input('150', { thread: 9 }))).toBe(false);
    expect(setBudgetMock).not.toHaveBeenCalled();
  });

  test('a failing budget write reopens the prompt and tells the user', async () => {
    const id = await openPrompt('Food');
    setBudgetMock.mockRejectedValueOnce(new Error('db down'));
    sendMessageMock.mockClear();

    expect(await handleBudgetPromptText(input('150'))).toBe(true);

    expect(prompts.findById(id)?.status).toBe('active');
    expect(logMock.error).toHaveBeenCalled();
    expect(sendMessageMock.mock.calls[0]?.[0]).toContain('Не удалось');
  });
});

describe('prompt lookup, apply and skip', () => {
  test('lookup accepts the owner and rejects stale and foreign prompts', async () => {
    const id = await openPrompt('Food');
    expect(lookupPromptForCallback(id, group.id, user.id).ok).toBe(true);
    expect(lookupPromptForCallback(id, group.id, otherUser.id)).toEqual({
      ok: false,
      reason: 'foreign',
    });
    expect(lookupPromptForCallback(id + 99, group.id, user.id)).toEqual({
      ok: false,
      reason: 'stale',
    });
    expect(lookupPromptForCallback(id, group.id + 1, user.id)).toEqual({
      ok: false,
      reason: 'stale',
    });
  });

  test('a used prompt is stale and cannot be applied twice', async () => {
    const id = await openPrompt('Food');
    const lookup = lookupPromptForCallback(id, group.id, user.id);
    if (!lookup.ok) throw new Error('expected prompt');

    expect(await applyBudgetPrompt(lookup.prompt, 100, 'EUR')).toBe('applied');
    expect(await applyBudgetPrompt(lookup.prompt, 200, 'EUR')).toBe('already_handled');
    expect(setBudgetMock).toHaveBeenCalledTimes(1);
    expect(lookupPromptForCallback(id, group.id, user.id)).toEqual({ ok: false, reason: 'stale' });
  });

  test('a stale button for an old prompt does not touch the newer prompt of the category', async () => {
    const oldId = await openPrompt('Food');
    const newId = await openPrompt('Food');
    expect(lookupPromptForCallback(oldId, group.id, user.id).ok).toBe(false);
    expect(lookupPromptForCallback(newId, group.id, user.id).ok).toBe(true);
    expect(setBudgetMock).not.toHaveBeenCalled();
  });

  test('skip retires the prompt without writing a budget', async () => {
    const id = await openPrompt('Food');
    const lookup = lookupPromptForCallback(id, group.id, user.id);
    if (!lookup.ok) throw new Error('expected prompt');
    expect(skipBudgetPrompt(lookup.prompt)).toBe(true);
    expect(skipBudgetPrompt(lookup.prompt)).toBe(false);
    expect(setBudgetMock).not.toHaveBeenCalled();
    expect(prompts.findById(id)?.status).toBe('skipped');
  });
});

afterEach(() => setSystemTime());

test('a September prompt answered in October still writes September', async () => {
  setSystemTime(new Date(2026, 8, 30, 23, 59));
  const id = await openPrompt('Food');
  expect(sendMessageMock.mock.calls[0]?.[0]).toContain('сентябрь 2026');
  setSystemTime(new Date(2026, 9, 1, 0, 1));
  const prompt = prompts.findById(id);
  if (!prompt) throw new Error('missing synthetic prompt');
  await applyBudgetPrompt(prompt, 150, 'EUR');
  expect(setBudgetMock.mock.calls[0]?.[0].month).toBe('2026-09');
});

test('a failed suggestion read does not leave an invisible prompt', async () => {
  expensesStub.getMonthlyHistoryByCategory.mockImplementationOnce(() => {
    throw new Error('synthetic read failure');
  });
  await expect(sendBudgetPrompt({ group, userId: user.id, category: 'Food' })).rejects.toThrow(
    'synthetic read failure',
  );
  expect(prompts.findActiveForUser(group.id, user.id, null)).toEqual([]);
  expect(await handleBudgetPromptText(input('150'))).toBe(false);
  expect(setBudgetMock).not.toHaveBeenCalled();
});

test('a category batch reads shared history and both budget months only once', async () => {
  expensesStub.getMonthlyHistoryByCategory.mockClear();
  budgetsStub.getBudgetCandidatesForMonth.mockClear();
  expensesStub.getMonthlyHistoryByCategory.mockReturnValue([
    { category: 'Food', month: '2026-09', monthly_total: 200, tx_count: 4 },
    { category: 'Gym', month: '2026-09', monthly_total: 70, tx_count: 1 },
  ]);
  await sendBudgetPrompts({ group, userId: user.id, categories: ['Food', 'Gym'] });
  expect(expensesStub.getMonthlyHistoryByCategory).toHaveBeenCalledTimes(1);
  expect(budgetsStub.getBudgetCandidatesForMonth).toHaveBeenCalledTimes(2);
  expect(sendMessageMock).toHaveBeenCalledTimes(2);
  expect(sendMessageMock.mock.calls[0]?.[0]).toContain('200.00');
  expect(sendMessageMock.mock.calls[1]?.[0]).toContain('70.00');
});

test('a rejected send leaves no invisible active prompt', async () => {
  sendMessageMock.mockRejectedValueOnce(new Error('synthetic send failure'));
  await expect(sendBudgetPrompt({ group, userId: user.id, category: 'Food' })).rejects.toThrow(
    'synthetic send failure',
  );
  expect(prompts.findActiveForUser(group.id, user.id, null)).toEqual([]);
});

test('legacy prompts without a recorded month never guess a financial target', async () => {
  const id = await openPrompt('Food');
  db.query('UPDATE budget_prompts SET target_month = NULL WHERE id = ?').run(id);
  const prompt = prompts.findById(id);
  if (!prompt) throw new Error('missing synthetic prompt');
  expect(await applyBudgetPrompt(prompt, 150, 'EUR')).toBe('failed');
  expect(setBudgetMock).not.toHaveBeenCalled();
  expect(prompts.findById(id)?.status).toBe('skipped');
});

test('batch suggestions retain previous and current category budget sources', async () => {
  budgetsStub.getBudgetCandidatesForMonth
    .mockReturnValueOnce([
      { category: 'FOOD', limit_amount: 180, currency: 'EUR' },
      { category: 'Gym', limit_amount: 70, currency: 'EUR' },
    ])
    .mockReturnValueOnce([{ category: 'Food', limit_amount: 120, currency: 'EUR' }]);
  await sendBudgetPrompts({ group, userId: user.id, categories: ['Food', 'Gym'] });
  const text = sendMessageMock.mock.calls[0]?.[0];
  expect(text).toContain('120.00');
  expect(text).toContain('180.00');
  expect(sendMessageMock.mock.calls[1]?.[0]).toContain('70.00');
});
