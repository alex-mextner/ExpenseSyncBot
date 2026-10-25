/**
 * `AI_TOOL_SCHEMA_MODE` / `AI_TOOL_SCHEMA_USER_IDS` (#203 step B; same names and semantics as
 * HyperCalendarBot). A leaf module so `config/env.ts` can parse with it; the behaviour of each mode
 * lives in tool-exposure.ts.
 */

/** `full`: every schema each request; `hybrid`: core + index; `lazy`: calculator + index. */
export type ToolSchemaMode = 'full' | 'lazy' | 'hybrid';

export function parseToolSchemaMode(raw: string | undefined): ToolSchemaMode {
  if (!raw) return 'full';
  if (raw === 'full' || raw === 'lazy' || raw === 'hybrid') return raw;
  throw new Error('AI_TOOL_SCHEMA_MODE must be full, lazy or hybrid');
}

/** The mode a user's requests run in: the configured mode, for the canary list's users if one is set. */
export function toolSchemaModeFor(
  mode: ToolSchemaMode,
  userIds: readonly number[] | undefined,
  telegramUserId: number,
): ToolSchemaMode {
  return !userIds || userIds.includes(telegramUserId) ? mode : 'full';
}
