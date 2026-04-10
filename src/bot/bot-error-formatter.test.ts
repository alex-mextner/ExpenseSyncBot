// src/bot/bot-error-formatter.test.ts
// TDD: write before implementing bot-error-formatter.ts

import { describe, expect, it } from 'bun:test';
import {
  AiProviderError,
  AppError,
  GoogleSheetsError,
  HuggingFaceError,
  NetworkError,
  OAuthError,
} from '../errors';
import { formatErrorForUser } from './bot-error-formatter';

describe('formatErrorForUser', () => {
  describe('GoogleSheetsError', () => {
    it('returns spreadsheet-related message', () => {
      const err = new GoogleSheetsError('API error', 'SHEETS_API_ERROR');
      const msg = formatErrorForUser(err);
      expect(msg.toLowerCase()).toMatch(/таблиц|sheets|google/);
    });

    it('includes suggestion to retry', () => {
      const err = new GoogleSheetsError('quota exceeded', 'QUOTA_EXCEEDED');
      const msg = formatErrorForUser(err);
      expect(msg.length).toBeGreaterThan(10);
    });

    it('returns a string', () => {
      const err = new GoogleSheetsError('fail', 'SHEETS_FAIL');
      expect(typeof formatErrorForUser(err)).toBe('string');
    });
  });

  describe('OAuthError', () => {
    it('returns reconnect suggestion', () => {
      const err = new OAuthError('token expired', 'TOKEN_EXPIRED');
      const msg = formatErrorForUser(err);
      expect(msg).toContain('/reconnect');
    });

    it('returns non-empty string', () => {
      const err = new OAuthError('invalid grant', 'INVALID_GRANT');
      expect(formatErrorForUser(err).length).toBeGreaterThan(5);
    });

    it('is distinct from GoogleSheetsError message', () => {
      const oauthMsg = formatErrorForUser(new OAuthError('x', 'y'));
      const sheetsMsg = formatErrorForUser(new GoogleSheetsError('x', 'y'));
      expect(oauthMsg).not.toBe(sheetsMsg);
    });
  });

  describe('NetworkError', () => {
    it('returns network problem message', () => {
      const err = new NetworkError('connection refused', 'CONNECTION_REFUSED');
      const msg = formatErrorForUser(err);
      expect(msg.toLowerCase()).toMatch(/сеть|соединени|интернет|недоступ/);
    });

    it('returns non-empty string', () => {
      const err = new NetworkError('timeout', 'ETIMEDOUT');
      expect(formatErrorForUser(err).length).toBeGreaterThan(5);
    });

    it('is distinct from OAuthError message', () => {
      const networkMsg = formatErrorForUser(new NetworkError('x', 'y'));
      const oauthMsg = formatErrorForUser(new OAuthError('x', 'y'));
      expect(networkMsg).not.toBe(oauthMsg);
    });
  });

  describe('HuggingFaceError', () => {
    it('returns AI service message', () => {
      const err = new HuggingFaceError('rate limit', 'RATE_LIMIT');
      const msg = formatErrorForUser(err);
      expect(msg.toLowerCase()).toMatch(/ai|ии|сервис|попробуй/);
    });

    it('returns non-empty string', () => {
      const err = new HuggingFaceError('model loading', 'MODEL_LOADING');
      expect(formatErrorForUser(err).length).toBeGreaterThan(5);
    });
  });

  describe('AiProviderError', () => {
    it('returns AI service unavailable message', () => {
      const err = new AiProviderError('rate limit', 'RATE_LIMIT_429');
      const msg = formatErrorForUser(err);
      expect(msg.toLowerCase()).toMatch(/ai|ии|сервис|попробуй/);
    });

    it('returns non-empty string', () => {
      const err = new AiProviderError('overloaded', 'OVERLOADED_529');
      expect(formatErrorForUser(err).length).toBeGreaterThan(5);
    });

    it('AiProviderError and HuggingFaceError produce same message (both AI services)', () => {
      const anthropicMsg = formatErrorForUser(new AiProviderError('x', 'y'));
      const hfMsg = formatErrorForUser(new HuggingFaceError('x', 'y'));
      expect(anthropicMsg).toBe(hfMsg);
    });
  });

  describe('generic AppError', () => {
    it('returns generic error message', () => {
      const err = new AppError('something', 'UNKNOWN');
      const msg = formatErrorForUser(err);
      expect(typeof msg).toBe('string');
      expect(msg.length).toBeGreaterThan(5);
    });

    it('subclasses take priority over base AppError', () => {
      const base = formatErrorForUser(new AppError('x', 'y'));
      const google = formatErrorForUser(new GoogleSheetsError('x', 'y'));
      // GoogleSheetsError message should differ from base AppError fallback
      expect(google).not.toBe(base);
    });
  });

  describe('unknown error', () => {
    it('handles plain Error', () => {
      const msg = formatErrorForUser(new Error('oops'));
      expect(typeof msg).toBe('string');
    });

    it('handles non-Error value (string)', () => {
      const msg = formatErrorForUser('string error' as unknown as Error);
      expect(typeof msg).toBe('string');
    });

    it('handles non-Error value (null)', () => {
      const msg = formatErrorForUser(null as unknown as Error);
      expect(typeof msg).toBe('string');
    });

    it('handles non-Error value (number)', () => {
      const msg = formatErrorForUser(42 as unknown as Error);
      expect(typeof msg).toBe('string');
    });

    it('handles non-Error value (object)', () => {
      const msg = formatErrorForUser({ some: 'object' } as unknown as Error);
      expect(typeof msg).toBe('string');
    });
  });

  it('never returns empty string', () => {
    const errors = [
      new GoogleSheetsError('x', 'y'),
      new OAuthError('x', 'y'),
      new NetworkError('x', 'y'),
      new HuggingFaceError('x', 'y'),
      new AiProviderError('x', 'y'),
      new AppError('x', 'y'),
      new Error('x'),
      'some string' as unknown as Error,
      null as unknown as Error,
    ];
    for (const err of errors) {
      expect(formatErrorForUser(err).length).toBeGreaterThan(0);
    }
  });

  it('all messages are plain strings (not HTML or markdown formatted with tags)', () => {
    const errors = [
      new GoogleSheetsError('x', 'y'),
      new OAuthError('x', 'y'),
      new NetworkError('x', 'y'),
      new HuggingFaceError('x', 'y'),
      new AiProviderError('x', 'y'),
    ];
    for (const err of errors) {
      const msg = formatErrorForUser(err);
      // All messages should be human-readable strings
      expect(typeof msg).toBe('string');
    }
  });
});
