// Tests for shared feedback utility

import { mock } from 'bun:test';
import type { TelegramMessage } from '@gramio/types';

// ── Module mock (must be declared before importing the module under test) ──

const sendDirectMock = mock(
  async (_chatId: number, _text: string): Promise<TelegramMessage | null> => null,
);

mock.module('./bank/telegram-sender', () => ({
  sendDirect: sendDirectMock,
}));

import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { database } from '../database';
import { sendFeedback } from './feedback';

beforeEach(() => {
  sendDirectMock.mockReset();
  sendDirectMock.mockResolvedValue(null);
});

afterEach(() => {
  mock.restore();
});

describe('sendFeedback', () => {
  it('returns error for empty message', async () => {
    const result = await sendFeedback({
      message: '   ',
      groupId: 1,
      chatId: 123,
    });
    expect(result.success).toBe(false);
    expect(result.error).toContain('пустым');
  });

  it('returns error when BOT_ADMIN_CHAT_ID is not configured', async () => {
    const { env } = await import('../config/env');
    const origValue = env.BOT_ADMIN_CHAT_ID;
    (env as { BOT_ADMIN_CHAT_ID: number | null }).BOT_ADMIN_CHAT_ID = null;

    const result = await sendFeedback({
      message: 'test feedback',
      groupId: 1,
      chatId: 123,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain('не настроен');
    (env as { BOT_ADMIN_CHAT_ID: number | null }).BOT_ADMIN_CHAT_ID = origValue;
  });

  it('sends feedback to admin when configured', async () => {
    const { env } = await import('../config/env');
    const origValue = env.BOT_ADMIN_CHAT_ID;
    (env as { BOT_ADMIN_CHAT_ID: number | null }).BOT_ADMIN_CHAT_ID = 999;

    spyOn(database.groups, 'findById').mockReturnValue({
      id: 1,
      telegram_group_id: 123,
      title: null,
      invite_link: null,
      default_currency: 'EUR',
      enabled_currencies: ['EUR'],
      custom_prompt: null,
      google_refresh_token: null,
      spreadsheet_id: null,
      active_topic_id: null,
      oauth_client: 'legacy' as const,
      bank_panel_summary_message_id: null,
      created_at: '',
      updated_at: '',
    });

    const result = await sendFeedback({
      message: 'Отличный бот!',
      groupId: 1,
      chatId: 123,
      userName: 'Алекс',
    });

    expect(result.success).toBe(true);
    expect(sendDirectMock).toHaveBeenCalledTimes(1);

    const callArgs = sendDirectMock.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.[0]).toBe(999); // admin chat id
    expect(callArgs?.[1]).toContain('Отличный бот!');
    expect(callArgs?.[1]).toContain('Алекс');

    (env as { BOT_ADMIN_CHAT_ID: number | null }).BOT_ADMIN_CHAT_ID = origValue;
  });

  it('escapes HTML in userName and message', async () => {
    const { env } = await import('../config/env');
    const origValue = env.BOT_ADMIN_CHAT_ID;
    (env as { BOT_ADMIN_CHAT_ID: number | null }).BOT_ADMIN_CHAT_ID = 999;

    spyOn(database.groups, 'findById').mockReturnValue({
      id: 1,
      telegram_group_id: 123,
      title: null,
      invite_link: null,
      default_currency: 'EUR',
      enabled_currencies: ['EUR'],
      custom_prompt: null,
      google_refresh_token: null,
      spreadsheet_id: null,
      active_topic_id: null,
      oauth_client: 'legacy' as const,
      bank_panel_summary_message_id: null,
      created_at: '',
      updated_at: '',
    });

    await sendFeedback({
      message: '<script>alert("xss")</script>',
      groupId: 1,
      chatId: 123,
      userName: '<b>hacker</b>',
    });

    const callArgs = sendDirectMock.mock.calls[0];
    const text = callArgs?.[1] as string;
    // HTML entities must be escaped
    expect(text).toContain('&lt;script&gt;');
    expect(text).not.toContain('<script>');
    expect(text).toContain('&lt;b&gt;hacker&lt;/b&gt;');

    (env as { BOT_ADMIN_CHAT_ID: number | null }).BOT_ADMIN_CHAT_ID = origValue;
  });
});
