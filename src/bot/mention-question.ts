// Extract the question text that follows a @botname mention. Kept as a leaf module so the
// mention routing (src/bot/index.ts) stays testable without booting the whole bot.

/**
 * Everything after the first "@<botUsername> " in `text`, or null when the bot is not mentioned.
 *
 * The captured text spans newlines on purpose: a mention followed by a multi-line payload
 * (a budget list, a pasted receipt, …) must reach the AI in full. The 2026-11-06 incident
 * (issue #123 follow-up): `(.+)` without the dotall behaviour stopped at the first newline,
 * the whole list was dropped and the AI answered «список … не дошёл».
 */
export function extractMentionQuestion(text: string, botUsername: string): string | null {
  const match = text.match(new RegExp(`@${botUsername}\\s+([\\s\\S]+)`, 'i'));
  const question = match?.[1]?.trim();
  return question ? question : null;
}
