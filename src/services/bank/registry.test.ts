// Tests for registry auto-discovery and preferences.xml parsing.

import { describe, expect, test } from 'bun:test';
import { BANK_REGISTRY, getBankList } from './registry';

describe('BANK_REGISTRY auto-discovery', () => {
  test('discovers multiple banks from ZenPlugins directory', () => {
    const list = getBankList();
    // At minimum the known banks we rely on
    expect(list.length).toBeGreaterThan(10);
  });

  test('getBankList returns banks sorted by name', () => {
    const names = getBankList().map((b) => b.name);
    const sorted = [...names].sort((a, b) => a.localeCompare(b));
    expect(names).toEqual(sorted);
  });

  test('excludes utility directories (bootloader, example, faktura)', () => {
    expect(BANK_REGISTRY['bootloader']).toBeUndefined();
    expect(BANK_REGISTRY['example']).toBeUndefined();
    expect(BANK_REGISTRY['faktura']).toBeUndefined();
  });

  test('tbc-ge has login/password fields', () => {
    const tbc = BANK_REGISTRY['tbc-ge'];
    if (!tbc) throw new Error('tbc-ge not in registry');
    const names = tbc.fields.map((f) => f.name);
    expect(names).toContain('login');
    expect(names).toContain('password');
    expect(tbc.fields.find((f) => f.name === 'password')?.type).toBe('password');
  });

  test('tbc-ge startDate is stored as default, not a wizard field', () => {
    const tbc = BANK_REGISTRY['tbc-ge'];
    if (!tbc) throw new Error('tbc-ge not in registry');
    expect(tbc.defaults?.['startDate']).toBeDefined();
    expect(tbc.fields.map((f) => f.name)).not.toContain('startDate');
  });

  test('kaspi has no wizard fields (date-only plugin)', () => {
    const kaspi = BANK_REGISTRY['kaspi'];
    if (!kaspi) throw new Error('kaspi not in registry');
    expect(kaspi.fields).toHaveLength(0);
    expect(kaspi.defaults?.['startDate']).toBeDefined();
  });

  test('each bank entry has name, plugin function, and fields array', () => {
    for (const [key, plugin] of Object.entries(BANK_REGISTRY)) {
      expect(typeof plugin.name).toBe('string');
      expect(plugin.name.length).toBeGreaterThan(0);
      expect(typeof plugin.plugin).toBe('function');
      expect(Array.isArray(plugin.fields)).toBe(true);
      // key must match directory name format
      expect(key).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
    }
  });
});
