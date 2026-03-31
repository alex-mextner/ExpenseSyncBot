/** Builds t.me deep link for opening the Mini App in Telegram. */
import { env } from '../config/env.ts';

/**
 * Returns a t.me direct link that opens the Mini App as a proper Telegram WebApp.
 * The tab name is passed as `startapp` param and available via initData.start_param.
 * Returns null when MINIAPP_SHORTNAME is not configured.
 */
export function buildMiniAppUrl(tab?: string): string | null {
  if (!env.MINIAPP_SHORTNAME) return null;
  const base = `https://t.me/${env.BOT_USERNAME}/${env.MINIAPP_SHORTNAME}`;
  return tab ? `${base}?startapp=${tab}` : base;
}
