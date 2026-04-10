// Console interceptor for ZenPlugin sub-process output.
// Plugins call console.log/warn/error with raw API responses containing PANs,
// IBANs, balances, phone numbers, tokens, and internal account identifiers.
//
// Two-layer defense:
//   1. Tree walker — for object/array/Map/Set/Error arguments, walks the
//      value and replaces any sensitive-keyed value with `[REDACTED]`
//      BEFORE stringification. This is the primary defense and handles
//      nested objects, Maps, Sets, arrays, and circular refs uniformly
//      regardless of the eventual string format.
//   2. Regex scrubber — applied to the final stringified form to catch
//      free-form PANs/IBANs/phone numbers that aren't wrapped in a
//      sensitive-keyed field (e.g. `console.log(panString)`).
//
// Output is routed through pino so that `console.log/.info/.debug` land at
// `debug` level, which is silenced in production (pino level=info). Only
// `console.warn/.error` get written to disk in prod — but redaction is
// always applied, so dev environments also stay clean.

import { inspect } from 'node:util';
import type { Logger } from 'pino';
import { createLogger } from '../../utils/logger.ts';

/** Field-name substrings (regex fragments) that indicate the value is
 *  sensitive. Entries use `[_-]?` separators so `apikey`, `api_key`,
 *  `api-key`, and `apiKey` all match. */
const SENSITIVE_KEYWORDS = [
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'credential',
  'bearer',
  'api[_-]?key',
  'private[_-]?key',
  'pin',
  'otp',
  'cvv',
  'cvc',
  'iban',
  'pan',
  'card[_-]?number',
  'account[_-]?number',
  'phone[_-]?number',
  'phone',
  'email',
  'cookie',
  'session[_-]?id',
  'identifier',
  'external[_-]?id',
  'contract[_-]?id',
  'login',
  'auth',
];

const SENSITIVE_KEY_REGEX = new RegExp(`(?:${SENSITIVE_KEYWORDS.join('|')})`, 'i');

/** Strong-secret keywords for free-form text scrubbing inside error
 *  messages / stacks. Narrower than the field-key list to avoid eating
 *  English prose like "phone connection failed". */
const STRONG_SECRET_KEYWORDS = [
  'token',
  'secret',
  'password',
  'passwd',
  'pwd',
  'credential',
  'bearer',
  'api[_-]?key',
  'private[_-]?key',
  'cookie',
  'cvv',
  'cvc',
  'otp',
  'pin',
];
// Match `keyword<sep>value` where sep is either `:`/`=` (with optional
// whitespace either side) or one or more spaces. Catches `token sk_live`,
// `token: sk_live`, `token=sk_live`, and `token:sk_live`.
const STRONG_SECRET_REGEX = new RegExp(
  `\\b(${STRONG_SECRET_KEYWORDS.join('|')})(?:\\s*[:=]\\s*|\\s+)\\S+`,
  'gi',
);

/** Case-insensitive substring check: does the field name contain any
 *  sensitive keyword fragment? */
function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_REGEX.test(key);
}

/** Scrub free-form text (Error message / stack) for any "keyword X" pattern
 *  where X is the next whitespace-delimited token. Coarser than the
 *  structured field redaction — accepts over-redaction. */
function redactFreeformText(text: string): string {
  return redactSensitive(text).replace(STRONG_SECRET_REGEX, '$1 [REDACTED]');
}

/** Walk a value and return a redacted copy. Values under sensitive keys are
 *  replaced with `'[REDACTED]'` regardless of their nested type. Handles
 *  plain objects, arrays, Maps, Sets, Errors, and circular references. */
export function redactObject(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value !== 'object') return value;

  if (seen.has(value as object)) return '[Circular]';
  seen.add(value as object);

  if (value instanceof Error) {
    return {
      name: value.name,
      message: redactFreeformText(value.message),
      stack: value.stack ? redactFreeformText(value.stack) : undefined,
    };
  }

  if (Array.isArray(value)) {
    return value.map((v) => redactObject(v, seen));
  }

  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    let objectKeyIndex = 0;
    for (const [k, v] of value) {
      // Object keys are never inspected (could leak secrets via key text).
      // Each non-primitive key gets a unique placeholder so multiple object
      // keys don't collide and overwrite each other.
      let keyStr: string;
      if (typeof k === 'string') keyStr = k;
      else if (typeof k === 'number' || typeof k === 'boolean' || typeof k === 'bigint') {
        keyStr = String(k);
      } else {
        keyStr = `[ObjectKey:${objectKeyIndex++}]`;
      }
      out[keyStr] = isSensitiveKey(keyStr) ? '[REDACTED]' : redactObject(v, seen);
    }
    return out;
  }

  if (value instanceof Set) {
    return [...value].map((v) => redactObject(v, seen));
  }

  // Plain object: walk own enumerable property descriptors. We check
  // descriptors (not Object.entries) so getters aren't invoked — a getter
  // could have side effects or return a sensitive value.
  const out: Record<string, unknown> = {};
  const descriptors = Object.getOwnPropertyDescriptors(value);
  for (const [k, desc] of Object.entries(descriptors)) {
    if (!desc.enumerable) continue;
    if (typeof desc.get === 'function') {
      out[k] = '[Getter]';
      continue;
    }
    out[k] = isSensitiveKey(k) ? '[REDACTED]' : redactObject(desc.value, seen);
  }
  return out;
}

// ── Free-form regex patterns (for bare strings that don't go through the
//    tree walker, e.g. `console.log('card is 4276 ...')`). ────────────────

/** Regex-scrub the final stringified output for PAN / IBAN / phone numbers
 *  that appear free-form (outside a sensitive-keyed field). */
const SENSITIVE_PATTERNS: Array<[RegExp, string]> = [
  // IBAN (uppercase). Greedy — BBAN is uppercase-only so English prose stops
  // the match naturally. Must run BEFORE PAN to avoid PAN eating the tail.
  [/\b[A-Z]{2}\d{2}(?:[ -]?[A-Z0-9]){10,30}\b/g, '[REDACTED_IBAN]'],
  // IBAN (lowercase, numeric BBAN). Works for both contiguous and spaced
  // digit-only BBANs because digits can't be absorbed by letter prose.
  [/\b[a-z]{2}\d{2}(?:[ -]?\d){14,28}\b/g, '[REDACTED_IBAN]'],
  // IBAN (lowercase, alphanumeric BBAN) — contiguous only. Lazy so trailing
  // lowercase prose isn't absorbed.
  [/\b[a-z]{2}\d{2}[a-z0-9]{10,30}?\b/g, '[REDACTED_IBAN]'],
  // Payment card number / long account number — split into two patterns to
  // avoid false-positiving on 13-digit unix-millis timestamps that appear in
  // every pino log line (`"time":1775826999217`).
  //   1. Card-formatted: 4-digit prefix + ≥2 more digit groups separated by
  //      spaces or dashes (matches Visa/MC `4276 1234 5678 9012`, Amex
  //      `3782 822463 10005`, Maestro `4276-1234-5678-9012-3456`).
  //   2. Contiguous form: 14+ digits with no separators (catches contiguous
  //      16-digit cards and 20-digit Russian/Belarusian account numbers
  //      while leaving 13-digit unix-millis timestamps alone).
  // KNOWN GAPS: 13-digit contiguous PANs (some legacy Visa) and unusual
  // 2-group separator formats (`4276 123456789012`) are not matched.
  [/\b\d{4}(?:[ -]\d{1,7}){2,}\b/g, '[REDACTED_PAN]'],
  [/\b\d{14,}\b/g, '[REDACTED_PAN]'],
  // E.164 phone numbers (loose — covers +375..., +7..., +995...).
  [/\+\d{10,15}\b/g, '[REDACTED_PHONE]'],
];

export function redactSensitive(input: string): string {
  let out = input;
  for (const [pattern, replacement] of SENSITIVE_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return out;
}

// ── Stringification ─────────────────────────────────────────────────────

function stringifyArg(arg: unknown): string {
  if (typeof arg === 'string') return arg;
  // For objects, walk the tree first to strip sensitive fields, then
  // inspect. customInspect: false blocks user-defined toJSON / toString /
  // [util.inspect.custom] hooks that could otherwise return arbitrary
  // (possibly sensitive) strings. Handles circular refs via [Circular].
  if (typeof arg === 'object' && arg !== null) {
    try {
      return inspect(redactObject(arg), {
        depth: 6,
        breakLength: Number.POSITIVE_INFINITY,
        customInspect: false,
      });
    } catch {
      return '[unserializable]';
    }
  }
  return String(arg);
}

function formatArgs(args: unknown[]): string {
  // Scrub each arg individually (cleans any bare-string PAN/IBAN within a
  // single arg), then join and scrub the combined string (catches patterns
  // that span multiple args).
  return args.map((a) => redactSensitive(stringifyArg(a))).join(' ');
}

// ── Console interceptor ─────────────────────────────────────────────────

interface ConsoleLike {
  log(...args: unknown[]): void;
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
  assert(condition: unknown, ...args: unknown[]): void;
}

interface InstallOptions {
  /** Target console (defaults to the global one). Injected for tests. */
  target?: ConsoleLike;
  /** Pino logger to route output to. Defaults to a `zen-plugin` child logger. */
  logger?: Logger;
}

/** Install the plugin console filter. Safe to call once at process start. */
export function installPluginConsoleFilter(opts: InstallOptions = {}): void {
  const target = opts.target ?? (globalThis.console as unknown as ConsoleLike);
  const log = opts.logger ?? createLogger('zen-plugin');

  const route =
    (level: 'debug' | 'warn' | 'error') =>
    (...args: unknown[]) => {
      log[level](redactSensitive(formatArgs(args)));
    };

  target.log = route('debug');
  target.info = route('debug');
  target.debug = route('debug');
  target.warn = route('warn');
  target.error = route('error');
  // ZenPlugins call console.assert(token, 'msg', response) for auth checks.
  // Mirror Node's behavior: only fire when condition is falsy. Route to
  // error level so failed assertions are visible but redacted.
  target.assert = (condition: unknown, ...args: unknown[]) => {
    if (!condition) {
      log.error(`Assertion failed: ${redactSensitive(formatArgs(args))}`);
    }
  };
}
