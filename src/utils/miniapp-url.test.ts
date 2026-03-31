/** Tests for buildMiniAppUrl utility */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { env } from '../config/env';
import { buildMiniAppUrl } from './miniapp-url';

// Cast env to writable for test setup (same pattern as miniapp-api.test.ts)
const envW = env as { BOT_USERNAME: string; MINIAPP_SHORTNAME: string | undefined };

describe('buildMiniAppUrl', () => {
  let originalShortname: string | undefined;
  let originalUsername: string;

  beforeEach(() => {
    originalShortname = envW.MINIAPP_SHORTNAME;
    originalUsername = envW.BOT_USERNAME;
  });

  afterEach(() => {
    envW.MINIAPP_SHORTNAME = originalShortname;
    envW.BOT_USERNAME = originalUsername;
  });

  it('returns null when MINIAPP_SHORTNAME is not set', () => {
    envW.MINIAPP_SHORTNAME = undefined;
    expect(buildMiniAppUrl('scanner')).toBeNull();
  });

  it('returns t.me link with startapp when tab is given', () => {
    envW.BOT_USERNAME = 'ExpenseSyncBot';
    envW.MINIAPP_SHORTNAME = 'extra';
    expect(buildMiniAppUrl('scanner')).toBe('https://t.me/ExpenseSyncBot/extra?startapp=scanner');
  });

  it('returns t.me link without startapp when tab is omitted', () => {
    envW.BOT_USERNAME = 'ExpenseSyncBot';
    envW.MINIAPP_SHORTNAME = 'extra';
    expect(buildMiniAppUrl()).toBe('https://t.me/ExpenseSyncBot/extra');
  });

  it('uses BOT_USERNAME from env', () => {
    envW.BOT_USERNAME = 'StagingBot';
    envW.MINIAPP_SHORTNAME = 'extra';
    expect(buildMiniAppUrl('dashboard')).toBe('https://t.me/StagingBot/extra?startapp=dashboard');
  });

  it('encodes telegramGroupId in startapp when both tab and groupId are given', () => {
    envW.BOT_USERNAME = 'ExpenseSyncBot';
    envW.MINIAPP_SHORTNAME = 'extra';
    expect(buildMiniAppUrl('scanner', -1001234567)).toBe(
      'https://t.me/ExpenseSyncBot/extra?startapp=scanner_-1001234567',
    );
  });

  it('encodes telegramGroupId even when tab is omitted', () => {
    envW.BOT_USERNAME = 'ExpenseSyncBot';
    envW.MINIAPP_SHORTNAME = 'extra';
    expect(buildMiniAppUrl(undefined, -1001234567)).toBe(
      'https://t.me/ExpenseSyncBot/extra?startapp=_-1001234567',
    );
  });
});
