// Tests for OTP manager — pending request lifecycle.

import { afterEach, describe, expect, test } from 'bun:test';
import {
  cancelOtpRequest,
  hasPendingOtp,
  registerOtpRequest,
  resolveOtpForGroup,
} from './otp-manager';

afterEach(() => {
  // Clean up any leftover pending requests between tests
  cancelOtpRequest(999);
  cancelOtpRequest(1);
  cancelOtpRequest(2);
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
    // Clean up to avoid timeout
    cancelOtpRequest(1);
    await promise.catch(() => {}); // swallow rejection
  });
});

describe('hasPendingOtp', () => {
  test('returns true when request is pending', async () => {
    const p = registerOtpRequest(2, 50);
    p.catch(() => {}); // prevent unhandled rejection
    expect(hasPendingOtp(50)).toBe(true);
    cancelOtpRequest(2);
    await p.catch(() => {});
  });

  test('returns false after resolution', async () => {
    const promise = registerOtpRequest(2, 50);
    resolveOtpForGroup(50, 'abc');
    await promise;
    expect(hasPendingOtp(50)).toBe(false);
  });
});

describe('cancelOtpRequest', () => {
  test('rejects pending promise', async () => {
    const promise = registerOtpRequest(1, 100);
    cancelOtpRequest(1);
    await expect(promise).rejects.toThrow('OTP запрос отменён');
  });
});
