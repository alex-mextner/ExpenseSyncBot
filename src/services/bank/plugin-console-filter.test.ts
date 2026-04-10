// Tests for ZenPlugin console interceptor — verifies redaction patterns
// and the tree walker, tested both directly and through the installer.

import { beforeEach, describe, expect, test } from 'bun:test';
import type { Logger } from 'pino';
import { installPluginConsoleFilter, redactObject, redactSensitive } from './plugin-console-filter';

// ─── Low-level regex: PAN / IBAN / phone on bare strings ────────────────

describe('redactSensitive — PAN', () => {
  test('16-digit PAN with spaces', () => {
    expect(redactSensitive('card 4276 1234 5678 9012 charged')).toBe('card [REDACTED_PAN] charged');
  });

  test('16-digit PAN contiguous', () => {
    expect(redactSensitive('PAN:4276123456789012')).toBe('PAN:[REDACTED_PAN]');
  });

  test('16-digit PAN with dashes', () => {
    expect(redactSensitive('4276-1234-5678-9012')).toBe('[REDACTED_PAN]');
  });

  test('20-digit Russian account number (H1 regression)', () => {
    expect(redactSensitive('acct 40817810099910004312 debit')).toBe('acct [REDACTED_PAN] debit');
  });

  test('30-digit blob', () => {
    expect(redactSensitive('123456789012345678901234567890')).toBe('[REDACTED_PAN]');
  });

  test('19+ digit PAN — no trailing leak', () => {
    expect(redactSensitive('4276-1234-5678-9012-3456')).toBe('[REDACTED_PAN]');
  });

  test('short numbers pass through', () => {
    expect(redactSensitive('123456789012')).toBe('123456789012'); // 12 digits — below threshold
    expect(redactSensitive('amount: 150')).toBe('amount: 150');
  });

  test('13-digit unix-millis pino timestamps are NOT matched (false-positive guard)', () => {
    // Every pino log line has `"time":1775826999217` — 13 contiguous digits.
    // The contiguous PAN pattern requires 14+ to leave these alone.
    expect(redactSensitive('"time":1775826999217')).toBe('"time":1775826999217');
    expect(redactSensitive('expirationDate: 1775826999217')).toBe('expirationDate: 1775826999217');
  });

  test('Amex format (4-6-5)', () => {
    expect(redactSensitive('3782 822463 10005')).toBe('[REDACTED_PAN]');
  });

  test('Maestro format with extra group', () => {
    expect(redactSensitive('4276-1234-5678-9012-3456')).toBe('[REDACTED_PAN]');
  });
});

describe('redactSensitive — IBAN', () => {
  test('contiguous uppercase IBAN', () => {
    expect(redactSensitive('IBAN: DE89370400440532013000 please')).toBe(
      'IBAN: [REDACTED_IBAN] please',
    );
  });

  test('spaced uppercase IBAN', () => {
    expect(redactSensitive('IBAN: DE89 3704 0044 0532 0130 00 done')).toBe(
      'IBAN: [REDACTED_IBAN] done',
    );
  });

  test('lowercase numeric IBAN (contiguous)', () => {
    expect(redactSensitive('iban de89370400440532013000 here')).toBe('iban [REDACTED_IBAN] here');
  });

  test('lowercase numeric IBAN (spaced)', () => {
    expect(redactSensitive('iban de89 3704 0044 0532 0130 00 done')).toBe(
      'iban [REDACTED_IBAN] done',
    );
  });

  test('uppercase alphanumeric IBAN (BY)', () => {
    expect(redactSensitive('BY04ALFA30120A15880010030000')).toBe('[REDACTED_IBAN]');
  });

  test('lowercase alphanumeric IBAN (MT, BY) — contiguous only', () => {
    expect(redactSensitive('by04alfa30120a15880010030000')).toBe('[REDACTED_IBAN]');
    expect(redactSensitive('mt84malt011000012345mtlcast001s')).toBe('[REDACTED_IBAN]');
  });
});

describe('redactSensitive — phone numbers', () => {
  test('E.164', () => {
    expect(redactSensitive('sms to +375291234567 sent')).toBe('sms to [REDACTED_PHONE] sent');
    expect(redactSensitive('+79991234567')).toBe('[REDACTED_PHONE]');
  });
});

// ─── Tree walker: object/array/Map/Set/Error ────────────────────────────

describe('redactObject', () => {
  test('redacts scalar value under sensitive key', () => {
    expect(redactObject({ access_token: 'jwt.secret.value', expires: 3600 })).toEqual({
      access_token: '[REDACTED]',
      expires: 3600,
    });
  });

  test('redacts nested object under sensitive key (round 4 H1)', () => {
    expect(redactObject({ accessToken: { expires: 3600, value: 'sk_live_abc' } })).toEqual({
      accessToken: '[REDACTED]',
    });
  });

  test('redacts array under sensitive key', () => {
    expect(redactObject({ apiKeys: ['sk_live_abc', 'sk_live_def'] })).toEqual({
      apiKeys: '[REDACTED]',
    });
  });

  test('recurses into non-sensitive parents', () => {
    expect(
      redactObject({
        user: { id: 42, accessToken: 'abc', email: 'me@x.y' },
      }),
    ).toEqual({
      user: { id: 42, accessToken: '[REDACTED]', email: '[REDACTED]' },
    });
  });

  test('handles hyphenated keys (round 2 M3)', () => {
    expect(redactObject({ 'x-api-key': 'sk_live_abc', 'client-secret': 'xyz' })).toEqual({
      'x-api-key': '[REDACTED]',
      'client-secret': '[REDACTED]',
    });
  });

  test('Map with sensitive key (round 4 M2)', () => {
    const m = new Map<string, string>([
      ['accessToken', 'sk_live_abc'],
      ['expires', '3600'],
    ]);
    expect(redactObject(m)).toEqual({
      accessToken: '[REDACTED]',
      expires: '3600',
    });
  });

  test('Set is walked recursively', () => {
    const s = new Set([{ token: 'abc' }, { name: 'x' }]);
    expect(redactObject(s)).toEqual([{ token: '[REDACTED]' }, { name: 'x' }]);
  });

  test('Error object is converted to a plain shape', () => {
    const err = new Error('boom');
    const result = redactObject(err) as { name: string; message: string; stack?: string };
    expect(result.name).toBe('Error');
    expect(result.message).toBe('boom');
    expect(typeof result.stack).toBe('string');
  });

  test('Error message with bare-text token is scrubbed (round 5 H2)', () => {
    const err = new Error('access token sk_live_abc failed');
    const result = redactObject(err) as { message: string; stack?: string };
    expect(result.message).not.toContain('sk_live_abc');
    expect(result.message).toContain('[REDACTED]');
  });

  test('Error message with token=value (no space) is scrubbed (round 6 H1)', () => {
    const err = new Error('access token=sk_live_abc failed');
    const result = redactObject(err) as { message: string };
    expect(result.message).not.toContain('sk_live_abc');
  });

  test('Error message with token:value (colon, no space) is scrubbed', () => {
    const err = new Error('access token:sk_live_abc failed');
    const result = redactObject(err) as { message: string };
    expect(result.message).not.toContain('sk_live_abc');
  });

  test('Map with multiple object keys keeps all entries (round 6 M2)', () => {
    const m = new Map<unknown, string>([
      [{ a: 1 }, 'first'],
      [{ b: 2 }, 'second'],
      [{ c: 3 }, 'third'],
    ]);
    const result = redactObject(m) as Record<string, string>;
    expect(Object.values(result)).toEqual(['first', 'second', 'third']);
  });

  test('getter is not invoked (round 5 M3)', () => {
    let invoked = false;
    const obj = {};
    Object.defineProperty(obj, 'details', {
      enumerable: true,
      get: () => {
        invoked = true;
        return 'sk_live_abc';
      },
    });
    const result = redactObject(obj) as { details: string };
    expect(invoked).toBe(false);
    expect(result.details).toBe('[Getter]');
  });

  test('Map with object key never inspects the key (round 5 M4)', () => {
    const m = new Map<unknown, string>([[{ accessToken: 'sk_live_abc' }, 'x']]);
    const result = redactObject(m) as Record<string, string>;
    // Key was an object → placeholder, never the inspected text.
    expect(JSON.stringify(result)).not.toContain('sk_live_abc');
    expect(JSON.stringify(result)).not.toContain('accessToken');
    expect(result['[ObjectKey:0]']).toBe('x');
  });

  test('circular reference → [Circular]', () => {
    const obj: Record<string, unknown> = { name: 'x' };
    obj['self'] = obj;
    const result = redactObject(obj) as { name: string; self: string };
    expect(result.name).toBe('x');
    expect(result.self).toBe('[Circular]');
  });

  test('primitive pass-through', () => {
    expect(redactObject('hello')).toBe('hello');
    expect(redactObject(42)).toBe(42);
    expect(redactObject(null)).toBe(null);
    expect(redactObject(undefined)).toBe(undefined);
  });
});

// ─── Installer: end-to-end through the interceptor ──────────────────────

describe('installPluginConsoleFilter — integration', () => {
  interface MockLogger {
    debug: (msg: string) => void;
    warn: (msg: string) => void;
    error: (msg: string) => void;
    info: (msg: string) => void;
    calls: { level: string; msg: string }[];
  }

  let fakeLogger: MockLogger;
  let fakeConsole: ConsoleLike;

  interface ConsoleLike {
    log: (...args: unknown[]) => void;
    info: (...args: unknown[]) => void;
    debug: (...args: unknown[]) => void;
    warn: (...args: unknown[]) => void;
    error: (...args: unknown[]) => void;
    assert: (condition: unknown, ...args: unknown[]) => void;
  }

  beforeEach(() => {
    const calls: { level: string; msg: string }[] = [];
    fakeLogger = {
      calls,
      debug: (msg: string) => calls.push({ level: 'debug', msg }),
      warn: (msg: string) => calls.push({ level: 'warn', msg }),
      error: (msg: string) => calls.push({ level: 'error', msg }),
      info: (msg: string) => calls.push({ level: 'info', msg }),
    };
    fakeConsole = {
      log: () => {},
      info: () => {},
      debug: () => {},
      warn: () => {},
      error: () => {},
      assert: () => {},
    };
    installPluginConsoleFilter({
      target: fakeConsole,
      logger: fakeLogger as unknown as Logger,
    });
  });

  const lastMsg = () => fakeLogger.calls[0]?.msg ?? '';

  test('console.log / .info / .debug all route to debug (silenced in prod)', () => {
    fakeConsole.log('log msg');
    fakeConsole.info('info msg');
    fakeConsole.debug('debug msg');
    expect(fakeLogger.calls.every((c) => c.level === 'debug')).toBe(true);
    expect(fakeLogger.calls).toHaveLength(3);
  });

  test('console.warn routes to warn, .error routes to error', () => {
    fakeConsole.warn('w');
    fakeConsole.error('e');
    expect(fakeLogger.calls).toEqual([
      { level: 'warn', msg: 'w' },
      { level: 'error', msg: 'e' },
    ]);
  });

  test('redacts token field in object', () => {
    fakeConsole.error({ access_token: 'jwt.secret.value', expires: 3600 });
    expect(lastMsg()).not.toContain('jwt.secret.value');
    expect(lastMsg()).toContain('[REDACTED]');
    expect(lastMsg()).toContain('expires');
  });

  test('redacts nested object under sensitive key (H1 round 4)', () => {
    fakeConsole.error({ accessToken: { value: 'sk_live_abc', expires: 3600 } });
    expect(lastMsg()).not.toContain('sk_live_abc');
    expect(lastMsg()).not.toContain('3600'); // redacted as part of the whole subtree
  });

  test('redacts sibling secrets in arrays', () => {
    fakeConsole.error({ apiKeys: ['4276123456789012', 'sk_live_abc'] });
    expect(lastMsg()).not.toContain('sk_live_abc');
    expect(lastMsg()).not.toContain('4276123456789012');
  });

  test('redacts hyphenated keys', () => {
    fakeConsole.error({ 'x-api-key': 'sk_live_abc', 'client-secret': 'xyz' });
    expect(lastMsg()).not.toContain('sk_live_abc');
    expect(lastMsg()).not.toContain('xyz');
  });

  test('Map with sensitive entries is fully redacted', () => {
    const m = new Map<string, string>([['accessToken', 'sk_live_abc']]);
    fakeConsole.error(m);
    expect(lastMsg()).not.toContain('sk_live_abc');
  });

  test('custom toJSON bypass (round 2 H1)', () => {
    const obj = { toJSON: () => 'hunter2-secret-value' };
    fakeConsole.error(obj);
    expect(lastMsg()).not.toContain('hunter2-secret-value');
  });

  test('custom toString bypass', () => {
    const obj: Record<string, unknown> = {
      name: 'x',
      toString: () => 'hunter2-secret-value',
    };
    obj['self'] = obj;
    expect(() => fakeConsole.error(obj)).not.toThrow();
    expect(lastMsg()).not.toContain('hunter2-secret-value');
  });

  test('util.inspect.custom bypass (round 3 M3)', async () => {
    const { inspect: utilInspect } = await import('node:util');
    const obj = { [utilInspect.custom]: () => 'custom dump: sk_live_abc' };
    fakeConsole.error(obj);
    expect(lastMsg()).not.toContain('sk_live_abc');
  });

  test('circular references handled', () => {
    const obj: Record<string, unknown> = { name: 'x' };
    obj['self'] = obj;
    expect(() => fakeConsole.error(obj)).not.toThrow();
    expect(fakeLogger.calls).toHaveLength(1);
    expect(lastMsg()).toContain('[Circular]');
  });

  test('bare-string PAN is redacted by regex', () => {
    fakeConsole.error('card number is 4276 1234 5678 9012');
    expect(lastMsg()).not.toContain('4276 1234 5678 9012');
    expect(lastMsg()).toContain('[REDACTED_PAN]');
  });

  test('non-sensitive amounts pass through', () => {
    fakeConsole.error({ amount: 1500, currency: 'BYN', currencyCode: 933 });
    expect(lastMsg()).toContain('1500');
    expect(lastMsg()).toContain('BYN');
    expect(lastMsg()).toContain('933');
  });

  test('stringifies Error with stack', () => {
    const err = new Error('boom');
    fakeConsole.error('failed:', err);
    expect(lastMsg()).toContain('boom');
  });

  test('mixed args: object + PAN string', () => {
    fakeConsole.error('card:', { cardNumber: '4276123456789012' }, 'raw 4276 1234 5678 9012');
    expect(lastMsg()).not.toContain('4276123456789012');
    expect(lastMsg()).not.toContain('4276 1234 5678 9012');
  });

  test('console.assert routes to error level when condition fails (round 5 H1)', () => {
    fakeConsole.assert(false, { accessToken: 'sk_live_abc' });
    expect(fakeLogger.calls).toHaveLength(1);
    expect(fakeLogger.calls[0]?.level).toBe('error');
    expect(lastMsg()).not.toContain('sk_live_abc');
    expect(lastMsg()).toContain('Assertion failed');
  });

  test('console.assert is silent when condition is truthy', () => {
    fakeConsole.assert(true, { accessToken: 'sk_live_abc' });
    expect(fakeLogger.calls).toHaveLength(0);
  });

  test('Error with bare-text token in message is scrubbed (round 5 H2)', () => {
    fakeConsole.error(new Error('access token sk_live_abc failed'));
    expect(fakeLogger.calls).toHaveLength(1);
    expect(lastMsg()).not.toContain('sk_live_abc');
  });
});
