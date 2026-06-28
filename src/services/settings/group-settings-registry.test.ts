// Tests for the group settings registry: enforcement guard, parse, formatValue, apply.

import { beforeEach, describe, expect, mock, test } from 'bun:test';
import type { CurrencyCode } from '../../config/constants';
import type { Group, UpdateGroupData } from '../../database/types';

// ── Database mock (registry writes via database.groups.update) ──────────────

const updateMock = mock((_id: number, _data: UpdateGroupData): Group | null => null);
mock.module('../../database', () => ({
  database: { groups: { update: updateMock } },
}));

const {
  GROUP_SETTINGS,
  SYSTEM_GROUP_FIELDS,
  ALL_UPDATE_KEYS,
  applyGroupSetting,
  isEditableGroupSettingKey,
} = await import('./group-settings-registry');

// ── Fixtures ────────────────────────────────────────────────────────────────

function fakeGroup(overrides: Partial<Group> = {}): Group {
  return {
    id: 1,
    telegram_group_id: -100,
    title: null,
    invite_link: null,
    google_refresh_token: null,
    spreadsheet_id: null,
    default_currency: 'USD' as CurrencyCode,
    enabled_currencies: ['USD', 'EUR'] as CurrencyCode[],
    custom_prompt: null,
    active_topic_id: null,
    bank_panel_summary_message_id: null,
    bank_cards_enabled: 0,
    oauth_client: 'current',
    created_at: '',
    updated_at: '',
    ...overrides,
  };
}

beforeEach(() => {
  updateMock.mockReset().mockReturnValue(null);
});

// ── Enforcement guard ─────────────────────────────────────────────────────────

describe('registry enforcement', () => {
  test('GROUP_SETTINGS covers exactly every editable (non-system) UpdateGroupData key', () => {
    const systemSet = new Set<string>(SYSTEM_GROUP_FIELDS);
    const expectedEditable = Object.keys(ALL_UPDATE_KEYS).filter((k) => !systemSet.has(k));

    expect(new Set(Object.keys(GROUP_SETTINGS))).toEqual(new Set(expectedEditable));
  });

  test('every registry entry declares a key matching its map slot', () => {
    for (const [key, def] of Object.entries(GROUP_SETTINGS)) {
      expect<string>(def.key).toBe(key);
    }
  });

  test('system fields and editable settings are disjoint', () => {
    const systemSet = new Set<string>(SYSTEM_GROUP_FIELDS);
    for (const key of Object.keys(GROUP_SETTINGS)) {
      expect(systemSet.has(key)).toBe(false);
    }
  });

  test('isEditableGroupSettingKey accepts registry keys and rejects system / unknown keys', () => {
    expect(isEditableGroupSettingKey('default_currency')).toBe(true);
    expect(isEditableGroupSettingKey('bank_cards_enabled')).toBe(true);
    expect(isEditableGroupSettingKey('spreadsheet_id')).toBe(false);
    expect(isEditableGroupSettingKey('nonsense')).toBe(false);
  });
});

// ── default_currency ──────────────────────────────────────────────────────────

describe('default_currency setting', () => {
  const def = GROUP_SETTINGS.default_currency;

  test('parse uppercases and accepts a supported code', () => {
    expect(def.parse('egp', fakeGroup())).toEqual({ ok: true, value: 'EGP' });
  });

  test('parse rejects an unsupported code with a Russian error naming supported codes', () => {
    const result = def.parse('xyz', fakeGroup());
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain('XYZ');
      expect(result.error).toContain('USD');
    }
  });

  test('formatValue returns the current default code', () => {
    expect(def.formatValue(fakeGroup({ default_currency: 'RSD' as CurrencyCode }))).toBe('RSD');
  });

  test('apply adds the new default to enabled_currencies when missing', async () => {
    const result = await applyGroupSetting(def, fakeGroup(), 'egp');
    expect(result.ok).toBe(true);
    expect(updateMock).toHaveBeenCalledWith(-100, {
      default_currency: 'EGP',
      enabled_currencies: ['USD', 'EUR', 'EGP'],
    });
  });

  test('apply keeps enabled set unchanged when default already present', async () => {
    const result = await applyGroupSetting(def, fakeGroup({ default_currency: 'USD' }), 'eur');
    expect(result.ok).toBe(true);
    expect(updateMock).toHaveBeenCalledWith(-100, {
      default_currency: 'EUR',
      enabled_currencies: ['USD', 'EUR'],
    });
  });

  test('apply does not write on invalid input', async () => {
    const result = await applyGroupSetting(def, fakeGroup(), 'nope');
    expect(result.ok).toBe(false);
    expect(updateMock).not.toHaveBeenCalled();
  });
});

// ── enabled_currencies ────────────────────────────────────────────────────────

describe('enabled_currencies setting', () => {
  const def = GROUP_SETTINGS.enabled_currencies;

  test('parse splits on commas/spaces, uppercases, dedupes', () => {
    const result = def.parse('usd, eur usd', fakeGroup({ default_currency: 'USD' }));
    expect(result).toEqual({ ok: true, value: ['USD', 'EUR'] });
  });

  test('parse always keeps the default currency in the set', () => {
    const result = def.parse('eur', fakeGroup({ default_currency: 'USD' }));
    expect(result).toEqual({ ok: true, value: ['EUR', 'USD'] });
  });

  test('parse rejects when any code is unsupported', () => {
    const result = def.parse('usd, zzz', fakeGroup());
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('ZZZ');
  });

  test('parse rejects an empty list', () => {
    const result = def.parse('   ', fakeGroup());
    expect(result.ok).toBe(false);
  });

  test('formatValue joins codes with commas', () => {
    expect(
      def.formatValue(fakeGroup({ enabled_currencies: ['USD', 'EUR', 'EGP'] as CurrencyCode[] })),
    ).toBe('USD, EUR, EGP');
  });

  test('apply writes the parsed currency list', async () => {
    const result = await applyGroupSetting(
      def,
      fakeGroup({ default_currency: 'USD' }),
      'usd eur egp',
    );
    expect(result.ok).toBe(true);
    expect(updateMock).toHaveBeenCalledWith(-100, { enabled_currencies: ['USD', 'EUR', 'EGP'] });
  });
});

// ── bank_cards_enabled (toggle) ────────────────────────────────────────────────

describe('bank_cards_enabled setting', () => {
  const def = GROUP_SETTINGS.bank_cards_enabled;

  test('parse accepts on/off synonyms', () => {
    expect(def.parse('on', fakeGroup())).toEqual({ ok: true, value: 1 });
    expect(def.parse('ВКЛ', fakeGroup())).toEqual({ ok: true, value: 1 });
    expect(def.parse('true', fakeGroup())).toEqual({ ok: true, value: 1 });
    expect(def.parse('off', fakeGroup())).toEqual({ ok: true, value: 0 });
    expect(def.parse('выкл', fakeGroup())).toEqual({ ok: true, value: 0 });
    expect(def.parse('0', fakeGroup())).toEqual({ ok: true, value: 0 });
  });

  test('parse rejects gibberish', () => {
    const result = def.parse('maybe', fakeGroup());
    expect(result.ok).toBe(false);
  });

  test('formatValue clarifies the off state still syncs balance', () => {
    expect(def.formatValue(fakeGroup({ bank_cards_enabled: 1 }))).toBe('вкл');
    expect(def.formatValue(fakeGroup({ bank_cards_enabled: 0 }))).toContain('только баланс');
  });

  test('apply writes 0/1', async () => {
    await applyGroupSetting(def, fakeGroup(), 'on');
    expect(updateMock).toHaveBeenCalledWith(-100, { bank_cards_enabled: 1 });
  });
});

// ── active_topic_id (topic) ────────────────────────────────────────────────────

describe('active_topic_id setting', () => {
  const def = GROUP_SETTINGS.active_topic_id;

  test('parse accepts an integer', () => {
    expect(def.parse('55', fakeGroup())).toEqual({ ok: true, value: 55 });
  });

  test('parse treats clear words and empty as null', () => {
    expect(def.parse('clear', fakeGroup())).toEqual({ ok: true, value: null });
    expect(def.parse('сброс', fakeGroup())).toEqual({ ok: true, value: null });
    expect(def.parse('', fakeGroup())).toEqual({ ok: true, value: null });
  });

  test('parse rejects non-integer text', () => {
    const result = def.parse('abc', fakeGroup());
    expect(result.ok).toBe(false);
  });

  test('formatValue shows the id or "не задан"', () => {
    expect(def.formatValue(fakeGroup({ active_topic_id: 7 }))).toBe('#7');
    expect(def.formatValue(fakeGroup({ active_topic_id: null }))).toBe('не задан');
  });

  test('apply writes the id and clears to null', async () => {
    await applyGroupSetting(def, fakeGroup(), '7');
    expect(updateMock).toHaveBeenCalledWith(-100, { active_topic_id: 7 });
    updateMock.mockReset();
    await applyGroupSetting(def, fakeGroup(), 'clear');
    expect(updateMock).toHaveBeenCalledWith(-100, { active_topic_id: null });
  });
});

// ── custom_prompt (text) ───────────────────────────────────────────────────────

describe('custom_prompt setting', () => {
  const def = GROUP_SETTINGS.custom_prompt;

  test('parse keeps trimmed text', () => {
    expect(def.parse('  speak in English  ', fakeGroup())).toEqual({
      ok: true,
      value: 'speak in English',
    });
  });

  test('parse clears on clear words and empty', () => {
    expect(def.parse('clear', fakeGroup())).toEqual({ ok: true, value: null });
    expect(def.parse('', fakeGroup())).toEqual({ ok: true, value: null });
  });

  test('formatValue previews the prompt or "не задан"', () => {
    expect(def.formatValue(fakeGroup({ custom_prompt: null }))).toBe('не задан');
    expect(def.formatValue(fakeGroup({ custom_prompt: 'Be brief' }))).toBe('Be brief');
  });

  test('apply writes the prompt and clears it', async () => {
    await applyGroupSetting(def, fakeGroup(), 'Be brief');
    expect(updateMock).toHaveBeenCalledWith(-100, { custom_prompt: 'Be brief' });
    updateMock.mockReset();
    await applyGroupSetting(def, fakeGroup(), 'clear');
    expect(updateMock).toHaveBeenCalledWith(-100, { custom_prompt: null });
  });
});
