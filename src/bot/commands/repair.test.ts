// Tests for /repair command — rate limiting, error paths

import { beforeEach, describe, expect, mock, spyOn, test } from 'bun:test';
import type { GoogleConnectedGroup } from '../guards';
import type { Ctx } from '../types';

// ── Mock telegram-sender ──────────────────────────────────────────────────

const sendMessageMock = mock(
  (_text: string, _options?: unknown): Promise<null> => Promise.resolve(null),
);

mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
  withChatContext: async <T>(_c: number, _t: number | null, fn: () => Promise<T>) => fn(),
  editMessageText: mock(() => Promise.resolve()),
  sendDirect: mock(() => Promise.resolve(null)),
}));

// Stub auditAndRepairSpreadsheets so the test doesn't go near real googleapis
const auditAndRepairMock = mock(async () => ({ audit: [], recreated: [] }));
mock.module('./reconnect', () => ({
  auditAndRepairSpreadsheets: auditAndRepairMock,
}));

const { handleRepairCommand, _resetRepairCooldownForTests } = await import('./repair');

function fakeCtx(): Ctx['Command'] {
  return { chat: { id: -100 }, from: { id: 1 } } as unknown as Ctx['Command'];
}

function fakeGroup(id = 1): GoogleConnectedGroup {
  return {
    id,
    telegram_group_id: -100,
    title: null,
    invite_link: null,
    google_refresh_token: 'tok',
    spreadsheet_id: 'sheet-123',
    default_currency: 'RSD',
    enabled_currencies: ['RSD'],
    custom_prompt: null,
    active_topic_id: null,
    oauth_client: 'current',
    bank_panel_summary_message_id: null,
    bank_cards_enabled: 1,
    created_at: '',
    updated_at: '',
  } as GoogleConnectedGroup;
}

beforeEach(() => {
  sendMessageMock.mockReset().mockResolvedValue(null);
  auditAndRepairMock.mockReset().mockResolvedValue({ audit: [], recreated: [] });
  _resetRepairCooldownForTests();
});

describe('/repair rate-limit', () => {
  test('first call within cooldown window proceeds', async () => {
    await handleRepairCommand(fakeCtx(), fakeGroup());
    expect(auditAndRepairMock).toHaveBeenCalledTimes(1);
  });

  test('second call within cooldown window is rejected without hitting audit', async () => {
    const now = Date.now();
    const dateSpy = spyOn(Date, 'now').mockReturnValue(now);

    await handleRepairCommand(fakeCtx(), fakeGroup());
    expect(auditAndRepairMock).toHaveBeenCalledTimes(1);

    // 1 minute later — still inside the 5-minute cooldown
    dateSpy.mockReturnValue(now + 60_000);
    await handleRepairCommand(fakeCtx(), fakeGroup());

    // audit was NOT called a second time
    expect(auditAndRepairMock).toHaveBeenCalledTimes(1);

    // User got a cooldown message with time remaining
    const lastMsg = sendMessageMock.mock.calls.at(-1)?.[0];
    expect(lastMsg).toContain('Подожди');
    dateSpy.mockRestore();
  });

  test('call after cooldown window is allowed again', async () => {
    const now = Date.now();
    const dateSpy = spyOn(Date, 'now').mockReturnValue(now);

    await handleRepairCommand(fakeCtx(), fakeGroup());
    // 6 minutes later — outside cooldown
    dateSpy.mockReturnValue(now + 6 * 60_000);
    await handleRepairCommand(fakeCtx(), fakeGroup());

    expect(auditAndRepairMock).toHaveBeenCalledTimes(2);
    dateSpy.mockRestore();
  });

  test('cooldown is per-group — other groups are not blocked', async () => {
    const now = Date.now();
    const dateSpy = spyOn(Date, 'now').mockReturnValue(now);

    await handleRepairCommand(fakeCtx(), fakeGroup(1));
    // Different group immediately — should NOT be blocked
    await handleRepairCommand(fakeCtx(), fakeGroup(2));

    expect(auditAndRepairMock).toHaveBeenCalledTimes(2);
    dateSpy.mockRestore();
  });
});
