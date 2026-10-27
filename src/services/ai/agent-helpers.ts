/**
 * Pure helpers of the agent loop: tool-argument parsing, result rendering, history sanitizing and
 * currency spotting. No state, no I/O.
 */

import type OpenAI from 'openai';
import { CURRENCY_ALIASES, SUPPORTED_CURRENCIES } from '../../config/constants';
import type { ToolResult } from './types';

/**
 * Currencies of the amounts in `text`, once each: a supported code or a currency symbol right
 * before or after a digit ("700 USD", "USD 700", "$700", "700 €"). Used to spot a forced answer
 * that names a currency no tool result had — the invented amounts of #166. Every pattern is a
 * fixed-width match, so the scan stays linear on long digit runs.
 */
export function amountCurrencies(text: string): string[] {
  const codes = new Set<string>();
  const add = (token: string | undefined) => {
    const code = token && (CURRENCY_ALIASES[token] ?? token);
    if (code && SUPPORTED_CURRENCIES.some((c) => c === code)) codes.add(code);
  };
  // Up to 3 spaces of any kind (non-breaking ones included) between amount and currency, and an
  // optional sign before a prefixed amount ("USD -700", "USD −700").
  for (const m of text.matchAll(
    /\d[\s\u00a0\u202f]{0,3}([A-Z]{3}|[$€₽£])(?![A-Za-z])|(?<![A-Za-z])([A-Z]{3}|[$€₽£])[\s\u00a0\u202f]{0,3}[-−+]?\d/g,
  )) {
    add(m[1] ?? m[2]);
  }
  return [...codes];
}

/**
 * JSON with object keys sorted at every level, so two tool calls with the same arguments in a
 * different key order produce the same cache key.
 */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Parsed tool arguments, or null when malformed. `null` is how some backends send a no-argument
 * call; any other valid JSON that is not an object (a number, an array) is no argument set.
 */
export function parseToolInput(raw: string | undefined): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(raw || '{}');
    if (parsed === null) return {};
    if (typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** Text of a tool result as the model sees it in the history. */
export function toolResultContent(result: ToolResult): string {
  if (!result.success) return `Error: ${result.error}`;
  if (result.data === undefined) return result.output || 'Success';
  return `${result.summary ? `${result.summary}\n` : ''}${JSON.stringify(result.data)}`;
}

/**
 * Sanitize tool_calls before pushing to history — some providers generate malformed JSON
 * arguments that break subsequent rounds when the next provider tries to parse the history.
 */
export function sanitizeAssistantToolCalls(
  message: OpenAI.ChatCompletionMessageParam,
): OpenAI.ChatCompletionMessageParam {
  const sanitized = { ...message };
  if ('tool_calls' in sanitized && Array.isArray(sanitized.tool_calls)) {
    sanitized.tool_calls = sanitized.tool_calls.map((tc) => {
      if (!('function' in tc)) return tc;
      try {
        JSON.parse(tc.function.arguments);
        return tc;
      } catch {
        return { ...tc, function: { ...tc.function, arguments: '{}' } };
      }
    });
  }
  return sanitized;
}
