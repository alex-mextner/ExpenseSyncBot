/**
 * Group settings registry — the single source of truth for every user-configurable
 * group setting. Both the AI `update_group_setting` tool and the /settings menu mutate
 * groups EXCLUSIVELY through these definitions, so a setting can never be changeable in
 * one surface but not the other.
 *
 * Enforcement (compile-time): every key of `UpdateGroupData` must be classified as either
 * a system field (`SYSTEM_GROUP_FIELDS`) or an editable setting with a `GROUP_SETTINGS`
 * entry. `ALL_UPDATE_KEYS satisfies Record<keyof UpdateGroupData, true>` fails to compile
 * if a new column is added to `UpdateGroupData` without listing it here; `GROUP_SETTINGS`
 * being keyed by `EditableGroupSettingKey` then forces an entry for every editable key.
 * `group-settings-registry.test.ts` re-checks the same invariant at runtime.
 */
import { type CurrencyCode, SUPPORTED_CURRENCIES } from '../../config/constants';
import { database } from '../../database';
import type { Group, UpdateGroupData } from '../../database/types';

// ── Enforcement: classify every UpdateGroupData key ───────────────────────────

/** Fields that are internal plumbing, never exposed as user settings. */
export const SYSTEM_GROUP_FIELDS = [
  'title',
  'invite_link',
  'google_refresh_token',
  'spreadsheet_id',
  'bank_panel_summary_message_id',
  'oauth_client',
] as const;

/**
 * Exhaustive map of every `UpdateGroupData` key. The `satisfies` clause makes TypeScript
 * fail to compile if a field is added to `UpdateGroupData` without being listed here —
 * forcing a deliberate system-vs-setting classification.
 */
export const ALL_UPDATE_KEYS = {
  title: true,
  invite_link: true,
  google_refresh_token: true,
  spreadsheet_id: true,
  default_currency: true,
  enabled_currencies: true,
  custom_prompt: true,
  active_topic_id: true,
  bank_panel_summary_message_id: true,
  bank_cards_enabled: true,
  oauth_client: true,
} satisfies Record<keyof UpdateGroupData, true>;

/** Every editable setting key = all update keys minus the system fields. */
export type EditableGroupSettingKey = Exclude<
  keyof UpdateGroupData,
  (typeof SYSTEM_GROUP_FIELDS)[number]
>;

// ── Setting definition shape ──────────────────────────────────────────────────

export type GroupSettingKind = 'currency' | 'currency_multi' | 'toggle' | 'topic' | 'text';

export type SettingParseResult<V> = { ok: true; value: V } | { ok: false; error: string };

interface BaseSettingDef {
  readonly emoji: string;
  readonly labelRu: string;
  /** Tells the AI exactly what value string to pass to `update_group_setting`. */
  readonly aiValueHint: string;
  /** Render the current stored value for display (menu lines, AI context, summaries). */
  formatValue(group: Group): string;
}

interface CurrencySettingDef extends BaseSettingDef {
  readonly key: 'default_currency';
  readonly kind: 'currency';
  parse(raw: string, group: Group): SettingParseResult<CurrencyCode>;
  apply(group: Group, value: CurrencyCode): Promise<void>;
}

interface CurrencyMultiSettingDef extends BaseSettingDef {
  readonly key: 'enabled_currencies';
  readonly kind: 'currency_multi';
  parse(raw: string, group: Group): SettingParseResult<CurrencyCode[]>;
  apply(group: Group, value: CurrencyCode[]): Promise<void>;
}

interface ToggleSettingDef extends BaseSettingDef {
  readonly key: 'bank_cards_enabled';
  readonly kind: 'toggle';
  parse(raw: string, group: Group): SettingParseResult<number>;
  apply(group: Group, value: number): Promise<void>;
}

interface TopicSettingDef extends BaseSettingDef {
  readonly key: 'active_topic_id';
  readonly kind: 'topic';
  parse(raw: string, group: Group): SettingParseResult<number | null>;
  apply(group: Group, value: number | null): Promise<void>;
}

interface TextSettingDef extends BaseSettingDef {
  readonly key: 'custom_prompt';
  readonly kind: 'text';
  parse(raw: string, group: Group): SettingParseResult<string | null>;
  apply(group: Group, value: string | null): Promise<void>;
}

export type GroupSettingDef =
  | CurrencySettingDef
  | CurrencyMultiSettingDef
  | ToggleSettingDef
  | TopicSettingDef
  | TextSettingDef;

// ── Parsing helpers ────────────────────────────────────────────────────────────

/** Words that clear an optional setting (topic / custom prompt). */
const CLEAR_WORDS = new Set([
  'clear',
  'none',
  'reset',
  'unset',
  'сброс',
  'сбросить',
  'очистить',
  'убрать',
]);

const TOGGLE_ON = new Set([
  'on',
  '1',
  'true',
  'yes',
  'enable',
  'enabled',
  'вкл',
  'включить',
  'включено',
  'да',
]);
const TOGGLE_OFF = new Set([
  'off',
  '0',
  'false',
  'no',
  'disable',
  'disabled',
  'выкл',
  'выключить',
  'выключено',
  'нет',
]);

function isSupportedCurrency(code: string): code is CurrencyCode {
  return SUPPORTED_CURRENCIES.some((c) => c === code);
}

function supportedCurrencyList(): string {
  return SUPPORTED_CURRENCIES.join(', ');
}

function parseCurrency(raw: string): SettingParseResult<CurrencyCode> {
  const code = raw.trim().toUpperCase();
  if (!code) {
    return { ok: false, error: 'Укажи код валюты, например EGP или USD.' };
  }
  if (isSupportedCurrency(code)) {
    return { ok: true, value: code };
  }
  return {
    ok: false,
    error: `Неизвестная валюта "${code}". Поддерживаются: ${supportedCurrencyList()}.`,
  };
}

function parseCurrencyMulti(raw: string, group: Group): SettingParseResult<CurrencyCode[]> {
  const tokens = raw
    .split(/[\s,]+/)
    .map((t) => t.trim().toUpperCase())
    .filter(Boolean);

  if (tokens.length === 0) {
    return { ok: false, error: 'Перечисли хотя бы одну валюту, например "USD, EUR".' };
  }

  const invalid = tokens.filter((t) => !isSupportedCurrency(t));
  if (invalid.length > 0) {
    return {
      ok: false,
      error: `Неизвестные валюты: ${invalid.join(', ')}. Поддерживаются: ${supportedCurrencyList()}.`,
    };
  }

  const valid = tokens.filter(isSupportedCurrency);
  // The default currency must always stay enabled — a default outside the set is a bug.
  const withDefault = valid.includes(group.default_currency)
    ? valid
    : [...valid, group.default_currency];
  return { ok: true, value: [...new Set(withDefault)] };
}

function parseToggle(raw: string): SettingParseResult<number> {
  const value = raw.trim().toLowerCase();
  if (TOGGLE_ON.has(value)) return { ok: true, value: 1 };
  if (TOGGLE_OFF.has(value)) return { ok: true, value: 0 };
  return { ok: false, error: `Не понял "${raw}". Напиши "вкл" или "выкл".` };
}

function parseTopic(raw: string): SettingParseResult<number | null> {
  const value = raw.trim().toLowerCase();
  if (value === '' || CLEAR_WORDS.has(value)) {
    return { ok: true, value: null };
  }
  if (!/^-?\d+$/.test(value)) {
    return { ok: false, error: `Топик должен быть числом или "сброс". Получено: "${raw}".` };
  }
  return { ok: true, value: Number.parseInt(value, 10) };
}

function parseText(raw: string): SettingParseResult<string | null> {
  const trimmed = raw.trim();
  if (trimmed === '' || CLEAR_WORDS.has(trimmed.toLowerCase())) {
    return { ok: true, value: null };
  }
  return { ok: true, value: trimmed };
}

function previewPrompt(prompt: string | null): string {
  if (!prompt) return 'не задан';
  const oneLine = prompt.replace(/\s+/g, ' ').trim();
  return oneLine.length > 60 ? `${oneLine.slice(0, 57)}…` : oneLine;
}

// ── Setting definitions ──────────────────────────────────────────────────────

const defaultCurrencySetting: CurrencySettingDef = {
  key: 'default_currency',
  kind: 'currency',
  emoji: '💱',
  labelRu: 'Валюта по умолчанию',
  aiValueHint: 'ISO currency code, e.g. "EGP", "USD", "RSD"',
  formatValue: (group) => group.default_currency,
  parse: (raw) => parseCurrency(raw),
  async apply(group, value) {
    const enabled = group.enabled_currencies.includes(value)
      ? group.enabled_currencies
      : [...group.enabled_currencies, value];
    database.groups.update(group.telegram_group_id, {
      default_currency: value,
      enabled_currencies: enabled,
    });
  },
};

const enabledCurrenciesSetting: CurrencyMultiSettingDef = {
  key: 'enabled_currencies',
  kind: 'currency_multi',
  emoji: '💵',
  labelRu: 'Включённые валюты',
  aiValueHint:
    'comma- or space-separated ISO codes, e.g. "USD, EUR, EGP"; the default currency is always kept',
  formatValue: (group) => group.enabled_currencies.join(', ') || '—',
  parse: (raw, group) => parseCurrencyMulti(raw, group),
  async apply(group, value) {
    database.groups.update(group.telegram_group_id, { enabled_currencies: value });
  },
};

const bankCardsSetting: ToggleSettingDef = {
  key: 'bank_cards_enabled',
  kind: 'toggle',
  emoji: '🔔',
  labelRu: 'Карточки банковских транзакций',
  aiValueHint: 'on / off (also accepts 1/0, true/false, вкл/выкл)',
  formatValue: (group) => (group.bank_cards_enabled ? 'вкл' : 'выкл (только баланс)'),
  parse: (raw) => parseToggle(raw),
  async apply(group, value) {
    database.groups.update(group.telegram_group_id, { bank_cards_enabled: value });
  },
};

const activeTopicSetting: TopicSettingDef = {
  key: 'active_topic_id',
  kind: 'topic',
  emoji: '📍',
  labelRu: 'Топик',
  aiValueHint: 'integer topic id, or "clear"/"сброс" to unset',
  formatValue: (group) =>
    group.active_topic_id != null ? `#${group.active_topic_id}` : 'не задан',
  parse: (raw) => parseTopic(raw),
  async apply(group, value) {
    database.groups.update(group.telegram_group_id, { active_topic_id: value });
  },
};

const customPromptSetting: TextSettingDef = {
  key: 'custom_prompt',
  kind: 'text',
  emoji: '📝',
  labelRu: 'AI-промпт',
  aiValueHint: 'free text, or "clear"/"сброс" to remove',
  formatValue: (group) => previewPrompt(group.custom_prompt),
  parse: (raw) => parseText(raw),
  async apply(group, value) {
    database.groups.update(group.telegram_group_id, { custom_prompt: value });
  },
};

/**
 * The registry. Keyed by `EditableGroupSettingKey` with each slot pinned to the definition
 * whose `key` matches, so adding an editable column without a matching, correctly-typed
 * definition fails to compile.
 */
export const GROUP_SETTINGS: {
  [K in EditableGroupSettingKey]: Extract<GroupSettingDef, { key: K }>;
} = {
  default_currency: defaultCurrencySetting,
  enabled_currencies: enabledCurrenciesSetting,
  bank_cards_enabled: bankCardsSetting,
  active_topic_id: activeTopicSetting,
  custom_prompt: customPromptSetting,
};

// ── Public API ──────────────────────────────────────────────────────────────

/** Type guard: is `key` a registry-backed editable setting? */
export function isEditableGroupSettingKey(key: string): key is EditableGroupSettingKey {
  return Object.hasOwn(GROUP_SETTINGS, key);
}

export type ApplyGroupSettingResult = { ok: true } | { ok: false; error: string };

/**
 * Parse a raw (LLM- or user-supplied) string for a setting and persist it.
 * This is the ONE mutation path shared by the AI tool and the /settings menu.
 */
export async function applyGroupSetting(
  def: GroupSettingDef,
  group: Group,
  raw: string,
): Promise<ApplyGroupSettingResult> {
  // The switch narrows `def` to a concrete variant so `parse`/`apply` stay correlated
  // on the same value type V — no casts needed.
  switch (def.kind) {
    case 'currency':
      return runSetting(def, group, raw);
    case 'currency_multi':
      return runSetting(def, group, raw);
    case 'toggle':
      return runSetting(def, group, raw);
    case 'topic':
      return runSetting(def, group, raw);
    case 'text':
      return runSetting(def, group, raw);
  }
}

async function runSetting<V>(
  def: {
    parse(raw: string, group: Group): SettingParseResult<V>;
    apply(group: Group, value: V): Promise<void>;
  },
  group: Group,
  raw: string,
): Promise<ApplyGroupSettingResult> {
  const parsed = def.parse(raw, group);
  if (!parsed.ok) {
    return { ok: false, error: parsed.error };
  }
  await def.apply(group, parsed.value);
  return { ok: true };
}
