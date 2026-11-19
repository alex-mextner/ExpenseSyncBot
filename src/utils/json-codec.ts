// Decode JSON strings through a concrete schema before request construction.
import { z } from 'zod';

/**
 * Create a Zod v4 codec that decodes a JSON string into a validated typed value.
 * Handles JSON.parse errors internally — no try-catch needed at call sites.
 *
 * Usage:
 *   const codec = jsonCodec(z.array(z.number()));
 *   codec.parse(str);       // number[] — throws ZodError on invalid
 *   codec.safeParse(str);   // { success: true, data: number[] } | { success: false, error: ZodError }
 */
export function jsonCodec<T extends z.ZodType>(schema: T) {
  return z.codec(z.string(), schema, {
    decode: (jsonString: string, payload) => {
      try {
        return JSON.parse(jsonString);
      } catch (err: unknown) {
        payload.issues.push({
          code: 'custom',
          input: jsonString,
          message: err instanceof Error ? err.message : String(err),
        });
        return z.NEVER;
      }
    },
    encode: (value) => JSON.stringify(value),
  });
}
