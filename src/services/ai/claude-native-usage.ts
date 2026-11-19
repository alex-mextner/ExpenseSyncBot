// Normalize native token categories and retain observed usage on failed attempts.
import type { CompletionUsage } from 'openai/resources/completions';
import { z } from 'zod';
import type { TokenUsage as AiTokenUsage } from './streaming/token-usage.ts';

const count = z.number().int().nonnegative();
export const nativeUsageSchema = z.object({
  input_tokens: count.nullish(),
  output_tokens: count.nullish(),
  output_tokens_details: z.object({ thinking_tokens: count.nullish() }).nullish(),
  cache_creation_input_tokens: count.nullish(),
  cache_read_input_tokens: count.nullish(),
});
export type NativeUsage = z.infer<typeof nativeUsageSchema>;
/** Native delta nulls mean "not updated", not a replacement for an observed count. */
export function mergeNativeUsage(previous: NativeUsage, next: NativeUsage): NativeUsage {
  const merged = { ...previous };
  for (const key of [
    'input_tokens',
    'output_tokens',
    'cache_creation_input_tokens',
    'cache_read_input_tokens',
  ] as const) {
    const value = next[key];
    if (value != null) merged[key] = value;
  }
  const thinking = next.output_tokens_details?.thinking_tokens;
  if (thinking != null) merged.output_tokens_details = { thinking_tokens: thinking };
  return merged;
}

const detailsSchema = z.object({
  freshInputTokens: count.nullable(),
  cacheWriteTokens: count.nullable(),
  credentialId: z.string().regex(/^[a-f0-9]{12}$/),
});
type NativeDetails = z.infer<typeof detailsSchema>;
interface NativeCompletionUsage extends CompletionUsage {
  native: NativeDetails;
}
export type NativeUsageObserver = (usage: AiTokenUsage) => void;

export function nativeUsageDetails(usage: CompletionUsage): NativeDetails | undefined {
  if (!('native' in usage)) return undefined;
  const parsed = detailsSchema.safeParse(usage.native);
  return parsed.success ? parsed.data : undefined;
}

export function nativeCompletionUsage(
  usage: NativeUsage,
  credentialId: string,
  outputReported = true,
): NativeCompletionUsage {
  const fresh = usage.input_tokens;
  const created = usage.cache_creation_input_tokens;
  const read = usage.cache_read_input_tokens;
  // NaN is an internal unknown sentinel normalized to null, never serialized or stored.
  const input =
    fresh == null || created == null || read == null ? Number.NaN : fresh + created + read;
  const output = outputReported ? (usage.output_tokens ?? Number.NaN) : Number.NaN;
  return {
    prompt_tokens: input,
    completion_tokens: output,
    total_tokens: input + output,
    ...(read == null ? {} : { prompt_tokens_details: { cached_tokens: read } }),
    ...(!outputReported || usage.output_tokens_details?.thinking_tokens == null
      ? {}
      : {
          completion_tokens_details: {
            reasoning_tokens: usage.output_tokens_details.thinking_tokens,
          },
        }),
    native: { freshInputTokens: fresh ?? null, cacheWriteTokens: created ?? null, credentialId },
  };
}

/**
 * Observed counters are lower bounds on interrupted attempts, including the initial output count.
 * Completed chunks publish output only after a terminal usage update; these are different coverage
 * guarantees, not additive channels. The request-owned observer never attaches data to shared errors.
 */
export function nativeTokenUsage(usage: NativeUsage, credentialId: string): AiTokenUsage {
  const normalized = nativeCompletionUsage(usage, credentialId, true);
  return {
    promptTokens: Number.isFinite(normalized.prompt_tokens) ? normalized.prompt_tokens : null,
    completionTokens: usage.output_tokens ?? null,
    reasoningTokens: usage.output_tokens_details?.thinking_tokens ?? null,
    cachedTokens: usage.cache_read_input_tokens ?? null,
    ...normalized.native,
  };
}
