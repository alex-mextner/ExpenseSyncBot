import { expect, test } from 'bun:test';
import { createClaudeCredentialPool } from './claude-credential-pool';

const options = { timeoutMs: 1000 };
const failure = (status: number, message = 'unavailable', retryAfter?: string) =>
  Object.assign(new Error(message), {
    status,
    headers: new Headers(retryAfter ? { 'retry-after': retryAfter } : {}),
  });

test('healthy primary keeps identical result and counts one HTTP attempt', async () => {
  const seen: string[] = [];
  let attempts = 0;
  const result = { text: 'synthetic' };
  const pool = createClaudeCredentialPool(['primary', 'backup']);
  expect(
    await pool.run(
      async (token) => {
        seen.push(token);
        return result;
      },
      { ...options, onHttpAttempt: () => attempts++ },
    ),
  ).toBe(result);
  expect(seen).toEqual(['primary']);
  expect(attempts).toBe(1);
});

for (const status of [401, 402, 403, 408, 409, 429, 500, 529]) {
  test(`HTTP ${status} tries the backup once and counts both requests`, async () => {
    const seen: string[] = [];
    let attempts = 0;
    const pool = createClaudeCredentialPool(['primary', 'backup']);
    const result = await pool.run(
      async (token) => {
        seen.push(token);
        if (token === 'primary') throw failure(status);
        return 'backup result';
      },
      { ...options, onHttpAttempt: () => attempts++ },
    );
    expect(result).toBe('backup result');
    expect(seen).toEqual(['primary', 'backup']);
    expect(attempts).toBe(2);
  });
}

test('recognized spend-limit 400 rotates; invalid schema and missing model do not', async () => {
  for (const [status, message, expected] of [
    [400, 'Your credit balance is too low', 2],
    [400, 'enforced_spend_limit_reached', 2],
    [400, 'invalid tool schema', 1],
    [400, 'invalid billing schema', 1],
    [404, 'model missing', 1],
  ] as const) {
    let calls = 0;
    await createClaudeCredentialPool(['primary', 'backup'])
      .run(async () => {
        calls++;
        if (calls === 1) throw failure(status, message);
        return 'ok';
      }, options)
      .catch(() => undefined);
    expect(calls).toBe(expected);
  }
});

test('Retry-After prevents calls while both cool down and primary recovers after expiry', async () => {
  let now = 1_000_000;
  const seen: string[] = [];
  const pool = createClaudeCredentialPool(['primary', 'backup'], () => now);
  const attempt = async (token: string) => {
    seen.push(token);
    if (now < 1_120_000) throw failure(429, 'limited', '120');
    return 'recovered';
  };
  await expect(pool.run(attempt, options)).rejects.toThrow('limited');
  await expect(pool.run(attempt, options)).rejects.toThrow('cooling down');
  now += 119_000;
  await expect(pool.run(attempt, options)).rejects.toThrow('cooling down');
  expect(seen).toEqual(['primary', 'backup']);
  now += 1000;
  expect(await pool.run(attempt, options)).toBe('recovered');
  expect(seen).toEqual(['primary', 'backup', 'primary']);
});

test('HTTP-date Retry-After is respected', async () => {
  let now = Date.parse('2026-10-29T12:00:00Z');
  let calls = 0;
  const pool = createClaudeCredentialPool(['primary', 'backup'], () => now);
  await pool
    .run(async () => {
      calls++;
      throw failure(429, 'limited', 'Thu, 29 Oct 2026 12:02:00 GMT');
    }, options)
    .catch(() => undefined);
  now += 119_000;
  await pool
    .run(async () => {
      calls++;
    }, options)
    .catch(() => undefined);
  expect(calls).toBe(2);
});

test('duplicate tokens are trimmed and never retried', async () => {
  let calls = 0;
  await createClaudeCredentialPool(['primary', ' primary ', '', undefined])
    .run(async () => {
      calls++;
      throw failure(429);
    }, options)
    .catch(() => undefined);
  expect(calls).toBe(1);
});

test('network failure switches once and cooling primary is skipped on the next request', async () => {
  const seen: string[] = [];
  const pool = createClaudeCredentialPool(['primary', 'backup']);
  const attempt = async (token: string) => {
    seen.push(token);
    if (token === 'primary') throw new TypeError('fetch failed');
    return 'ok';
  };
  await pool.run(attempt, options);
  await pool.run(attempt, options);
  expect(seen).toEqual(['primary', 'backup', 'backup']);
});

test('caller abort prevents another key attempt and does not mark primary unhealthy', async () => {
  const controller = new AbortController();
  const seen: string[] = [];
  const pool = createClaudeCredentialPool(['primary', 'backup']);
  await expect(
    pool.run(
      async (token) => {
        seen.push(token);
        controller.abort();
        throw new DOMException('aborted', 'AbortError');
      },
      { ...options, signal: controller.signal },
    ),
  ).rejects.toThrow();
  await pool.run(async (token) => {
    seen.push(token);
    return 'ok';
  }, options);
  expect(seen).toEqual(['primary', 'primary']);
});

test('expired caller signal never starts a request', async () => {
  const controller = new AbortController();
  controller.abort();
  let calls = 0;
  await expect(
    createClaudeCredentialPool(['primary', 'backup']).run(
      async () => {
        calls++;
      },
      { ...options, signal: controller.signal },
    ),
  ).rejects.toThrow();
  expect(calls).toBe(0);
});

test('header timeout shares the existing budget and aborts a late first producer', async () => {
  const seen: string[] = [];
  let firstSignal: AbortSignal | undefined;
  let discarded = false;
  const pool = createClaudeCredentialPool(['primary', 'backup']);
  const result = await pool.run(
    async (token, signal) => {
      seen.push(token);
      if (token === 'primary') {
        firstSignal = signal;
        await Bun.sleep(1500);
        return {
          text: 'late',
          controller: {
            abort() {
              discarded = true;
            },
          },
        };
      }
      return { text: 'backup', controller: new AbortController() };
    },
    { timeoutMs: 1000 },
  );
  expect(result.text).toBe('backup');
  expect(firstSignal?.aborted).toBe(true);
  await Bun.sleep(1550);
  expect(discarded).toBe(true);
  expect(seen).toEqual(['primary', 'backup']);
});

test('a returned stream is never replayed and caller cancellation still aborts its signal', async () => {
  const controller = new AbortController();
  let calls = 0;
  let streamSignal: AbortSignal | undefined;
  const stream = {
    async *[Symbol.asyncIterator]() {
      yield 'partial';
      throw new Error('stream broke');
    },
  };
  const result = await createClaudeCredentialPool(['primary', 'backup']).run(
    async (_token, signal) => {
      calls++;
      streamSignal = signal;
      return stream;
    },
    { timeoutMs: 20, signal: controller.signal },
  );
  await Bun.sleep(30);
  expect(streamSignal?.aborted).toBe(false);
  const consume = async () => {
    for await (const _chunk of result) {
      /* consume */
    }
  };
  await expect(consume()).rejects.toThrow('stream broke');
  controller.abort();
  expect(streamSignal?.aborted).toBe(true);
  expect(calls).toBe(1);
});

test('an older concurrent success cannot erase a newer credential failure cooldown', async () => {
  const pool = createClaudeCredentialPool(['primary', 'backup']);
  let release: ((value: string) => void) | undefined;
  const older = pool.run(
    async () =>
      new Promise<string>((resolve) => {
        release = resolve;
      }),
    options,
  );
  await Bun.sleep(1);
  await pool.run(async (token) => {
    if (token === 'primary') throw failure(401);
    return 'backup';
  }, options);
  release?.('older success');
  await older;
  const selected = await pool.run(async (token) => token, options);
  expect(selected).toBe('backup');
});

test('only one recovery request probes an expired failed credential concurrently', async () => {
  let now = 1_000_000;
  const pool = createClaudeCredentialPool(['primary', 'backup'], () => now);
  await pool.run(async (token) => {
    if (token === 'primary') throw failure(401);
    return 'backup';
  }, options);
  now += 300_001;
  let release: ((value: string) => void) | undefined;
  const probe = pool.run(
    async (token) =>
      token === 'primary'
        ? new Promise<string>((resolve) => {
            release = resolve;
          })
        : 'backup',
    options,
  );
  await Bun.sleep(1);
  const concurrent = await pool.run(async (token) => token, options);
  release?.('recovered');
  await probe;
  expect(concurrent).toBe('backup');
});

test('retry telemetry reports the actual failed attempt before the backup starts', async () => {
  const events: string[] = [];
  const failureError = failure(429);
  let recorded: unknown;
  const result = await createClaudeCredentialPool(['primary', 'backup']).run(
    async (token) => {
      events.push(token);
      if (token === 'primary') throw failureError;
      return 'ok';
    },
    {
      ...options,
      onRetry: (attempt: { error: unknown; startedAt: number; durationMs: number }) => {
        recorded = attempt.error;
        expect(attempt.startedAt).toBeGreaterThan(0);
        expect(attempt.durationMs).toBeGreaterThanOrEqual(0);
        events.push('retry');
      },
    },
  );
  expect(result).toBe('ok');
  expect(recorded).toBe(failureError);
  expect(events).toEqual(['primary', 'retry', 'backup']);
});

test('absurd Retry-After is bounded and invalid Retry-After still permits recovery', async () => {
  for (const [retryAfter, elapsed] of [
    ['1e99', 86_400_001],
    ['not-a-date', 60_001],
  ] as const) {
    let now = 1_000_000;
    const pool = createClaudeCredentialPool(['primary', 'backup'], () => now);
    await pool.run(async (token) => {
      if (token === 'primary') throw failure(429, 'limited', retryAfter);
      return 'backup';
    }, options);
    now += elapsed;
    expect(await pool.run(async (token) => token, options)).toBe('primary');
  }
});

test('a short Retry-After allows prompt recovery instead of imposing the default cooldown', async () => {
  let now = 1_000_000;
  const pool = createClaudeCredentialPool(['primary', 'backup'], () => now);
  await pool.run(async (token) => {
    if (token === 'primary') throw failure(429, 'limited', '1');
    return 'backup';
  }, options);
  now += 1001;
  expect(await pool.run(async (token) => token, options)).toBe('primary');
});
