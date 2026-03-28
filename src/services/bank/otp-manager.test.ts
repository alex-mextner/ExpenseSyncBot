// Tests for OTP manager — pending request lifecycle.

import { afterEach, describe, expect, test } from 'bun:test';
import { cancelOtpRequest, registerOtpRequest, resolveOtpForGroup } from './otp-manager';

afterEach(() => {
  // Clean up any leftover pending requests between tests
  cancelOtpRequest(1);
  cancelOtpRequest(2);
  cancelOtpRequest(999);
});

describe('registerOtpRequest / resolveOtpForGroup', () => {
  test('resolves promise when code sent to matching group', async () => {
    const promise = registerOtpRequest(1, 100);
    const resolved = resolveOtpForGroup(100, '123456');
    expect(resolved).toBe(true);
    expect(await promise).toBe('123456');
  });

  test('returns false when no pending OTP for group', () => {
    expect(resolveOtpForGroup(999, 'code')).toBe(false);
  });

  test('does not resolve for wrong group', async () => {
    const promise = registerOtpRequest(1, 100);
    const resolved = resolveOtpForGroup(200, 'code');
    expect(resolved).toBe(false);
    cancelOtpRequest(1);
    await promise.catch(() => {});
  });
});

describe('cancelOtpRequest', () => {
  test('rejects pending promise', async () => {
    const promise = registerOtpRequest(1, 100);
    cancelOtpRequest(1);
    await expect(promise).rejects.toThrow('OTP запрос отменён');
  });

  test('is a no-op when no pending request', () => {
    expect(() => cancelOtpRequest(999)).not.toThrow();
  });
});
