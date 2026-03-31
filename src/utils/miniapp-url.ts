/** Builds t.me deep link for opening the Mini App in Telegram. */
import { env } from '../config/env.ts';

/**
 * Returns a t.me direct link that opens the Mini App as a proper Telegram WebApp.
 * Tab and telegramGroupId are encoded in `startapp` as "tab_groupId" and available
 * via initDataUnsafe.start_param on the client side.
 * Returns null when MINIAPP_SHORTNAME is not configured.
 */
export function buildMiniAppUrl(tab?: string, telegramGroupId?: number): string | null {
  if (!env.MINIAPP_SHORTNAME) return null;
  const base = `https://t.me/${env.BOT_USERNAME}/${env.MINIAPP_SHORTNAME}`;

  if (tab && telegramGroupId) {
    return `${base}?startapp=${tab}_${telegramGroupId}`;
  }
  if (tab) {
    return `${base}?startapp=${tab}`;
  }
  return base;
}
