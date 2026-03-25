// Tests for getErrorMessage utility
import { describe, expect, test } from 'bun:test';
import { getErrorMessage } from './error';

describe('getErrorMessage', () => {
  test('extracts message from Error', () => {
    expect(getErrorMessage(new Error('boom'))).toBe('boom');
  });

  test('converts non-Error to string', () => {
    expect(getErrorMessage(42)).toBe('42');
    expect(getErrorMessage('text')).toBe('text');
    expect(getErrorMessage(null)).toBe('null');
    expect(getErrorMessage(undefined)).toBe('undefined');
  });

  test('handles Error subclasses', () => {
    expect(getErrorMessage(new TypeError('bad type'))).toBe('bad type');
    expect(getErrorMessage(new RangeError('out of range'))).toBe('out of range');
  });
});
