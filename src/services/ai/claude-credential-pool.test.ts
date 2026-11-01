import { expect, spyOn, test } from 'bun:test';
import {
  CredentialsCoolingDownError,
  createClaudeCredentialPool,
  getClaudeCredentialAvailability,
} from './claude-credential-pool';

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

// Anthropic documents these as HTTP 400 invalid_request_error (rate-limits docs, "Spend limits").
for (const [scope, message] of [
  [
    'organization',
    'You have reached your specified API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
  ],
  [
    'workspace',
    'You have reached your specified workspace API usage limits. You will regain access on 2026-11-01 at 00:00 UTC.',
  ],
] as const) {
  test(`the documented ${scope} usage-limit 400 rotates once and cools only that credential`, async () => {
    const seen: string[] = [];
    const pool = createClaudeCredentialPool(['primary', 'backup']);
    const run = () =>
      pool.run(async (token) => {
        seen.push(token);
        if (token === 'primary') throw failure(400, message);
        return 'backup result';
      }, options);
    expect(await run()).toBe('backup result');
    expect(await run()).toBe('backup result');
    expect(seen).toEqual(['primary', 'backup', 'backup']);
  });
}

test('the documented spend-cap 429 without Retry-After rotates once and cools only that credential', async () => {
  const message =
    "You have reached your API usage limits: your organization has crossed its monthly API usage threshold, set based on your organization's API tier. You will regain access on 2026-09-01 at 00:00 UTC.";
  const seen: string[] = [];
  const pool = createClaudeCredentialPool(['primary', 'backup']);
  const run = () =>
    pool.run(async (token) => {
      seen.push(token);
      if (token === 'primary') throw failure(429, message);
      return 'backup result';
    }, options);
  expect(await run()).toBe('backup result');
  expect(await run()).toBe('backup result');
  expect(seen).toEqual(['primary', 'backup', 'backup']);
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
  now += 119_999;
  await expect(pool.run(attempt, options)).rejects.toThrow('cooling down');
  expect(seen).toEqual(['primary', 'backup']);
  now += 1;
  expect(await pool.run(attempt, options)).toBe('recovered');
  expect(seen).toEqual(['primary', 'backup', 'primary']);
});

// The cooldown is max(1s, Retry-After): sub-second hints still hold the key for exactly one second.
for (const retryAfter of ['0', '0.5', '0.001']) {
  test(`sub-second Retry-After "${retryAfter}" cools a key for exactly the one second floor`, async () => {
    let now = 1_000_000;
    const pool = createClaudeCredentialPool(['primary', 'backup'], () => now);
    await pool.run(async (token) => {
      if (token === 'primary') throw failure(429, 'limited', retryAfter);
      return 'backup';
    }, options);
    now += 999;
    expect(await pool.run(async (token) => token, options)).toBe('backup');
    now += 1;
    expect(await pool.run(async (token) => token, options)).toBe('primary');
  });
}

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

test('a credential recovered during another key failure is reconsidered once within the same request', async () => {
  let clock = 1_000_000;
  const pool = createClaudeCredentialPool(['primary', 'backup'], () => clock);
  await pool.run(async (token) => {
    if (token === 'primary') throw failure(401);
    return 'seed backup';
  }, options);
  clock += 300_001;
  let recoverPrimary: ((value: string) => void) | undefined;
  const recovering = pool.run(
    async () =>
      new Promise<string>((resolve) => {
        recoverPrimary = resolve;
      }),
    options,
  );
  await Bun.sleep(1);
  const seen: string[] = [];
  let failBackup: ((reason: unknown) => void) | undefined;
  const concurrent = pool.run(async (token) => {
    seen.push(token);
    if (token === 'backup')
      return new Promise<string>((_resolve, reject) => {
        failBackup = reject;
      });
    return 'newly recovered primary';
  }, options);
  await Bun.sleep(1);
  recoverPrimary?.('recovered');
  await recovering;
  failBackup?.(failure(401));
  expect(await concurrent).toBe('newly recovered primary');
  expect(seen).toEqual(['backup', 'primary']);
});

test('terminal availability includes an already-attempted key recovered by another request', async () => {
  const { getClaudeCredentialAvailability } = await import('./claude-credential-pool');
  let clock = 1_000_000;
  const pool = createClaudeCredentialPool(['primary', 'backup'], () => clock);
  let failBackup: ((reason: unknown) => void) | undefined;
  const seen: string[] = [];
  const concurrent = pool
    .run(async (token) => {
      seen.push(token);
      if (token === 'primary') throw failure(401);
      return new Promise<string>((_resolve, reject) => {
        failBackup = reject;
      });
    }, options)
    .catch((error: unknown) => error);
  await Bun.sleep(1);
  clock += 300_001;
  expect(await pool.run(async (token) => token, options)).toBe('primary');
  failBackup?.(failure(401));
  const terminal = await concurrent;
  expect(seen).toEqual(['primary', 'backup']);
  expect(getClaudeCredentialAvailability(terminal)).toEqual({
    local: false,
    retryAfterMs: 0,
    state: 'ready',
  });
});

test('an active recovery probe makes terminal pool availability inconclusive rather than five minutes down', async () => {
  const { getClaudeCredentialAvailability } = await import('./claude-credential-pool');
  let clock = 1_000_000;
  const pool = createClaudeCredentialPool(['primary', 'backup'], () => clock);
  await pool.run(async (token) => {
    if (token === 'primary') throw failure(401);
    return 'seed backup';
  }, options);
  clock += 300_001;
  let recoverPrimary: ((value: string) => void) | undefined;
  const recovering = pool.run(
    async () =>
      new Promise<string>((resolve) => {
        recoverPrimary = resolve;
      }),
    options,
  );
  await Bun.sleep(1);
  const terminal = await pool
    .run(async () => {
      throw failure(401);
    }, options)
    .catch((error: unknown) => error);
  recoverPrimary?.('recovered');
  await recovering;
  expect(getClaudeCredentialAvailability(terminal)).toEqual({
    local: false,
    retryAfterMs: 1000,
    state: 'probing',
  });
});

test('a local auth cooldown has availability metadata and zero HTTP calls without inventing HTTP 429', async () => {
  const { getClaudeCredentialAvailability, CredentialsCoolingDownError } = await import(
    './claude-credential-pool'
  );
  const pool = createClaudeCredentialPool(['primary', 'backup']);
  await pool
    .run(async () => {
      throw failure(401);
    }, options)
    .catch(() => undefined);
  let calls = 0;
  const terminal = await pool
    .run(async () => {
      calls++;
      return 'unexpected';
    }, options)
    .catch((error: unknown) => error);
  expect(terminal).toBeInstanceOf(CredentialsCoolingDownError);
  expect(calls).toBe(0);
  expect(terminal).toMatchObject({ status: 401 });
  expect(getClaudeCredentialAvailability(terminal)).toMatchObject({
    local: true,
    state: 'cooling',
  });
});

test('a local cooldown after two 429s carries that real 429, and one after a network error reads as a connection failure', async () => {
  const limited = createClaudeCredentialPool(['primary', 'backup']);
  await limited
    .run(async () => {
      throw failure(429, 'rate limited', '30');
    }, options)
    .catch(() => undefined);
  const cooling = await limited.run(async () => 'unexpected', options).catch((e: unknown) => e);
  expect(cooling).toBeInstanceOf(CredentialsCoolingDownError);
  expect(cooling).toMatchObject({ status: 429 });

  const offline = createClaudeCredentialPool(
    ['primary', 'backup'],
    Date.now,
    () => false,
    (error) => error instanceof TypeError,
  );
  await offline
    .run(async () => {
      throw new TypeError('synthetic');
    }, options)
    .catch(() => undefined);
  const disconnected = await offline
    .run(async () => 'unexpected', options)
    .catch((e: unknown) => e);
  expect(disconnected).not.toHaveProperty('status');
  expect(disconnected).toMatchObject({ message: expect.stringMatching(/connection error/i) });
});

for (const status of [400, 404]) {
  test(`an authoritative HTTP ${status} after expiry clears stale probe-only credential state`, async () => {
    let clock = 1_000_000;
    const pool = createClaudeCredentialPool(['primary', 'backup'], () => clock);
    await pool.run(async (token) => {
      if (token === 'primary') throw failure(401);
      return 'backup';
    }, options);
    clock += 300_001;
    await pool
      .run(async () => {
        throw failure(status, 'request rejected');
      }, options)
      .catch(() => undefined);
    let release: ((value: string) => void) | undefined;
    const first = pool.run(
      async (token) =>
        token === 'primary'
          ? new Promise<string>((resolve) => {
              release = resolve;
            })
          : 'backup',
      options,
    );
    await Bun.sleep(1);
    const second = await pool.run(async (token) => token, options);
    release?.('primary');
    await first;
    expect(second).toBe('primary');
  });
}

test('a fatal HTTP response cannot erase a newer concurrent credential cooldown', async () => {
  let clock = 1_000_000;
  const pool = createClaudeCredentialPool(['primary', 'backup'], () => clock);
  let failOlder: ((reason: unknown) => void) | undefined;
  const older = pool.run(
    async (token) =>
      token === 'primary'
        ? new Promise<string>((_resolve, reject) => {
            failOlder = reject;
          })
        : 'backup',
    options,
  );
  await Bun.sleep(1);
  await pool.run(async (token) => {
    if (token === 'primary') throw failure(401);
    return 'backup';
  }, options);
  clock += 300_001;
  let rejectRequest: ((reason: unknown) => void) | undefined;
  const recovering = pool
    .run(
      async () =>
        new Promise<string>((_resolve, reject) => {
          rejectRequest = reject;
        }),
      options,
    )
    .catch(() => undefined);
  await Bun.sleep(1);
  failOlder?.(failure(401));
  await older;
  rejectRequest?.(failure(400, 'invalid request'));
  await recovering;
  expect(await pool.run(async (token) => token, options)).toBe('backup');
});

test('a backup recovered mid-request gets no sliver budget: the primary failure survives and the backup is not cooled', async () => {
  let now = 1_000_000;
  let elapsed = 0;
  const pool = createClaudeCredentialPool(['primary', 'backup'], () => now);
  await pool
    .run(async (token) => {
      throw failure(429, 'limited', token === 'primary' ? '1' : '2');
    }, options)
    .catch(() => undefined);
  now += 1001; // primary is back, the backup still cools
  const clock = spyOn(performance, 'now').mockImplementation(() => elapsed);
  const seen: string[] = [];
  const primaryFailure = failure(529, 'overloaded');
  try {
    const error = await pool
      .run(
        async (token) => {
          seen.push(token);
          if (token === 'backup') await new Promise<never>(() => undefined); // a doomed attempt would hang here
          now += 1000; // the backup recovers while the primary spends the whole budget
          elapsed += 999.5;
          throw primaryFailure;
        },
        { timeoutMs: 1000 },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBe(primaryFailure);
    expect(seen).toEqual(['primary']);
    expect(getClaudeCredentialAvailability(error)?.state).toBe('ready');
    elapsed += 10_000;
    expect(await pool.run(async (token) => token, options)).toBe('backup');
  } finally {
    clock.mockRestore();
  }
});

test('a late backup still gets its attempt while the leftover budget is at least min(timeout/4, 1s)', async () => {
  for (const [timeoutMs, spent] of [
    [1000, 749], // 251ms left of a 250ms threshold
    [200, 149], // 51ms left of a 50ms threshold
  ] as const) {
    let now = 1_000_000;
    let elapsed = 0;
    const pool = createClaudeCredentialPool(['primary', 'backup'], () => now);
    await pool
      .run(async (token) => {
        throw failure(429, 'limited', token === 'primary' ? '1' : '2');
      }, options)
      .catch(() => undefined);
    now += 1001;
    const clock = spyOn(performance, 'now').mockImplementation(() => elapsed);
    const seen: string[] = [];
    try {
      const result = await pool.run(
        async (token) => {
          seen.push(token);
          if (token === 'backup') return 'backup result';
          now += 1000;
          elapsed += spent;
          throw failure(529, 'overloaded');
        },
        { timeoutMs },
      );
      expect(result).toBe('backup result');
      expect(seen).toEqual(['primary', 'backup']);
    } finally {
      clock.mockRestore();
    }
  }
});

test('a failed attempt that exhausted the budget rethrows its own failure, not a fresh timeout', async () => {
  let elapsed = 0;
  const clock = spyOn(performance, 'now').mockImplementation(() => elapsed);
  const primaryFailure = failure(529, 'overloaded');
  try {
    const error = await createClaudeCredentialPool(['primary', 'backup'])
      .run(
        async () => {
          elapsed += 5000;
          throw primaryFailure;
        },
        { timeoutMs: 1000 },
      )
      .catch((caught: unknown) => caught);
    expect(error).toBe(primaryFailure);
  } finally {
    clock.mockRestore();
  }
});

const neverAnswers = (_token: string, signal: AbortSignal) =>
  new Promise<never>((_resolve, reject) =>
    signal.addEventListener('abort', () => reject(signal.reason), { once: true }),
  );

test('two healthy slow keys sharing a sub-second slice are not cooled by their own too-short timeout', async () => {
  const pool = createClaudeCredentialPool(['primary', 'backup']);
  // 1500ms shared between two keys leaves 750ms per attempt, below the one-second useful floor.
  const error = await pool
    .run(neverAnswers, { timeoutMs: 1500 })
    .catch((caught: unknown) => caught);
  expect((error as Error).name).toBe('CredentialAttemptTimeoutError');
  const seen: string[] = [];
  const result = await pool.run(async (token) => {
    seen.push(token);
    return 'answered';
  }, options);
  expect(result).toBe('answered');
  expect(seen).toEqual(['primary']);
});

test('a sub-floor first-attempt timeout still rotates to the backup within the shared deadline', async () => {
  const seen: string[] = [];
  const result = await createClaudeCredentialPool(['primary', 'backup']).run(
    async (token, signal) => {
      seen.push(token);
      if (token === 'primary') return neverAnswers(token, signal);
      return 'backup answered';
    },
    { timeoutMs: 1500 },
  );
  expect(result).toBe('backup answered');
  expect(seen).toEqual(['primary', 'backup']);
});

test('a key that outlasts a full useful slice is still cooled for its timeout', async () => {
  const pool = createClaudeCredentialPool(['only']);
  await pool.run(neverAnswers, { timeoutMs: 1100 }).catch(() => undefined);
  let calls = 0;
  const error = await pool
    .run(async () => {
      calls++;
      return 'unreachable';
    }, options)
    .catch((caught: unknown) => caught);
  expect(error).toBeInstanceOf(CredentialsCoolingDownError);
  expect(calls).toBe(0);
});

test('a request that finds one key probing and the other cooling still carries the real cause', async () => {
  let clock = 1_000_000;
  const pool = createClaudeCredentialPool(['primary', 'backup'], () => clock);
  await pool
    .run(async (token) => {
      throw failure(529, 'overloaded', token === 'primary' ? '1' : '60');
    }, options)
    .catch(() => undefined);
  clock += 1001; // the primary cooldown has expired, the backup still cools
  let finishProbe: ((value: string) => void) | undefined;
  const probeStarted = Promise.withResolvers<void>();
  const probe = pool.run(
    () =>
      new Promise<string>((resolve) => {
        finishProbe = resolve;
        probeStarted.resolve();
      }),
    options,
  );
  await probeStarted.promise;
  try {
    const concurrent = await pool.run(async () => 'unexpected', options).catch((e: unknown) => e);
    expect(concurrent).toBeInstanceOf(CredentialsCoolingDownError);
    expect(getClaudeCredentialAvailability(concurrent)).toMatchObject({
      local: true,
      state: 'probing',
    });
    expect(concurrent).toMatchObject({ status: 529 });
  } finally {
    finishProbe?.('probed');
    await probe;
  }
});

test('a shorter cooldown from a concurrent failure never replaces the cause of the cooldown that is kept', async () => {
  let clock = 1_000_000;
  const pool = createClaudeCredentialPool(
    ['primary', 'backup'],
    () => clock,
    () => false,
    (error) => error instanceof TypeError,
  );
  let failOlder: ((reason: unknown) => void) | undefined;
  const olderStarted = Promise.withResolvers<void>();
  const older = pool
    .run(
      () =>
        new Promise<string>((_resolve, reject) => {
          failOlder = reject;
          olderStarted.resolve();
        }),
      { timeoutMs: 5000 },
    )
    .catch((caught: unknown) => caught);
  await olderStarted.promise;
  // A newer request cools both keys for 300s with an authentication failure.
  await pool
    .run(async () => {
      throw failure(401, 'unauthorized');
    }, options)
    .catch(() => undefined);
  // The older primary request now fails with a connection error, a 60s cooldown that must lose.
  failOlder?.(new TypeError('synthetic network down'));
  await older;
  clock += 61_000;
  const cooling = await pool.run(async () => 'unexpected', options).catch((e: unknown) => e);
  expect(cooling).toBeInstanceOf(CredentialsCoolingDownError);
  expect(cooling).toMatchObject({ status: 401 });
  expect((cooling as Error).message).not.toMatch(/connection/i);
});
