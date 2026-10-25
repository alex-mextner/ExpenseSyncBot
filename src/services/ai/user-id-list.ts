/**
 * Parser of the canary user-id lists (`AI_ROUTING_USER_IDS`, `AI_TOOL_SCHEMA_USER_IDS`): same
 * bounds as HyperCalendarBot applies to its own lists. An empty value is invalid, not "no canary".
 * A leaf module so `config/env.ts` can parse with it.
 */

/** Most Telegram ids a canary list may hold. */
const MAX_USER_IDS = 100;

/** `undefined` when the variable is unset; otherwise the deduplicated list, or an error naming the variable. */
export function parseUserIdList(name: string, raw: string | undefined): number[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw.split(',').map((part) => part.trim());
  if (
    raw.length > 1800 ||
    parts.length > MAX_USER_IDS ||
    parts.some((part) => !/^[1-9][0-9]*$/.test(part) || !Number.isSafeInteger(Number(part)))
  ) {
    throw new Error(
      `${name} must be at most ${MAX_USER_IDS} positive safe integer Telegram user IDs`,
    );
  }
  return [...new Set(parts.map(Number))];
}
