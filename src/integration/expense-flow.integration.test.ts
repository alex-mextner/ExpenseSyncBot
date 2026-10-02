// End-to-end integration for the expense-message flow:
// text message → parser → validator → pending_expense → batch save → local DB.
//
// Real: SQLite (:memory:), repositories, currency parser/converter, validator.
// Mocked: telegram-sender (capture outgoing), googleapis (Sheets), AI helpers.

import type { Database as SqliteDb } from 'bun:sqlite';
import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import { createMockLogger } from '../test-utils/mocks/logger';

const logMock = createMockLogger();
mock.module('../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

import { BudgetRepository } from '../database/repositories/budget.repository';
import { CategoryRepository } from '../database/repositories/category.repository';
import { ChatMessageRepository } from '../database/repositories/chat-message.repository';
import { ExpenseRepository } from '../database/repositories/expense.repository';
import { GroupRepository } from '../database/repositories/group.repository';
import { PendingExpenseRepository } from '../database/repositories/pending-expense.repository';
import { UserRepository } from '../database/repositories/user.repository';
import { clearTestDb, createTestDb } from '../test-utils/db';

// ── Outgoing message capture ─────────────────────────────────────────────

interface SentMessage {
  text: string;
  opts?: unknown;
}
const sentMessages: SentMessage[] = [];
const sendMessageMock = mock(
  (text: string, opts?: unknown): Promise<{ message_id: number } | null> => {
    sentMessages.push(opts === undefined ? { text } : { text, opts });
    return Promise.resolve({ message_id: sentMessages.length } as const);
  },
);

mock.module('../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  withChatContext: async <T>(_c: number, _t: number | null, fn: () => Promise<T>) => fn(),
  editMessageText: mock(() => Promise.resolve()),
  sendDirect: mock(() => Promise.resolve(null)),
  sendChatAction: mock(() => Promise.resolve()),
  deleteMessage: mock(() => Promise.resolve()),
  createInviteLink: mock(() => Promise.resolve(null)),
  initSender: mock(),
}));

// ── Google Sheets: intercept writes ──────────────────────────────────────

const appendExpenseRowsMock = mock(async (..._args: unknown[]) => {});
const silentSyncBudgetsMock = mock(async (..._args: unknown[]): Promise<number> => 0);

mock.module('../services/google/sheets', () => ({
  appendExpenseRows: appendExpenseRowsMock,
  googleConn: (group: { google_refresh_token: string | null; oauth_client: string }) => ({
    refreshToken: group.google_refresh_token ?? '',
    oauthClient: group.oauth_client,
  }),
  isRateLimitError: () => false,
  withSheetsRetry: async <T>(fn: () => Promise<T>) => fn(),
}));

mock.module('../services/google/oauth', () => ({
  isTokenExpiredError: () => false,
  getAuthenticatedClient: () => ({}),
  generateAuthUrl: () => 'https://fake',
  encryptToken: (t: string) => t,
  decryptToken: (t: string) => t,
}));

mock.module('../bot/services/budget-sync', () => ({
  silentSyncBudgets: silentSyncBudgetsMock,
}));

// ── AI helpers: no real network ──────────────────────────────────────────

mock.module('../utils/fuzzy-search', () => ({
  findBestCategoryMatch: () => null,
  findBestCategoryMatchAsync: async () => null,
  normalizeCategoryName: (s: string) => s,
}));

const handleAskQuestionMock = mock(async (..._args: unknown[]) => {});
mock.module('../bot/commands/ask', () => ({
  maybeSmartAdvice: async () => {},
  handleAskQuestion: handleAskQuestionMock,
}));
mock.module('../bot/commands/dev', () => ({
  consumePendingDesignEdit: () => null,
  getPipelineInstance: () => null,
}));
mock.module('../bot/commands/feedback', () => ({
  consumePendingFeedback: () => null,
  submitFeedback: async () => {},
}));
mock.module('../bot/commands/connect', () => ({
  isAwaitingCustomCurrency: () => false,
  handleCustomCurrencyInput: async () => true,
}));
mock.module('../bot/commands/bank', () => ({
  handleWizardInput: async () => false,
  handleBankEditReply: async () => false,
}));
mock.module('../services/bank/otp-manager', () => ({
  resolveOtpForGroup: () => false,
}));
mock.module('../services/receipt/link-analyzer', () => ({
  extractURLsFromText: () => [],
  processPaymentLinks: async () => false,
}));

// ── Pin DB to our test instance ──────────────────────────────────────────

let db: SqliteDb;
let groups: GroupRepository;
let users: UserRepository;
let expenses: ExpenseRepository;
let budgets: BudgetRepository;
let categories: CategoryRepository;
let chatMessages: ChatMessageRepository;
let pendingExpenses: PendingExpenseRepository;

mock.module('../database', () => ({
  database: {
    get groups() {
      return groups;
    },
    get users() {
      return users;
    },
    get expenses() {
      return expenses;
    },
    get budgets() {
      return budgets;
    },
    get categories() {
      return categories;
    },
    get chatMessages() {
      return chatMessages;
    },
    get pendingExpenses() {
      return pendingExpenses;
    },
    get photoQueue() {
      return { findWaitingForBulkCorrection: () => null };
    },
    get receiptItems() {
      return { findWaitingForCategoryInput: () => null };
    },
    get groupMembers() {
      return { upsert: () => {}, findGroupsByTelegramId: () => [] };
    },
    get devTasks() {
      return { findActiveByGroupId: () => [] };
    },
    transaction: <T>(fn: () => T): T => fn(),
    queryAll: () => [],
  },
  _budgetWriter: () => budgets,
}));

// ── Dynamic imports AFTER all mocks ──────────────────────────────────────

const { handleExpenseMessage, routeTextMessage } = await import('../bot/handlers/message.handler');

// ── Fixtures ─────────────────────────────────────────────────────────────

beforeAll(() => {
  db = createTestDb();
  groups = new GroupRepository(db);
  users = new UserRepository(db);
  expenses = new ExpenseRepository(db);
  budgets = new BudgetRepository(db);
  categories = new CategoryRepository(db);
  chatMessages = new ChatMessageRepository(db);
  pendingExpenses = new PendingExpenseRepository(db);
});

afterAll(() => {
  db.close();
});

beforeEach(() => {
  clearTestDb(db);
  handleAskQuestionMock.mockClear();
  sentMessages.length = 0;
  sendMessageMock.mockClear();
  appendExpenseRowsMock.mockReset();
  appendExpenseRowsMock.mockImplementation(async () => {});
  silentSyncBudgetsMock.mockReset();
  silentSyncBudgetsMock.mockImplementation(async () => 0);
  logMock.error.mockReset();
  logMock.warn.mockReset();
  logMock.info.mockReset();
});

function seedGroupAndUser(): { groupId: number; userId: number; telegramGroupId: number } {
  const g = groups.create({
    telegram_group_id: -1001,
    default_currency: 'EUR',
  });
  // create() hardcodes enabled_currencies=[] — populate via update()
  groups.update(-1001, {
    enabled_currencies: ['EUR', 'RSD', 'USD'],
    google_refresh_token: 'tok',
    spreadsheet_id: 'SHEET-X',
  });
  const u = users.create({ telegram_id: 42, group_id: g.id });
  return { groupId: g.id, userId: u.id, telegramGroupId: -1001 };
}

function fakeCtx(text: string, chatType: 'group' | 'private' = 'group') {
  return {
    id: 555, // GramIO message id
    chat: { id: -1001, type: chatType, title: 'Test Group' },
    from: { id: 42, firstName: 'Alex', username: 'alex' },
    text,
    update: { message: {} },
  } as unknown as Parameters<typeof handleExpenseMessage>[0];
}

function fakeBot() {
  return {
    api: {
      setMessageReaction: mock(async () => true),
      sendChatAction: mock(async () => undefined),
    },
  } as unknown as Parameters<typeof handleExpenseMessage>[1];
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('expense-flow integration', () => {
  test('"100 EUR groceries" → saved expense in DB + pushed to sheet', async () => {
    const { groupId, userId } = seedGroupAndUser();
    categories.create({ group_id: groupId, name: 'groceries' });

    const handled = await handleExpenseMessage(fakeCtx('100 EUR groceries'), fakeBot());

    expect(handled).toBe(true);
    const rows = expenses.findByDateRange(groupId, '2000-01-01', '2100-01-01');
    expect(rows.length).toBe(1);
    expect(rows[0]?.category).toBe('groceries');
    expect(rows[0]?.eur_amount).toBeGreaterThan(0);
    expect(rows[0]?.user_id).toBe(userId);
    expect(appendExpenseRowsMock).toHaveBeenCalledTimes(1);
  });

  test('"1 900 RSD ужин" → parsed with space in amount, non-EUR currency', async () => {
    const { groupId } = seedGroupAndUser();
    categories.create({ group_id: groupId, name: 'ужин' });

    await handleExpenseMessage(fakeCtx('1 900 RSD ужин'), fakeBot());

    const rows = expenses.findByDateRange(groupId, '2000-01-01', '2100-01-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe('ужин');
  });

  test('"100е обед" — Russian EUR alias is normalized', async () => {
    const { groupId } = seedGroupAndUser();
    categories.create({ group_id: groupId, name: 'обед' });

    await handleExpenseMessage(fakeCtx('100е обед'), fakeBot());

    const rows = expenses.findByDateRange(groupId, '2000-01-01', '2100-01-01');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.category).toBe('обед');
  });

  test('unknown category → no expense saved, confirmation keyboard sent', async () => {
    const { groupId } = seedGroupAndUser();
    // no categories seeded

    await handleExpenseMessage(fakeCtx('50 EUR экзотика'), fakeBot());

    const rows = expenses.findByDateRange(groupId, '2000-01-01', '2100-01-01');
    expect(rows).toHaveLength(0);
    expect(sentMessages.length).toBeGreaterThan(0);
    const joined = sentMessages.map((m) => m.text).join('\n');
    expect(joined).toContain('экзотика');
    expect(appendExpenseRowsMock).not.toHaveBeenCalled();
  });

  test('non-expense text → ignored, no sheet writes', async () => {
    seedGroupAndUser();
    await handleExpenseMessage(fakeCtx('привет как дела'), fakeBot());
    expect(appendExpenseRowsMock).not.toHaveBeenCalled();
  });

  test('multiple expenses in one message, both saved', async () => {
    const { groupId } = seedGroupAndUser();
    categories.create({ group_id: groupId, name: 'food' });
    categories.create({ group_id: groupId, name: 'gas' });

    await handleExpenseMessage(fakeCtx('100 EUR food\n50 EUR gas'), fakeBot());

    const rows = expenses.findByDateRange(groupId, '2000-01-01', '2100-01-01');
    expect(rows).toHaveLength(2);
    const cats = rows.map((r) => r.category).sort();
    expect(cats).toEqual(['food', 'gas']);
  });

  test('zero amount → rejected, no DB write', async () => {
    const { groupId } = seedGroupAndUser();
    categories.create({ group_id: groupId, name: 'food' });

    await handleExpenseMessage(fakeCtx('0 EUR food'), fakeBot());

    const rows = expenses.findByDateRange(groupId, '2000-01-01', '2100-01-01');
    expect(rows).toHaveLength(0);
  });

  test('private chat → redirected, no sheet writes', async () => {
    seedGroupAndUser();
    await handleExpenseMessage(fakeCtx('100 EUR food', 'private'), fakeBot());
    expect(appendExpenseRowsMock).not.toHaveBeenCalled();
  });

  test('sheet append throws → expense rolled back, user notified', async () => {
    const { groupId } = seedGroupAndUser();
    categories.create({ group_id: groupId, name: 'food' });
    appendExpenseRowsMock.mockRejectedValueOnce(new Error('Google 500'));

    await handleExpenseMessage(fakeCtx('100 EUR food'), fakeBot());

    const rows = expenses.findByDateRange(groupId, '2000-01-01', '2100-01-01');
    expect(rows).toHaveLength(0);
    const joined = sentMessages.map((m) => m.text).join('\n');
    expect(joined.toLowerCase()).toMatch(/ошибка|sheet|не удалось/i);
  });

  test('group not found → message ignored, no sheet write', async () => {
    // No group seeded — findByTelegramGroupId returns null
    await handleExpenseMessage(fakeCtx('100 EUR food'), fakeBot());
    expect(appendExpenseRowsMock).not.toHaveBeenCalled();
  });
});

test('exact October budget replay reaches AI with zero real expense or pending rows', async () => {
  seedGroupAndUser();
  const text = `Сформируй бюджет на грядущий октябрь

€450 — квартира
€600 — еда
€300 — коммуналка
€200 — животные
€200 — машина
€700 — Лена
€700 — Алекс
€100 — развлечения
€620 — подписки
€100 — дом

Другие категории убери (перечили), сумма должна быть 6000€`;
  const ctx = fakeCtx(text);
  const bot = fakeBot();
  await routeTextMessage(ctx, bot, true);
  expect(handleAskQuestionMock).toHaveBeenCalledTimes(1);
  expect(handleAskQuestionMock).toHaveBeenCalledWith(ctx, text, bot);
  expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM expenses').get()?.n).toBe(0);
  expect(db.query<{ n: number }, []>('SELECT COUNT(*) AS n FROM pending_expenses').get()?.n).toBe(
    0,
  );
  expect(appendExpenseRowsMock).not.toHaveBeenCalled();
  expect(sentMessages).toEqual([]);
  expect(logMock.error).not.toHaveBeenCalled();
});
