// Tests for /scan command handler.
import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import type { Group } from '../../database/types';
import * as senderModule from '../../services/bank/telegram-sender';
import * as miniappUrlModule from '../../utils/miniapp-url';
import type { Ctx } from '../types';
import { handleScanCommand } from './scan';

let buildMiniAppUrlSpy: ReturnType<typeof mock>;
let sendMessageSpy: ReturnType<typeof mock>;

const fakeCtx = {} as Ctx['Command'];
const fakeGroup = { telegram_group_id: -1001234567 } as Group;

beforeEach(() => {
  buildMiniAppUrlSpy = spyOn(miniappUrlModule, 'buildMiniAppUrl').mockReturnValue(null);
  sendMessageSpy = spyOn(senderModule, 'sendMessage').mockResolvedValue(null);
});

afterEach(() => {
  mock.restore();
});

describe('handleScanCommand', () => {
  it('sends inline keyboard with URL when MINIAPP_SHORTNAME is configured', async () => {
    buildMiniAppUrlSpy.mockReturnValue('https://t.me/TestBot/scanner');

    await handleScanCommand(fakeCtx, fakeGroup);

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const [text, options] = sendMessageSpy.mock.calls[0] ?? [];
    expect(text).toBe('Открой сканер чеков в Mini App:');
    expect(options).toEqual({
      reply_markup: {
        inline_keyboard: [[{ text: '📷 Открыть сканер', url: 'https://t.me/TestBot/scanner' }]],
      },
    });
  });

  it('passes telegram_group_id to buildMiniAppUrl', async () => {
    buildMiniAppUrlSpy.mockReturnValue('https://t.me/TestBot/scanner');

    await handleScanCommand(fakeCtx, fakeGroup);

    expect(buildMiniAppUrlSpy).toHaveBeenCalledWith('scanner', -1001234567);
  });

  it('sends plain text when MINIAPP_SHORTNAME is not configured', async () => {
    buildMiniAppUrlSpy.mockReturnValue(null);

    await handleScanCommand(fakeCtx, fakeGroup);

    expect(sendMessageSpy).toHaveBeenCalledTimes(1);
    const [text, options] = sendMessageSpy.mock.calls[0] ?? [];
    expect(text).toContain('MINIAPP_SHORTNAME');
    expect(options).toBeUndefined();
  });
});
