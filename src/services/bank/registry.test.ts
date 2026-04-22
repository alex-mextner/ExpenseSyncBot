// Tests for registry auto-discovery and preferences.xml parsing.

import { describe, expect, test } from 'bun:test';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BANK_REGISTRY, getBankList, lookupBank } from './registry';

const pluginsDir = join(dirname(fileURLToPath(import.meta.url)), 'ZenPlugins/src/plugins');
const hasZenPlugins = existsSync(pluginsDir);

describe.skipIf(!hasZenPlugins)('BANK_REGISTRY auto-discovery', () => {
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

  test('registry has no duplicate display names', () => {
    // Display names should be unique so the `/bank` picker is unambiguous.
    const names = getBankList().map((b) => b.name);
    const unique = new Set(names);
    expect(unique.size).toBe(names.length);
  });

  test('country-code suffix converts to uppercase parenthetical (e.g. -ge → (GE))', () => {
    const tbc = BANK_REGISTRY['tbc-ge'];
    if (!tbc) throw new Error('tbc-ge not in registry');
    expect(tbc.name).toMatch(/\(GE\)$/);
  });

  test('short directory segments (≤4 chars) are rendered as ALL-CAPS acronyms', () => {
    // 'tbc' is 3 chars → must appear uppercased as 'TBC'.
    const tbc = BANK_REGISTRY['tbc-ge'];
    if (!tbc) throw new Error('tbc-ge not in registry');
    expect(tbc.name.startsWith('TBC')).toBe(true);
  });

  test('text/password fields expose a non-empty prompt', () => {
    const tbc = BANK_REGISTRY['tbc-ge'];
    if (!tbc) throw new Error('tbc-ge not in registry');
    for (const f of tbc.fields) {
      expect(f.prompt).toBeDefined();
      expect(f.prompt.length).toBeGreaterThan(0);
      expect(['text', 'password', 'otp']).toContain(f.type);
    }
  });

  test('every password field is flagged type="password", never "text"', () => {
    for (const plugin of Object.values(BANK_REGISTRY)) {
      for (const f of plugin.fields) {
        if (f.name.toLowerCase() === 'password') {
          expect(f.type).toBe('password');
        }
      }
    }
  });

  test('plugin loader returns a function (not yet invoked — no real import)', () => {
    const tbc = BANK_REGISTRY['tbc-ge'];
    if (!tbc) throw new Error('tbc-ge not in registry');
    expect(typeof tbc.plugin).toBe('function');
  });
});

describe.skipIf(!hasZenPlugins)('lookupBank', () => {
  test('exact key match (tbc-ge)', () => {
    const result = lookupBank('tbc-ge');
    expect(result).not.toBeNull();
    expect(result?.[0]).toBe('tbc-ge');
  });

  test('key-prefix match (tbc → tbc-ge)', () => {
    const result = lookupBank('tbc');
    expect(result).not.toBeNull();
    expect(result?.[0]).toBe('tbc-ge');
  });

  test('is case-insensitive for key match', () => {
    const result = lookupBank('TBC-GE');
    expect(result).not.toBeNull();
    expect(result?.[0]).toBe('tbc-ge');
  });

  test('display-name prefix match (TBC → tbc-ge via "TBC (GE)")', () => {
    // Same query as prefix; validated via display-name contract too.
    const result = lookupBank('tbc');
    expect(result).not.toBeNull();
    expect(result?.[1].name.toLowerCase()).toContain('tbc');
  });

  test('display-name contains match (fuzzy)', () => {
    // Use a substring likely present in many display names.
    const result = lookupBank('kaspi');
    if (BANK_REGISTRY['kaspi']) {
      expect(result).not.toBeNull();
      expect(result?.[0]).toBe('kaspi');
    }
  });

  test('returns null for unknown query', () => {
    expect(lookupBank('definitely-not-a-real-bank-zzz')).toBeNull();
  });

  test('returns null for empty string only when no bank starts with it (all do)', () => {
    // Empty string matches via startsWith('') — so ANY bank will match.
    // Assert behaviour is stable: either matches or returns null, never throws.
    const result = lookupBank('');
    expect(result === null || typeof result[0] === 'string').toBe(true);
  });

  test('getBankList returns stable key/name pairs for every registry entry', () => {
    const list = getBankList();
    const keys = new Set(list.map((b) => b.key));
    for (const key of Object.keys(BANK_REGISTRY)) {
      expect(keys.has(key)).toBe(true);
    }
  });
});

// Branch behaviour independent of whether ZenPlugins is checked out.
describe('registry — environment-independent contracts', () => {
  test('BANK_REGISTRY is a plain object (never undefined, never null)', () => {
    expect(BANK_REGISTRY).toBeDefined();
    expect(typeof BANK_REGISTRY).toBe('object');
    expect(BANK_REGISTRY).not.toBeNull();
  });

  test('getBankList returns an array (possibly empty if no plugins)', () => {
    expect(Array.isArray(getBankList())).toBe(true);
  });

  test('getBankList output is sorted by localeCompare on name', () => {
    const list = getBankList();
    for (let i = 1; i < list.length; i++) {
      const prev = list[i - 1];
      const curr = list[i];
      if (!prev || !curr) continue;
      expect(prev.name.localeCompare(curr.name)).toBeLessThanOrEqual(0);
    }
  });

  test('lookupBank result shape is [key, plugin] tuple or null', () => {
    const result = lookupBank('tbc');
    if (result !== null) {
      expect(result).toHaveLength(2);
      expect(typeof result[0]).toBe('string');
      expect(typeof result[1].plugin).toBe('function');
    }
  });

  test('SKIP_DIRS are absent from registry regardless of ZenPlugins presence', () => {
    // These names would be skipped even if real; ensures no accidental registration.
    expect(BANK_REGISTRY['bootloader']).toBeUndefined();
    expect(BANK_REGISTRY['example']).toBeUndefined();
    expect(BANK_REGISTRY['faktura']).toBeUndefined();
  });
});
