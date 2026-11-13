/**
 * Pure helpers of the agent loop: tool-argument parsing, result rendering, history sanitizing and
 * currency spotting. No state, no I/O.
 */

import type OpenAI from 'openai';
import { isSupportedCurrency } from '../../config/constants';
import {
  CURRENCY_TOKEN_PATTERN,
  normalizeCurrencyAlias,
  normalizeCurrencyText,
} from '../currency/tokens';
import type { ToolResult } from './types';

/** The amount side consumes one digit and bounded spacing, avoiding repeated long-number scans. */
const amountCurrencyPattern = new RegExp(
  String.raw`\d[\s\u00a0\u202f]{0,3}(${CURRENCY_TOKEN_PATTERN})(?![\p{L}\p{M}])|(?<![\p{L}\p{M}])(${CURRENCY_TOKEN_PATTERN})[\s\u00a0\u202f]{0,3}[-−+]?\d`,
  'giu',
);

/**
 * Currencies adjacent to amounts, once each, using the same aliases as expense input.
 * Used to reject a forced answer that invents a currency absent from tool results (#166).
 */
export function amountCurrencies(text: string): string[] {
  const codes = new Set<string>();
  for (const match of normalizeCurrencyText(text).matchAll(amountCurrencyPattern)) {
    const token = match[1] ?? match[2];
    const code = token ? normalizeCurrencyAlias(token) : null;
    if (code && isSupportedCurrency(code)) codes.add(code);
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
