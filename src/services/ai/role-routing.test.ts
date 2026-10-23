// Tests for role-routing config: chain entry parsing, the AI_ROUTING_USER_IDS canary, user id parsing.

import { describe, expect, it } from 'bun:test';
import type { ModelPreset } from './model-presets';
import {
  parseRoleChain,
  parseRoutingMode,
  parseRoutingUserIds,
  rolesRoutingAppliesTo,
} from './role-routing';

const FLASH: ModelPreset = {
  id: 'flash',
  models: { openrouter: 'v/flash', zai: 'flash' },
  roles: ['executor'],
  priceUsdPerMTok: null,
  qualification: null,
};
const REGISTRY = [FLASH];

describe('parseRoleChain', () => {
  it('reads provider:preset and bare provider entries in order', () => {
    const { entries, problems } = parseRoleChain('openrouter:flash, zai:flash,claude', REGISTRY);
    expect(problems).toEqual([]);
    expect(entries).toEqual([
      { provider: 'openrouter', preset: FLASH },
      { provider: 'zai', preset: FLASH },
      { provider: 'claude', preset: null },
    ]);
  });

  it('is empty for an unset or blank value', () => {
    expect(parseRoleChain(undefined, REGISTRY)).toEqual({ entries: [], problems: [] });
    expect(parseRoleChain(' , ', REGISTRY)).toEqual({ entries: [], problems: [] });
  });

  it('drops and reports an unknown provider, an unknown preset and a route the preset lacks', () => {
    const { entries, problems } = parseRoleChain('groq,openrouter:nope,hf:flash,claude', REGISTRY);
    expect(entries).toEqual([{ provider: 'claude', preset: null }]);
    expect(problems).toHaveLength(3);
    expect(problems[0]).toContain('groq');
    expect(problems[1]).toContain('nope');
    expect(problems[2]).toContain('hf:flash');
  });

  it('keeps the first of duplicate entries', () => {
    const { entries } = parseRoleChain('claude,claude,openrouter:flash,openrouter:flash', REGISTRY);
    expect(entries).toHaveLength(2);
  });

  it('refuses an excluded model even when a preset route names it', () => {
    const bad: ModelPreset = { ...FLASH, id: 'bad', models: { openrouter: 'openai/gpt-oss-120b' } };
    const { entries, problems } = parseRoleChain('openrouter:bad', [bad]);
    expect(entries).toEqual([]);
    expect(problems[0]).toContain('excluded');
  });
});

describe('parseRoutingMode', () => {
  it('defaults to legacy and accepts roles', () => {
    expect(parseRoutingMode(undefined)).toBe('legacy');
    expect(parseRoutingMode('')).toBe('legacy');
    expect(parseRoutingMode('legacy')).toBe('legacy');
    expect(parseRoutingMode('roles')).toBe('roles');
  });

  it('rejects a misspelling instead of silently falling back', () => {
    expect(() => parseRoutingMode('role')).toThrow('AI_ROUTING must be legacy or roles');
  });
});

describe('parseRoutingUserIds', () => {
  it('is undefined when unset and a deduplicated list otherwise', () => {
    expect(parseRoutingUserIds(undefined)).toBeUndefined();
    expect(parseRoutingUserIds('5, 7,5')).toEqual([5, 7]);
  });

  it.each([
    '',
    '0',
    '-3',
    '1.5',
    'abc',
    '1,,2',
    Array.from({ length: 101 }, (_, i) => i + 1).join(','),
  ])('rejects %p', (raw) => {
    expect(() => parseRoutingUserIds(raw)).toThrow('AI_ROUTING_USER_IDS');
  });
});

describe('rolesRoutingAppliesTo', () => {
  it('never applies in legacy mode, whatever the user list says', () => {
    expect(rolesRoutingAppliesTo('legacy', [5], 5)).toBe(false);
    expect(rolesRoutingAppliesTo('legacy', undefined, 5)).toBe(false);
  });

  it('applies to everyone in roles mode without a user list', () => {
    expect(rolesRoutingAppliesTo('roles', undefined, 5)).toBe(true);
  });

  it('is a canary with a user list: only listed Telegram users', () => {
    expect(rolesRoutingAppliesTo('roles', [5, 7], 7)).toBe(true);
    expect(rolesRoutingAppliesTo('roles', [5, 7], 8)).toBe(false);
  });
});
