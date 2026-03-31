// Helpers for mocking globalThis.fetch in tests
import { mock } from 'bun:test';

type FetchMock = ReturnType<typeof mock>;

/**
 * Mock fetch to return a JSON response.
 * Returns the mock function for assertions.
 */
export function mockFetchJson(body: unknown, status = 200): FetchMock {
  const fn = mock(
    async () =>
      new Response(JSON.stringify(body), {
        status,
        headers: { 'Content-Type': 'application/json' },
      }),
  );
  // bun-types adds `.preconnect` to `typeof fetch` which a Mock doesn't have,
  // but at runtime the mock satisfies the call signature — cast is unavoidable.
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/**
 * Mock fetch to return a text/binary response.
 */
export function mockFetchText(body: string, status = 200): FetchMock {
  const fn = mock(async () => new Response(body, { status }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/**
 * Mock fetch to throw a network error.
 */
export function mockFetchError(message = 'Network error'): FetchMock {
  const fn = mock(async () => {
    throw new Error(message);
  });
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/**
 * Restore original fetch. Call in afterEach.
 */
const originalFetch = globalThis.fetch;
export function restoreFetch(): void {
  globalThis.fetch = originalFetch;
}
