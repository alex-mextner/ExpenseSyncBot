// Tests for /scan command handler.
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import type { Group } from '../../database/types';

const buildMiniAppUrlMock = mock((_tab?: string, _groupId?: number): string | null => null);
const sendMessageMock = mock(
  (_text: string, _options?: unknown): Promise<null> => Promise.resolve(null),
);

mock.module('../../utils/miniapp-url', () => ({
  buildMiniAppUrl: buildMiniAppUrlMock,
}));

mock.module('../../services/bank/telegram-sender', () => ({
  sendMessage: sendMessageMock,
}));

import type { Ctx } from '../types';
import { handleScanCommand } from './scan';

const fakeCtx = {} as Ctx['Command'];
const fakeGroup = { telegram_group_id: -1001234567 } as Group;

beforeEach(() => {
  buildMiniAppUrlMock.mockReset();
  buildMiniAppUrlMock.mockReturnValue(null);
  sendMessageMock.mockReset();
  sendMessageMock.mockResolvedValue(null);
});

afterEach(() => {
  mock.restore();
});

describe('handleScanCommand', () => {
  it('sends inline keyboard with URL when MINIAPP_SHORTNAME is configured', async () => {
    buildMiniAppUrlMock.mockReturnValue('https://t.me/TestBot/scanner');

    await handleScanCommand(fakeCtx, fakeGroup);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [text, options] = sendMessageMock.mock.calls[0] ?? [];
    expect(text).toBe('Открой сканер чеков в Mini App:');
    expect(options).toEqual({
      reply_markup: {
        inline_keyboard: [[{ text: '📷 Открыть сканер', url: 'https://t.me/TestBot/scanner' }]],
      },
    });
  });

  it('passes telegram_group_id to buildMiniAppUrl', async () => {
    buildMiniAppUrlMock.mockReturnValue('https://t.me/TestBot/scanner');

    await handleScanCommand(fakeCtx, fakeGroup);

    expect(buildMiniAppUrlMock).toHaveBeenCalledWith('scanner', -1001234567);
  });

  it('sends plain text when MINIAPP_SHORTNAME is not configured', async () => {
    buildMiniAppUrlMock.mockReturnValue(null);

    await handleScanCommand(fakeCtx, fakeGroup);

    expect(sendMessageMock).toHaveBeenCalledTimes(1);
    const [text, options] = sendMessageMock.mock.calls[0] ?? [];
    expect(text).toContain('MINIAPP_SHORTNAME');
    expect(options).toBeUndefined();
  });
});
