// src/services/ai/tool-schema-mode.test.ts
// AI_TOOL_SCHEMA_MODE parsing and the AI_TOOL_SCHEMA_USER_IDS canary (#203 step B).

import { describe, expect, it } from 'bun:test';
import { parseToolSchemaMode, toolSchemaModeFor } from './tool-schema-mode';
import { parseUserIdList } from './user-id-list';

describe('parseToolSchemaMode', () => {
  it('defaults to full when unset or empty', () => {
    expect(parseToolSchemaMode(undefined)).toBe('full');
    expect(parseToolSchemaMode('')).toBe('full');
  });

  it.each(['full', 'lazy', 'hybrid'] as const)('accepts %s', (mode) => {
    expect(parseToolSchemaMode(mode)).toBe(mode);
  });

  it('rejects a misspelling instead of silently falling back', () => {
    expect(() => parseToolSchemaMode('hybird')).toThrow(
      'AI_TOOL_SCHEMA_MODE must be full, lazy or hybrid',
    );
  });
});

describe('toolSchemaModeFor', () => {
  it('applies the mode to everyone when there is no canary list', () => {
    expect(toolSchemaModeFor('hybrid', undefined, 5)).toBe('hybrid');
  });

  it('applies the mode only to listed users, full for the rest', () => {
    expect(toolSchemaModeFor('hybrid', [5, 7], 7)).toBe('hybrid');
    expect(toolSchemaModeFor('hybrid', [5, 7], 8)).toBe('full');
  });

  it('stays full in full mode whatever the list says', () => {
    expect(toolSchemaModeFor('full', [5], 5)).toBe('full');
  });
});

describe('parseUserIdList', () => {
  it('is undefined when unset and a deduplicated list otherwise', () => {
    expect(parseUserIdList('X', undefined)).toBeUndefined();
    expect(parseUserIdList('X', '5, 7,5')).toEqual([5, 7]);
  });

  it.each([
    '',
    '0',
    '-3',
    '1.5',
    'abc',
    '1,,2',
    Array.from({ length: 101 }, (_, i) => i + 1).join(','),
  ])('rejects %p and names the variable', (raw) => {
    expect(() => parseUserIdList('AI_TOOL_SCHEMA_USER_IDS', raw)).toThrow(
      'AI_TOOL_SCHEMA_USER_IDS must be at most 100 positive safe integer Telegram user IDs',
    );
  });
});
