// Tests for /bank command: wizard, status panel, credentials, disconnect, letter nav.
// Confirmation flow (confirm/merge/receipt/nocomment) lives in bank.confirm.test.ts.

import { afterAll, afterEach, beforeAll, describe, expect, mock, spyOn, test } from 'bun:test';
import type { TelegramMessage } from '@gramio/types';
import type { BankAccount, BankConnection, BankCredential, Group } from '../../database/types';
import * as panelBuilderModule from '../../services/bank/panel-builder';
import * as registryModule from '../../services/bank/registry';
import * as syncServiceModule from '../../services/bank/sync-service';
import * as senderModule from '../../services/bank/telegram-sender';
import { mockDatabase } from '../../test-utils/mocks/database';
import { createMockLogger } from '../../test-utils/mocks/logger';
import * as cryptoModule from '../../utils/crypto';

// ─── Logger mock ──────────────────────────────────────────────────────────────

const logMock = createMockLogger();
mock.module('../../utils/logger.ts', () => ({
  createLogger: () => logMock,
  logger: logMock,
}));

// ─── Repo mocks ───────────────────────────────────────────────────────────────

const mockGroups = {
  findByTelegramGroupId: mock((_id: number): Group | null => null),
  update: mock((_telegramGroupId: number, _data: unknown): void => {}),
};

const mockBankConnections = {
  deleteStaleSetup: mock((_groupId: number): number[] => []),
  findByGroupAndBank: mock((_groupId: number, _bankName: string): BankConnection | null => null),
  findSetupByGroupId: mock((_groupId: number): BankConnection | null => null),
  findAllByGroupId: mock((_groupId: number): BankConnection[] => []),
  findById: mock((_id: number): BankConnection | null => null),
  create: mock(
    (_data: unknown): BankConnection => ({
      id: 101,
      group_id: 1,
      bank_name: 'tbc-ge',
      display_name: 'TBC (GE)',
      status: 'setup',
      consecutive_failures: 0,
      last_sync_at: null,
      last_error: null,
      panel_message_id: null,
      panel_message_thread_id: null,
      created_at: '2026-04-19T00:00:00Z',
    }),
  ),
  update: mock((_id: number, _data: unknown): void => {}),
  deleteById: mock((_id: number): void => {}),
};

const mockBankCredentials = {
  findByConnectionId: mock((_id: number): BankCredential | null => null),
  upsert: mock((_id: number, _data: string): void => {}),
  deleteByConnectionId: mock((_id: number): void => {}),
};

const mockBankAccounts = {
  findByGroupId: mock((_groupId: number): BankAccount[] => []),
  findByConnectionId: mock((_id: number): BankAccount[] => []),
  findById: mock((_id: number): BankAccount | null => null),
  setExcluded: mock((_id: number, _flag: boolean): void => {}),
};

mock.module('../../database', () => ({
  database: mockDatabase({
    groups: mockGroups,
    bankConnections: mockBankConnections,
    bankCredentials: mockBankCredentials,
    bankAccounts: mockBankAccounts,
  }),
}));

// ─── Service mocks via spyOn ──────────────────────────────────────────────────

const sentMessages: { text: string; opts?: Record<string, unknown> }[] = [];
const mockSendMessage = mock(
  (text: string, opts?: Record<string, unknown>): Promise<TelegramMessage | null> => {
    sentMessages.push(opts === undefined ? { text } : { text, opts });
    return Promise.resolve({ message_id: 9000 } as TelegramMessage);
  },
);

const spies: { mockRestore: () => void }[] = [];
const activateNewConnectionMock = mock((_id: number) => Promise.resolve());
const triggerManualSyncMock = mock((_id: number) => Promise.resolve());

beforeAll(() => {
  spies.push(
    spyOn(senderModule, 'sendMessage').mockImplementation(mockSendMessage),
    spyOn(senderModule, 'editMessageText').mockResolvedValue(undefined),
    spyOn(senderModule, 'sendDirect').mockResolvedValue(null),
    spyOn(senderModule, 'deleteMessage').mockResolvedValue(undefined),
    spyOn(senderModule, 'withChatContext').mockImplementation(
      // @ts-expect-error — simplified signature for tests
      (_c: number, _t: number | null, fn: () => unknown) => fn(),
    ),
    spyOn(syncServiceModule, 'activateNewConnection').mockImplementation(activateNewConnectionMock),
    spyOn(syncServiceModule, 'triggerManualSync').mockImplementation(triggerManualSyncMock),
    // Stub panel-builder — formatting details belong to panel-builder.test.ts
    spyOn(panelBuilderModule, 'buildBankStatusText').mockImplementation(
      (conn) => `STATUS:${conn.display_name}:${conn.status}`,
    ),
    spyOn(panelBuilderModule, 'buildBankManageKeyboard').mockImplementation(() => [
      [{ text: 'manage', callback_data: 'manage' }],
    ]),
    spyOn(panelBuilderModule, 'buildCombinedBankStatusText').mockImplementation(
      (conns, total) => `COMBINED:${conns.length}:${total}`,
    ),
    spyOn(panelBuilderModule, 'buildCombinedBankKeyboard').mockImplementation(() => [
      [{ text: 'combined', callback_data: 'combined' }],
    ]),
    spyOn(panelBuilderModule, 'timeSince').mockImplementation(() => '5 мин'),
  );
});

afterAll(() => {
  for (const spy of spies) spy.mockRestore();
});

// ─── Registry: install a predictable fake registry for all tests ──────────────
// We rewrite BANK_REGISTRY and lookupBank/getBankList through the real module
// because bank.ts imports the object references at module load.

const fakePlugin = {
  name: 'TBC (GE)',
  plugin: () =>
    Promise.resolve({ scrape: () => Promise.resolve({ accounts: [], transactions: [] }) }),
  fields: [
    { name: 'username', type: 'text' as const, prompt: 'Логин' },
    { name: 'password', type: 'password' as const, prompt: 'Пароль' },
  ],
  defaults: { lastSync: '2020-01-01T00:00:00.000Z' },
};

const fakePluginNoFields = {
  name: 'Trivial Bank',
  plugin: () =>
    Promise.resolve({ scrape: () => Promise.resolve({ accounts: [], transactions: [] }) }),
  fields: [],
  defaults: { token: 'auto' },
};

// Replace keys on the live registry object (same reference bank.ts imported).
beforeAll(() => {
  for (const k of Object.keys(registryModule.BANK_REGISTRY)) {
    delete registryModule.BANK_REGISTRY[k];
  }
  registryModule.BANK_REGISTRY['tbc-ge'] = fakePlugin;
  registryModule.BANK_REGISTRY['trivial'] = fakePluginNoFields;
});

// Import the command AFTER module mocks have been installed.
const {
  handleBankCommand,
  handleWizardInput,
  handleBankSetupCallback,
  handleBankWizardStartCallback,
  handleBankWizardCancelCallback,
  handleBankSettingsCallback,
  handleBankSyncCallback,
  handleBankSyncAllCallback,
  handleBankDisconnectCallback,
  handleBankDisconnectConfirmCallback,
  handleBankDisconnectCancelCallback,
  handleBankReconnectCallback,
  handleBankSettingsBackCallback,
  handleBankAccountsCallback,
  handleBankAccountToggleCallback,
  handleBankAddCallback,
  handleBankLetterCallback,
  handleBankLetterNavCallback,
} = await import('./bank');

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const group: Group = {
  id: 1,
  telegram_group_id: -100,
  title: null,
  invite_link: null,
  google_refresh_token: null,
  spreadsheet_id: null,
  default_currency: 'EUR',
  enabled_currencies: ['EUR'],
  custom_prompt: null,
  active_topic_id: null,
  oauth_client: 'legacy' as const,
  bank_panel_summary_message_id: null,
  bank_cards_enabled: 1,
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
};

function makeConnection(overrides: Partial<BankConnection> = {}): BankConnection {
  return {
    id: 101,
    group_id: 1,
    bank_name: 'tbc-ge',
    display_name: 'TBC (GE)',
    status: 'setup',
    consecutive_failures: 0,
    last_sync_at: null,
    last_error: null,
    panel_message_id: null,
    panel_message_thread_id: null,
    created_at: '2026-04-19T00:00:00Z',
    ...overrides,
  };
}

function makeAccount(overrides: Partial<BankAccount> = {}): BankAccount {
  return {
    id: 1,
    connection_id: 101,
    account_id: 'acc-1',
    title: 'Main',
    balance: 100,
    currency: 'EUR',
    type: null,
    is_excluded: 0,
    updated_at: '2026-04-19T00:00:00Z',
    ...overrides,
  };
}

function makeCommandCtx(overrides: Record<string, unknown> = {}) {
  return {
    chat: { id: -100 },
    from: { id: 42 },
    text: '/bank',
    ...overrides,
  };
}

function makeCallbackCtx(overrides: Record<string, unknown> = {}) {
  return {
    from: { id: 42 },
    message: { id: 500 },
    answerCallbackQuery: mock((_data?: unknown): Promise<void> => Promise.resolve()),
    editText: mock(
      (_text: string, _opts?: unknown): Promise<unknown> => Promise.resolve(undefined),
    ),
    update: { callback_query: { message: { message_thread_id: undefined } } },
    ...overrides,
  };
}

function makeMessageCtx(overrides: Record<string, unknown> = {}) {
  return {
    id: 777,
    from: { id: 42 },
    chat: { id: -100 },
    update: { message: { message_thread_id: undefined } },
    ...overrides,
  };
}

function makeBot(): {
  api: {
    editMessageText: ReturnType<typeof mock>;
    deleteMessage: ReturnType<typeof mock>;
    sendMessage: ReturnType<typeof mock>;
  };
} {
  return {
    api: {
      editMessageText: mock(() => Promise.resolve({ message_id: 9001 })),
      deleteMessage: mock(() => Promise.resolve(true)),
      sendMessage: mock(() => Promise.resolve({ message_id: 9002 })),
    },
  };
}

// ─── Reset between tests ──────────────────────────────────────────────────────

const allRepoMocks = [
  mockGroups.findByTelegramGroupId,
  mockGroups.update,
  mockBankConnections.deleteStaleSetup,
  mockBankConnections.findByGroupAndBank,
  mockBankConnections.findSetupByGroupId,
  mockBankConnections.findAllByGroupId,
  mockBankConnections.findById,
  mockBankConnections.create,
  mockBankConnections.update,
  mockBankConnections.deleteById,
  mockBankCredentials.findByConnectionId,
  mockBankCredentials.upsert,
  mockBankCredentials.deleteByConnectionId,
  mockBankAccounts.findByGroupId,
  mockBankAccounts.findByConnectionId,
  mockBankAccounts.findById,
  mockBankAccounts.setExcluded,
  activateNewConnectionMock,
  triggerManualSyncMock,
];

afterEach(() => {
  for (const m of allRepoMocks) m.mockReset();
  mockSendMessage.mockClear();
  sentMessages.length = 0;
  (senderModule.editMessageText as ReturnType<typeof mock>).mockClear();
  (senderModule.deleteMessage as ReturnType<typeof mock>).mockClear();
  for (const fn of Object.values(logMock)) fn.mockClear?.();
  // Restore structural defaults after mockReset
  mockBankConnections.deleteStaleSetup.mockImplementation(() => []);
  mockBankConnections.findAllByGroupId.mockImplementation(() => []);
  mockBankAccounts.findByGroupId.mockImplementation(() => []);
  mockBankAccounts.findByConnectionId.mockImplementation(() => []);
  mockBankConnections.create.mockImplementation(() => makeConnection());
  activateNewConnectionMock.mockImplementation(() => Promise.resolve());
  triggerManualSyncMock.mockImplementation(() => Promise.resolve());
  mockGroups.findByTelegramGroupId.mockImplementation(() => group);
});

// ═══ /bank in clean state ═════════════════════════════════════════════════════

describe('/bank in clean state', () => {
  test('no connections → shows letter navigation keyboard', async () => {
    mockBankConnections.findAllByGroupId.mockImplementation(() => []);
    const bot = makeBot();

    await handleBankCommand(makeCommandCtx() as never, group, bot as never);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const [text, opts] = mockSendMessage.mock.calls[0] ?? [];
    expect(text).toContain('Ни одного банка не подключено');
    const keyboard = (opts as { reply_markup?: { inline_keyboard?: unknown[][] } })?.reply_markup
      ?.inline_keyboard as { text: string; callback_data: string }[][];
    expect(Array.isArray(keyboard)).toBe(true);
    // Each cell uses `bank_letter:` prefix
    expect(keyboard.flat().every((btn) => btn.callback_data.startsWith('bank_letter:'))).toBe(true);
  });

  test('deleteStaleSetup is called at entry', async () => {
    mockBankConnections.deleteStaleSetup.mockImplementation(() => [55, 56]);
    await handleBankCommand(makeCommandCtx() as never, group, makeBot() as never);
    expect(mockBankConnections.deleteStaleSetup).toHaveBeenCalledWith(group.id);
  });
});

// ═══ /bank when already connected ════════════════════════════════════════════

describe('/bank when already connected', () => {
  test('single connection → shows individual status panel', async () => {
    const conn = makeConnection({ status: 'active', last_sync_at: '2026-04-19T00:00:00Z' });
    mockBankConnections.findAllByGroupId.mockImplementation(() => [conn]);
    mockBankAccounts.findByConnectionId.mockImplementation(() => [makeAccount()]);

    await handleBankCommand(makeCommandCtx() as never, group, makeBot() as never);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    const [text] = mockSendMessage.mock.calls[0] ?? [];
    expect(text).toContain('STATUS:TBC (GE):active');
  });

  test('multiple connections → shows combined panel and records summary msg id', async () => {
    const c1 = makeConnection({ id: 101, status: 'active', last_sync_at: '2026-04-19T00:00:00Z' });
    const c2 = makeConnection({
      id: 102,
      bank_name: 'trivial',
      display_name: 'Trivial Bank',
      status: 'active',
      last_sync_at: '2026-04-19T00:00:00Z',
    });
    mockBankConnections.findAllByGroupId.mockImplementation(() => [c1, c2]);
    mockBankAccounts.findByGroupId.mockImplementation(() => [
      makeAccount({ balance: 100, currency: 'EUR' }),
    ]);
    mockSendMessage.mockImplementationOnce((text, opts) => {
      sentMessages.push(opts === undefined ? { text } : { text, opts });
      return Promise.resolve({ message_id: 12345 } as TelegramMessage);
    });

    await handleBankCommand(makeCommandCtx() as never, group, makeBot() as never);

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0]?.[0]).toContain('COMBINED:2:');
    // All connection rows get the same summary message id
    expect(mockBankConnections.update).toHaveBeenCalledWith(
      c1.id,
      expect.objectContaining({ panel_message_id: 12345 }),
    );
    expect(mockBankConnections.update).toHaveBeenCalledWith(
      c2.id,
      expect.objectContaining({ panel_message_id: 12345 }),
    );
    expect(mockGroups.update).toHaveBeenCalledWith(
      group.telegram_group_id,
      expect.objectContaining({ bank_panel_summary_message_id: 12345 }),
    );
  });

  test('multi-bank: deletes stale individual panels before resending', async () => {
    const c1 = makeConnection({
      id: 101,
      panel_message_id: 5000,
      status: 'active',
      last_sync_at: 'x',
    });
    const c2 = makeConnection({
      id: 102,
      panel_message_id: 5001,
      status: 'active',
      last_sync_at: 'x',
    });
    mockBankConnections.findAllByGroupId.mockImplementation(() => [c1, c2]);
    const bot = makeBot();

    await handleBankCommand(makeCommandCtx() as never, group, bot as never);

    expect(bot.api.deleteMessage).toHaveBeenCalledWith({
      chat_id: group.telegram_group_id,
      message_id: 5000,
    });
    expect(bot.api.deleteMessage).toHaveBeenCalledWith({
      chat_id: group.telegram_group_id,
      message_id: 5001,
    });
  });

  test('/bank tbc argument with existing active connection → shows expanded panel', async () => {
    const conn = makeConnection({ status: 'active', last_sync_at: '2026-04-19T00:00:00Z' });
    mockBankConnections.findByGroupAndBank.mockImplementation(() => conn);

    await handleBankCommand(
      makeCommandCtx({ text: '/bank tbc-ge' }) as never,
      group,
      makeBot() as never,
    );

    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0]?.[0]).toContain('STATUS:TBC (GE)');
  });

  test('/bank unknown-bank → error message, no DB writes', async () => {
    await handleBankCommand(
      makeCommandCtx({ text: '/bank zzzunknown' }) as never,
      group,
      makeBot() as never,
    );
    expect(mockSendMessage.mock.calls[0]?.[0]).toContain('не найден');
    expect(mockBankConnections.create).not.toHaveBeenCalled();
  });

  test('/bank отмена with no setup → informs user', async () => {
    mockBankConnections.findSetupByGroupId.mockImplementation(() => null);
    await handleBankCommand(
      makeCommandCtx({ text: '/bank отмена' }) as never,
      group,
      makeBot() as never,
    );
    expect(mockSendMessage.mock.calls[0]?.[0]).toContain('Нет активного подключения');
  });

  test('/bank отмена with active setup → deletes setup row', async () => {
    const setup = makeConnection({ status: 'setup' });
    mockBankConnections.findSetupByGroupId.mockImplementation(() => setup);

    await handleBankCommand(
      makeCommandCtx({ text: '/bank отмена' }) as never,
      group,
      makeBot() as never,
    );

    expect(mockBankConnections.deleteById).toHaveBeenCalledWith(setup.id);
    expect(mockSendMessage.mock.calls[0]?.[0]).toContain('отменено');
  });
});

// ═══ Select bank from list (callback flow) ═══════════════════════════════════

describe('bank setup/wizard callbacks', () => {
  test('handleBankSetupCallback: unknown bank → answerCallback with error', async () => {
    const ctx = makeCallbackCtx();
    await handleBankSetupCallback(ctx as never, makeBot() as never, 'nonexistent', -100);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('не найден') }),
    );
  });

  test('handleBankSetupCallback: known bank → edits to info screen with Подключить button', async () => {
    const ctx = makeCallbackCtx();
    const bot = makeBot();
    await handleBankSetupCallback(ctx as never, bot as never, 'tbc-ge', -100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    const call = bot.api.editMessageText.mock.calls[0]?.[0] as {
      text: string;
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    expect(call.text).toContain('TBC (GE)');
    expect(call.reply_markup.inline_keyboard[0]?.[0]?.callback_data).toBe(
      'bank_wizard_start:tbc-ge',
    );
  });

  test('handleBankWizardStartCallback: creates setup connection, prompts first field', async () => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => group);
    const newConn = makeConnection({ id: 201 });
    mockBankConnections.create.mockImplementation(() => newConn);
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankWizardStartCallback(ctx as never, bot as never, 'tbc-ge', -100);

    expect(mockBankConnections.create).toHaveBeenCalledWith(
      expect.objectContaining({
        group_id: group.id,
        bank_name: 'tbc-ge',
        display_name: 'TBC (GE)',
        status: 'setup',
      }),
    );
    // Should edit the info screen to show first field prompt
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    const edit = bot.api.editMessageText.mock.calls[0]?.[0] as { text: string };
    expect(edit.text).toContain('Логин');
  });

  test('handleBankWizardStartCallback: existing active → blocks with "уже подключён"', async () => {
    mockBankConnections.findByGroupAndBank.mockImplementation(() =>
      makeConnection({ status: 'active' }),
    );
    const ctx = makeCallbackCtx();

    await handleBankWizardStartCallback(ctx as never, makeBot() as never, 'tbc-ge', -100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('уже подключён') }),
    );
    expect(mockBankConnections.create).not.toHaveBeenCalled();
  });

  test('handleBankWizardStartCallback: group missing → error answer, no DB writes', async () => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => null);
    const ctx = makeCallbackCtx();
    await handleBankWizardStartCallback(ctx as never, makeBot() as never, 'tbc-ge', -100);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Группа') }),
    );
    expect(mockBankConnections.create).not.toHaveBeenCalled();
  });

  test('handleBankWizardStartCallback: no-field plugin → auto-activates, triggers sync', async () => {
    const newConn = makeConnection({ id: 301, bank_name: 'trivial', display_name: 'Trivial Bank' });
    mockBankConnections.create.mockImplementation(() => newConn);
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankWizardStartCallback(ctx as never, bot as never, 'trivial', -100);

    // defaults are stored, status flipped to active, sync kicked off
    expect(mockBankCredentials.upsert).toHaveBeenCalledWith(newConn.id, expect.any(String));
    expect(mockBankConnections.update).toHaveBeenCalledWith(
      newConn.id,
      expect.objectContaining({ status: 'active' }),
    );
    expect(activateNewConnectionMock).toHaveBeenCalledWith(newConn.id);
  });
});

// ═══ Credentials entered (message flow) ══════════════════════════════════════

describe('handleWizardInput — credential entry flow', () => {
  test('no setup session → returns false, does nothing', async () => {
    mockBankConnections.findSetupByGroupId.mockImplementation(() => null);
    const handled = await handleWizardInput(
      makeMessageCtx() as never,
      group.id,
      'ignored',
      makeBot() as never,
    );
    expect(handled).toBe(false);
    expect(mockBankCredentials.upsert).not.toHaveBeenCalled();
  });

  test('first field saved, next field prompt sent', async () => {
    const setup = makeConnection({ id: 401, status: 'setup' });
    mockBankConnections.findSetupByGroupId.mockImplementation(() => setup);
    mockBankCredentials.findByConnectionId.mockImplementation(() => null);
    mockSendMessage.mockImplementationOnce(() =>
      Promise.resolve({ message_id: 8001 } as TelegramMessage),
    );

    const handled = await handleWizardInput(
      makeMessageCtx() as never,
      group.id,
      'myusername',
      makeBot() as never,
    );

    expect(handled).toBe(true);
    expect(mockBankCredentials.upsert).toHaveBeenCalledTimes(1);
    // Verify encrypted payload decrypts to the captured field
    const [, encrypted] = mockBankCredentials.upsert.mock.calls[0] ?? [];
    const decrypted = JSON.parse(cryptoModule.decryptData(encrypted as string)) as Record<
      string,
      string
    >;
    expect(decrypted['username']).toBe('myusername');
    // Next prompt (password) was sent
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0]?.[0]).toContain('Пароль');
  });

  test('last field completes wizard → activates connection & triggers sync', async () => {
    const setup = makeConnection({ id: 501, status: 'setup' });
    mockBankConnections.findSetupByGroupId.mockImplementation(() => setup);
    // Simulate partial credentials (username already collected)
    const partial = cryptoModule.encryptData(JSON.stringify({ username: 'u' }));
    mockBankCredentials.findByConnectionId.mockImplementation(() => ({
      connection_id: setup.id,
      encrypted_data: partial,
    }));
    mockSendMessage.mockImplementationOnce(() =>
      Promise.resolve({ message_id: 8002 } as TelegramMessage),
    );

    const handled = await handleWizardInput(
      makeMessageCtx() as never,
      group.id,
      'mypassword',
      makeBot() as never,
    );

    expect(handled).toBe(true);
    // Status flipped to active
    expect(mockBankConnections.update).toHaveBeenCalledWith(
      setup.id,
      expect.objectContaining({ status: 'active' }),
    );
    expect(activateNewConnectionMock).toHaveBeenCalledWith(setup.id);
    // Logged success
    expect(logMock.info).toHaveBeenCalled();
  });

  test('activateNewConnection rejection is logged, not thrown', async () => {
    const setup = makeConnection({ id: 502, status: 'setup' });
    mockBankConnections.findSetupByGroupId.mockImplementation(() => setup);
    const partial = cryptoModule.encryptData(JSON.stringify({ username: 'u' }));
    mockBankCredentials.findByConnectionId.mockImplementation(() => ({
      connection_id: setup.id,
      encrypted_data: partial,
    }));
    activateNewConnectionMock.mockImplementation(() => Promise.reject(new Error('boom')));

    const handled = await handleWizardInput(
      makeMessageCtx() as never,
      group.id,
      'mypassword',
      makeBot() as never,
    );

    expect(handled).toBe(true);
    // Wait a tick so the rejected promise's .catch() runs
    await new Promise((r) => setTimeout(r, 0));
    expect(logMock.error).toHaveBeenCalledWith(
      expect.objectContaining({ err: expect.any(Error) }),
      expect.stringContaining('activation failed'),
    );
  });

  test('sensitive field: deletes user message and masks prompt', async () => {
    const setup = makeConnection({ id: 601, status: 'setup' });
    mockBankConnections.findSetupByGroupId.mockImplementation(() => setup);
    // Start first field (username), then jump into password step by pre-seeding stored prompt
    // We need to drive through first call to set wizardPromptMessages for password entry.
    mockBankCredentials.findByConnectionId.mockImplementation(() => null);
    mockSendMessage.mockImplementationOnce(() =>
      Promise.resolve({ message_id: 1010 } as TelegramMessage),
    );
    await handleWizardInput(
      makeMessageCtx({ id: 500 }) as never,
      group.id,
      'the-user',
      makeBot() as never,
    );

    // Now password step: credentials contain username → isPassword=true stored by previous call.
    const partial = cryptoModule.encryptData(JSON.stringify({ username: 'the-user' }));
    mockBankCredentials.findByConnectionId.mockImplementation(() => ({
      connection_id: setup.id,
      encrypted_data: partial,
    }));

    const bot = makeBot();
    await handleWizardInput(
      makeMessageCtx({ id: 501 }) as never,
      group.id,
      'hunter2',
      bot as never,
    );

    expect(bot.api.deleteMessage).toHaveBeenCalledWith({ chat_id: -100, message_id: 501 });
    expect(bot.api.editMessageText).toHaveBeenCalledWith(
      expect.objectContaining({
        message_id: 1010,
        text: expect.stringContaining('•••••••'),
      }),
    );
  });
});

// ═══ Disconnect flow ═════════════════════════════════════════════════════════

describe('disconnect callbacks', () => {
  test('handleBankDisconnectCallback: edits message to confirmation prompt', async () => {
    const conn = makeConnection({ id: 701, status: 'active' });
    mockBankConnections.findById.mockImplementation(() => conn);
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankDisconnectCallback(ctx as never, bot as never, conn.id, -100);

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    const call = bot.api.editMessageText.mock.calls[0]?.[0] as {
      text: string;
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    expect(call.text).toContain('Отключить TBC (GE)');
    expect(call.reply_markup.inline_keyboard[0]?.[0]?.callback_data).toBe(
      `bank_disconnect_confirm:${conn.id}`,
    );
    expect(call.reply_markup.inline_keyboard[0]?.[1]?.callback_data).toBe(
      `bank_disconnect_cancel:${conn.id}`,
    );
    expect(mockBankConnections.deleteById).not.toHaveBeenCalled();
  });

  test('handleBankDisconnectConfirmCallback: deletes connection and removes panel', async () => {
    const conn = makeConnection({ id: 702, status: 'active' });
    mockBankConnections.findById.mockImplementation(() => conn);
    const ctx = makeCallbackCtx({ message: { id: 900 } });
    const bot = makeBot();

    await handleBankDisconnectConfirmCallback(ctx as never, bot as never, conn.id, -100);

    expect(mockBankConnections.deleteById).toHaveBeenCalledWith(conn.id);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('отключён') }),
    );
    expect(bot.api.deleteMessage).toHaveBeenCalledWith({ chat_id: -100, message_id: 900 });
  });

  test('handleBankDisconnectConfirmCallback: wrong group → rejects without deleting', async () => {
    mockBankConnections.findById.mockImplementation(() =>
      makeConnection({ id: 702, group_id: 999 }),
    );
    const ctx = makeCallbackCtx();

    await handleBankDisconnectConfirmCallback(ctx as never, makeBot() as never, 702, -100);

    expect(mockBankConnections.deleteById).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Подключение не найдено') }),
    );
  });

  test('handleBankDisconnectCancelCallback: restores status panel', async () => {
    const conn = makeConnection({ id: 703, status: 'active' });
    mockBankConnections.findById.mockImplementation(() => conn);
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankDisconnectCancelCallback(ctx as never, bot as never, conn.id, -100);

    expect(mockBankConnections.deleteById).not.toHaveBeenCalled();
    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    const call = bot.api.editMessageText.mock.calls[0]?.[0] as { text: string };
    expect(call.text).toContain('STATUS:TBC (GE):active');
  });
});

// ═══ Settings / sync / reconnect callbacks ═══════════════════════════════════

describe('settings + sync + reconnect', () => {
  test('handleBankSettingsCallback: edits to settings view with reconnect/disconnect rows', async () => {
    const conn = makeConnection({
      id: 801,
      status: 'active',
      last_sync_at: '2026-04-19T00:00:00Z',
    });
    mockBankConnections.findById.mockImplementation(() => conn);
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankSettingsCallback(ctx as never, bot as never, conn.id, -100);

    const call = bot.api.editMessageText.mock.calls[0]?.[0] as {
      text: string;
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    expect(call.text).toContain('TBC (GE)');
    const buttons = call.reply_markup.inline_keyboard.flat();
    expect(buttons.some((b) => b.callback_data === `bank_reconnect:${conn.id}`)).toBe(true);
    expect(buttons.some((b) => b.callback_data === `bank_disconnect:${conn.id}`)).toBe(true);
  });

  test('handleBankSyncCallback: active bank → triggers manual sync', async () => {
    const conn = makeConnection({
      id: 802,
      status: 'active',
      last_sync_at: '2026-04-19T00:00:00Z',
    });
    mockBankConnections.findById.mockImplementation(() => conn);
    const ctx = makeCallbackCtx();

    await handleBankSyncCallback(ctx as never, conn.id, -100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Синхронизация') }),
    );
    expect(triggerManualSyncMock).toHaveBeenCalledWith(conn.id);
  });

  test('handleBankSyncCallback: inactive bank → rejected, no sync call', async () => {
    const conn = makeConnection({ id: 803, status: 'setup' });
    mockBankConnections.findById.mockImplementation(() => conn);
    const ctx = makeCallbackCtx();

    await handleBankSyncCallback(ctx as never, conn.id, -100);

    expect(triggerManualSyncMock).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('не активен') }),
    );
  });

  test('handleBankSyncAllCallback: syncs only healthy active banks', async () => {
    const ok = makeConnection({ id: 901, status: 'active', last_sync_at: 'x' });
    const failing = makeConnection({
      id: 902,
      status: 'active',
      last_sync_at: 'x',
      consecutive_failures: 3,
    });
    const neverSynced = makeConnection({ id: 903, status: 'active', last_sync_at: null });
    mockBankConnections.findAllByGroupId.mockImplementation(() => [ok, failing, neverSynced]);

    const ctx = makeCallbackCtx();
    await handleBankSyncAllCallback(ctx as never, -100);

    expect(triggerManualSyncMock).toHaveBeenCalledTimes(1);
    expect(triggerManualSyncMock).toHaveBeenCalledWith(ok.id);
  });

  test('handleBankSyncAllCallback: no syncable → rejects', async () => {
    mockBankConnections.findAllByGroupId.mockImplementation(() => []);
    const ctx = makeCallbackCtx();
    await handleBankSyncAllCallback(ctx as never, -100);
    expect(triggerManualSyncMock).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Нет активных') }),
    );
  });

  test('handleBankReconnectCallback: wipes credentials, sets setup, prompts first field', async () => {
    const conn = makeConnection({
      id: 1001,
      status: 'active',
      consecutive_failures: 2,
      last_error: 'prev',
    });
    mockBankConnections.findById.mockImplementation(() => conn);
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankReconnectCallback(ctx as never, bot as never, conn.id, -100);

    expect(mockBankCredentials.deleteByConnectionId).toHaveBeenCalledWith(conn.id);
    expect(mockBankConnections.update).toHaveBeenCalledWith(
      conn.id,
      expect.objectContaining({ status: 'setup', consecutive_failures: 0, last_error: null }),
    );
    expect(mockSendMessage).toHaveBeenCalledTimes(1);
    expect(mockSendMessage.mock.calls[0]?.[0]).toContain('Логин');
  });

  test('handleBankReconnectCallback: unknown bank in registry → rejects', async () => {
    const conn = makeConnection({ id: 1002, bank_name: 'gone-bank' });
    mockBankConnections.findById.mockImplementation(() => conn);
    const ctx = makeCallbackCtx();

    await handleBankReconnectCallback(ctx as never, makeBot() as never, conn.id, -100);

    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('не найден') }),
    );
    expect(mockBankCredentials.deleteByConnectionId).not.toHaveBeenCalled();
  });

  test('handleBankSettingsBackCallback: restores status panel from settings', async () => {
    const conn = makeConnection({ id: 1101, status: 'active', last_sync_at: 'x' });
    mockBankConnections.findById.mockImplementation(() => conn);
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankSettingsBackCallback(ctx as never, bot as never, conn.id, -100);

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    const call = bot.api.editMessageText.mock.calls[0]?.[0] as { text: string };
    expect(call.text).toContain('STATUS:TBC (GE):active');
  });
});

// ═══ Accounts callbacks ══════════════════════════════════════════════════════

describe('accounts management', () => {
  test('handleBankAccountsCallback: renders row per account with toggle', async () => {
    const conn = makeConnection({ id: 1201, status: 'active' });
    mockBankConnections.findById.mockImplementation(() => conn);
    const accs = [
      makeAccount({ id: 1, title: 'Main', is_excluded: 0, balance: 100, currency: 'EUR' }),
      makeAccount({ id: 2, title: 'Savings', is_excluded: 1, balance: 500, currency: 'EUR' }),
    ];
    mockBankAccounts.findByConnectionId.mockImplementation(() => accs);
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankAccountsCallback(ctx as never, bot as never, conn.id, -100);

    const call = bot.api.editMessageText.mock.calls[0]?.[0] as {
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    const rows = call.reply_markup.inline_keyboard;
    expect(rows[0]?.[0]?.callback_data).toBe(`bank_account_toggle:1:${conn.id}`);
    expect(rows[0]?.[0]?.text).toContain('🔔'); // not excluded
    expect(rows[1]?.[0]?.text).toContain('🔕'); // excluded
    expect(rows[2]?.[0]?.callback_data).toBe(`bank_settings:${conn.id}`);
  });

  test('handleBankAccountsCallback: no accounts → error answer', async () => {
    mockBankConnections.findById.mockImplementation(() => makeConnection());
    mockBankAccounts.findByConnectionId.mockImplementation(() => []);
    const ctx = makeCallbackCtx();
    await handleBankAccountsCallback(ctx as never, makeBot() as never, 1, -100);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('не найдены') }),
    );
  });

  test('handleBankAccountToggleCallback: flips is_excluded and refreshes list', async () => {
    const conn = makeConnection({ id: 1301 });
    const acc = makeAccount({ id: 10, is_excluded: 0 });
    mockBankAccounts.findById.mockImplementation(() => acc);
    mockBankConnections.findById.mockImplementation(() => conn);
    mockBankAccounts.findByConnectionId.mockImplementation(() => [acc]);
    const ctx = makeCallbackCtx();

    await handleBankAccountToggleCallback(ctx as never, makeBot() as never, 10, conn.id, -100);

    expect(mockBankAccounts.setExcluded).toHaveBeenCalledWith(10, true);
  });
});

// ═══ Letter navigation + add bank ════════════════════════════════════════════

describe('letter navigation', () => {
  test('handleBankAddCallback: edits message to letter picker', async () => {
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankAddCallback(ctx as never, -100);

    // Uses ctx.editText path first
    expect(ctx.editText).toHaveBeenCalledWith(
      'Выбери букву:',
      expect.objectContaining({
        reply_markup: expect.objectContaining({ inline_keyboard: expect.any(Array) }),
      }),
    );
    expect(bot.api.editMessageText).not.toHaveBeenCalled();
  });

  test('handleBankLetterCallback: T → shows TBC (GE) button', async () => {
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankLetterCallback(ctx as never, bot as never, 'T', -100);

    const call = bot.api.editMessageText.mock.calls[0]?.[0] as {
      text: string;
      reply_markup: { inline_keyboard: { text: string; callback_data: string }[][] };
    };
    expect(call.text).toContain('букву T');
    expect(call.reply_markup.inline_keyboard[0]?.[0]?.callback_data).toBe('bank_setup:tbc-ge');
  });

  test('handleBankLetterCallback: letter with no banks → error answer', async () => {
    const ctx = makeCallbackCtx();
    await handleBankLetterCallback(ctx as never, makeBot() as never, 'Z', -100);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Нет банков') }),
    );
  });

  test('handleBankLetterNavCallback: restores the letter picker', async () => {
    const ctx = makeCallbackCtx();
    const bot = makeBot();

    await handleBankLetterNavCallback(ctx as never, bot as never, -100);

    expect(bot.api.editMessageText).toHaveBeenCalledTimes(1);
    const call = bot.api.editMessageText.mock.calls[0]?.[0] as { text: string };
    expect(call.text).toBe('Выбери букву:');
  });
});

// ═══ Wizard cancel ═══════════════════════════════════════════════════════════

describe('handleBankWizardCancelCallback', () => {
  test('fresh setup (no sync) → fully deletes row', async () => {
    const setup = makeConnection({ id: 1401, status: 'setup', last_sync_at: null });
    mockBankConnections.findSetupByGroupId.mockImplementation(() => setup);
    const ctx = makeCallbackCtx();

    await handleBankWizardCancelCallback(ctx as never, -100);

    expect(mockBankConnections.deleteById).toHaveBeenCalledWith(setup.id);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: 'Отменено' }),
    );
  });

  test('reconnect cancel (had sync) → marks disconnected, preserves row', async () => {
    const setup = makeConnection({
      id: 1402,
      status: 'setup',
      last_sync_at: '2026-04-01T00:00:00Z',
    });
    mockBankConnections.findSetupByGroupId.mockImplementation(() => setup);
    const ctx = makeCallbackCtx();

    await handleBankWizardCancelCallback(ctx as never, -100);

    expect(mockBankConnections.deleteById).not.toHaveBeenCalled();
    expect(mockBankConnections.update).toHaveBeenCalledWith(
      setup.id,
      expect.objectContaining({ status: 'disconnected' }),
    );
  });

  test('group missing → rejects without touching DB', async () => {
    mockGroups.findByTelegramGroupId.mockImplementation(() => null);
    const ctx = makeCallbackCtx();

    await handleBankWizardCancelCallback(ctx as never, -100);

    expect(mockBankConnections.deleteById).not.toHaveBeenCalled();
    expect(mockBankConnections.update).not.toHaveBeenCalled();
    expect(ctx.answerCallbackQuery).toHaveBeenCalledWith(
      expect.objectContaining({ text: expect.stringContaining('Группа') }),
    );
  });
});
