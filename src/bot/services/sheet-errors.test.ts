/** Tests for Google Sheets error classification */
import { describe, expect, test } from 'bun:test';
import { classifySheetError, getSheetErrorMessage } from './sheet-errors';

describe('classifySheetError', () => {
  test('returns "auth" for 401 errors', () => {
    expect(classifySheetError(new Error('Request failed with status 401'))).toBe('auth');
  });

  test('returns "auth" for invalid_grant', () => {
    expect(classifySheetError(new Error('invalid_grant: Token has been expired'))).toBe('auth');
  });

  test('returns "auth" for token revoked messages', () => {
    expect(classifySheetError(new Error('Token has been expired or revoked.'))).toBe('auth');
  });

  test('returns "not_found" for 404 errors', () => {
    expect(classifySheetError(new Error('404: Requested entity was not found'))).toBe('not_found');
  });

  test('returns "not_found" for 403 forbidden', () => {
    expect(classifySheetError(new Error('403 Forbidden: caller does not have permission'))).toBe(
      'not_found',
    );
  });

  test('returns "rate_limit" for 429 errors', () => {
    expect(classifySheetError(new Error('429: Too Many Requests'))).toBe('rate_limit');
  });

  test('returns "rate_limit" for quota messages', () => {
    expect(classifySheetError(new Error('Quota exceeded for quota metric'))).toBe('rate_limit');
  });

  test('returns "network" for ECONNRESET', () => {
    expect(classifySheetError(new Error('ECONNRESET: socket hang up'))).toBe('network');
  });

  test('returns "network" for timeout', () => {
    expect(classifySheetError(new Error('ETIMEDOUT: connection timed out'))).toBe('network');
  });

  test('returns "unknown" for unrecognized errors', () => {
    expect(classifySheetError(new Error('Some weird internal error'))).toBe('unknown');
  });

  test('returns "unknown" for non-Error values', () => {
    expect(classifySheetError('string error')).toBe('unknown');
    expect(classifySheetError(null)).toBe('unknown');
    expect(classifySheetError(undefined)).toBe('unknown');
    expect(classifySheetError({ code: 500 })).toBe('unknown');
  });
});

describe('getSheetErrorMessage', () => {
  test('auth error suggests /reconnect', () => {
    const msg = getSheetErrorMessage(new Error('401 Unauthorized'));
    expect(msg).toContain('/reconnect');
    expect(msg).toContain('авторизация');
  });

  test('not_found error mentions sheet inaccessible', () => {
    const msg = getSheetErrorMessage(new Error('404 Not Found'));
    expect(msg).toContain('недоступна');
    expect(msg).toContain('/reconnect');
  });

  test('rate_limit error suggests waiting', () => {
    const msg = getSheetErrorMessage(new Error('429 quota exceeded'));
    expect(msg).toContain('Подожди');
    expect(msg).not.toContain('/reconnect');
  });

  test('network error suggests retry', () => {
    const msg = getSheetErrorMessage(new Error('ETIMEDOUT'));
    expect(msg).toContain('сетью');
    expect(msg).toContain('Повтори');
  });

  test('unknown error has fallback message', () => {
    const msg = getSheetErrorMessage(new Error('weird error'));
    expect(msg).toContain('Не удалось');
    expect(msg).toContain('/reconnect');
  });
});
